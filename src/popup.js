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
            ? `✔ ${entry.count || '?'} comentario(s) → #${entry.destId || '?'}`
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

  renderManual(tab.id, res.leadId, res.remoteId);
}

function renderManual(tabId, leadId, remoteId) {
  $('manual').hidden = false;
  const btn = $('sendLead');

  if (remoteId === 0) {
    // Hay nota en el chatter pero sin id parseable: sincronizado, sin acciones
    btn.hidden = true;
    setManualStatus(`Lead #${leadId} ya sincronizado (nota en el chatter sin ID remoto)`, true);
    return;
  }

  btn.hidden = false;
  if (remoteId) {
    btn.textContent = `Actualizar datos del lead #${leadId} en odoo.com`;
    setManualStatus(`Ya sincronizado — ID remoto ${remoteId}`, true);
    btn.onclick = () => runManualAction(tabId, leadId, 'UPDATE_CURRENT_LEAD', remoteId);
  } else {
    btn.textContent = `Enviar lead #${leadId} a odoo.com`;
    setManualStatus('');
    btn.onclick = () => runManualAction(tabId, leadId, 'SEND_CURRENT_LEAD', null);
  }
}

async function runManualAction(tabId, leadId, type, remoteId) {
  const btn = $('sendLead');
  btn.disabled = true;
  setManualStatus(type === 'SEND_CURRENT_LEAD' ? 'Enviando…' : 'Actualizando…');
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type });
    const comentarios = r && r.commentsPosted ? ` · ${r.commentsPosted} comentario(s) enviados` : '';
    if (type === 'UPDATE_CURRENT_LEAD') {
      if (r && r.ok) {
        setManualStatus(`✔ Datos actualizados en odoo.com (ID remoto ${r.destId || remoteId})${comentarios}`, true);
      } else {
        setManualStatus(`✖ ${(r && r.error) || 'No se pudo actualizar'}`, false);
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
  btn.disabled = false;
  render(); // refrescar la lista de envíos
}

$('options').addEventListener('click', () => chrome.runtime.openOptionsPage());

render();
renderSession();
initManual();
