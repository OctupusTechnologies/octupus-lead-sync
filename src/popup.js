/**
 * Octupus Lead Sync — popup
 *
 * Estado de la sesión de odoo.com, acciones sobre el lead abierto en la
 * pestaña activa (vía bridge.js), listado de leads activos del CRM (vía
 * service worker) e historial de envíos. Requiere shared.js (popup.html).
 */
'use strict';

const { MSG, STORAGE, errMsg, readStorage } = globalThis.OctupusShared;

const $ = (id) => document.getElementById(id);

/** Crea un elemento con clase y texto opcionales. */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleString('es-ES', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

// ───────────────────────── Historial ─────────────────────────

/** Texto de una entrada correcta del historial según la acción registrada. */
const LOG_OK_TEXT = Object.freeze({
  create: (e) => `✔ creado #${e.destId || '?'}`,
  update: (e) => `✔ actualizado #${e.destId || '?'}`,
  link: (e) => `✔ vinculado #${e.destId || '?'} (ya existía)`,
  comments: (e) => `✔ ${e.count || '?'} mensaje(s) → #${e.destId || '?'}`,
  pull: (e) => `✔ ${e.count || '?'} mensaje(s) traídos de #${e.destId || '?'}`,
});

function describeLogEntry(entry) {
  if (!entry.ok) return `✖ ${entry.error || 'error'}`;
  return (LOG_OK_TEXT[entry.action] || LOG_OK_TEXT.create)(entry);
}

async function renderLog() {
  const log = await readStorage(STORAGE.LOG, []);

  const list = $('log');
  list.replaceChildren();
  $('empty').hidden = log.length > 0;

  for (const entry of log) {
    const li = el('li', entry.ok ? 'ok' : 'error');
    const meta = el('div', 'meta');
    meta.append(`${fmtDate(entry.at)} · `, el('span', 'status', describeLogEntry(entry)));
    if (entry.ok && entry.warn) meta.append(` · ⚠ ${entry.warn}`);
    li.append(el('div', 'name', entry.name || '(sin nombre)'), meta);
    list.append(li);
  }
}

// ───────────────────────── Sesión ─────────────────────────

async function renderSession() {
  const node = $('session');
  try {
    const res = await chrome.runtime.sendMessage({ type: MSG.CHECK_SESSION });
    if (res && res.ok) {
      node.textContent = `odoo.com: conectado como ${res.username || `uid ${res.uid}`}`;
      node.className = 'session ok';
    } else {
      node.textContent = `odoo.com: ${(res && res.error) || 'sin sesión'}`;
      node.className = 'session error';
    }
  } catch (err) {
    node.textContent = `odoo.com: ${errMsg(err)}`;
    node.className = 'session error';
  }
}

// ───────────────────────── Acciones sobre el lead abierto ─────────────────────────

function setManualStatus(text, ok) {
  const node = $('manualStatus');
  node.textContent = text;
  node.className = 'manual-status' + (ok === true ? ' ok' : ok === false ? ' error' : '');
}

/**
 * Muestra las acciones manuales si la pestaña activa tiene un lead abierto.
 * Según el chatter del lead: sin nota → "Enviar"; con nota (ya sincronizado)
 * → actualizar contacto / enviar / traer mensajes; nota sin ID → re-vincular.
 */
async function initManual() {
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {
    return;
  }
  if (!tab || !tab.id) return;

  let res;
  try {
    res = await chrome.tabs.sendMessage(tab.id, { type: MSG.GET_CURRENT_LEAD });
  } catch {
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
    btn.onclick = () => runManualAction(tabId, leadId, MSG.RELINK_CURRENT_LEAD, null);
    return;
  }

  if (remoteId) {
    btn.textContent = `📇 Actualizar contacto del lead #${leadId}`;
    btn.title = 'Vuelve a enviar los datos de contacto del lead a la oportunidad del portal';
    setManualStatus(`Ya sincronizado — ID remoto ${remoteId}`, true);
    btn.onclick = () => runManualAction(tabId, leadId, MSG.UPDATE_CURRENT_LEAD, remoteId);
    push.hidden = false;
    push.onclick = () => runManualAction(tabId, leadId, MSG.PUSH_CURRENT_COMMENTS, remoteId);
    pull.hidden = false;
    pull.onclick = () => runManualAction(tabId, leadId, MSG.PULL_CURRENT_COMMENTS, remoteId);
    return;
  }

  btn.textContent = `🐙 Enviar lead #${leadId} a odoo.com`;
  btn.title = 'Crea la oportunidad en el portal, rellena el contacto, deja nota y sube los mensajes';
  setManualStatus('');
  btn.onclick = () => runManualAction(tabId, leadId, MSG.SEND_CURRENT_LEAD, null);
}

function failure(r, fallback) {
  return { ok: false, text: `✖ ${(r && r.error) || fallback}` };
}

/**
 * Por cada acción: texto de progreso y cómo describir la respuesta del bridge.
 * `describe(r, remoteId)` devuelve {ok, text, remoteId?}; si trae remoteId,
 * el panel se vuelve a pintar en el nuevo estado antes de mostrar el texto.
 */
const MANUAL_ACTIONS = Object.freeze({
  [MSG.SEND_CURRENT_LEAD]: {
    progress: 'Enviando…',
    describe(r) {
      const comments = r && r.commentsPosted ? ` · ${r.commentsPosted} comentario(s) enviados` : '';
      if (r && r.ok && Array.isArray(r.created) && r.created.length) {
        const d = r.created[0];
        return {
          ok: true,
          remoteId: d.destId || 0,
          text: d.existing
            ? `Ya existía en odoo.com — vinculado con ID remoto ${d.destId} (nota añadida al lead)${comments}`
            : `✔ Enviado — ID remoto ${d.destId || 'desconocido'} (nota añadida al lead)${comments}`,
        };
      }
      if (r && r.ok && Array.isArray(r.already) && r.already.length) {
        const d = r.already[0];
        return {
          ok: true,
          remoteId: d.destId || 0,
          text: `Ya estaba sincronizado — ID remoto ${d.destId || 'desconocido'}`,
        };
      }
      return failure(r, 'No se pudo enviar');
    },
  },
  [MSG.RELINK_CURRENT_LEAD]: {
    progress: 'Re-vinculando…',
    describe: (r) =>
      r && r.ok
        ? { ok: true, remoteId: r.destId, text: `✔ Re-vinculado — ID remoto ${r.destId}` }
        : failure(r, 'No se pudo re-vincular'),
  },
  [MSG.UPDATE_CURRENT_LEAD]: {
    progress: 'Actualizando datos…',
    describe: (r, remoteId) =>
      r && r.ok
        ? { ok: true, text: `✔ Datos actualizados en odoo.com (ID remoto ${r.destId || remoteId})` }
        : failure(r, 'No se pudo actualizar'),
  },
  [MSG.PUSH_CURRENT_COMMENTS]: {
    progress: 'Enviando mensajes…',
    describe: (r) =>
      r && r.ok
        ? {
            ok: true,
            text: r.posted ? `✔ ${r.posted} mensaje(s) enviados al portal` : 'Nada nuevo que enviar',
          }
        : failure(r, 'No se pudieron enviar los mensajes'),
  },
  [MSG.PULL_CURRENT_COMMENTS]: {
    progress: 'Trayendo mensajes…',
    describe: (r) =>
      r && r.ok
        ? {
            ok: true,
            text: r.pulled ? `✔ ${r.pulled} mensaje(s) traídos como notas` : 'Nada nuevo que traer',
          }
        : failure(r, 'No se pudieron traer los mensajes'),
  },
});

async function runManualAction(tabId, leadId, type, remoteId) {
  const spec = MANUAL_ACTIONS[type];
  const buttons = [$('sendLead'), $('pushMsgs'), $('pullMsgs')];
  for (const button of buttons) button.disabled = true;
  setManualStatus(spec.progress);
  try {
    const result = spec.describe(await chrome.tabs.sendMessage(tabId, { type }), remoteId);
    if (result.remoteId !== undefined) renderManual(tabId, leadId, result.remoteId);
    setManualStatus(result.text, result.ok);
  } catch (err) {
    setManualStatus(`✖ ${errMsg(err)}`, false);
  }
  for (const button of buttons) button.disabled = false;
  renderLog(); // refrescar el historial
}

// ───────────────────────── Leads activos del CRM ─────────────────────────

/** Lista los leads activos del CRM; clic abre el lead en una pestaña. */
async function renderLeads() {
  const status = $('leadsStatus');
  const list = $('leadsList');
  list.replaceChildren();
  status.hidden = false;
  status.textContent = 'Cargando leads…';
  try {
    const r = await chrome.runtime.sendMessage({ type: MSG.LIST_LEADS });
    if (!r || !r.ok) {
      status.textContent = `✖ ${(r && r.error) || 'No se pudieron cargar los leads'}`;
      return;
    }
    if (!r.leads.length) {
      status.textContent = 'Sin leads activos en el CRM';
      return;
    }
    status.hidden = true;
    for (const lead of r.leads) list.append(renderLeadItem(lead, r.crmUrl));
  } catch (err) {
    status.textContent = `✖ ${errMsg(err)}`;
  }
}

function renderLeadItem(lead, crmUrl) {
  const li = el('li');
  li.title = `${lead.name}${lead.contact ? ` — ${lead.contact}` : ''} · clic para abrir en el CRM`;
  li.append(el('span', 'lead-name', lead.name || `lead #${lead.id}`));
  if (lead.stage) li.append(el('span', 'tag', lead.stage));
  if (lead.synced) {
    const badge = el('span', 'tag sync', `🐙 #${lead.synced}`);
    badge.title = 'Sincronizado con el portal de odoo.com';
    li.append(badge);
  }
  li.onclick = () => chrome.tabs.create({ url: `${crmUrl}/odoo/crm/${lead.id}` });
  return li;
}

// ───────────────────────── Arranque ─────────────────────────

$('refreshLeads').addEventListener('click', renderLeads);
$('options').addEventListener('click', () => chrome.runtime.openOptionsPage());

renderLog();
renderSession();
initManual();
renderLeads();
