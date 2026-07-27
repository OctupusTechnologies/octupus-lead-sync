/**
 * Octupus Lead Sync — service worker
 *
 * Recibe los leads convertidos desde bridge.js y los crea en el portal de
 * partners de www.odoo.com mediante crm.lead/create_opp_portal, reutilizando
 * la sesión (cookie session_id) que el usuario ya tiene iniciada en odoo.com.
 *
 * No se necesita clave API: al tener la extensión permiso de host sobre
 * *.odoo.com, los fetch con credentials:'include' adjuntan la cookie de
 * sesión automáticamente.
 */
'use strict';

const DEFAULTS = {
  portalUrl: 'https://www.odoo.com',
  sourceLabel: 'Octupus',
};

let rpcId = 1;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'SYNC_LEADS') {
    syncLeads(msg.origin, msg.leads)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: errMsg(err) }));
    return true; // respuesta asíncrona
  }
  if (msg && msg.type === 'UPDATE_LEAD') {
    updateLead(msg.origin, msg.lead, msg.destId)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: errMsg(err) }));
    return true;
  }
  if (msg && msg.type === 'SYNC_COMMENTS') {
    syncComments(msg.origin, msg.leadId, msg.destId, msg.leadName, msg.comments)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, posted: 0, error: errMsg(err) }));
    return true;
  }
  if (msg && msg.type === 'FIND_REMOTE') {
    (async () => {
      const cfg = await getConfig();
      const destId = await findRemotePortalOpportunity(cfg, msg.title);
      return { ok: true, destId, portalUrl: cfg.portalUrl };
    })()
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: errMsg(err) }));
    return true;
  }
  if (msg && msg.type === 'MARK_LINKED') {
    (async () => {
      const cfg = await getConfig();
      const { sent = {} } = await chrome.storage.local.get('sent');
      const key = `${msg.origin}#${msg.leadId}`;
      const prev = sent[key] || {};
      sent[key] = { ...prev, destId: msg.destId, at: prev.at || new Date().toISOString() };
      await chrome.storage.local.set({ sent });
      await addLog({
        ok: true,
        name: msg.name || `lead #${msg.leadId}`,
        srcId: msg.leadId,
        destId: msg.destId,
        origin: msg.origin,
        action: 'link',
      });
      return { ok: true, portalUrl: cfg.portalUrl };
    })()
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: errMsg(err) }));
    return true;
  }
  if (msg && msg.type === 'LOG') {
    addLog(msg.entry || {})
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (msg && msg.type === 'CHECK_SESSION') {
    checkSession(msg.config)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: errMsg(err) }));
    return true;
  }
  return false;
});

function errMsg(err) {
  return String((err && err.message) || err);
}

async function getConfig() {
  const stored = await chrome.storage.local.get('config');
  return { ...DEFAULTS, ...(stored.config || {}) };
}

async function portalRpc(baseUrl, path, params) {
  const url = baseUrl.replace(/\/+$/, '') + path;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ id: rpcId++, jsonrpc: '2.0', method: 'call', params }),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} al llamar a ${url}`);

  const text = await resp.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`Respuesta no JSON de ${url}: probablemente no hay sesión iniciada en odoo.com`);
  }
  if (json.error) {
    const msg = (json.error.data && json.error.data.message) || json.error.message || 'Error JSON-RPC';
    if (json.error.code === 100 || /session/i.test(msg)) {
      throw new Error('Sesión de odoo.com caducada: vuelve a iniciar sesión en www.odoo.com');
    }
    throw new Error(msg);
  }
  return json.result;
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
  } catch (e) {
    /* sin acceso a la API de cookies para ese host: lo verificará get_session_info */
  }
  if (cookieChecked && cookie === null) {
    throw new Error(`No hay cookie de sesión para ${cfg.portalUrl}. Inicia sesión en esa web con este perfil de Chrome.`);
  }

  const info = await portalRpc(cfg.portalUrl, '/web/session/get_session_info', {});
  if (!info || !info.uid) {
    throw new Error('La sesión de odoo.com no es válida o ha caducado. Vuelve a iniciar sesión.');
  }
  return { ok: true, uid: info.uid, username: info.username || info.name || '' };
}

/**
 * create_opp_portal solo acepta title, contact_name y description (los campos
 * del formulario del portal), así que el resto de datos del lead se vuelca
 * en la descripción para no perder información.
 */
function buildPortalValues(lead, origin, sourceLabel) {
  const datos = [];
  if (lead.partner_name) datos.push(`Empresa: ${lead.partner_name}`);
  if (lead.email_from) datos.push(`Email: ${lead.email_from}`);
  if (lead.phone) datos.push(`Teléfono: ${lead.phone}`);
  if (lead.mobile) datos.push(`Móvil: ${lead.mobile}`);
  if (lead.website) datos.push(`Web: ${lead.website}`);
  const direccion = [lead.street, lead.street2, lead.zip, lead.city].filter(Boolean).join(', ');
  if (direccion) datos.push(`Dirección: ${direccion}`);
  if (lead.country_id) datos.push(`País: ${lead.country_id[1]}`);
  if (lead.expected_revenue) datos.push(`Ingreso esperado: ${lead.expected_revenue}`);
  if (lead.user_id) datos.push(`Comercial: ${lead.user_id[1]}`);

  const partes = [];
  if (lead.description) partes.push(lead.description, '');
  if (datos.length) partes.push(datos.join('\n'), '');
  partes.push(`Origen: ${sourceLabel || 'Octupus'}`);
  partes.push(`Sincronizado desde ${origin} (lead #${lead.id})`);
  partes.push(`${origin}/web#id=${lead.id}&model=crm.lead&view_type=form`);

  return {
    title: lead.name,
    contact_name: lead.contact_name || lead.partner_name || '',
    description: partes.join('\n'),
  };
}

// Los ids de país/provincia difieren entre bases de datos: se resuelven en
// odoo.com por código ISO (leído del origen por bridge.js) y se cachean.
const destCountryCache = new Map();
const destStateCache = new Map();

async function resolveDestCountryId(cfg, code) {
  if (!code) return null;
  const key = `${cfg.portalUrl}#${code}`;
  if (destCountryCache.has(key)) return destCountryCache.get(key);
  let id = null;
  try {
    const rows = await portalRpc(cfg.portalUrl, '/web/dataset/call_kw/res.country/search_read', {
      model: 'res.country',
      method: 'search_read',
      args: [],
      kwargs: { domain: [['code', '=', code]], fields: ['id'], limit: 1, context: {} },
    });
    id = rows && rows.length ? rows[0].id : null;
  } catch (e) {
    id = null;
  }
  destCountryCache.set(key, id);
  return id;
}

async function resolveDestStateId(cfg, countryId, code, name) {
  if (!countryId || (!code && !name)) return null;
  const key = `${cfg.portalUrl}#${countryId}#${code || ''}#${name || ''}`;
  if (destStateCache.has(key)) return destStateCache.get(key);
  let id = null;
  const domains = [];
  if (code) domains.push([['country_id', '=', countryId], ['code', '=', code]]);
  if (name) domains.push([['country_id', '=', countryId], ['name', '=', name]]);
  for (const domain of domains) {
    try {
      const rows = await portalRpc(cfg.portalUrl, '/web/dataset/call_kw/res.country.state/search_read', {
        model: 'res.country.state',
        method: 'search_read',
        args: [],
        kwargs: { domain, fields: ['id'], limit: 1, context: {} },
      });
      if (rows && rows.length) {
        id = rows[0].id;
        break;
      }
    } catch (e) {
      /* probar el siguiente criterio */
    }
  }
  destStateCache.set(key, id);
  return id;
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
  const candidatos = {
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
  const values = {};
  for (const [campo, valor] of Object.entries(candidatos)) {
    if (valor) values[campo] = valor;
  }
  if (!Object.keys(values).length) return;
  await portalRpc(cfg.portalUrl, '/web/dataset/call_kw/crm.lead/update_contact_details_from_portal', {
    model: 'crm.lead',
    method: 'update_contact_details_from_portal',
    args: [[destId], values],
    kwargs: { context: {} },
  });
}

/** Actualización manual (botón del popup) de un lead ya sincronizado. */
async function updateLead(origin, lead, destId) {
  const cfg = await getConfig();
  await checkSession();
  await updateContactDetails(cfg, destId, lead);
  const { sent = {} } = await chrome.storage.local.get('sent');
  const prev = sent[`${origin}#${lead.id}`] || {};
  sent[`${origin}#${lead.id}`] = { ...prev, destId, at: prev.at || new Date().toISOString() };
  await chrome.storage.local.set({ sent });
  await addLog({ ok: true, name: lead.name, srcId: lead.id, destId, origin, action: 'update' });
  return { ok: true, destId };
}

/** Aproximación del slugify de Odoo para comparar títulos con URLs del portal. */
function odooSlug(text) {
  return String(text || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function matchOpportunityInHtml(html, name) {
  const target = odooSlug(name);
  if (!target) return null;
  const re = /\/my\/opportunity\/([^"'?#\s]+)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    let seg = m[1];
    try {
      seg = decodeURIComponent(seg);
    } catch (e) {
      /* segmento con % suelto: usar tal cual */
    }
    const parts = seg.match(/^(?:(.+)-)?(\d+)$/);
    if (!parts || !parts[1]) continue;
    if (parts[1] === target) return parseInt(parts[2], 10);
  }
  return null;
}

/**
 * Tercera capa anti-duplicados: busca la oportunidad en el listado del portal
 * (/my/opportunities) por título. Un usuario portal no puede hacer search_read
 * sobre crm.lead en odoo.com, así que se busca en el HTML del portal y se
 * compara el slug del enlace con el del título (coincidencia exacta).
 */
async function findRemotePortalOpportunity(cfg, title) {
  const name = String(title || '').trim();
  if (!name) return null;
  const base = cfg.portalUrl.replace(/\/+$/, '');
  const urls = [
    `${base}/my/opportunities?search_in=all&search=${encodeURIComponent(name)}`,
    `${base}/my/opportunities`,
  ];
  for (const url of urls) {
    try {
      const resp = await fetch(url, { credentials: 'include' });
      if (!resp.ok) continue;
      const id = matchOpportunityInHtml(await resp.text(), name);
      if (id) return id;
    } catch (e) {
      /* probar la siguiente URL */
    }
  }
  return null;
}

async function createOppPortal(cfg, lead, origin) {
  const result = await portalRpc(cfg.portalUrl, '/web/dataset/call_kw/crm.lead/create_opp_portal', {
    model: 'crm.lead',
    method: 'create_opp_portal',
    args: [buildPortalValues(lead, origin, cfg.sourceLabel)],
    kwargs: { context: {} },
  });
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
  const { sent = {} } = await chrome.storage.local.get('sent');
  const already = leads
    .filter((l) => sent[`${origin}#${l.id}`] && sent[`${origin}#${l.id}`].destId)
    .map((l) => ({ srcId: l.id, destId: sent[`${origin}#${l.id}`].destId }));
  const pending = leads.filter((l) => !(sent[`${origin}#${l.id}`] && sent[`${origin}#${l.id}`].destId));
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
        // recién creada debe aparecer en el portal con este título
        destId = await findRemotePortalOpportunity(cfg, lead.name);
        if (!destId) warn = 'El portal no devolvió el ID remoto: usa Re-vincular más tarde';
      }
      if (destId) {
        try {
          await updateContactDetails(cfg, destId, lead);
        } catch (err) {
          warn = `Contacto no actualizado: ${errMsg(err)}`;
        }
      }
      sent[`${origin}#${lead.id}`] = { destId, at: new Date().toISOString() };
      created.push({ srcId: lead.id, destId });
      await addLog({ ok: true, name: lead.name, srcId: lead.id, destId, origin, warn });
    } catch (err) {
      await addLog({ ok: false, name: lead.name, srcId: lead.id, origin, error: errMsg(err) });
    }
  }
  await chrome.storage.local.set({ sent });
  if (created.length) flashBadge(String(created.length));
  return { ok: true, created, already, portalUrl: cfg.portalUrl };
}

/** Publica un comentario en el chatter de la oportunidad remota (portal). */
function postRemoteComment(cfg, destId, body) {
  return portalRpc(cfg.portalUrl, '/mail/message/post', {
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
 * Lee el chatter de la oportunidad remota y devuelve los ids de origen ya
 * publicados (marcadores [src#id] en los cuerpos). Así el dedupe de
 * comentarios es compartido entre navegadores/usuarios, no solo local.
 * Devuelve null si no se pudo leer (se sigue con el registro local).
 */
async function fetchRemoteMarkers(cfg, destId) {
  const intentos = [
    // Odoo 18/19 saas (www.odoo.com actual)
    [
      '/mail/action',
      {
        fetch_params: [
          [
            '/mail/chatter_fetch',
            { thread_id: destId, thread_model: 'crm.lead', rating_include: true, fetch_params: { limit: 100 } },
            1,
          ],
        ],
        context: {},
      },
    ],
    // Portales más antiguos
    ['/mail/chatter_fetch', { res_model: 'crm.lead', res_id: destId, limit: 100 }],
  ];
  for (const [path, params] of intentos) {
    try {
      const result = await portalRpc(cfg.portalUrl, path, params);
      if (result === undefined || result === null) continue;
      const ids = new Set();
      const re = /\[src#(\d+)\]/g;
      const text = JSON.stringify(result);
      let m;
      while ((m = re.exec(text)) !== null) ids.add(parseInt(m[1], 10));
      return ids;
    } catch (e) {
      /* probar el siguiente endpoint */
    }
  }
  return null;
}

/**
 * Sincroniza comentarios del lead de origen hacia la oportunidad remota.
 * Dedupe en dos capas: marcadores [src#id] leídos del chatter remoto
 * (compartido) + registro en chrome.storage (clave sentComments, local).
 */
async function syncComments(origin, leadId, destId, leadName, comments) {
  if (!destId || !Array.isArray(comments) || !comments.length) return { ok: true, posted: 0 };
  const cfg = await getConfig();

  const { sentComments = {} } = await chrome.storage.local.get('sentComments');
  const key = `${origin}#${leadId}`;
  const done = new Set(sentComments[key] || []);

  // Unión con lo ya publicado en el portal (por cualquier usuario/navegador)
  const remotos = await fetchRemoteMarkers(cfg, destId);
  if (remotos) for (const id of remotos) done.add(id);

  let posted = 0;
  for (const c of comments) {
    if (!c || !c.id || !c.body || done.has(c.id)) continue;
    try {
      await postRemoteComment(cfg, destId, c.body);
      done.add(c.id);
      posted++;
    } catch (err) {
      await addLog({
        ok: false,
        name: leadName || `lead #${leadId}`,
        srcId: leadId,
        origin,
        error: `Comentario no enviado: ${errMsg(err)}`,
      });
      break; // no insistir: probablemente fallarán todos igual
    }
  }

  sentComments[key] = [...done];
  await chrome.storage.local.set({ sentComments });
  if (posted) {
    await addLog({
      ok: true,
      name: leadName || `lead #${leadId}`,
      srcId: leadId,
      destId,
      origin,
      action: 'comments',
      count: posted,
    });
  }
  return { ok: true, posted };
}

async function addLog(entry) {
  const { log = [] } = await chrome.storage.local.get('log');
  log.unshift({ at: new Date().toISOString(), ...entry });
  await chrome.storage.local.set({ log: log.slice(0, 50) });
}

function flashBadge(text) {
  chrome.action.setBadgeBackgroundColor({ color: '#2e7d32' });
  chrome.action.setBadgeText({ text });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 8000);
}
