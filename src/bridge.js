/**
 * Octupus Lead Sync — bridge (ISOLATED world)
 *
 * - Flujo automático: recibe el aviso del injector cuando se convierte un
 *   lead a oportunidad y lo sincroniza con el portal de odoo.com.
 * - Flujo manual: el popup pide detectar/enviar el lead abierto en la pestaña.
 * - Tras cada envío correcto deja una nota interna en el chatter del lead de
 *   origen con el ID remoto, usando la sesión Odoo del propio usuario.
 */
'use strict';

const OCTUPUS_SEEN = new Set();

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

// --- Flujo automático: conversión detectada por injector.js ---
window.addEventListener('message', async (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.type !== 'OCTUPUS_LEAD_CONVERTED' || !Array.isArray(data.leadIds)) return;

  const ids = data.leadIds.filter((id) => Number.isInteger(id) && !OCTUPUS_SEEN.has(id));
  if (!ids.length) return;
  ids.forEach((id) => OCTUPUS_SEEN.add(id));

  try {
    const result = await octupusSyncIds(ids, { manual: false });
    if (result && result.ok) {
      console.info('[Octupus Lead Sync] Sincronizados:', result.created);
    } else if (result && result.error) {
      console.warn('[Octupus Lead Sync] Error al sincronizar:', result.error);
    }
  } catch (err) {
    // Permitir reintento si falla la lectura (p. ej. red)
    ids.forEach((id) => OCTUPUS_SEEN.delete(id));
    console.warn('[Octupus Lead Sync] No se pudieron sincronizar los leads:', err);
  }
});

// --- Flujo manual: peticiones desde el popup ---
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'GET_CURRENT_LEAD') {
    (async () => {
      const leadId = octupusCurrentLeadId();
      if (!leadId) return { leadId: null };
      return { leadId, remoteId: await octupusFindRemoteId(leadId) };
    })()
      .then(sendResponse)
      .catch(() => sendResponse({ leadId: octupusCurrentLeadId(), remoteId: null }));
    return true;
  }
  if (msg && msg.type === 'SEND_CURRENT_LEAD') {
    (async () => {
      const leadId = octupusCurrentLeadId();
      if (!leadId) return { ok: false, error: 'No hay ningún lead abierto en esta pestaña' };
      return octupusSyncIds([leadId], { manual: true });
    })()
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true; // respuesta asíncrona
  }
  if (msg && msg.type === 'UPDATE_CURRENT_LEAD') {
    (async () => {
      const leadId = octupusCurrentLeadId();
      if (!leadId) return { ok: false, error: 'No hay ningún lead abierto en esta pestaña' };
      const remoteId = await octupusFindRemoteId(leadId);
      if (remoteId === null) {
        return { ok: false, error: 'Este lead aún no está sincronizado (no hay nota 🐙 en el chatter)' };
      }
      if (!remoteId) {
        return { ok: false, error: 'La nota del chatter no contiene el ID remoto: no se puede actualizar' };
      }
      const leads = await octupusReadLeads([leadId], { onlyOpportunities: false });
      if (!leads.length) return { ok: false, error: 'No se pudo leer el lead' };
      const result = await chrome.runtime.sendMessage({
        type: 'UPDATE_LEAD',
        origin: window.location.origin,
        lead: leads[0],
        destId: remoteId,
      });
      if (result && result.ok) {
        const cr = await octupusSyncComments(leadId, remoteId, leads[0].name);
        result.commentsPosted = (cr && cr.posted) || 0;
      }
      return result;
    })()
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }
  return false;
});

/**
 * El chatter es la fuente de verdad de sincronización: busca la nota
 * "Octupus Lead Sync" en el lead y extrae el id remoto de su enlace
 * …/my/opportunity/<id>. Devuelve el id, 0 si hay nota sin id parseable,
 * o null si no hay nota (o no se pudo leer).
 */
async function octupusFindRemoteId(leadId) {
  try {
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
  } catch (e) {
    console.warn('[Octupus Lead Sync] No se pudo leer el chatter del lead', leadId, e);
    return null;
  }
}

/** Devuelve el id del crm.lead abierto en la URL actual, o null. */
function octupusCurrentLeadId() {
  // Odoo <=16: /web#id=123&model=crm.lead&view_type=form...
  const hashParams = new URLSearchParams(window.location.hash.slice(1));
  if (hashParams.get('model') === 'crm.lead') {
    const id = parseInt(hashParams.get('id'), 10);
    if (Number.isInteger(id)) return id;
  }
  // Odoo 17+: /odoo/crm/123
  const m = window.location.pathname.match(/\/odoo\/crm(?:\.lead)?\/(\d+)(?:\/|$)/);
  if (m) return parseInt(m[1], 10);
  return null;
}

/** Lee los leads, los envía al service worker y deja nota con el id remoto. */
async function octupusSyncIds(ids, { manual = false } = {}) {
  const leads = await octupusReadLeads(ids, { onlyOpportunities: !manual });
  if (!leads.length) {
    return { ok: false, error: 'No se pudo leer el lead (¿existe todavía?)', created: [], already: [] };
  }

  // El chatter manda: si el lead ya tiene nota de sincronización, no se reenvía
  const already = [];
  const pending = [];
  for (const lead of leads) {
    const remoteId = await octupusFindRemoteId(lead.id);
    if (remoteId !== null) already.push({ srcId: lead.id, destId: remoteId || null });
    else pending.push(lead);
  }
  if (!pending.length) return { ok: true, created: [], already };

  const result = await chrome.runtime.sendMessage({
    type: 'SYNC_LEADS',
    origin: window.location.origin,
    leads: pending,
    manual,
  });
  if (result && result.ok) {
    // Notas: para los recién creados/vinculados y también para los que el
    // service worker tenía en su registro local pero SIN nota en el chatter
    // (bridge solo le envía leads sin nota) — así se restauran notas perdidas.
    const paraNota = [
      ...(result.created || []),
      ...(result.already || []).map((a) => ({ ...a, existing: true })),
    ];
    if (paraNota.length) await octupusPostNotes(paraNota, result.portalUrl);

    if (Array.isArray(result.created) && result.created.length) {
      let commentsPosted = 0;
      const byId = Object.fromEntries(pending.map((l) => [l.id, l]));
      for (const item of result.created) {
        const lead = byId[item.srcId];
        const cr = await octupusSyncComments(item.srcId, item.destId, lead ? lead.name : '');
        commentsPosted += (cr && cr.posted) || 0;
      }
      result.commentsPosted = commentsPosted;
    }
    result.already = [...(result.already || []), ...already];
  }
  return result;
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

async function octupusReadLeads(ids, { onlyOpportunities = true } = {}) {
  // search_read en lugar de read: tolera leads eliminados por fusión (merge)
  const result = await octupusCallKw('crm.lead', 'search_read', [], {
    domain: [['id', 'in', ids]],
    fields: OCTUPUS_LEAD_FIELDS,
  });
  const leads = (result || []).filter((lead) => !onlyOpportunities || lead.type === 'opportunity');
  return octupusEnrichLeads(leads);
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

/** Deja una nota interna en el chatter de cada lead de origen con el id remoto. */
async function octupusPostNotes(created, portalUrl) {
  const base = (portalUrl || 'https://www.odoo.com').replace(/\/+$/, '');
  for (const item of created) {
    if (!item || !item.srcId) continue;
    const accion = item.existing
      ? 'ya existía en el portal de partners de odoo.com; vinculado sin duplicar'
      : 'enviado al portal de partners de odoo.com';
    const remoteUrl = item.destId ? `${base}/my/opportunity/${item.destId}` : null;
    const bodyHtml = remoteUrl
      ? `🐙 <b>Octupus Lead Sync</b>: ${accion}.<br/>` +
        `ID remoto: <b>${item.destId}</b> — <a href="${remoteUrl}" target="_blank">ver en el portal</a>`
      : `🐙 <b>Octupus Lead Sync</b>: ${accion}.<br/>` +
        `ID remoto no disponible en la respuesta del portal`;
    const bodyText = remoteUrl
      ? `🐙 Octupus Lead Sync: ${accion}. ID remoto: ${item.destId} — ${remoteUrl}`
      : `🐙 Octupus Lead Sync: ${accion} (ID remoto no disponible).`;
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
  doc.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
  doc.querySelectorAll('p, div, li').forEach((el) => el.append('\n'));
  return (doc.body.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
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
