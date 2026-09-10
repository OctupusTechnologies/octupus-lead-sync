/**
 * Octupus Lead Sync — bridge (content script, ISOLATED world)
 *
 * Sincronización 100% manual:
 * - Widget flotante en el backend de Odoo: muestra el estado del lead abierto
 *   (sincronizado o no) y permite enviarlo/actualizarlo con un clic.
 * - El popup de la extensión ofrece las mismas acciones (mensajes MSG.*).
 * - Tras cada envío correcto deja una nota interna en el chatter del lead de
 *   origen con el ID remoto, usando la sesión Odoo del propio usuario.
 *
 * Convención: todas las funciones llevan el prefijo `octupus` para
 * reconocerlas de un vistazo en las trazas de DevTools junto al código de
 * Odoo. Requiere que shared.js se haya cargado antes (manifest).
 */
'use strict';

const {
  MSG,
  STORAGE,
  MARK,
  RE_PULLED_MARKER,
  errMsg,
  leadKey,
  escapeHtml,
  linkedPortalId,
  collectIds,
  portalOpportunityUrl,
  jsonRpc,
  readStorage,
  writeStorage,
  getConfig,
} = globalThis.OctupusShared;

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

/** Límites de lectura del chatter del lead de origen. */
const OCTUPUS_LIMITS = Object.freeze({
  /** Notas 🐙 candidatas a nota de vinculación. */
  LINK_NOTES: 10,
  /** Notas con marcadores [odoo#…] leídas para el dedupe de "traer". */
  PULLED_NOTES: 100,
  /** Mensajes más recientes del chatter que se suben al portal. */
  COMMENTS: 50,
  /** Notas que pueden reclamar una oportunidad remota. */
  CLAIMANT_NOTES: 10,
  /** Caracteres máximos de un mensaje traído (el resto se recorta). */
  PULLED_TEXT_CHARS: 4000,
});

const OCTUPUS_NO_LEAD_OPEN = 'No hay ningún lead abierto en esta pestaña';

// ───────────────────────── Peticiones desde el popup ─────────────────────────

const OCTUPUS_HANDLERS = Object.freeze({
  [MSG.GET_CURRENT_LEAD]: () => octupusCurrentLeadState(),
  [MSG.SEND_CURRENT_LEAD]: () => octupusWithCurrentLead((leadId) => octupusSyncIds([leadId])),
  [MSG.RELINK_CURRENT_LEAD]: () => octupusWithCurrentLead(octupusRelinkLead),
  [MSG.UPDATE_CURRENT_LEAD]: () => octupusRunOnSynced(octupusUpdateData),
  [MSG.PUSH_CURRENT_COMMENTS]: () => octupusRunOnSynced(octupusPushComments),
  [MSG.PULL_CURRENT_COMMENTS]: () => octupusRunOnSynced(octupusPullComments),
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = msg && OCTUPUS_HANDLERS[msg.type];
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(msg))
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: errMsg(err) }));
  return true; // respuesta asíncrona
});

/** Envía un mensaje al service worker y devuelve su respuesta. */
function octupusAskBackground(type, payload) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

/** Estado del lead abierto para el popup: {leadId, remoteId, readError}. */
async function octupusCurrentLeadState() {
  const leadId = await octupusCurrentLeadId();
  if (!leadId) return { leadId: null };
  try {
    return { leadId, remoteId: await octupusFindRemoteId(leadId) };
  } catch {
    return { leadId, remoteId: null, readError: true };
  }
}

/** Ejecuta la acción con el lead abierto en la pestaña, o error claro si no hay. */
async function octupusWithCurrentLead(action) {
  const leadId = await octupusCurrentLeadId();
  if (!leadId) return { ok: false, error: OCTUPUS_NO_LEAD_OPEN };
  return action(leadId);
}

/** Resuelve lead abierto + ID remoto y ejecuta la acción, con errores claros. */
function octupusRunOnSynced(action) {
  return octupusWithCurrentLead(async (leadId) => {
    let remoteId;
    try {
      remoteId = await octupusFindRemoteId(leadId);
    } catch (err) {
      return { ok: false, error: `No se pudo leer el chatter del lead: ${errMsg(err)}` };
    }
    if (remoteId === null) {
      return { ok: false, error: 'Este lead aún no está sincronizado (no hay nota 🐙 en el chatter)' };
    }
    if (!remoteId) {
      return { ok: false, error: 'La nota del chatter no contiene el ID remoto: usa Re-vincular' };
    }
    return action(leadId, remoteId);
  });
}

// ───────────────────────── Acciones sobre un lead sincronizado ─────────────────────────

/** Actualiza SOLO los datos de contacto de la oportunidad remota. */
async function octupusUpdateData(leadId, remoteId) {
  const leads = await octupusReadLeads([leadId]);
  if (!leads.length) return { ok: false, error: 'No se pudo leer el lead' };
  const result = await octupusAskBackground(MSG.UPDATE_LEAD, {
    origin: window.location.origin,
    lead: leads[0],
    destId: remoteId,
  });
  if (result && result.ok) result.destId = result.destId || remoteId;
  return result;
}

/** Empuja los mensajes del lead hacia la oportunidad remota. */
async function octupusPushComments(leadId, remoteId) {
  const name = await octupusLeadName(leadId);
  const r = await octupusSyncComments(leadId, remoteId, name);
  if (!r || r.ok === false) {
    return { ok: false, error: (r && r.error) || 'No se pudieron enviar los mensajes', posted: 0 };
  }
  return { ok: true, posted: r.posted || 0, destId: remoteId };
}

/**
 * Trae los mensajes del chatter remoto como notas internas del lead.
 * Anti-eco y anti-duplicados:
 *  - Se ignoran los mensajes remotos con [src#…] o la firma de la extensión
 *    (nuestros propios envíos y notas) → nunca traemos lo nuestro.
 *  - Cada nota traída lleva [odoo#<id remoto>] y el texto
 *    "vía Octupus Lead Sync" → el filtro de empuje la excluye (sin eco
 *    inverso) y el marcador evita traerla dos veces.
 *  - Dedupe en dos capas: marcadores [odoo#id] del chatter del lead
 *    (compartido) + registro local.
 */
async function octupusPullComments(leadId, remoteId) {
  const resp = await octupusAskBackground(MSG.PULL_REMOTE_MESSAGES, { destId: remoteId });
  if (!resp || !resp.ok) {
    return { ok: false, error: (resp && resp.error) || 'No se pudo leer el chatter remoto', pulled: 0 };
  }

  const alreadyPulled = await octupusFindPulledIds(leadId); // lanza si el chatter no se puede leer
  const pulled = await readStorage(STORAGE.PULLED, {});
  const key = leadKey(window.location.origin, leadId);
  const done = new Set([...(pulled[key] || []), ...alreadyPulled]);
  const persist = () => {
    pulled[key] = [...done];
    return writeStorage(STORAGE.PULLED, pulled);
  };

  let count = 0;
  // chatter_fetch devuelve de nuevo → viejo: publicar en orden cronológico
  // para que el chatter del lead se lea de arriba abajo correctamente
  const messages = (resp.messages || []).slice().sort((a, b) => (a.id || 0) - (b.id || 0));
  for (const m of messages) {
    if (!m || !m.id || done.has(m.id)) continue;
    const note = octupusBuildPulledNote(m);
    if (!note) continue;
    try {
      await octupusPostNote(leadId, note.html, note.text);
      done.add(m.id);
      count++;
    } catch (err) {
      await persist();
      return { ok: false, error: `Nota no guardada: ${errMsg(err)}`, pulled: count };
    }
  }

  await persist();
  if (count) {
    octupusAskBackground(MSG.LOG, {
      entry: {
        ok: true,
        name: await octupusLeadName(leadId),
        srcId: leadId,
        destId: remoteId,
        origin: window.location.origin,
        action: 'pull',
        count,
      },
    }).catch(() => {});
  }
  return { ok: true, pulled: count };
}

/**
 * Cuerpo (HTML y texto) de la nota interna que representa un mensaje remoto,
 * o null si el mensaje no debe traerse (vacío, propio o del bot).
 */
function octupusBuildPulledNote(m) {
  let text = octupusHtmlToText(m.body);
  if (!text) return null;
  if (text.includes(MARK.SRC_PREFIX) || text.includes(MARK.SIGNATURE)) return null;
  if (m.author === 'OdooBot') return null;
  if (text.length > OCTUPUS_LIMITS.PULLED_TEXT_CHARS) {
    text = `${text.slice(0, OCTUPUS_LIMITS.PULLED_TEXT_CHARS)}\n… [mensaje recortado]`;
  }
  const date = m.date ? ` (${m.date})` : '';
  const header = `📥 ${m.author}${date} en odoo.com vía ${MARK.SIGNATURE} ${MARK.PULLED_PREFIX}${m.id}]:`;
  return {
    text: `${header}\n${text}`,
    html: `<b>${escapeHtml(header)}</b><br/>${escapeHtml(text).replace(/\n/g, '<br/>')}`,
  };
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
    limit: OCTUPUS_LIMITS.PULLED_NOTES,
  });
  return (msgs || []).flatMap((m) => collectIds(m.body, RE_PULLED_MARKER));
}

async function octupusLeadName(leadId) {
  try {
    const rows = await octupusCallKw('crm.lead', 'read', [[leadId], ['name']]);
    return (rows && rows[0] && rows[0].name) || `lead #${leadId}`;
  } catch {
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

  const found = await octupusAskBackground(MSG.FIND_REMOTE, { title: lead.name, email: lead.email_from });
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
  await octupusMarkLinked(lead, found.destId);
  await octupusPostNotes([{ srcId: leadId, destId: found.destId, existing: true }], found.portalUrl);
  return { ok: true, destId: found.destId };
}

/** Registra en el service worker la vinculación lead ↔ oportunidad remota. */
function octupusMarkLinked(lead, destId) {
  return octupusAskBackground(MSG.MARK_LINKED, {
    origin: window.location.origin,
    leadId: lead.id,
    destId,
    name: lead.name,
  });
}

// ───────────────────────── Estado de sincronización (chatter) ─────────────────────────

/**
 * El chatter es la fuente de verdad de sincronización: busca la nota 🐙 en
 * el lead y extrae el id remoto de su enlace …/my/opportunity/<id>. Devuelve
 * el id, 0 si hay nota sin id parseable, o null si NO hay nota. Si el chatter
 * no se puede leer, LANZA el error: "no sincronizado" y "no lo sé" nunca
 * deben confundirse (evita duplicados).
 */
async function octupusFindRemoteId(leadId) {
  // Buscar la nota de vinculación por su ENLACE, no solo por la firma: las
  // notas 📥 traídas también contienen la firma y desplazarían a la nota 🐙
  // fuera de cualquier ventana por recencia.
  const msgs = await octupusCallKw('mail.message', 'search_read', [], {
    domain: [
      ['model', '=', 'crm.lead'],
      ['res_id', '=', leadId],
      ['body', 'like', MARK.SIGNATURE],
      ['body', 'like', MARK.PORTAL_LINK],
    ],
    fields: ['body'],
    order: 'id desc',
    limit: OCTUPUS_LIMITS.LINK_NOTES,
  });
  for (const msg of msgs || []) {
    const destId = linkedPortalId(msg.body);
    if (destId) return destId;
  }

  // Sin nota con enlace: ¿queda alguna nota 🐙 legado sin ID? (excluyendo traídas)
  const legacy = await octupusCallKw('mail.message', 'search_read', [], {
    domain: [
      ['model', '=', 'crm.lead'],
      ['res_id', '=', leadId],
      ['body', 'like', MARK.SIGNATURE],
      '!',
      ['body', 'like', 'odoo#'],
    ],
    fields: ['id'],
    order: 'id desc',
    limit: 1,
  });
  return legacy && legacy.length ? 0 : null;
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
        ['body', 'like', `${MARK.PORTAL_LINK}${destId}`],
      ],
      fields: ['res_id', 'body'],
      order: 'id desc',
      limit: OCTUPUS_LIMITS.CLAIMANT_NOTES,
    });
    // 'like' es substring (…/123 también casa con …/1234): verificar el id exacto
    const claim = (msgs || []).find((m) => linkedPortalId(m.body) === destId);
    return claim ? claim.res_id : null;
  } catch {
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
    if ((await octupusActionModel(actionId)) === 'crm.lead') return recordId;
  }
  return null;
}

/** res_model de una acción de ventana (cacheado; null si no se pudo leer). */
async function octupusActionModel(actionId) {
  if (!octupusActionModelCache.has(actionId)) {
    let model;
    try {
      const action = await octupusJsonRpc('/web/action/load', { action_id: actionId });
      model = (action && action.res_model) || null;
    } catch {
      model = null;
    }
    octupusActionModelCache.set(actionId, model);
  }
  return octupusActionModelCache.get(actionId);
}

// ───────────────────────── Envío ─────────────────────────

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
        error:
          `No se pudo leer el chatter del lead #${lead.id} (${errMsg(err)}). ` +
          'Envío cancelado para evitar duplicados.',
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
    const found = await octupusAskBackground(MSG.FIND_REMOTE, { title: lead.name, email: lead.email_from });
    if (found && found.portalUrl) portalUrl = found.portalUrl;
    const candidateId = found && found.ok ? found.destId : null;
    if (candidateId) {
      const claimant = await octupusFindClaimant(candidateId);
      if (!claimant || claimant === lead.id) {
        await octupusMarkLinked(lead, candidateId);
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
    const r = await octupusAskBackground(MSG.SYNC_LEADS, { origin: window.location.origin, leads: toCreate });
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
  const toAnnotate = [...created, ...alreadyBg.map((a) => ({ ...a, existing: true }))].filter(
    (i) => i.destId
  );
  if (toAnnotate.length) await octupusPostNotes(toAnnotate, portalUrl);

  let commentsPosted = 0;
  const byId = new Map(leads.map((lead) => [lead.id, lead]));
  for (const item of created) {
    if (!item.destId) continue;
    const lead = byId.get(item.srcId);
    const cr = await octupusSyncComments(item.srcId, item.destId, lead ? lead.name : '');
    commentsPosted += (cr && cr.posted) || 0;
  }

  if (errorBg && !created.length) {
    return { ok: false, error: errorBg, created, already: [...already, ...alreadyBg] };
  }
  return { ok: true, created, already: [...already, ...alreadyBg], commentsPosted };
}

// ───────────────────────── RPC contra el Odoo de origen ─────────────────────────

/** JSON-RPC same-origin con la sesión del usuario, a cualquier ruta. */
function octupusJsonRpc(path, params) {
  return jsonRpc(`${window.location.origin}${path}`, params, { credentials: 'same-origin' });
}

function octupusCallKw(model, method, args, kwargs) {
  return octupusJsonRpc('/web/dataset/call_kw', {
    model,
    method,
    args,
    kwargs: { context: {}, ...(kwargs || {}) },
  });
}

const octupusLeadFieldsCache = new Map(); // origin -> Set de campos existentes, o null si no se pudo comprobar

/**
 * Subconjunto de OCTUPUS_LEAD_FIELDS que existe realmente en crm.lead de esta
 * instancia. No todas las versiones/personalizaciones traen todos los campos
 * (p. ej. 'mobile'), y pedir uno inexistente hace fallar el search_read
 * entero ("Invalid field 'x' on 'crm.lead'"), así que se comprueba una vez
 * por origin con fields_get y se cachea.
 */
async function octupusValidLeadFields() {
  const origin = window.location.origin;
  if (!octupusLeadFieldsCache.has(origin)) {
    let valid = null;
    try {
      const fields = await octupusCallKw('crm.lead', 'fields_get', [OCTUPUS_LEAD_FIELDS, ['type']]);
      valid = new Set(Object.keys(fields || {}));
    } catch {
      /* no se pudo comprobar: se usa la lista completa tal cual */
    }
    octupusLeadFieldsCache.set(origin, valid);
  }
  return octupusLeadFieldsCache.get(origin);
}

async function octupusReadLeads(ids) {
  const valid = await octupusValidLeadFields();
  const fields = valid ? OCTUPUS_LEAD_FIELDS.filter((f) => valid.has(f)) : OCTUPUS_LEAD_FIELDS;
  // search_read en lugar de read: tolera leads eliminados por fusión (merge)
  const result = await octupusCallKw('crm.lead', 'search_read', [], {
    domain: [['id', 'in', ids]],
    fields,
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
      const codeById = new Map(rows.map((r) => [r.id, r.code]));
      for (const lead of leads) {
        if (lead.country_id) lead.country_code = codeById.get(lead.country_id[0]) || null;
      }
    }
    if (stateIds.length) {
      const rows = await octupusCallKw('res.country.state', 'read', [stateIds, ['code', 'name']]);
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const lead of leads) {
        const row = lead.state_id && byId.get(lead.state_id[0]);
        if (row) {
          lead.state_code = row.code || null;
          lead.state_name = row.name || null;
        }
      }
    }
  } catch (err) {
    console.warn('[Octupus Lead Sync] No se pudieron leer país/provincia del origen:', err);
  }
  return leads;
}

// ───────────────────────── Notas y comentarios ─────────────────────────

/**
 * Deja una nota interna en el chatter de cada lead de origen con el id remoto.
 * NUNCA publica notas sin ID: una nota sin URL "envenena" la detección
 * (el lead quedaría como sincronizado sin poder actualizarse).
 */
async function octupusPostNotes(created, portalUrl) {
  for (const item of created) {
    if (!item || !item.srcId || !item.destId) continue;
    const action = item.existing
      ? 'ya existía en el portal de partners de odoo.com; vinculado sin duplicar'
      : 'enviado al portal de partners de odoo.com';
    const remoteUrl = portalOpportunityUrl(portalUrl, item.destId);
    const bodyHtml =
      `🐙 <b>${MARK.SIGNATURE}</b>: ${action}.<br/>` +
      `ID remoto: <b>${item.destId}</b> — <a href="${remoteUrl}" target="_blank">ver en el portal</a>`;
    const bodyText = `🐙 ${MARK.SIGNATURE}: ${action}. ID remoto: ${item.destId} — ${remoteUrl}`;
    try {
      await octupusPostNote(item.srcId, bodyHtml, bodyText);
    } catch (err) {
      console.warn('[Octupus Lead Sync] No se pudo dejar la nota en el lead', item.srcId, err);
      // Que el fallo sea visible en el popup, no solo en la consola
      octupusAskBackground(MSG.LOG, {
        entry: {
          ok: false,
          name: `Nota no guardada en lead #${item.srcId}`,
          srcId: item.srcId,
          destId: item.destId,
          origin: window.location.origin,
          error: errMsg(err),
        },
      }).catch(() => {});
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
    .replace(/\u00a0/g, ' ') // espacios duros (&nbsp;)
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
  const { syncNotes } = await getConfig();

  const subtypeIds = [];
  const commentSubtypeId = await octupusGetSubtypeId('mail.mt_comment');
  if (commentSubtypeId) subtypeIds.push(commentSubtypeId);
  let noteSubtypeId = null;
  if (syncNotes !== false) {
    noteSubtypeId = await octupusGetSubtypeId('mail.mt_note');
    if (noteSubtypeId) subtypeIds.push(noteSubtypeId);
  }
  if (!subtypeIds.length) {
    console.warn('[Octupus Lead Sync] No se pudieron resolver los subtipos de mensaje: comentarios omitidos');
    return [];
  }

  // Los N más RECIENTES (id desc) — con 'id asc' un lead con más mensajes que
  // el límite enviaría los antiguos y nunca los nuevos — y luego se invierte
  // el orden para publicarlos cronológicamente
  const msgs = await octupusCallKw('mail.message', 'search_read', [], {
    domain: [
      ['model', '=', 'crm.lead'],
      ['res_id', '=', leadId],
      ['message_type', '=', 'comment'],
      ['subtype_id', 'in', subtypeIds],
    ],
    fields: ['id', 'body', 'author_id', 'date', 'subtype_id'],
    order: 'id desc',
    limit: OCTUPUS_LIMITS.COMMENTS,
  });
  return (msgs || [])
    .slice()
    .reverse()
    .map((m) => {
      const text = octupusHtmlToText(m.body);
      if (!text || text.includes(MARK.SIGNATURE)) return null;
      const isNote = noteSubtypeId && m.subtype_id && m.subtype_id[0] === noteSubtypeId;
      const author = (m.author_id && m.author_id[1]) || 'Desconocido';
      return {
        id: m.id,
        body: `${isNote ? '📝' : '💬'} ${author} (${m.date}) vía ${MARK.SIGNATURE} ${MARK.SRC_PREFIX}${m.id}]:\n${text}`,
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
    return await octupusAskBackground(MSG.SYNC_COMMENTS, {
      origin: window.location.origin,
      leadId,
      destId,
      leadName: leadName || '',
      comments,
    });
  } catch (err) {
    console.warn('[Octupus Lead Sync] No se pudieron sincronizar los comentarios del lead', leadId, err);
    return { ok: false, posted: 0 };
  }
}

const octupusSubtypeCache = new Map();

/** Resuelve (y cachea) el id de un subtipo de mensaje por xmlid; false si no existe. */
async function octupusGetSubtypeId(xmlid) {
  if (!octupusSubtypeCache.has(xmlid)) {
    let id;
    try {
      const [module, name] = xmlid.split('.');
      const ref = await octupusCallKw('ir.model.data', 'check_object_reference', [module, name]);
      id = Array.isArray(ref) ? ref[1] : false;
    } catch {
      id = false;
    }
    octupusSubtypeCache.set(xmlid, id);
  }
  return octupusSubtypeCache.get(xmlid);
}

/**
 * Publica la nota interna con tres estrategias, de más a menos completa:
 *  1) message_post con body_is_html:true — conserva el HTML y pasa por el
 *     flujo completo del chatter (la nota aparece en vivo, Odoo 17+).
 *  2) mail.message.create directo — conserva el HTML (verificado en Odoo 18)
 *     pero sin notificación en vivo del chatter.
 *  3) /mail/message/post — el endpoint del chatter; escapa el HTML, así que
 *     va el texto plano (los saltos de línea pueden verse colapsados).
 * Si todo falla, lanza un error con el detalle de cada intento.
 */
async function octupusPostNote(srcId, bodyHtml, bodyText) {
  const strategies = [
    [
      'message_post(body_is_html)',
      () =>
        octupusCallKw('crm.lead', 'message_post', [[srcId]], {
          body: bodyHtml,
          body_is_html: true,
          message_type: 'comment',
          subtype_xmlid: 'mail.mt_note',
        }),
    ],
    [
      'mail.message.create',
      async () => {
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
      },
    ],
    [
      '/mail/message/post',
      () =>
        octupusJsonRpc('/mail/message/post', {
          thread_model: 'crm.lead',
          thread_id: srcId,
          post_data: { body: bodyText, message_type: 'comment', subtype_xmlid: 'mail.mt_note' },
          context: {},
        }),
    ],
  ];

  const failures = [];
  for (const [label, attempt] of strategies) {
    try {
      await attempt();
      return;
    } catch (err) {
      failures.push(`${label}: ${errMsg(err)}`);
    }
  }
  throw new Error(failures.join(' | '));
}

// ───────────────────────── Widget flotante ─────────────────────────

const OCTUPUS_COLORS = Object.freeze({
  brand: '#714b67',
  ok: '#2e7d32',
  warn: '#b26a00',
  muted: '#6b7280',
  loading: '#9aa0ab',
  dark: '#1f2430',
  light: '#e8eaf0',
  white: '#fff',
});
const OCTUPUS_TOAST_MS = 6000;
const OCTUPUS_TOAST_ERROR_MS = 10000;
const OCTUPUS_POLL_MS = 1000;
const OCTUPUS_WIDGET_ID = 'octupus-lead-sync-widget';

let octupusUi = null;
let octupusUiLeadId = null;
let octupusUiBusy = false;
let octupusToastTimer = null;
const octupusRemoteCache = new Map(); // leadId -> remoteId | 0 | null

function octupusButtonCss(bg, color, fontSize) {
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
  if (octupusUi && document.getElementById(OCTUPUS_WIDGET_ID)) return octupusUi;

  const wrap = document.createElement('div');
  wrap.id = OCTUPUS_WIDGET_ID;
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
    `display:none;max-width:300px;background:${OCTUPUS_COLORS.dark};color:${OCTUPUS_COLORS.white};` +
    'padding:8px 12px;border-radius:10px;font-size:12px;line-height:1.4;box-shadow:0 6px 18px rgba(0,0,0,.28);';

  const makeSecondaryButton = () => {
    const button = document.createElement('button');
    button.type = 'button';
    button.style.cssText = octupusButtonCss(OCTUPUS_COLORS.light, OCTUPUS_COLORS.dark, '12px');
    button.style.display = 'none';
    return button;
  };
  const btnData = makeSecondaryButton();
  const btnPush = makeSecondaryButton();
  const btnPull = makeSecondaryButton();

  const main = document.createElement('button');
  main.type = 'button';
  main.style.cssText = octupusButtonCss(OCTUPUS_COLORS.brand, OCTUPUS_COLORS.white, '13px');

  wrap.append(toast, btnData, btnPush, btnPull, main);
  document.documentElement.appendChild(wrap);
  octupusUi = { wrap, main, toast, btnData, btnPush, btnPull };
  return octupusUi;
}

function octupusToast(text, ms = OCTUPUS_TOAST_MS) {
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

/** Configura el botón principal del widget. */
function octupusSetMainButton(main, { text, title = '', bg, onclick = null }) {
  main.textContent = text;
  main.title = title;
  main.style.background = bg;
  main.style.color = OCTUPUS_COLORS.white;
  main.onclick = onclick;
}

/** Muestra un botón secundario con su texto, tooltip y acción. */
function octupusShowButton(button, { text, title, onclick }) {
  button.textContent = text;
  button.title = title;
  button.style.display = 'flex';
  button.onclick = onclick;
}

function octupusRenderWidget(leadId, remoteId, loading) {
  const ui = octupusEnsureUi();
  if (!leadId) {
    ui.wrap.style.display = 'none';
    return;
  }
  ui.wrap.style.display = 'flex';
  const { main, btnData, btnPush, btnPull } = ui;
  const secondary = [btnData, btnPush, btnPull];
  for (const button of secondary) button.style.display = 'none';
  main.disabled = Boolean(loading || octupusUiBusy);
  for (const button of secondary) button.disabled = main.disabled;

  if (loading) {
    octupusSetMainButton(main, { text: '🐙 Comprobando…', bg: OCTUPUS_COLORS.loading });
    return;
  }

  if (remoteId === 'error') {
    // No se pudo leer el chatter: NUNCA ofrecer "Enviar" (riesgo de duplicado)
    octupusSetMainButton(main, {
      text: '⚠️ Estado desconocido · reintentar',
      title: 'No se pudo leer el chatter del lead. Clic para volver a comprobar.',
      bg: OCTUPUS_COLORS.muted,
      onclick: () => {
        octupusRemoteCache.delete(leadId);
        octupusRenderWidget(leadId, null, true);
        octupusUiRefresh(leadId);
      },
    });
    main.disabled = false;
    return;
  }

  if (remoteId) {
    octupusSetMainButton(main, {
      text: `🐙 Sincronizado · #${remoteId} ↗`,
      title: 'Abrir la oportunidad en el portal de odoo.com',
      bg: OCTUPUS_COLORS.ok,
      onclick: async () => {
        const { portalUrl } = await getConfig();
        window.open(portalOpportunityUrl(portalUrl, remoteId), '_blank');
      },
    });
    octupusShowButton(btnData, {
      text: '📇 Actualizar contacto en odoo.com',
      title:
        'Vuelve a enviar los datos de contacto del lead (nombre, email, teléfono, dirección) ' +
        'a la oportunidad del portal',
      onclick: () => octupusUiAction(leadId, remoteId, 'data'),
    });
    octupusShowButton(btnPush, {
      text: '⬆️ Enviar mensajes a odoo.com',
      title: 'Publica en el portal los mensajes nuevos del chatter de este lead',
      onclick: () => octupusUiAction(leadId, remoteId, 'push'),
    });
    octupusShowButton(btnPull, {
      text: '⬇️ Traer mensajes de odoo.com',
      title: 'Importa como notas internas los mensajes escritos en el portal (Odoo, cliente…)',
      onclick: () => octupusUiAction(leadId, remoteId, 'pull'),
    });
    return;
  }

  if (remoteId === 0) {
    octupusSetMainButton(main, {
      text: '🐙 Sincronizado (sin ID remoto)',
      title: 'La nota del chatter no contiene el ID de la oportunidad del portal',
      bg: OCTUPUS_COLORS.warn,
    });
    octupusShowButton(btnData, {
      text: '🔗 Re-vincular con el portal',
      title:
        'Busca la oportunidad en el portal (por título y email) y reescribe la nota con su ID. No crea nada.',
      onclick: () => octupusUiRelink(leadId),
    });
    return;
  }

  octupusSetMainButton(main, {
    text: '🐙 Enviar lead a odoo.com',
    title:
      'Crea la oportunidad en el portal de partners, rellena el contacto, deja nota de trazabilidad ' +
      'y sube los mensajes',
    bg: OCTUPUS_COLORS.brand,
    onclick: () => octupusUiSend(leadId),
  });
}

/**
 * Esqueleto común de las acciones del widget: bloquea la UI, muestra el toast
 * de progreso, ejecuta la acción, muestra el resultado y vuelve a leer el
 * estado sin caché (la acción puede haber cambiado el chatter).
 * `describe(result)` devuelve {text, error}.
 */
async function octupusUiRun({ leadId, renderRemoteId, progress, action, describe }) {
  if (octupusUiBusy) return;
  octupusUiBusy = true;
  octupusRenderWidget(leadId, renderRemoteId, true);
  octupusToast(progress, 0);
  try {
    const { text, error } = describe(await action());
    octupusToast(text, error ? OCTUPUS_TOAST_ERROR_MS : OCTUPUS_TOAST_MS);
  } catch (err) {
    octupusToast(`✖ ${errMsg(err)}`, OCTUPUS_TOAST_ERROR_MS);
  }
  octupusUiBusy = false;
  octupusRemoteCache.delete(leadId);
  await octupusUiRefresh(leadId);
}

function octupusFailure(r, fallback) {
  return { text: `✖ ${(r && r.error) || fallback}`, error: true };
}

function octupusUiSend(leadId) {
  return octupusUiRun({
    leadId,
    renderRemoteId: null,
    progress: 'Enviando lead a odoo.com…',
    action: () => octupusSyncIds([leadId]),
    describe: (r) => {
      if (r && r.ok && Array.isArray(r.created) && r.created.length) {
        const d = r.created[0];
        const extra = r.commentsPosted ? ` · ${r.commentsPosted} comentario(s)` : '';
        return {
          text: d.existing
            ? `Ya existía en el portal: vinculado con ID ${d.destId || '?'}${extra}`
            : `✔ Enviado — ID remoto ${d.destId || '?'}${extra}`,
        };
      }
      if (r && r.ok && Array.isArray(r.already) && r.already.length) {
        return { text: `Ya estaba sincronizado — ID remoto ${r.already[0].destId || '?'}` };
      }
      return octupusFailure(r, 'No se pudo enviar');
    },
  });
}

/** Las tres acciones sobre un lead sincronizado: progreso, ejecución y texto de éxito. */
const OCTUPUS_UI_ACTIONS = Object.freeze({
  data: {
    progress: 'Actualizando datos…',
    run: octupusUpdateData,
    done: (r, remoteId) => `✔ Datos actualizados (ID remoto ${r.destId || remoteId})`,
  },
  push: {
    progress: 'Enviando mensajes…',
    run: octupusPushComments,
    done: (r) => (r.posted ? `✔ ${r.posted} mensaje(s) enviados al portal` : 'Nada nuevo que enviar'),
  },
  pull: {
    progress: 'Trayendo mensajes…',
    run: octupusPullComments,
    done: (r) => (r.pulled ? `✔ ${r.pulled} mensaje(s) traídos como notas` : 'Nada nuevo que traer'),
  },
});

function octupusUiAction(leadId, remoteId, kind) {
  const spec = OCTUPUS_UI_ACTIONS[kind];
  return octupusUiRun({
    leadId,
    renderRemoteId: remoteId,
    progress: spec.progress,
    action: () => spec.run(leadId, remoteId),
    describe: (r) =>
      r && r.ok ? { text: spec.done(r, remoteId) } : octupusFailure(r, 'No se pudo completar la acción'),
  });
}

/** Re-vincula desde el widget un lead cuya nota no tiene ID remoto. */
function octupusUiRelink(leadId) {
  return octupusUiRun({
    leadId,
    renderRemoteId: 0,
    progress: 'Buscando la oportunidad en el portal…',
    action: () => octupusRelinkLead(leadId),
    describe: (r) =>
      r && r.ok
        ? { text: `✔ Re-vinculado — ID remoto ${r.destId}` }
        : octupusFailure(r, 'No se pudo re-vincular'),
  });
}

async function octupusUiRefresh(leadId) {
  let remoteId;
  if (octupusRemoteCache.has(leadId)) {
    remoteId = octupusRemoteCache.get(leadId);
  } else {
    try {
      remoteId = await octupusFindRemoteId(leadId);
      octupusRemoteCache.set(leadId, remoteId);
    } catch {
      remoteId = 'error'; // no se cachea: el siguiente intento vuelve a leer
    }
  }
  if (octupusUiLeadId === leadId) octupusRenderWidget(leadId, remoteId, false);
}

/**
 * El cliente web de Odoo es una SPA (cambia de registro sin recargar) y desde
 * el mundo aislado no se pueden interceptar sus pushState, así que se sondea
 * la URL periódicamente y se refresca el widget al cambiar de lead.
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
  } catch {
    /* siguiente tick */
  }
  octupusTickRunning = false;
}

setInterval(octupusUiTick, OCTUPUS_POLL_MS);
octupusUiTick();
