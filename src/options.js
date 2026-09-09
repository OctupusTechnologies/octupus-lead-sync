/**
 * Octupus Lead Sync — página de opciones
 *
 * Guarda la configuración en chrome.storage.local y pide permiso de host para
 * los orígenes que no cubre el manifest (*.odoo.com). Requiere shared.js.
 */
'use strict';

const { DEFAULTS, MSG, STORAGE, errMsg, stripTrailingSlash, getConfig, writeStorage } =
  globalThis.OctupusShared;

const $ = (id) => document.getElementById(id);

async function load() {
  const cfg = await getConfig();
  $('portalUrl').value = cfg.portalUrl;
  $('crmUrl').value = cfg.crmUrl;
  $('sourceLabel').value = cfg.sourceLabel;
  $('syncNotes').checked = cfg.syncNotes !== false;
}

function readForm() {
  return {
    portalUrl: stripTrailingSlash($('portalUrl').value.trim() || DEFAULTS.portalUrl),
    crmUrl: stripTrailingSlash($('crmUrl').value.trim() || DEFAULTS.crmUrl),
    sourceLabel: $('sourceLabel').value.trim() || DEFAULTS.sourceLabel,
    syncNotes: $('syncNotes').checked,
  };
}

function setStatus(text, ok) {
  const node = $('status');
  node.textContent = text;
  node.className = ok === true ? 'ok' : ok === false ? 'error' : '';
}

/** Patrón de host permission de una URL http(s) válida, o null. */
function originPattern(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return `${parsed.origin}/*`;
  } catch {
    return null;
  }
}

$('save').addEventListener('click', async () => {
  const cfg = readForm();

  // Tanto el portal como el CRM se consultan desde el service worker: ambos
  // necesitan permiso de host si no son *.odoo.com
  const origins = [...new Set([originPattern(cfg.portalUrl), originPattern(cfg.crmUrl)])];
  if (origins.some((origin) => !origin)) {
    setStatus('Las URL del portal y del CRM deben ser direcciones http(s) válidas.', false);
    return;
  }

  let granted;
  try {
    granted = await chrome.permissions.contains({ origins });
    if (!granted) granted = await chrome.permissions.request({ origins });
  } catch (err) {
    setStatus(`Error al pedir permisos: ${errMsg(err)}`, false);
    return;
  }

  await writeStorage(STORAGE.CONFIG, cfg);
  if (!granted) {
    setStatus(`Guardado, pero sin permiso para ${origins.join(', ')} la sincronización fallará.`, false);
    return;
  }
  setStatus('Configuración guardada ✔', true);
});

$('test').addEventListener('click', async () => {
  setStatus('Comprobando sesión…');
  try {
    const res = await chrome.runtime.sendMessage({ type: MSG.CHECK_SESSION, config: readForm() });
    if (res && res.ok) {
      setStatus(`Sesión activa ✔ — conectado como ${res.username || `uid ${res.uid}`}`, true);
    } else {
      setStatus(`Error: ${(res && res.error) || 'sin respuesta'}`, false);
    }
  } catch (err) {
    setStatus(`Error: ${errMsg(err)}`, false);
  }
});

load();
