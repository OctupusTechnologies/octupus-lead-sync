/**
 * Octupus Lead Sync — service worker
 *
 * Recibe los leads convertidos desde bridge.js y los crea en el portal de
 * partners de www.odoo.com mediante crm.lead/create_opp_portal, reutilizando
 * la sesión (cookie session_id) que el usuario ya tiene iniciada en odoo.com.
 *
 * No se necesita clave API: al tener la extensión permiso de host sobre
 * *.odoo.com, los fetch con credentials:'include' adjuntan la cookie de
 * sesión automáticamente. Lo mismo vale para el CRM de origen (listado de
 * leads del popup).
 */
'use strict';

importScripts('shared.js');

const {
  MSG,
  STORAGE,
  MARK,
  RE_SRC_MARKER,
  DEFAULTS,
  errMsg,
  stripTrailingSlash,
  leadKey,
  escapeIlike,
  odooSlug,
  linkedPortalId,
  collectIds,
  extractOpportunities,
  parseRemoteMessages,
  jsonRpc,
  readStorage,
  writeStorage,
  getConfig,
} = globalThis.OctupusShared;

/** Límites de consultas y del registro local. */
const LIMITS = Object.freeze({
  /** Leads activos que muestra el popup. */
  LEADS_LIST: 15,
  /** Notas 🐙 leídas de golpe para resolver el estado de esos leads. */
  LEADS_LIST_NOTES: 200,
  /** Mensajes leídos del chatter de la oportunidad remota. */
  REMOTE_CHATTER: 100,
  /** Entradas del historial del popup. */
  LOG_ENTRIES: 50,
  /** Páginas recorridas del listado HTML del portal (fallback de búsqueda). */
  PORTAL_HTML_PAGES: 10,
});

const BADGE = Object.freeze({ color: '#2e7d32', ms: 8000 });

// ───────────────────────── Mensajería ─────────────────────────

/** Un handler por tipo de mensaje; cada uno devuelve la respuesta (o lanza). */
const HANDLERS = Object.freeze({
  [MSG.SYNC_LEADS]: (msg) => syncLeads(msg.origin, msg.leads),
  [MSG.UPDATE_LEAD]: (msg) => updateLead(msg.origin, msg.lead, msg.destId),
  [MSG.SYNC_COMMENTS]: (msg) => syncComments(msg.origin, msg.leadId, msg.destId, msg.leadName, msg.comments),
  [MSG.FIND_REMOTE]: (msg) => findRemote(msg.title, msg.email),
  [MSG.MARK_LINKED]: (msg) => markLinked(msg.origin, msg.leadId, msg.destId, msg.name),
  [MSG.PULL_REMOTE_MESSAGES]: (msg) => pullRemoteMessages(msg.destId),
  [MSG.LIST_LEADS]: () => listActiveLeads(),
  [MSG.LOG]: (msg) => addLog(msg.entry || {}).then(() => ({ ok: true })),
  [MSG.CHECK_SESSION]: (msg) => checkSession(msg.config),
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = msg && HANDLERS[msg.type];
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(msg))
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: errMsg(err) }));
  return true; // respuesta asíncrona
});

async function findRemote(title, email) {
  const cfg = await getConfig();
  const destId = await findRemotePortalOpportunity(cfg, title, email);
  return { ok: true, destId, portalUrl: cfg.portalUrl };
}

async function markLinked(origin, leadId, destId, name) {
  const cfg = await getConfig();
  await rememberSent(origin, leadId, destId);
  await addLog({ ok: true, name: name || `lead #${leadId}`, srcId: leadId, destId, origin, action: 'link' });
  return { ok: true, portalUrl: cfg.portalUrl };
}

async function pullRemoteMessages(destId) {
  const cfg = await getConfig();
  const result = await fetchRemoteChatter(cfg, destId);
  if (result === null) return { ok: false, error: 'No se pudo leer el chatter de la oportunidad remota' };
  return { ok: true, messages: parseRemoteMessages(result) };
}

// ───────────────────────── Registro local ─────────────────────────

/**
 * Apunta un lead como enviado/vinculado. `at` conserva la fecha del primer
 * registro; `destId` se sobreescribe siempre (puede pasar de null a real).
 */
async function rememberSent(origin, leadId, destId) {
  const sent = await readStorage(STORAGE.SENT, {});
  const key = leadKey(origin, leadId);
  const prev = sent[key] || {};
  sent[key] = { ...prev, destId, at: prev.at || new Date().toISOString() };
  await writeStorage(STORAGE.SENT, sent);
}

async function addLog(entry) {
  const log = await readStorage(STORAGE.LOG, []);
  log.unshift({ at: new Date().toISOString(), ...entry });
  await writeStorage(STORAGE.LOG, log.slice(0, LIMITS.LOG_ENTRIES));
}

function flashBadge(text) {
  chrome.action.setBadgeBackgroundColor({ color: BADGE.color });
  chrome.action.setBadgeText({ text });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), BADGE.ms);
}

// ───────────────────────── RPC contra Odoo ─────────────────────────

/** JSON-RPC a una instancia Odoo (portal o CRM) con la cookie del navegador. */
function odooRpc(baseUrl, path, params) {
  return jsonRpc(stripTrailingSlash(baseUrl) + path, params, { credentials: 'include' });
}

/** Atajo para /web/dataset/call_kw. */
function callKw(baseUrl, model, method, args, kwargs) {
  return odooRpc(baseUrl, `/web/dataset/call_kw/${model}/${method}`, {
    model,
    method,
    args,
    kwargs: { context: {}, ...(kwargs || {}) },
  });
}

/**
 * Comprueba que hay sesión válida en el portal: primero la cookie session_id
 * (mensaje claro si el usuario no está logueado) y después get_session_info.
 */
async function checkSession(cfgOverride) {
  const cfg = cfgOverride ? { ...DEFAULTS, ...cfgOverride } : await getConfig();

  let cookie = null;
  let cookieChecked = false;
  try {
    cookie = await chrome.cookies.get({ url: cfg.portalUrl, name: 'session_id' });
    cookieChecked = true;
  } catch {
    /* sin acceso a la API de cookies para ese host: lo verificará get_session_info */
  }
  if (cookieChecked && cookie === null) {
    throw new Error(
      `No hay cookie de sesión para ${cfg.portalUrl}. Inicia sesión en esa web con este perfil de Chrome.`
    );
  }

  const info = await odooRpc(cfg.portalUrl, '/web/session/get_session_info', {});
  if (!info || !info.uid) {
    throw new Error('La sesión de odoo.com no es válida o ha caducado. Vuelve a iniciar sesión.');
  }
  return { ok: true, uid: info.uid, username: info.username || info.name || '' };
}

// ───────────────────────── Creación y contacto ─────────────────────────

/**
 * create_opp_portal solo acepta title, contact_name y description (los campos
 * del formulario del portal), así que el resto de datos del lead se vuelca
 * en la descripción para no perder información.
 */
function buildPortalValues(lead, origin, sourceLabel) {
  const lines = [];
  if (lead.partner_name) lines.push(`Empresa: ${lead.partner_name}`);
  if (lead.email_from) lines.push(`Email: ${lead.email_from}`);
  if (lead.phone) lines.push(`Teléfono: ${lead.phone}`);
  if (lead.mobile) lines.push(`Móvil: ${lead.mobile}`);
  if (lead.website) lines.push(`Web: ${lead.website}`);
  const address = [lead.street, lead.street2, lead.zip, lead.city].filter(Boolean).join(', ');
  if (address) lines.push(`Dirección: ${address}`);
  if (lead.country_id) lines.push(`País: ${lead.country_id[1]}`);
  if (lead.expected_revenue) lines.push(`Ingreso esperado: ${lead.expected_revenue}`);
  if (lead.user_id) lines.push(`Comercial: ${lead.user_id[1]}`);

  const parts = [];
  if (lead.description) parts.push(lead.description, '');
  if (lines.length) parts.push(lines.join('\n'), '');
  parts.push(`Origen: ${sourceLabel || DEFAULTS.sourceLabel}`);
  parts.push(`Sincronizado desde ${origin} (lead #${lead.id})`);
  parts.push(`${origin}/web#id=${lead.id}&model=crm.lead&view_type=form`);

  return {
    title: lead.name,
    // create_opp_portal exige contact_name no vacío ("All fields are
    // required!"): fallback al email o a un guion si el lead no tiene nombre
    contact_name: lead.contact_name || lead.partner_name || lead.email_from || '-',
    description: parts.join('\n'),
  };
}

// Los ids de país/provincia difieren entre bases de datos: se resuelven en
// odoo.com por código ISO (leído del origen por bridge.js) y se cachean.
const destCountryCache = new Map();
const destStateCache = new Map();

/** Primer id que devuelve search_read para el dominio, o null (también si falla). */
async function firstIdMatching(cfg, model, domain) {
  try {
    const rows = await callKw(cfg.portalUrl, model, 'search_read', [], { domain, fields: ['id'], limit: 1 });
    return rows && rows.length ? rows[0].id : null;
  } catch {
    return null;
  }
}

async function resolveDestCountryId(cfg, code) {
  if (!code) return null;
  const key = `${cfg.portalUrl}#${code}`;
  if (!destCountryCache.has(key)) {
    destCountryCache.set(key, await firstIdMatching(cfg, 'res.country', [['code', '=', code]]));
  }
  return destCountryCache.get(key);
}

async function resolveDestStateId(cfg, countryId, code, name) {
  if (!countryId || (!code && !name)) return null;
  const key = `${cfg.portalUrl}#${countryId}#${code || ''}#${name || ''}`;
  if (!destStateCache.has(key)) {
    let id = null;
    if (code)
      id = await firstIdMatching(cfg, 'res.country.state', [
        ['country_id', '=', countryId],
        ['code', '=', code],
      ]);
    if (!id && name) {
      id = await firstIdMatching(cfg, 'res.country.state', [
        ['country_id', '=', countryId],
        ['name', '=', name],
      ]);
    }
    destStateCache.set(key, id);
  }
  return destStateCache.get(key);
}

/**
 * Segundo paso del envío: rellena los datos de contacto de la oportunidad
 * remota con crm.lead/update_contact_details_from_portal (mismos campos que
 * el formulario del portal).
 */
async function updateContactDetails(cfg, destId, lead) {
  if (!destId) throw new Error('ID remoto desconocido');
  const countryId = await resolveDestCountryId(cfg, lead.country_code);
  const stateId = await resolveDestStateId(cfg, countryId, lead.state_code, lead.state_name);
  // Solo campos con valor: lo que el origen no tiene NO debe borrar lo que
  // alguien haya completado a mano en el portal
  const candidates = {
    partner_name: lead.partner_name || lead.contact_name,
    phone: lead.phone || lead.mobile,
    email_from: lead.email_from,
    street: lead.street,
    street2: lead.street2,
    city: lead.city,
    zip: lead.zip,
    state_id: stateId,
    country_id: countryId,
  };
  const values = Object.fromEntries(Object.entries(candidates).filter(([, value]) => Boolean(value)));
  if (!Object.keys(values).length) return;
  await callKw(cfg.portalUrl, 'crm.lead', 'update_contact_details_from_portal', [[destId], values]);
}

/** Actualización manual (botón del popup/widget) de un lead ya sincronizado. */
async function updateLead(origin, lead, destId) {
  const cfg = await getConfig();
  await checkSession();
  await updateContactDetails(cfg, destId, lead);
  await rememberSent(origin, lead.id, destId);
  await addLog({ ok: true, name: lead.name, srcId: lead.id, destId, origin, action: 'update' });
  return { ok: true, destId };
}

async function createOppPortal(cfg, lead, origin) {
  const result = await callKw(cfg.portalUrl, 'crm.lead', 'create_opp_portal', [
    buildPortalValues(lead, origin, cfg.sourceLabel),
  ]);
  if (result && result.errors) {
    throw new Error(typeof result.errors === 'string' ? result.errors : JSON.stringify(result.errors));
  }
  if (typeof result === 'number') return result;
  if (result && typeof result === 'object') return result.id || result.lead_id || null;
  return null;
}

async function syncLeads(origin, leads) {
  const cfg = await getConfig();

  // Registro local: solo cuenta como "ya enviado" si tiene ID remoto real.
  // Las entradas con destId nulo se reintentan (la búsqueda por título del
  // bridge y la auto-curación de abajo evitan duplicar).
  const sent = await readStorage(STORAGE.SENT, {});
  const knownDestId = (lead) => (sent[leadKey(origin, lead.id)] || {}).destId || null;
  const already = leads.filter(knownDestId).map((lead) => ({ srcId: lead.id, destId: knownDestId(lead) }));
  const pending = leads.filter((lead) => !knownDestId(lead));
  if (!pending.length) return { ok: true, created: [], already, portalUrl: cfg.portalUrl };

  try {
    await checkSession();
  } catch (err) {
    await addLog({ ok: false, name: '(sesión odoo.com)', origin, error: errMsg(err) });
    throw err;
  }

  const created = [];
  for (const lead of pending) {
    try {
      let destId = await createOppPortal(cfg, lead, origin);
      let warn = null;
      if (!destId) {
        // Auto-curación: la respuesta no traía el ID, pero la oportunidad
        // recién creada debe aparecer en el portal con este título (aún sin
        // email: el contacto se rellena después)
        destId = await findRemotePortalOpportunity(cfg, lead.name, null);
        if (!destId) warn = 'El portal no devolvió el ID remoto: usa Re-vincular más tarde';
      }
      if (destId) {
        try {
          await updateContactDetails(cfg, destId, lead);
        } catch (err) {
          warn = `Contacto no actualizado: ${errMsg(err)}`;
        }
      }
      await rememberSent(origin, lead.id, destId);
      created.push({ srcId: lead.id, destId });
      await addLog({ ok: true, name: lead.name, srcId: lead.id, destId, origin, warn });
    } catch (err) {
      await addLog({ ok: false, name: lead.name, srcId: lead.id, origin, error: errMsg(err) });
    }
  }
  if (created.length) flashBadge(String(created.length));
  return { ok: true, created, already, portalUrl: cfg.portalUrl };
}

// ───────────────────────── Búsqueda en el portal ─────────────────────────

/**
 * Tercera capa anti-duplicados: localiza la oportunidad en el portal.
 * website_crm_partner_assign concede a los usuarios portal LECTURA sobre
 * crm.lead (acotada por regla de registro a sus asignadas), así que se busca
 * con search_read y active_test:false (incluye perdidas), por criterios de
 * más a menos específicos:
 *   1. título + email  → mismo negocio, aunque cambie uno de los dos
 *   2. título          → comportamiento clásico
 *   3. email solo      → sobrevive a renombres del título, pero identifica
 *      al cliente y no al negocio: solo se acepta si la coincidencia es
 *      ÚNICA (si el cliente tiene varias oportunidades, es ambiguo).
 * La comprobación de reclamante (bridge) sigue siendo la guarda final.
 * Si la instancia no permite leer crm.lead, se cae al listado HTML.
 */
async function findRemotePortalOpportunity(cfg, title, email) {
  const name = String(title || '').trim();
  const mail = String(email || '').trim();
  if (!name && !mail) return null;

  const isOpportunity = ['type', '=', 'opportunity'];
  const byName = ['name', '=', name];
  const byEmail = ['email_from', '=ilike', escapeIlike(mail)];

  const attempts = [];
  if (name && mail) attempts.push({ domain: [byName, byEmail, isOpportunity], onlyIfUnique: false });
  if (name) attempts.push({ domain: [byName, isOpportunity], onlyIfUnique: false });
  if (mail) attempts.push({ domain: [byEmail, isOpportunity], onlyIfUnique: true });

  for (const { domain, onlyIfUnique } of attempts) {
    let rows;
    try {
      rows = await callKw(cfg.portalUrl, 'crm.lead', 'search_read', [], {
        domain,
        fields: ['id'],
        limit: 2,
        order: 'id desc',
        context: { active_test: false },
      });
    } catch {
      /* sin permiso de lectura en esa instancia: usar el listado HTML */
      return name ? findRemotePortalOpportunityHtml(cfg, name) : null;
    }
    if (!Array.isArray(rows)) break;
    if (rows.length === 1) return rows[0].id;
    if (rows.length > 1 && !onlyIfUnique) return rows[0].id;
    // >1 resultado con criterio de solo-email: ambiguo → probar siguiente/ninguno
  }
  return null;
}

/**
 * Fallback: el controlador de /my/opportunities no soporta búsqueda por
 * texto — solo sortby/filterby/paginación — así que se recorre el listado
 * ordenado por nombre (sortby=name) cortando al rebasar alfabéticamente el
 * título, y se repasa con filterby=lost (las perdidas no salen del activo).
 */
async function findRemotePortalOpportunityHtml(cfg, title) {
  const target = odooSlug(title);
  if (!target) return null;
  const base = stripTrailingSlash(cfg.portalUrl);

  for (const filterby of ['all', 'lost']) {
    for (let page = 1; page <= LIMITS.PORTAL_HTML_PAGES; page++) {
      const path = page === 1 ? '/my/opportunities' : `/my/opportunities/page/${page}`;
      const url = `${base}${path}?sortby=name${filterby === 'lost' ? '&filterby=lost' : ''}`;
      let html;
      try {
        const resp = await fetch(url, { credentials: 'include' });
        if (!resp.ok) break;
        html = await resp.text();
      } catch {
        break;
      }
      const entries = extractOpportunities(html);
      if (!entries.length) break; // fin del listado
      const hit = entries.find((entry) => entry.slug === target);
      if (hit) return hit.id;
      // Listado alfabético: si el último ya supera al objetivo, no está
      if (entries[entries.length - 1].slug > target) break;
    }
  }
  return null;
}

// ───────────────────────── Chatter remoto ─────────────────────────

/** Publica un comentario en el chatter de la oportunidad remota (portal). */
function postRemoteComment(cfg, destId, body) {
  return odooRpc(cfg.portalUrl, '/mail/message/post', {
    post_data: {
      body,
      email_add_signature: true,
      message_type: 'comment',
      subtype_xmlid: 'mail.mt_comment',
    },
    thread_id: destId,
    thread_model: 'crm.lead',
    context: {},
  });
}

/**
 * Lee el chatter completo de la oportunidad remota (payload crudo del
 * endpoint que responda). Devuelve null si ninguno funcionó.
 */
async function fetchRemoteChatter(cfg, destId) {
  const attempts = [
    // Odoo 18/19 saas (www.odoo.com actual)
    [
      '/mail/action',
      {
        fetch_params: [
          [
            '/mail/chatter_fetch',
            {
              thread_id: destId,
              thread_model: 'crm.lead',
              rating_include: true,
              fetch_params: { limit: LIMITS.REMOTE_CHATTER },
            },
            1,
          ],
        ],
        context: {},
      },
    ],
    // Portales más antiguos
    ['/mail/chatter_fetch', { res_model: 'crm.lead', res_id: destId, limit: LIMITS.REMOTE_CHATTER }],
  ];
  for (const [path, params] of attempts) {
    try {
      const result = await odooRpc(cfg.portalUrl, path, params);
      if (result !== undefined && result !== null) return result;
    } catch {
      /* probar el siguiente endpoint */
    }
  }
  return null;
}

/**
 * Ids de origen ya publicados en el chatter remoto (marcadores [src#id]).
 * Dedupe de envíos compartido entre navegadores/usuarios. Devuelve null si
 * no se pudo leer (se sigue con el registro local).
 */
async function fetchRemoteMarkers(cfg, destId) {
  const result = await fetchRemoteChatter(cfg, destId);
  if (result === null) return null;
  return new Set(collectIds(JSON.stringify(result), RE_SRC_MARKER));
}

/**
 * Sincroniza comentarios del lead de origen hacia la oportunidad remota.
 * Dedupe en dos capas: marcadores [src#id] leídos del chatter remoto
 * (compartido) + registro en chrome.storage (clave sentComments, local).
 */
async function syncComments(origin, leadId, destId, leadName, comments) {
  if (!destId || !Array.isArray(comments) || !comments.length) return { ok: true, posted: 0 };
  const cfg = await getConfig();
  const name = leadName || `lead #${leadId}`;

  const sentComments = await readStorage(STORAGE.SENT_COMMENTS, {});
  const key = leadKey(origin, leadId);
  const done = new Set(sentComments[key] || []);

  // Unión con lo ya publicado en el portal (por cualquier usuario/navegador)
  const remoteIds = await fetchRemoteMarkers(cfg, destId);
  if (remoteIds) for (const id of remoteIds) done.add(id);

  let posted = 0;
  for (const comment of comments) {
    if (!comment || !comment.id || !comment.body || done.has(comment.id)) continue;
    try {
      await postRemoteComment(cfg, destId, comment.body);
      done.add(comment.id);
      posted++;
    } catch (err) {
      await addLog({
        ok: false,
        name,
        srcId: leadId,
        origin,
        error: `Comentario no enviado: ${errMsg(err)}`,
      });
      break; // no insistir: probablemente fallarán todos igual
    }
  }

  sentComments[key] = [...done];
  await writeStorage(STORAGE.SENT_COMMENTS, sentComments);
  if (posted) {
    await addLog({ ok: true, name, srcId: leadId, destId, origin, action: 'comments', count: posted });
  }
  return { ok: true, posted };
}

// ───────────────────────── Listado del CRM ─────────────────────────

/**
 * Lista los leads/oportunidades activos del CRM de Octupus (con la sesión
 * del navegador, sin necesidad de pestaña abierta) y resuelve su estado de
 * sincronización con UNA sola consulta al chatter de todos ellos.
 */
async function listActiveLeads() {
  const cfg = await getConfig();
  let leads;
  try {
    leads = await callKw(cfg.crmUrl, 'crm.lead', 'search_read', [], {
      domain: [['type', 'in', ['lead', 'opportunity']]],
      fields: ['id', 'name', 'type', 'stage_id', 'partner_name', 'contact_name'],
      order: 'write_date desc',
      limit: LIMITS.LEADS_LIST,
    });
  } catch (err) {
    throw new Error(`CRM (${cfg.crmUrl}): ${errMsg(err)}`, { cause: err });
  }
  leads = leads || [];

  const syncedById = await fetchSyncState(
    cfg,
    leads.map((lead) => lead.id)
  );

  return {
    ok: true,
    crmUrl: cfg.crmUrl,
    leads: leads.map((lead) => ({
      id: lead.id,
      name: lead.name,
      type: lead.type,
      stage: (lead.stage_id && lead.stage_id[1]) || '',
      contact: lead.partner_name || lead.contact_name || '',
      synced: syncedById.get(lead.id) || null,
    })),
  };
}

/** Map leadId → destId a partir de las notas 🐙 de vinculación de esos leads. */
async function fetchSyncState(cfg, leadIds) {
  const syncedById = new Map();
  if (!leadIds.length) return syncedById;
  try {
    const notes = await callKw(cfg.crmUrl, 'mail.message', 'search_read', [], {
      domain: [
        ['model', '=', 'crm.lead'],
        ['res_id', 'in', leadIds],
        ['body', 'like', MARK.SIGNATURE],
        ['body', 'like', MARK.PORTAL_LINK],
      ],
      fields: ['res_id', 'body'],
      limit: LIMITS.LEADS_LIST_NOTES,
    });
    for (const note of notes || []) {
      const destId = linkedPortalId(note.body);
      if (destId && !syncedById.has(note.res_id)) syncedById.set(note.res_id, destId);
    }
  } catch {
    /* sin estado de sincronización: la lista sigue siendo útil */
  }
  return syncedById;
}
