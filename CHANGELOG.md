# Changelog

## 1.4.5 — 2026-07-27

### Corregido
- **Formato de las notas**: se publican ahora como HTML real vía
  `message_post(body_is_html=True)` (Odoo 17+), con `mail.message.create`
  directo como fallback (verificado en la instancia) y el texto plano como
  último recurso. Las notas traídas muestran encabezado en negrita y saltos
  de línea reales (antes los \n se colapsaban en un bloque), y las notas 🐙
  recuperan la negrita y el enlace clicable al portal.

## 1.4.4 — 2026-07-27

### Corregido
- **Orden cronológico en la traída**: los mensajes remotos llegan de nuevo a
  viejo y se publicaban tal cual, dejando la conversación invertida en el
  chatter del lead. Ahora se publican en orden cronológico.
- **Ventana de subida**: se enviaban los 50 mensajes más antiguos del lead
  (`id asc`), con lo que en hilos largos los recientes no viajaban nunca.
  Ahora se toman los 50 más recientes y se publican en orden.
- **Leads sin nombre de contacto**: `create_opp_portal` exige contact_name
  no vacío (verificado en el fuente del módulo); ahora hay fallback al
  email o a un guion, en vez de fallar con "All fields are required!".

## 1.4.3 — 2026-07-27

### Cambiado
- **Iconografía de botones** más clara: ⬆️/⬇️ para subir/bajar mensajes
  (convención upload/download), 📇 para actualizar el contacto, 🔗 para
  re-vincular, ⚠️ para el estado de error, y "↗" en la píldora verde para
  indicar que abre la oportunidad en el portal. Destino explícito en los
  textos ("a odoo.com" / "de odoo.com") y tooltips en todos los botones.

## 1.4.2 — 2026-07-27

### Corregido
- **Traer mensajes** ya incluye los correos del cliente (`message_type:
  'email'`), que antes se descartaban — solo entraban los comentarios del
  chatter.
- Los emails traídos se limpian: se elimina la cadena citada del mensaje
  anterior y los bloques ocultos (marcados con `data-o-mail-quote` /
  `display:none`), se normalizan los espacios duros y los mensajes de más
  de 4000 caracteres se recortan.

## 1.4.1 — 2026-07-27

### Corregido
- Al traer mensajes, el body del formato mail.Store (Odoo 18/19) llega como
  tupla `["markup", "<p>…</p>"]`: se desenvuelve correctamente (antes las
  notas traídas empezaban con el artefacto `markup,`).

## 1.4.0 — 2026-07-27

### Añadido
- **Traer mensajes** (widget y popup): nueva acción que importa los mensajes
  del chatter de la oportunidad remota como **notas internas** del lead de
  origen, con autor y fecha. Anti-eco y anti-duplicados simétricos al envío:
  los mensajes remotos con `[src#…]` o "Octupus Lead Sync" (nuestros propios
  envíos) nunca se traen; cada nota traída lleva `[odoo#<id remoto>]` y el
  texto "vía Octupus Lead Sync", con lo que el filtro de empuje la excluye
  (sin eco inverso) y el marcador evita traerla dos veces. Dedupe en dos
  capas: marcadores del chatter del lead (compartido) + registro local.

### Cambiado
- **Acciones separadas** para leads sincronizados: "↻ Actualizar datos"
  (solo contacto), "📤 Enviar mensajes" y "📥 Traer mensajes" — antes datos y
  mensajes iban juntos en un único botón. El envío inicial sigue haciendo el
  ciclo completo (crear + contacto + nota + empujar mensajes).

## 1.3.0 — 2026-07-27

### Añadido
- **Búsqueda por email**: la localización de oportunidades en el portal usa
  criterios escalonados — título+email (lo más específico), título solo, y
  email solo. El email sobrevive a renombres del título, pero identifica al
  cliente y no al negocio, así que la coincidencia por email solo se acepta
  cuando es única; si el cliente tiene varias oportunidades es ambiguo y no
  se vincula. Aplica al envío, al Re-vincular y a la auto-curación.

## 1.2.2 — 2026-07-27

### Cambiado
- **Búsqueda de oportunidades en el portal, vía rápida**: resulta que
  `website_crm_partner_assign` concede a los usuarios portal lectura sobre
  `crm.lead` (acotada por regla de registro a sus asignadas), así que la
  búsqueda por título ahora es un único `search_read` por nombre exacto con
  `active_test: false` (incluye perdidas) — una llamada JSON-RPC en lugar de
  recorrer hasta 20 páginas HTML. El recorrido del listado queda solo como
  fallback para instancias sin ese permiso. Ventaja extra: coincidencia por
  nombre real, no por aproximación de slug.

## 1.2.1 — 2026-07-27

### Corregido
- **Búsqueda de oportunidades en el portal**: el controlador real de
  `/my/opportunities` (website_crm_partner_assign) no soporta búsqueda por
  texto — el parámetro `search` que usábamos se ignoraba y solo se miraba la
  primera página. Ahora se recorre el listado ordenado por nombre
  (`sortby=name`, hasta 10 páginas, con corte alfabético) y se repasa además
  con `filterby=lost`, porque las oportunidades perdidas no aparecen en el
  listado activo y provocaban duplicados.

## 1.2.0 — 2026-07-27

Endurecimiento de la lógica tras auditoría completa.

### Corregido
- "No hay nota" y "no se pudo leer el chatter" ya no se confunden: ante un
  error de lectura, el widget muestra "Estado desconocido · reintentar" y el
  envío se cancela (antes podía ofrecer "Enviar" en un lead ya sincronizado
  y provocar duplicados).
- Ya no se publican notas 🐙 sin ID remoto (envenenaban la detección dejando
  el lead en un estado sin salida).
- "Actualizar datos" ya no borra campos remotos: solo se envían los campos
  con valor en el origen.
- Registro local: las entradas sin ID remoto se reintentan en vez de quedar
  bloqueadas; corregido un bug que descartaba el ID recién confirmado al
  actualizar; corregido el mensaje de error engañoso cuando falla la API de
  cookies.

### Añadido
- **Re-vincular** (widget y popup): vía de escape para leads con nota sin ID
  o con la oportunidad remota borrada — re-busca por título en el portal y
  reescribe la nota. Nunca crea nada.
- **Comprobación de reclamante** antes de vincular por título: si otro lead
  ya reclama esa oportunidad (nota 🐙 con su ID), se crea una nueva en lugar
  de mezclar dos negocios con el mismo título.
- **Auto-curación del ID**: si `create_opp_portal` no devuelve el ID, se
  recupera buscando la oportunidad recién creada en el portal.
- Detección del lead en rutas `/odoo/action-<id>/<record>` (leads abiertos
  desde smart buttons u otros menús en Odoo 17+), resolviendo el modelo de
  la acción vía `/web/action/load`.

### Cambiado
- La orquestación del envío pasa al content script (bridge), que es quien
  puede consultar el chatter de origen; el service worker queda como capa de
  operaciones contra el portal (`FIND_REMOTE`, `MARK_LINKED`, crear,
  contacto, comentarios).

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
