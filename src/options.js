'use strict';

const DEFAULTS = {
  enabled: true,
  portalUrl: 'https://www.odoo.com',
  sourceLabel: 'Octupus',
  syncNotes: true,
};

const $ = (id) => document.getElementById(id);

async function load() {
  const { config = {} } = await chrome.storage.local.get('config');
  const cfg = { ...DEFAULTS, ...config };
  $('portalUrl').value = cfg.portalUrl;
  $('sourceLabel').value = cfg.sourceLabel;
  $('enabled').checked = cfg.enabled;
  $('syncNotes').checked = cfg.syncNotes !== false;
}

function readForm() {
  return {
    enabled: $('enabled').checked,
    portalUrl: ($('portalUrl').value.trim() || DEFAULTS.portalUrl).replace(/\/+$/, ''),
    sourceLabel: $('sourceLabel').value.trim() || 'Octupus',
    syncNotes: $('syncNotes').checked,
  };
}

function setStatus(text, ok) {
  const el = $('status');
  el.textContent = text;
  el.className = ok === true ? 'ok' : ok === false ? 'error' : '';
}

$('save').addEventListener('click', async () => {
  const cfg = readForm();

  let originPattern;
  try {
    originPattern = new URL(cfg.portalUrl).origin + '/*';
  } catch (e) {
    setStatus('La URL del portal no es válida.', false);
    return;
  }
  // Pedir permiso de host si el portal no es *.odoo.com
  const has = await chrome.permissions.contains({ origins: [originPattern] });
  if (!has) {
    const granted = await chrome.permissions.request({ origins: [originPattern] });
    if (!granted) {
      await chrome.storage.local.set({ config: cfg });
      setStatus(`Guardado, pero sin permiso para ${originPattern} la sincronización fallará.`, false);
      return;
    }
  }

  await chrome.storage.local.set({ config: cfg });
  setStatus('Configuración guardada ✔', true);
});

$('test').addEventListener('click', async () => {
  setStatus('Comprobando sesión…');
  try {
    const res = await chrome.runtime.sendMessage({ type: 'CHECK_SESSION', config: readForm() });
    if (res && res.ok) {
      setStatus(`Sesión activa ✔ — conectado como ${res.username || 'uid ' + res.uid}`, true);
    } else {
      setStatus(`Error: ${(res && res.error) || 'sin respuesta'}`, false);
    }
  } catch (err) {
    setStatus(`Error: ${err.message || err}`, false);
  }
});

load();
