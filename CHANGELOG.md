# Changelog

## 1.0.0 — 2026-07-27

Primera versión funcional.

### Sincronización de leads
- Detección automática de la conversión lead → oportunidad en Odoo
  (intercepta el wizard `crm.lead2opportunity.partner`, individual y masivo;
  compatible XHR y fetch, Odoo 13–18).
- Creación en el portal de partners de www.odoo.com vía
  `crm.lead/create_opp_portal` reutilizando la sesión del navegador
  (cookie `session_id`, sin clave API).
- Segundo paso de datos de contacto con
  `crm.lead/update_contact_details_from_portal` (país/provincia re-resueltos
  por código ISO entre bases de datos).
- Envío manual desde el popup para el lead abierto en la pestaña activa.
- Botón "Actualizar datos" para leads ya sincronizados.

### Trazabilidad y anti-duplicados
- Nota interna 🐙 en el chatter del lead de origen con el ID remoto y enlace
  al portal (vía `/mail/message/post`, con fallbacks).
- Anti-duplicados de leads en tres capas: nota del chatter (fuente de verdad
  compartida), búsqueda por título en `/my/opportunities` del portal
  (vincula sin duplicar) y almacenamiento local.

### Comentarios
- Sincronización de mensajes del chatter (comentarios 💬 y, opcionalmente,
  notas internas 📝) hacia la oportunidad remota, en texto plano con autor,
  fecha y marcador `[src#id]`.
- Dedupe compartido: lectura de marcadores `[src#id]` en el chatter remoto
  (`/mail/action` + `chatter_fetch`) más registro local auto-reparable.

### Interfaz
- Popup con estado de sesión de odoo.com, acción contextual
  (enviar/actualizar), historial de envíos y errores visibles.
- Opciones: URL del portal, etiqueta de origen, incluir notas internas,
  interruptor de sincronización automática y prueba de sesión.
