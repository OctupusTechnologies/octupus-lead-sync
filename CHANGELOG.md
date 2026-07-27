# Changelog

## 1.1.0 — 2026-07-27

### Añadido
- **Widget flotante** en el backend de Odoo (abajo a la derecha) al abrir un
  lead: muestra el estado de sincronización leído del chatter
  ("🐙 Enviar a odoo.com" / "🐙 Sincronizado · #ID") y permite enviar o
  actualizar datos y comentarios con un clic, con avisos de resultado.
  Clic en el estado verde abre la oportunidad en el portal. Sigue el
  cambio de registro de la SPA de Odoo sin recargar.

### Eliminado
- **Envío automático al convertir lead → oportunidad**: la sincronización es
  ahora 100% manual (widget o popup). Desaparecen `src/injector.js` (la
  intercepción de RPC) y el interruptor "Sincronización activada" de las
  opciones y el popup.

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
