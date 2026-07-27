/**
 * Octupus Lead Sync — bridge (ISOLATED world)
 *
 * Sincronización 100% manual:
 * - Widget flotante en el backend de Odoo: muestra el estado del lead abierto
 *   (sincronizado o no) y permite enviarlo/actualizarlo con un clic.
 * - El popup de la extensión ofrece las mismas acciones.
 * - Tras cada envío correcto deja una nota interna en el chatter del lead de
 *   origen con el ID remoto, usando la sesión Odoo del propio usuario.
 */
'use strict';

const OCTUPUS_LEAD_FIELDS = [
  'name',
  'type',
  'contact_name',
  'partner_name',
  'email_from',
  'phone',
  'mobile',
  'website',
  'function',
  'street',
  'street2',
  'city',
  'zip',
  'expected_revenue',
  'probability',
  'priority',
  'description',
  'country_id',
  'state_id',
  'user_id',
  'team_id',
];

// --- Peticiones desde el popup ---
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'GET_CURRENT_LEAD') {
    (async () => {
      const leadId = await octupusCurrentLeadId();
      if (!leadId) return { leadId: null };
      try {
        return { leadId, remoteId: await octupusFindRemoteId(leadId) };
      } catch (e) {
        return { leadId, remoteId: null, readError: true };
      }
    })()
      .then(sendResponse)
      .catch(() => sendResponse({ leadId: null }));
    return true;
  }
  if (msg && msg.type === 'SEND_CURRENT_LEAD') {
    (async () => {
      const leadId = await octupusCurrentLeadId();
      if (!leadId) return { ok: false, error: 'No hay ningún lead abierto en esta pestaña' };
      return octupusSyncIds([leadId]);
    })()
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true; // respuesta asíncrona
  }
  if (msg && msg.type === 'UPDATE_CURRENT_LEAD') {
    octupusRunOnSynced((leadId, remoteId) => octupusUpdateData(leadId, remoteId))
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }
  if (msg && msg.type === 'PUSH_CURRENT_COMMENTS') {
    octupusRunOnSynced((leadId, remoteId) => octupusPushComments(leadId, remoteId))
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }
  if (msg && msg.type === 'PULL_CURRENT_COMMENTS') {
    octupusRunOnSynced((leadId, remoteId) => octupusPullComments(leadId, remoteId))
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }
  if (msg && msg.type === 'RELINK_CURRENT_LEAD') {
    (async () => {
      const leadId = await octupusCurrentLeadId();
      if (!leadId) return { ok: false, error: 'No hay ningún lead abierto en esta pestaña' };
      return octupusRelinkLead(leadId);
    })()
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }
  return false;
});

/** Resuelve lead abierto + ID remoto y ejecuta la acción, con errores claros. */
async function octupusRunOnSynced(accion) {
  const leadId = await octupusCurrentLeadId();
  if (!leadId) return { ok: false, error: 'No hay ningún lead abierto en esta pestaña' };
  let remoteId;
  try {
    remoteId = await octupusFindRemoteId(leadId);
  } catch (err) {
    return { ok: false, error: `No se pudo leer el chatter del lead: ${(err && err.message) || err}` };
  }
  if (remoteId === null) {
    return { ok: false, error: 'Este lead aún no está sincronizado (no hay nota 🐙 en el chatter)' };
  }
  if (!remoteId) {
    return { ok: false, error: 'La nota del chatter no contiene el ID remoto: usa Re-vincular' };
  }
  return accion(leadId, remoteId);
}

/** Actualiza SOLO los datos de contacto de la oportunidad remota. */
async function octupusUpdateData(leadId, remoteId) {
  const leads = await octupusReadLeads([leadId]);
  if (!leads.length) return { ok: false, error: 'No se pudo leer el lead' };
  const result = await chrome.runtime.sendMessage({
    type: 'UPDATE_LEAD',
    origin: window.location.origin,
    lead: leads[0],
    destId: remoteId,
  });
  if (result && result.ok) result.destId = result.destId || remoteId;
  return result;
}

/** Empuja los mensajes del lead hacia la oportunidad remota. */
async function octupusPushComments(leadId, remoteId) {
  const nombre = await octupusLeadName(leadId);
  const r = await octupusSyncComments(leadId, remoteId, nombre);
  if (!r || r.ok === false) {
    return { ok: false, error: (r && r.error) || 'No se pudieron enviar los mensajes', posted: 0 };
  }
  return { ok: true, posted: r.posted || 0, destId: remoteId };
}

/**
 * Trae los mensajes del chatter remoto como notas internas del lead.
 * Anti-eco y anti-duplicados:
 *  - Se ignoran los mensajes remotos con [src#…] o "Octupus Lead Sync"
 *    (nuestros propios envíos y notas) → nunca traemos lo nuestro.
 *  - Cada nota traída lleva [odoo#<id remoto>] y el texto
 *    "vía Octupus Lead Sync" → el filtro de empuje la excluye (sin eco
 *    inverso) y el marcador evita traerla dos veces.
 *  - Dedupe en dos capas: marcadores [odoo#id] del chatter del lead
 *    (compartido) + registro local.
 */
async function octupusPullComments(leadId, remoteId) {
  const resp = await chrome.runtime.sendMessage({ type: 'PULL_REMOTE_MESSAGES', destId: remoteId });
  if (!resp || !resp.ok) {
    return { ok: false, error: (resp && resp.error) || 'No se pudo leer el chatter remoto', pulled: 0 };
  }

  const existentes = await octupusFindPulledIds(leadId); // lanza si el chatter no se puede leer
  const { pulled = {} } = await chrome.storage.local.get('pulled');
  const key = `${window.location.origin}#${leadId}`;
  const done = new Set([...(pulled[key] || []), ...existentes]);

  let count = 0;
  for (const m of resp.messages || []) {
    if (!m || !m.id || done.has(m.id)) continue;
    let text = octupusHtmlToText(m.body);
    if (!text) continue;
    if (text.includes('[src#') || text.includes('Octupus Lead Sync')) continue;
    if (m.author === 'OdooBot') continue;
    if (text.length > 4000) text = `${text.slice(0, 4000)}\n… [mensaje recortado]`;
    const body = `📥 ${m.author}${m.date ? ` (${m.date})` : ''} en odoo.com vía Octupus Lead Sync [odoo#${m.id}]:\n${text}`;
    try {
      await octupusPostNote(leadId, body, body);
      done.add(m.id);
      count++;
    } catch (err) {
      pulled[key] = [...done];
      await chrome.storage.local.set({ pulled });
      return { ok: false, error: `Nota no guardada: ${(err && err.message) || err}`, pulled: count };
    }
  }

  pulled[key] = [...done];
  await chrome.storage.local.set({ pulled });
  if (count) {
    chrome.runtime
      .sendMessage({
        type: 'LOG',
        entry: {
          ok: true,
          name: await octupusLeadName(leadId),
          srcId: leadId,
          destId: remoteId,
          origin: window.location.origin,
          action: 'pull',
          count,
        },
      })
      .catch(() => {});
  }
  return { ok: true, pulled: count };
}

/** Ids remotos ya traídos, leyendo los marcadores [odoo#id] del chatter del lead. */
async function octupusFindPulledIds(leadId) {
  const msgs = await octupusCallKw('mail.message', 'search_read', [], {
    domain: [
      ['model', '=', 'crm.lead'],
      ['res_id', '=', leadId],
      ['body', 'like', 'odoo#'],
    ],
    fields: ['body'],
    order: 'id desc',
    limit: 100,
  });
  const ids = [];
  for (const m of msgs || []) {
    const re = /\[odoo#(\d+)\]/g;
    let match;
    while ((match = re.exec(String(m.body || ''))) !== null) ids.push(parseInt(match[1], 10));
  }
  return ids;
}

async function octupusLeadName(leadId) {
  try {
    const rows = await octupusCallKw('crm.lead', 'read', [[leadId], ['name']]);
    return (rows && rows[0] && rows[0].name) || `lead #${leadId}`;
  } catch (e) {
    return `lead #${leadId}`;
  }
}

/**
 * Vía de escape: para leads con nota sin ID (o tras borrar la oportunidad
 * remota), re-busca en el portal por título y reescribe la nota con el ID.
 * Nunca crea nada nuevo.
 */
async function octupusRelinkLead(leadId) {
  const leads = await octupusReadLeads([leadId]);
  if (!leads.length) return { ok: false, error: 'No se pudo leer el lead' };
  const lead = leads[0];

  const found = await chrome.runtime.sendMessage({
    type: 'FIND_REMOTE',
    title: lead.name,
    email: lead.email_from,
  });
  if (!found || !found.ok) {
    return { ok: false, error: (found && found.error) || 'Error buscando en el portal' };
  }
  if (!found.destId) {
    return {
      ok: false,
      error:
        'No hay en el portal ninguna oportunidad con este título. Si se borró, ' +
        'elimina la nota 🐙 del chatter para poder reenviar el lead.',
    };
  }
  const claimant = await octupusFindClaimant(found.destId);
  if (claimant && claimant !== leadId) {
    return { ok: false, error: `La oportunidad #${found.destId} ya está vinculada al lead #${claimant}` };
  }
  await chrome.runtime.sendMessage({
    type: 'MARK_LINKED',
    origin: window.location.origin,
    leadId,
    destId: found.destId,
    name: lead.name,
  });
  await octupusPostNotes([{ srcId: leadId, destId: found.destId, existing: true }], found.portalUrl);
  return { ok: true, destId: found.destId };
}

/**
 * El chatter es la fuente de verdad de sincronización: busca la nota
 * "Octupus Lead Sync" en el lead y extrae el id remoto de su enlace
 * …/my/opportunity/<id>. Devuelve el id, 0 si hay nota sin id parseable,
 * o null si NO hay nota. Si el chatter no se puede leer, LANZA el error:
 * "no sincronizado" y "no lo sé" nunca deben confundirse (evita duplicados).
 */
async function octupusFindRemoteId(leadId) {
  const msgs = await octupusCallKw('mail.message', 'search_read', [], {
    domain: [
      ['model', '=', 'crm.lead'],
      ['res_id', '=', leadId],
      ['body', 'like', 'Octupus Lead Sync'],
    ],
    fields: ['body'],
    order: 'id desc',
    limit: 5,
  });
  for (const msg of msgs || []) {
    const m = String(msg.body || '').match(/my\/opportunity\/(\d+)/);
    if (m) return parseInt(m[1], 10);
  }
  return msgs && msgs.length ? 0 : null;
}

/**
 * ¿Qué lead reclama ya esta oportunidad remota? Busca notas 🐙 que enlacen a
 * my/opportunity/<destId> en cualquier lead. Devuelve el res_id del lead que
 * la reclama, o null (también si la comprobación falla: vincular no destruye).
 */
async function octupusFindClaimant(destId) {
  try {
    const msgs = await octupusCallKw('mail.message', 'search_read', [], {
      domain: [
        ['model', '=', 'crm.lead'],
        ['body', 'like', `my/opportunity/${destId}`],
      ],
      fields: ['res_id', 'body'],
      order: 'id desc',
      limit: 10,
    });
    for (const m of msgs || []) {
      // 'like' es substring: verificar coincidencia exacta del id
      const match = String(m.body || '').match(/my\/opportunity\/(\d+)/);
      if (match && parseInt(match[1], 10) === destId) return m.res_id;
    }
    return null;
  } catch (e) {
    return null;
  }
}

const octupusActionModelCache = new Map();

/** Devuelve el id del crm.lead abierto en la URL actual, o null. */
async function octupusCurrentLeadId() {
  // Odoo <=16: /web#id=123&model=crm.lead&view_type=form...
  const hashParams = new URLSearchParams(window.location.hash.slice(1));
  if (hashParams.get('model') === 'crm.lead') {
    const id = parseInt(hashParams.get('id'), 10);
    if (Number.isInteger(id)) return id;
  }
  // Odoo 17+: /odoo/crm/123
  let m = window.location.pathname.match(/\/odoo\/crm(?:\.lead)?\/(\d+)(?:\/|$)/);
  if (m) return parseInt(m[1], 10);
  // Odoo 17+ desde otros menús o smart buttons: /odoo/action-123/456
  m = window.location.pathname.match(/\/odoo\/(?:[^/]+\/)*action-(\d+)\/(\d+)(?:\/|$)/);
  if (m) {
    const actionId = parseInt(m[1], 10);
    const recordId = parseInt(m[2], 10);
    let model = octupusActionModelCache.get(actionId);
    if (model === undefined) {
      try {
        const action = await octupusJsonRpc('/web/action/load', { action_id: actionId });
        model = (action && action.res_model) || null;
      } catch (e) {
        model = null;
      }
      octupusActionModelCache.set(actionId, model);
    }
    if (model === 'crm.lead') return recordId;
  }
  return null;
}

/**
 * Orquestador del envío:
 *  1. Chatter del lead (fuente de verdad): con nota → no se reenvía. Si el
 *     chatter no se puede leer, se ABORTA (nunca crear "a ciegas").
 *  2. Búsqueda por título en el portal: si existe y ningún otro lead la
 *     reclama → vincular sin duplicar. Si la reclama otro lead, es otro
 *     negocio con el mismo título → se crea una nueva.
 *  3. El service worker crea la oportunidad y rellena el contacto.
 *  4. Nota 🐙 (solo con ID remoto real) + sincronización de comentarios.
 */
async function octupusSyncIds(ids) {
  const leads = await octupusReadLeads(ids);
  if (!leads.length) {
    return { ok: false, error: 'No se pudo leer el lead (¿existe todavía?)', created: [], already: [] };
  }

  // 1. El chatter manda
  const already = [];
  const toProcess = [];
  for (const lead of leads) {
    let remoteId;
    try {
      remoteId = await octupusFindRemoteId(lead.id);
    } catch (err) {
      return {
        ok: false,
        error: `No se pudo leer el chatter del lead #${lead.id} (${(err && err.message) || err}). Envío cancelado para evitar duplicados.`,
        created: [],
        already: [],
      };
    }
    if (remoteId !== null) already.push({ srcId: lead.id, destId: remoteId || null });
    else toProcess.push(lead);
  }
  if (!toProcess.length) return { ok: true, created: [], already };

  // 2. Vincular contra el portal si procede
  const created = [];
  const toCreate = [];
  let portalUrl = null;
  for (const lead of toProcess) {
    const found = await chrome.runtime.sendMessage({
      type: 'FIND_REMOTE',
      title: lead.name,
      email: lead.email_from,
    });
    if (found && found.portalUrl) portalUrl = found.portalUrl;
    const candidateId = found && found.ok ? found.destId : null;
    if (candidateId) {
      const claimant = await octupusFindClaimant(candidateId);
      if (!claimant || claimant === lead.id) {
        await chrome.runtime.sendMessage({
          type: 'MARK_LINKED',
          origin: window.location.origin,
          leadId: lead.id,
          destId: candidateId,
          name: lead.name,
        });
        created.push({ srcId: lead.id, destId: candidateId, existing: true });
        continue;
      }
      // Reclamada por otro lead → mismo título, negocio distinto: crear nueva
    }
    toCreate.push(lead);
  }

  // 3. Crear las restantes
  let alreadyBg = [];
  let errorBg = null;
  if (toCreate.length) {
    const r = await chrome.runtime.sendMessage({
      type: 'SYNC_LEADS',
      origin: window.location.origin,
      leads: toCreate,
    });
    if (r && r.ok) {
      created.push(...(r.created || []));
      // Solo restaurar notas de entradas locales con ID remoto real
      alreadyBg = (r.already || []).filter((a) => a.destId);
      portalUrl = r.portalUrl || portalUrl;
    } else {
      errorBg = (r && r.error) || 'Error en el envío';
    }
  }

  // 4. Notas (nunca sin ID remoto) y comentarios
  const paraNota = [...created, ...alreadyBg.map((a) => ({ ...a, existing: true }))].filter((i) => i.destId);
  if (paraNota.length) await octupusPostNotes(paraNota, portalUrl);

  let commentsPosted = 0;
  const byId = Object.fromEntries(leads.map((l) => [l.id, l]));
  for (const item of created) {
    if (!item.destId) continue;
    const lead = byId[item.srcId];
    const cr = await octupusSyncComments(item.srcId, item.destId, lead ? lead.name : '');
    commentsPosted += (cr && cr.posted) || 0;
  }

  if (errorBg && !created.length) {
    return { ok: false, error: errorBg, created, already: [...already, ...alreadyBg] };
  }
  return { ok: true, created, already: [...already, ...alreadyBg], commentsPosted };
}

/** JSON-RPC same-origin con la sesión del usuario, a cualquier ruta. */
async function octupusJsonRpc(path, params) {
  const resp = await fetch(`${window.location.origin}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params }),
  });
  const json = await resp.json();
  if (json.error) {
    const msg = (json.error.data && json.error.data.message) || json.error.message;
    throw new Error(msg || `Error RPC en ${path}`);
  }
  return json.result;
}

function octupusCallKw(model, method, args, kwargs) {
  return octupusJsonRpc('/web/dataset/call_kw', {
    model,
    method,
    args,
    kwargs: { context: {}, ...(kwargs || {}) },
  });
}

async function octupusReadLeads(ids) {
  // search_read en lugar de read: tolera leads eliminados por fusión (merge)
  const result = await octupusCallKw('crm.lead', 'search_read', [], {
    domain: [['id', 'in', ids]],
    fields: OCTUPUS_LEAD_FIELDS,
  });
  return octupusEnrichLeads(result || []);
}

/**
 * Añade los códigos ISO de país/provincia leídos del origen: los ids de
 * res.country/res.country.state no coinciden entre bases de datos, así que
 * el service worker los re-resuelve en odoo.com por código.
 */
async function octupusEnrichLeads(leads) {
  const countryIds = [...new Set(leads.map((l) => l.country_id && l.country_id[0]).filter(Boolean))];
  const stateIds = [...new Set(leads.map((l) => l.state_id && l.state_id[0]).filter(Boolean))];
  try {
    if (countryIds.length) {
      const rows = await octupusCallKw('res.country', 'read', [countryIds, ['code']]);
      const codeById = Object.fromEntries(rows.map((r) => [r.id, r.code]));
      leads.forEach((l) => {
        if (l.country_id) l.country_code = codeById[l.country_id[0]] || null;
      });
    }
    if (stateIds.length) {
      const rows = await octupusCallKw('res.country.state', 'read', [stateIds, ['code', 'name']]);
      const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
      leads.forEach((l) => {
        const row = l.state_id && byId[l.state_id[0]];
        if (row) {
          l.state_code = row.code || null;
          l.state_name = row.name || null;
        }
      });
    }
  } catch (e) {
    console.warn('[Octupus Lead Sync] No se pudieron leer país/provincia del origen:', e);
  }
  return leads;
}

/**
 * Deja una nota interna en el chatter de cada lead de origen con el id remoto.
 * NUNCA publica notas sin ID: una nota sin URL "envenena" la detección
 * (el lead quedaría como sincronizado sin poder actualizarse).
 */
async function octupusPostNotes(created, portalUrl) {
  const base = (portalUrl || 'https://www.odoo.com').replace(/\/+$/, '');
  for (const item of created) {
    if (!item || !item.srcId || !item.destId) continue;
    const accion = item.existing
      ? 'ya existía en el portal de partners de odoo.com; vinculado sin duplicar'
      : 'enviado al portal de partners de odoo.com';
    const remoteUrl = `${base}/my/opportunity/${item.destId}`;
    const bodyHtml =
      `🐙 <b>Octupus Lead Sync</b>: ${accion}.<br/>` +
      `ID remoto: <b>${item.destId}</b> — <a href="${remoteUrl}" target="_blank">ver en el portal</a>`;
    const bodyText = `🐙 Octupus Lead Sync: ${accion}. ID remoto: ${item.destId} — ${remoteUrl}`;
    try {
      await octupusPostNote(item.srcId, bodyHtml, bodyText);
    } catch (err) {
      console.warn('[Octupus Lead Sync] No se pudo dejar la nota en el lead', item.srcId, err);
      // Que el fallo sea visible en el popup, no solo en la consola
      try {
        await chrome.runtime.sendMessage({
          type: 'LOG',
          entry: {
            ok: false,
            name: `Nota no guardada en lead #${item.srcId}`,
            srcId: item.srcId,
            destId: item.destId,
            origin: window.location.origin,
            error: String((err && err.message) || err),
          },
        });
      } catch (e) {
        /* sin log remoto */
      }
    }
  }
}

/** Convierte el body HTML de un mensaje de Odoo a texto plano legible. */
function octupusHtmlToText(html) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  // Fuera la cadena citada de los emails (Odoo la marca con data-o-mail-quote)
  // y los preheaders ocultos
  doc.querySelectorAll('[data-o-mail-quote], [style*="display:none"]').forEach((el) => el.remove());
  doc.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
  doc.querySelectorAll('p, div, li').forEach((el) => el.append('\n'));
  return (doc.body.textContent || '')
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Lee los mensajes del chatter del lead escritos por personas
 * (message_type 'comment'): los públicos (mail.mt_comment) y, si la opción
 * syncNotes está activa (por defecto sí), también las notas internas
 * (mail.mt_note). Las notas de la propia extensión se excluyen siempre.
 */
async function octupusReadComments(leadId) {
  const { config = {} } = await chrome.storage.local.get('config');
  const incluirNotas = config.syncNotes !== false;

  const subtypeIds = [];
  const commentSubtypeId = await octupusGetSubtypeId('mail.mt_comment');
  if (commentSubtypeId) subtypeIds.push(commentSubtypeId);
  let noteSubtypeId = null;
  if (incluirNotas) {
    noteSubtypeId = await octupusGetSubtypeId('mail.mt_note');
    if (noteSubtypeId) subtypeIds.push(noteSubtypeId);
  }
  if (!subtypeIds.length) {
    console.warn('[Octupus Lead Sync] No se pudieron resolver los subtipos de mensaje: comentarios omitidos');
    return [];
  }

  const msgs = await octupusCallKw('mail.message', 'search_read', [], {
    domain: [
      ['model', '=', 'crm.lead'],
      ['res_id', '=', leadId],
      ['message_type', '=', 'comment'],
      ['subtype_id', 'in', subtypeIds],
    ],
    fields: ['id', 'body', 'author_id', 'date', 'subtype_id'],
    order: 'id asc',
    limit: 50,
  });
  return (msgs || [])
    .map((m) => {
      const text = octupusHtmlToText(m.body);
      if (!text || text.includes('Octupus Lead Sync')) return null;
      const esNota = noteSubtypeId && m.subtype_id && m.subtype_id[0] === noteSubtypeId;
      const author = (m.author_id && m.author_id[1]) || 'Desconocido';
      return {
        id: m.id,
        body: `${esNota ? '📝' : '💬'} ${author} (${m.date}) vía Octupus Lead Sync [src#${m.id}]:\n${text}`,
      };
    })
    .filter(Boolean);
}

/** Envía al service worker los comentarios del lead para publicarlos en el portal. */
async function octupusSyncComments(leadId, destId, leadName) {
  if (!destId) return { ok: false, posted: 0 };
  try {
    const comments = await octupusReadComments(leadId);
    if (!comments.length) return { ok: true, posted: 0 };
    return await chrome.runtime.sendMessage({
      type: 'SYNC_COMMENTS',
      origin: window.location.origin,
      leadId,
      destId,
      leadName: leadName || '',
      comments,
    });
  } catch (e) {
    console.warn('[Octupus Lead Sync] No se pudieron sincronizar los comentarios del lead', leadId, e);
    return { ok: false, posted: 0 };
  }
}

const octupusSubtypeCache = {};

/** Resuelve (y cachea) el id de un subtipo de mensaje por xmlid. */
async function octupusGetSubtypeId(xmlid) {
  if (xmlid in octupusSubtypeCache) return octupusSubtypeCache[xmlid];
  try {
    const [module, name] = xmlid.split('.');
    const ref = await octupusCallKw('ir.model.data', 'check_object_reference', [module, name]);
    octupusSubtypeCache[xmlid] = Array.isArray(ref) ? ref[1] : false;
  } catch (e) {
    octupusSubtypeCache[xmlid] = false;
  }
  return octupusSubtypeCache[xmlid];
}

/**
 * Publica la nota interna con tres estrategias, de más a menos fiable:
 *  1) /mail/message/post — el endpoint que usa el propio chatter (Odoo 15+),
 *     con texto plano (el servidor escapa el HTML recibido por RPC).
 *  2) mail.message.create directo — conserva el HTML, pero en Odoo 17/18 la
 *     creación directa puede estar restringida.
 *  3) crm.lead.message_post por call_kw — texto plano, versiones antiguas.
 * Si todo falla, lanza un error con el detalle de cada intento.
 */
async function octupusPostNote(srcId, bodyHtml, bodyText) {
  const intentos = [];

  try {
    await octupusJsonRpc('/mail/message/post', {
      thread_model: 'crm.lead',
      thread_id: srcId,
      post_data: {
        body: bodyText,
        message_type: 'comment',
        subtype_xmlid: 'mail.mt_note',
      },
      context: {},
    });
    return;
  } catch (err) {
    intentos.push(`/mail/message/post: ${err.message || err}`);
  }

  try {
    const subtypeId = await octupusGetSubtypeId('mail.mt_note');
    await octupusCallKw('mail.message', 'create', [
      {
        model: 'crm.lead',
        res_id: srcId,
        body: bodyHtml,
        message_type: 'comment',
        subtype_id: subtypeId || false,
      },
    ]);
    return;
  } catch (err) {
    intentos.push(`mail.message.create: ${err.message || err}`);
  }

  try {
    await octupusCallKw('crm.lead', 'message_post', [[srcId]], {
      body: bodyText,
      message_type: 'comment',
      subtype_xmlid: 'mail.mt_note',
    });
    return;
  } catch (err) {
    intentos.push(`message_post: ${err.message || err}`);
  }

  throw new Error(intentos.join(' | '));
}

// ─────────────────────────────────────────
// Widget flotante en el backend de Odoo
// ─────────────────────────────────────────

let octupusUi = null;
let octupusUiLeadId = null;
let octupusUiBusy = false;
let octupusToastTimer = null;
const octupusRemoteCache = new Map(); // leadId -> remoteId | 0 | null

function octupusBtnCss(bg, color, fontSize) {
  return [
    'border:none',
    'border-radius:999px',
    'padding:10px 16px',
    `font-size:${fontSize}`,
    'font-weight:600',
    'cursor:pointer',
    `background:${bg}`,
    `color:${color}`,
    'box-shadow:0 6px 18px rgba(0,0,0,.28)',
    'display:flex',
    'align-items:center',
    'gap:6px',
  ].join(';');
}

function octupusEnsureUi() {
  if (octupusUi && document.getElementById('octupus-lead-sync-widget')) return octupusUi;

  const wrap = document.createElement('div');
  wrap.id = 'octupus-lead-sync-widget';
  wrap.style.cssText = [
    'position:fixed',
    'bottom:24px',
    'right:24px',
    'z-index:2147483000',
    'display:none',
    'flex-direction:column',
    'align-items:flex-end',
    'gap:8px',
    "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
  ].join(';');

  const toast = document.createElement('div');
  toast.style.cssText =
    'display:none;max-width:300px;background:#1f2430;color:#fff;padding:8px 12px;' +
    'border-radius:10px;font-size:12px;line-height:1.4;box-shadow:0 6px 18px rgba(0,0,0,.28);';

  const mkSecundario = () => {
    const b = document.createElement('button');
    b.type = 'button';
    b.style.cssText = octupusBtnCss('#e8eaf0', '#1f2430', '12px');
    b.style.display = 'none';
    return b;
  };
  const btnData = mkSecundario();
  const btnPush = mkSecundario();
  const btnPull = mkSecundario();

  const main = document.createElement('button');
  main.type = 'button';
  main.style.cssText = octupusBtnCss('#714b67', '#fff', '13px');

  wrap.append(toast, btnData, btnPush, btnPull, main);
  document.documentElement.appendChild(wrap);
  octupusUi = { wrap, main, toast, btnData, btnPush, btnPull };
  return octupusUi;
}

function octupusToast(text, ms = 6000) {
  const ui = octupusEnsureUi();
  ui.toast.textContent = text;
  ui.toast.style.display = 'block';
  clearTimeout(octupusToastTimer);
  if (ms) {
    octupusToastTimer = setTimeout(() => {
      ui.toast.style.display = 'none';
    }, ms);
  }
}

function octupusRenderWidget(leadId, remoteId, loading) {
  const ui = octupusEnsureUi();
  if (!leadId) {
    ui.wrap.style.display = 'none';
    return;
  }
  ui.wrap.style.display = 'flex';
  const { main, btnData, btnPush, btnPull } = ui;
  const secundarios = [btnData, btnPush, btnPull];
  const ocultarSecundarios = () => secundarios.forEach((b) => (b.style.display = 'none'));
  main.disabled = Boolean(loading || octupusUiBusy);
  secundarios.forEach((b) => (b.disabled = main.disabled));

  if (loading) {
    main.textContent = '🐙 Comprobando…';
    main.style.background = '#9aa0ab';
    main.style.color = '#fff';
    main.onclick = null;
    ocultarSecundarios();
  } else if (remoteId === 'error') {
    // No se pudo leer el chatter: NUNCA ofrecer "Enviar" (riesgo de duplicado)
    main.textContent = '🐙 Estado desconocido · reintentar';
    main.style.background = '#6b7280';
    main.style.color = '#fff';
    main.disabled = false;
    main.onclick = () => {
      octupusRemoteCache.delete(leadId);
      octupusRenderWidget(leadId, null, true);
      octupusUiRefresh(leadId);
    };
    ocultarSecundarios();
  } else if (remoteId) {
    main.textContent = `🐙 Sincronizado · #${remoteId}`;
    main.style.background = '#2e7d32';
    main.style.color = '#fff';
    main.onclick = async () => {
      const { config = {} } = await chrome.storage.local.get('config');
      const base = (config.portalUrl || 'https://www.odoo.com').replace(/\/+$/, '');
      window.open(`${base}/my/opportunity/${remoteId}`, '_blank');
    };
    btnData.textContent = '↻ Actualizar datos';
    btnData.style.display = 'flex';
    btnData.onclick = () => octupusUiAction(leadId, remoteId, 'data');
    btnPush.textContent = '📤 Enviar mensajes';
    btnPush.style.display = 'flex';
    btnPush.onclick = () => octupusUiAction(leadId, remoteId, 'push');
    btnPull.textContent = '📥 Traer mensajes';
    btnPull.style.display = 'flex';
    btnPull.onclick = () => octupusUiAction(leadId, remoteId, 'pull');
  } else if (remoteId === 0) {
    main.textContent = '🐙 Sincronizado (ID desconocido)';
    main.style.background = '#b26a00';
    main.style.color = '#fff';
    main.onclick = null;
    ocultarSecundarios();
    btnData.textContent = '🔁 Re-vincular con el portal';
    btnData.style.display = 'flex';
    btnData.onclick = () => octupusUiRelink(leadId);
  } else {
    main.textContent = '🐙 Enviar a odoo.com';
    main.style.background = '#714b67';
    main.style.color = '#fff';
    main.onclick = () => octupusUiSend(leadId);
    ocultarSecundarios();
  }
}

async function octupusUiSend(leadId) {
  if (octupusUiBusy) return;
  octupusUiBusy = true;
  octupusRenderWidget(leadId, null, true);
  octupusToast('Enviando lead a odoo.com…', 0);
  try {
    const r = await octupusSyncIds([leadId]);
    if (r && r.ok && Array.isArray(r.created) && r.created.length) {
      const d = r.created[0];
      const extra = r.commentsPosted ? ` · ${r.commentsPosted} comentario(s)` : '';
      octupusToast(
        d.existing
          ? `Ya existía en el portal: vinculado con ID ${d.destId || '?'}${extra}`
          : `✔ Enviado — ID remoto ${d.destId || '?'}${extra}`
      );
    } else if (r && r.ok && Array.isArray(r.already) && r.already.length) {
      octupusToast(`Ya estaba sincronizado — ID remoto ${r.already[0].destId || '?'}`);
    } else {
      octupusToast(`✖ ${(r && r.error) || 'No se pudo enviar'}`);
    }
  } catch (err) {
    octupusToast(`✖ ${(err && err.message) || err}`);
  }
  octupusUiBusy = false;
  octupusRemoteCache.delete(leadId);
  await octupusUiRefresh(leadId);
}

/** Ejecuta una de las tres acciones sobre un lead sincronizado. */
async function octupusUiAction(leadId, remoteId, kind) {
  if (octupusUiBusy) return;
  octupusUiBusy = true;
  octupusRenderWidget(leadId, remoteId, true);
  const enCurso = { data: 'Actualizando datos…', push: 'Enviando mensajes…', pull: 'Trayendo mensajes…' };
  octupusToast(enCurso[kind], 0);
  try {
    let r;
    if (kind === 'data') r = await octupusUpdateData(leadId, remoteId);
    else if (kind === 'push') r = await octupusPushComments(leadId, remoteId);
    else r = await octupusPullComments(leadId, remoteId);

    if (r && r.ok) {
      if (kind === 'data') octupusToast(`✔ Datos actualizados (ID remoto ${r.destId || remoteId})`);
      else if (kind === 'push') {
        octupusToast(r.posted ? `✔ ${r.posted} mensaje(s) enviados al portal` : 'Nada nuevo que enviar');
      } else {
        octupusToast(r.pulled ? `✔ ${r.pulled} mensaje(s) traídos como notas` : 'Nada nuevo que traer');
      }
    } else {
      octupusToast(`✖ ${(r && r.error) || 'No se pudo completar la acción'}`, 10000);
    }
  } catch (err) {
    octupusToast(`✖ ${(err && err.message) || err}`, 10000);
  }
  octupusUiBusy = false;
  // Traer mensajes añade notas al chatter propio: refrescar estado sin caché
  octupusRemoteCache.delete(leadId);
  await octupusUiRefresh(leadId);
}

async function octupusUiRefresh(leadId) {
  let remoteId;
  if (octupusRemoteCache.has(leadId)) {
    remoteId = octupusRemoteCache.get(leadId);
  } else {
    try {
      remoteId = await octupusFindRemoteId(leadId);
      octupusRemoteCache.set(leadId, remoteId);
    } catch (e) {
      remoteId = 'error'; // no se cachea: el siguiente intento vuelve a leer
    }
  }
  if (octupusUiLeadId === leadId) octupusRenderWidget(leadId, remoteId, false);
}

/** Re-vincula desde el widget un lead cuya nota no tiene ID remoto. */
async function octupusUiRelink(leadId) {
  if (octupusUiBusy) return;
  octupusUiBusy = true;
  octupusRenderWidget(leadId, 0, true);
  octupusToast('Buscando la oportunidad en el portal…', 0);
  try {
    const r = await octupusRelinkLead(leadId);
    if (r && r.ok) {
      octupusToast(`✔ Re-vinculado — ID remoto ${r.destId}`);
    } else {
      octupusToast(`✖ ${(r && r.error) || 'No se pudo re-vincular'}`, 10000);
    }
  } catch (err) {
    octupusToast(`✖ ${(err && err.message) || err}`, 10000);
  }
  octupusUiBusy = false;
  octupusRemoteCache.delete(leadId);
  await octupusUiRefresh(leadId);
}

/**
 * El cliente web de Odoo es una SPA (cambia de registro sin recargar), así
 * que se sondea la URL cada segundo y se refresca el widget al cambiar de lead.
 */
let octupusTickRunning = false;
async function octupusUiTick() {
  if (octupusTickRunning) return;
  octupusTickRunning = true;
  try {
    const leadId = await octupusCurrentLeadId();
    if (leadId !== octupusUiLeadId) {
      octupusUiLeadId = leadId;
      if (!leadId) {
        if (octupusUi) octupusUi.wrap.style.display = 'none';
      } else {
        octupusRenderWidget(leadId, null, true);
        await octupusUiRefresh(leadId);
      }
    }
  } catch (e) {
    /* siguiente tick */
  }
  octupusTickRunning = false;
}

setInterval(octupusUiTick, 1000);
octupusUiTick();
