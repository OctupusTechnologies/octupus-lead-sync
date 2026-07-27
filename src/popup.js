'use strict';

const $ = (id) => document.getElementById(id);

function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleString('es-ES', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch (e) {
    return iso;
  }
}

async function render() {
  const { log = [] } = await chrome.storage.local.get('log');

  const list = $('log');
  list.innerHTML = '';
  $('empty').hidden = log.length > 0;

  for (const entry of log) {
    const li = document.createElement('li');
    li.className = entry.ok ? 'ok' : 'error';

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = entry.name || '(sin nombre)';

    const meta = document.createElement('div');
    meta.className = 'meta';
    const status = document.createElement('span');
    status.className = 'status';
    const okText =
      entry.action === 'update'
        ? `✔ actualizado #${entry.destId || '?'}`
        : entry.action === 'link'
          ? `✔ vinculado #${entry.destId || '?'} (ya existía)`
          : entry.action === 'comments'
            ? `✔ ${entry.count || '?'} mensaje(s) → #${entry.destId || '?'}`
            : entry.action === 'pull'
              ? `✔ ${entry.count || '?'} mensaje(s) traídos de #${entry.destId || '?'}`
              : `✔ creado #${entry.destId || '?'}`;
    status.textContent = entry.ok ? okText : `✖ ${entry.error || 'error'}`;
    meta.append(`${fmtDate(entry.at)} · `, status);
    if (entry.ok && entry.warn) meta.append(` · ⚠ ${entry.warn}`);

    li.append(name, meta);
    list.append(li);
  }
}

async function renderSession() {
  const el = $('session');
  try {
    const res = await chrome.runtime.sendMessage({ type: 'CHECK_SESSION' });
    if (res && res.ok) {
      el.textContent = `odoo.com: conectado como ${res.username || 'uid ' + res.uid}`;
      el.className = 'session ok';
    } else {
      el.textContent = `odoo.com: ${(res && res.error) || 'sin sesión'}`;
      el.className = 'session error';
    }
  } catch (err) {
    el.textContent = `odoo.com: ${err.message || err}`;
    el.className = 'session error';
  }
}

function setManualStatus(text, ok) {
  const el = $('manualStatus');
  el.textContent = text;
  el.className = 'manual-status' + (ok === true ? ' ok' : ok === false ? ' error' : '');
}

/**
 * Muestra el botón manual si la pestaña activa tiene un lead abierto.
 * Según el chatter del lead: sin nota → "Enviar"; con nota (ya sincronizado)
 * → "Actualizar datos" contra la oportunidad remota.
 */
async function initManual() {
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (e) {
    return;
  }
  if (!tab || !tab.id) return;

  let res;
  try {
    res = await chrome.tabs.sendMessage(tab.id, { type: 'GET_CURRENT_LEAD' });
  } catch (e) {
    return; // no es una pestaña de Odoo (o falta recargarla tras instalar)
  }
  if (!res || !res.leadId) return;

  renderManual(tab.id, res.leadId, res.remoteId, res.readError);
}

function renderManual(tabId, leadId, remoteId, readError) {
  $('manual').hidden = false;
  const btn = $('sendLead');
  const push = $('pushMsgs');
  const pull = $('pullMsgs');
  push.hidden = true;
  pull.hidden = true;

  if (readError) {
    // No se pudo leer el chatter: nunca ofrecer "Enviar" (riesgo de duplicado)
    btn.hidden = true;
    setManualStatus(
      `No se pudo comprobar el estado del lead #${leadId}. Revisa tu sesión de Odoo y vuelve a abrir el popup.`,
      false
    );
    return;
  }

  btn.hidden = false;
  if (remoteId === 0) {
    // Hay nota en el chatter pero sin id parseable: ofrecer re-vinculación
    btn.textContent = `🔗 Re-vincular lead #${leadId} con el portal`;
    btn.title = 'Busca la oportunidad en el portal y reescribe la nota con su ID. No crea nada.';
    setManualStatus('Sincronizado, pero la nota del chatter no tiene ID remoto', false);
    btn.onclick = () => runManualAction(tabId, leadId, 'RELINK_CURRENT_LEAD', null);
    return;
  }

  if (remoteId) {
    btn.textContent = `📇 Actualizar contacto del lead #${leadId}`;
    btn.title = 'Vuelve a enviar los datos de contacto del lead a la oportunidad del portal';
    setManualStatus(`Ya sincronizado — ID remoto ${remoteId}`, true);
    btn.onclick = () => runManualAction(tabId, leadId, 'UPDATE_CURRENT_LEAD', remoteId);
    push.hidden = false;
    push.onclick = () => runManualAction(tabId, leadId, 'PUSH_CURRENT_COMMENTS', remoteId);
    pull.hidden = false;
    pull.onclick = () => runManualAction(tabId, leadId, 'PULL_CURRENT_COMMENTS', remoteId);
  } else {
    btn.textContent = `🐙 Enviar lead #${leadId} a odoo.com`;
    btn.title = 'Crea la oportunidad en el portal, rellena el contacto, deja nota y sube los mensajes';
    setManualStatus('');
    btn.onclick = () => runManualAction(tabId, leadId, 'SEND_CURRENT_LEAD', null);
  }
}

async function runManualAction(tabId, leadId, type, remoteId) {
  const btn = $('sendLead');
  const botones = [btn, $('pushMsgs'), $('pullMsgs')];
  botones.forEach((b) => (b.disabled = true));
  const enCurso = {
    SEND_CURRENT_LEAD: 'Enviando…',
    RELINK_CURRENT_LEAD: 'Re-vinculando…',
    UPDATE_CURRENT_LEAD: 'Actualizando datos…',
    PUSH_CURRENT_COMMENTS: 'Enviando mensajes…',
    PULL_CURRENT_COMMENTS: 'Trayendo mensajes…',
  };
  setManualStatus(enCurso[type] || 'Trabajando…');
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type });
    const comentarios = r && r.commentsPosted ? ` · ${r.commentsPosted} comentario(s) enviados` : '';
    if (type === 'RELINK_CURRENT_LEAD') {
      if (r && r.ok) {
        renderManual(tabId, leadId, r.destId);
        setManualStatus(`✔ Re-vinculado — ID remoto ${r.destId}`, true);
      } else {
        setManualStatus(`✖ ${(r && r.error) || 'No se pudo re-vincular'}`, false);
      }
    } else if (type === 'UPDATE_CURRENT_LEAD') {
      if (r && r.ok) {
        setManualStatus(`✔ Datos actualizados en odoo.com (ID remoto ${r.destId || remoteId})`, true);
      } else {
        setManualStatus(`✖ ${(r && r.error) || 'No se pudo actualizar'}`, false);
      }
    } else if (type === 'PUSH_CURRENT_COMMENTS') {
      if (r && r.ok) {
        setManualStatus(r.posted ? `✔ ${r.posted} mensaje(s) enviados al portal` : 'Nada nuevo que enviar', true);
      } else {
        setManualStatus(`✖ ${(r && r.error) || 'No se pudieron enviar los mensajes'}`, false);
      }
    } else if (type === 'PULL_CURRENT_COMMENTS') {
      if (r && r.ok) {
        setManualStatus(r.pulled ? `✔ ${r.pulled} mensaje(s) traídos como notas` : 'Nada nuevo que traer', true);
      } else {
        setManualStatus(`✖ ${(r && r.error) || 'No se pudieron traer los mensajes'}`, false);
      }
    } else if (r && r.ok && Array.isArray(r.created) && r.created.length) {
      const d = r.created[0];
      renderManual(tabId, leadId, d.destId || 0); // pasar a modo "actualizar"
      setManualStatus(
        d.existing
          ? `Ya existía en odoo.com — vinculado con ID remoto ${d.destId} (nota añadida al lead)${comentarios}`
          : `✔ Enviado — ID remoto ${d.destId || 'desconocido'} (nota añadida al lead)${comentarios}`,
        true
      );
    } else if (r && r.ok && Array.isArray(r.already) && r.already.length) {
      const d = r.already[0];
      renderManual(tabId, leadId, d.destId || 0);
      setManualStatus(`Ya estaba sincronizado — ID remoto ${d.destId || 'desconocido'}`, true);
    } else {
      setManualStatus(`✖ ${(r && r.error) || 'No se pudo enviar'}`, false);
    }
  } catch (err) {
    setManualStatus(`✖ ${err.message || err}`, false);
  }
  botones.forEach((b) => (b.disabled = false));
  render(); // refrescar la lista de envíos
}

$('options').addEventListener('click', () => chrome.runtime.openOptionsPage());

render();
renderSession();
initManual();
