/**
 * Octupus Lead Sync — constantes, helpers puros y transporte JSON-RPC
 * compartidos por el service worker, el content script y las páginas.
 *
 * No hay bundler y los content scripts no admiten `import`, así que este
 * archivo se carga como script clásico en los tres contextos (importScripts en
 * el service worker, content_scripts.js en el bridge y <script> en popup y
 * opciones) y expone un único namespace inmutable: globalThis.OctupusShared.
 * Al no depender de chrome.* en la carga, también se puede requerir desde Node
 * para los tests (test/shared.test.js).
 *
 * Regla: aquí solo constantes y funciones sin estado ni DOM. Las únicas que
 * tocan APIs del navegador son jsonRpc (fetch) y las de chrome.storage.
 */
'use strict';

(() => {
  // ───────────────────────── Constantes ─────────────────────────

  /** Configuración por defecto (se mezcla con la guardada en storage). */
  const DEFAULTS = Object.freeze({
    portalUrl: 'https://www.odoo.com',
    crmUrl: 'https://octupus.odoo.com',
    sourceLabel: 'Octupus',
    syncNotes: true,
  });

  /** Tipos de mensaje entre popup, content script (bridge) y service worker. */
  const MSG = Object.freeze({
    // popup → service worker
    CHECK_SESSION: 'CHECK_SESSION',
    LIST_LEADS: 'LIST_LEADS',
    // bridge → service worker
    SYNC_LEADS: 'SYNC_LEADS',
    UPDATE_LEAD: 'UPDATE_LEAD',
    SYNC_COMMENTS: 'SYNC_COMMENTS',
    FIND_REMOTE: 'FIND_REMOTE',
    MARK_LINKED: 'MARK_LINKED',
    PULL_REMOTE_MESSAGES: 'PULL_REMOTE_MESSAGES',
    LOG: 'LOG',
    // popup → bridge (pestaña activa)
    GET_CURRENT_LEAD: 'GET_CURRENT_LEAD',
    SEND_CURRENT_LEAD: 'SEND_CURRENT_LEAD',
    UPDATE_CURRENT_LEAD: 'UPDATE_CURRENT_LEAD',
    PUSH_CURRENT_COMMENTS: 'PUSH_CURRENT_COMMENTS',
    PULL_CURRENT_COMMENTS: 'PULL_CURRENT_COMMENTS',
    RELINK_CURRENT_LEAD: 'RELINK_CURRENT_LEAD',
  });

  /** Claves de chrome.storage.local. */
  const STORAGE = Object.freeze({
    CONFIG: 'config',
    /** {"<origin>#<leadId>": {destId, at}} — leads enviados/vinculados. */
    SENT: 'sent',
    /** {"<origin>#<leadId>": [srcMsgId, …]} — mensajes ya subidos al portal. */
    SENT_COMMENTS: 'sentComments',
    /** {"<origin>#<leadId>": [remoteMsgId, …]} — mensajes ya traídos del portal. */
    PULLED: 'pulled',
    /** [{at, ok, name, …}] — historial del popup. */
    LOG: 'log',
  });

  /** Marcas de trazabilidad que la extensión deja en los chatters. */
  const MARK = Object.freeze({
    /** Firma presente en todas las notas de la extensión. */
    SIGNATURE: 'Octupus Lead Sync',
    /** Fragmento del enlace de la nota de vinculación (…/my/opportunity/<id>). */
    PORTAL_LINK: 'my/opportunity/',
    /** Marcador de mensaje subido al portal: [src#<id del mensaje origen>]. */
    SRC_PREFIX: '[src#',
    /** Marcador de mensaje traído del portal: [odoo#<id del mensaje remoto>]. */
    PULLED_PREFIX: '[odoo#',
  });

  const RE_PORTAL_LINK_ID = /my\/opportunity\/(\d+)/;
  const RE_SRC_MARKER = /\[src#(\d+)\]/g;
  const RE_PULLED_MARKER = /\[odoo#(\d+)\]/g;

  // ───────────────────────── Helpers puros ─────────────────────────

  /** Mensaje legible de cualquier cosa lanzada (Error, string, objeto…). */
  function errMsg(err) {
    return String((err && err.message) || err);
  }

  function stripTrailingSlash(url) {
    return String(url || '').replace(/\/+$/, '');
  }

  /** URL pública de una oportunidad en el portal de partners. */
  function portalOpportunityUrl(portalUrl, destId) {
    return `${stripTrailingSlash(portalUrl || DEFAULTS.portalUrl)}/${MARK.PORTAL_LINK}${destId}`;
  }

  /** Clave de un lead en los registros locales (por instancia de origen). */
  function leadKey(origin, leadId) {
    return `${origin}#${leadId}`;
  }

  /** Escapa texto para incrustarlo en un body HTML. */
  function escapeHtml(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /** Escapa los comodines de ilike (%, _) para una comparación literal. */
  function escapeIlike(value) {
    return String(value).replace(/([%_\\])/g, '\\$1');
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

  /** ¿Es una nota 📥 traída del portal? (cita URLs pero no vincula nada) */
  function isPulledNote(body) {
    return String(body || '').includes(MARK.PULLED_PREFIX);
  }

  /**
   * ID remoto que declara una nota 🐙 de vinculación, o null si el body no es
   * una nota de vinculación (p. ej. es una nota traída que cita la URL).
   */
  function linkedPortalId(body) {
    const text = String(body || '');
    if (isPulledNote(text)) return null;
    const m = text.match(RE_PORTAL_LINK_ID);
    return m ? parseInt(m[1], 10) : null;
  }

  /** Todos los ids capturados por una regex global (grupo 1) en un texto. */
  function collectIds(text, globalRegex) {
    const ids = [];
    for (const m of String(text || '').matchAll(globalRegex)) ids.push(parseInt(m[1], 10));
    return ids;
  }

  /** Extrae, en orden de aparición, los pares {slug, id} de los enlaces /my/opportunity/. */
  function extractOpportunities(html) {
    const out = [];
    const seen = new Set();
    const re = /\/my\/opportunity\/([^"'?#\s]+)/g;
    for (const m of String(html || '').matchAll(re)) {
      let segment = m[1];
      try {
        segment = decodeURIComponent(segment);
      } catch {
        /* segmento con % suelto: usar tal cual */
      }
      const parts = segment.match(/^(?:(.+)-)?(\d+)$/);
      if (!parts || !parts[1]) continue;
      const id = parseInt(parts[2], 10);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ slug: parts[1], id });
    }
    return out;
  }

  /**
   * Normaliza los mensajes del payload del chatter remoto a
   * {id, body, author, date}. Soporta el formato mail.Store de Odoo 18/19
   * ("mail.message" + "res.partner") y el clásico {messages: [...]}.
   * Solo conserva comment (chatter) y email (correos del cliente).
   */
  function parseRemoteMessages(result) {
    let messages = null;
    let partners = [];
    if (result && Array.isArray(result['mail.message'])) {
      messages = result['mail.message'];
      partners = Array.isArray(result['res.partner']) ? result['res.partner'] : [];
    } else if (result && Array.isArray(result.messages)) {
      messages = result.messages;
    }
    if (!messages) return [];

    const partnerName = (pid) => {
      const p = partners.find((x) => x && x.id === pid);
      return (p && (p.name || p.display_name)) || null;
    };

    return messages
      .map((m) => {
        if (!m || !m.id || !m.body) return null;
        if (m.message_type && m.message_type !== 'comment' && m.message_type !== 'email') return null;
        const body = normalizeMarkupBody(m.body);
        if (!body) return null;
        return {
          id: m.id,
          body,
          author: resolveAuthor(m, partnerName) || 'Odoo',
          date: m.date || m.datetime || '',
        };
      })
      .filter(Boolean);
  }

  /** En mail.Store el body llega como tupla ["markup", "<p>…</p>"]. */
  function normalizeMarkupBody(body) {
    if (Array.isArray(body)) {
      return body[0] === 'markup' && body.length > 1 ? body.slice(1).join('') : body.join('');
    }
    return typeof body === 'string' ? body : null;
  }

  /** Nombre del autor según las distintas formas en que llega en cada versión. */
  function resolveAuthor(m, partnerName) {
    if (Array.isArray(m.author_id)) return m.author_id[1];
    if (m.author && typeof m.author === 'object') return m.author.name || partnerName(m.author.id);
    if (typeof m.author_id === 'number') return partnerName(m.author_id);
    if (m.author_id && typeof m.author_id === 'object')
      return m.author_id.name || partnerName(m.author_id.id);
    return null;
  }

  // ───────────────────────── Transporte JSON-RPC ─────────────────────────

  let rpcId = 1;

  /**
   * Llamada JSON-RPC a Odoo. Odoo devuelve los errores con HTTP 200 y un
   * objeto `error` en el JSON, así que se parsea siempre el cuerpo y el código
   * HTTP solo se usa cuando la respuesta no es JSON (login HTML, 404, 500…).
   * La sesión caducada (código 100) se traduce a un mensaje accionable.
   */
  async function jsonRpc(url, params, { credentials = 'include' } = {}) {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials,
      body: JSON.stringify({ id: rpcId++, jsonrpc: '2.0', method: 'call', params }),
    });
    const host = new URL(url).host;
    const text = await resp.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(
        resp.ok
          ? `Respuesta no JSON de ${host}: probablemente no hay sesión iniciada`
          : `HTTP ${resp.status} al llamar a ${url}`
      );
    }
    if (json.error) {
      const message = (json.error.data && json.error.data.message) || json.error.message || 'Error JSON-RPC';
      if (json.error.code === 100 || /session/i.test(message)) {
        throw new Error(`Sesión de ${host} caducada: vuelve a iniciar sesión en esa web`);
      }
      throw new Error(message);
    }
    return json.result;
  }

  // ───────────────────────── chrome.storage ─────────────────────────

  async function readStorage(key, fallback) {
    const data = await chrome.storage.local.get(key);
    return data[key] === undefined ? fallback : data[key];
  }

  function writeStorage(key, value) {
    return chrome.storage.local.set({ [key]: value });
  }

  /** Configuración efectiva: valores por defecto + lo guardado en Opciones. */
  async function getConfig() {
    const stored = await readStorage(STORAGE.CONFIG, {});
    return { ...DEFAULTS, ...stored };
  }

  globalThis.OctupusShared = Object.freeze({
    DEFAULTS,
    MSG,
    STORAGE,
    MARK,
    RE_SRC_MARKER,
    RE_PULLED_MARKER,
    errMsg,
    stripTrailingSlash,
    portalOpportunityUrl,
    leadKey,
    escapeHtml,
    escapeIlike,
    odooSlug,
    isPulledNote,
    linkedPortalId,
    collectIds,
    extractOpportunities,
    parseRemoteMessages,
    jsonRpc,
    readStorage,
    writeStorage,
    getConfig,
  });
})();
