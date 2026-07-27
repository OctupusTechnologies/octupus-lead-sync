/**
 * Octupus Lead Sync — injector (MAIN world)
 *
 * Se ejecuta en el contexto de la página de Odoo y parchea XMLHttpRequest y
 * fetch para detectar la llamada RPC que confirma la conversión de un lead
 * a oportunidad (wizard crm.lead2opportunity.partner). Cuando la detecta,
 * avisa al content script aislado (bridge.js) vía window.postMessage.
 */
(() => {
  'use strict';

  const WIZARD_MODELS = ['crm.lead2opportunity.partner', 'crm.lead2opportunity.partner.mass'];
  const WIZARD_METHODS = ['action_apply', 'action_mass_convert'];

  function isRpcUrl(url) {
    return (
      typeof url === 'string' &&
      (url.includes('/web/dataset/call_button') || url.includes('/web/dataset/call_kw'))
    );
  }

  function extractLeadIds(payload) {
    try {
      const p = payload && payload.params;
      if (!p || !p.model || !p.method) return null;

      let matched = false;
      let ids = [];

      if (WIZARD_MODELS.includes(p.model) && WIZARD_METHODS.includes(p.method)) {
        matched = true;
        const ctx = (p.kwargs && p.kwargs.context) || {};
        if (Array.isArray(ctx.active_ids) && ctx.active_ids.length) ids = ctx.active_ids;
        else if (ctx.active_id) ids = [ctx.active_id];
      } else if (p.model === 'crm.lead' && p.method === 'convert_opportunity') {
        matched = true;
        if (Array.isArray(p.args) && Array.isArray(p.args[0])) ids = p.args[0];
      }

      if (!matched) return null;
      ids = ids.filter((id) => Number.isInteger(id));
      return ids.length ? ids : null;
    } catch (e) {
      return null;
    }
  }

  function handleResponse(url, requestBody, responseText) {
    if (!isRpcUrl(url) || !requestBody) return;
    let payload;
    try {
      payload = JSON.parse(requestBody);
    } catch (e) {
      return;
    }
    const leadIds = extractLeadIds(payload);
    if (!leadIds) return;

    // Si la respuesta contiene un error de Odoo, la conversión falló: no avisar.
    try {
      const res = JSON.parse(responseText);
      if (res && res.error) return;
    } catch (e) {
      /* respuesta no-JSON: asumimos éxito HTTP */
    }

    window.postMessage({ type: 'OCTUPUS_LEAD_CONVERTED', leadIds }, window.location.origin);
  }

  // --- Parche de XMLHttpRequest (Odoo 13-16 usa XHR para RPC) ---
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__octupusUrl = url;
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    if (isRpcUrl(this.__octupusUrl) && typeof body === 'string') {
      const reqUrl = this.__octupusUrl;
      const reqBody = body;
      this.addEventListener('load', function () {
        if (this.status !== 200) return;
        let text = '';
        try {
          text = this.responseText;
        } catch (e) {
          /* responseType no textual */
        }
        handleResponse(reqUrl, reqBody, text);
      });
    }
    return origSend.apply(this, arguments);
  };

  // --- Parche de fetch (Odoo 17+ usa fetch para RPC) ---
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input && input.url;
    const body = init && typeof init.body === 'string' ? init.body : null;
    const promise = origFetch.apply(this, arguments);

    if (isRpcUrl(url) && body) {
      promise
        .then((resp) => {
          if (!resp.ok) return;
          resp
            .clone()
            .text()
            .then((text) => handleResponse(url, body, text))
            .catch(() => {});
        })
        .catch(() => {});
    }
    return promise;
  };
})();
