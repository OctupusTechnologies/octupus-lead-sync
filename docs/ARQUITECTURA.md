# 🐙 Octupus Lead Sync — Extensión de Chrome

Extensión para enviar **leads del CRM de Odoo** (p. ej. `octupus.odoo.com`)
al **portal de partners de www.odoo.com** con un clic, usando el método
`crm.lead/create_opp_portal` y reutilizando la sesión que ya tienes iniciada
en odoo.com. El envío es **siempre manual**: tú decides qué lead viaja y
cuándo.

## Cómo funciona

1. Al abrir un lead en el backend de Odoo aparece un **widget flotante**
   (abajo a la derecha) que consulta el chatter y muestra el estado:
   **"🐙 Enviar lead a odoo.com"** si no está sincronizado, o
   **"🐙 Sincronizado · #ID"** (clic → abre la oportunidad en el portal) con
   tres acciones separadas si ya lo está: actualizar contacto, enviar
   mensajes y traer mensajes (ver [Uso](#uso)).
2. Al pulsar Enviar, lee los datos del lead usando **tu propia sesión de
   Odoo** (no necesita credenciales de la instancia origen).
3. El service worker crea la oportunidad en el portal de partners con:
   ```
   POST https://www.odoo.com/web/dataset/call_kw/crm.lead/create_opp_portal
   ```
   **Sin clave API**: el portal de odoo.com no la permite, así que la petición
   se hace con `credentials: 'include'` y Chrome adjunta automáticamente la
   cookie `session_id` de tu sesión de odoo.com (la extensión tiene permiso
   de host sobre `*.odoo.com`, por lo que la petición se trata como de
   primera parte). Antes de enviar, valida la sesión con
   `/web/session/get_session_info` y avisa si no estás logueado.
4. `create_opp_portal` solo acepta `title`, `contact_name` y `description`,
   así que a continuación se rellenan los **datos de contacto** con un
   segundo paso: `crm.lead/update_contact_details_from_portal` (nombre,
   email, teléfono, calle, ciudad, CP, provincia y país). Los ids de
   país/provincia difieren entre bases de datos, por lo que se leen sus
   códigos ISO en el origen y se re-resuelven en odoo.com. El resto del lead
   (móvil, web, ingreso esperado, comercial, enlace al original) va en la
   descripción, junto a la línea `Origen: Octupus`.
5. Tras cada envío correcto deja una **nota interna en el chatter del lead
   de origen** con el ID remoto y el enlace `…/my/opportunity/<id>` del
   portal.
5b. **Comentarios**: tras el envío inicial, o al pulsar **"⬆️ Enviar mensajes
   a odoo.com"**, los mensajes del chatter del lead se publican en el chatter
   de la oportunidad remota vía `/mail/message/post`, en texto plano con
   autor, fecha y marcador `[src#id]`. Se envían los comentarios públicos (💬,
   "Enviar mensaje") y, con la opción "Enviar también las notas internas"
   activada (por defecto sí), las notas (📝, "Registrar nota"). Las notas de la
   propia extensión y las notificaciones de sistema nunca se envían. Dedupe en
   dos capas: antes de publicar se leen los últimos 100 mensajes del chatter
   remoto y se extraen los marcadores `[src#id]` ya presentes (compartido
   entre usuarios/navegadores), más el registro en almacenamiento local. Ojo:
   publicar como comentario puede notificar por email a los seguidores de la
   oportunidad en odoo.com (p. ej. tu account manager). 6. Anti-duplicados en
   tres capas: - **Chatter (fuente de verdad)**: antes de enviar se busca la
   nota "Octupus Lead Sync" en el lead y se extrae el ID remoto; si existe, no
   se reenvía (aunque lo haya enviado otro compañero desde su navegador). -
   **Portal de odoo.com**: `website_crm_partner_assign` concede a los usuarios
   portal lectura sobre `crm.lead` (limitada a sus oportunidades asignadas),
   así que se busca con `search_read` y `active_test: false` (incluye las
   perdidas), por criterios escalonados: **título + email**, **título**, y
   **email solo** (este último únicamente si la coincidencia es única — el
   email identifica al cliente, no al negocio). Si la instancia no lo permite,
   se recorre el listado HTML como fallback. Si hay coincidencia **y ningún
   otro lead reclama ya ese ID** (se comprueba en las notas 🐙 del origen), se
   **vincula** la oportunidad existente sin crear duplicado y sin tocar los
   datos remotos. Si otro lead la reclama, se asume que es un negocio distinto
   con el mismo título y se crea una nueva. - **Almacenamiento local** de la
   extensión, como última capa.

   Seguridad ante fallos: si el chatter del lead no se puede leer, el envío
   se **cancela** (el widget muestra "Estado desconocido · reintentar") —
   nunca se crea "a ciegas". Y si el portal no devuelve el ID al crear, se
   recupera buscando la oportunidad recién creada por título.

7. **Re-vincular** (vía de escape): si una nota quedó sin ID remoto o la
   oportunidad se borró en el portal, el botón "🔗 Re-vincular con el portal"
   (widget y popup) re-busca por título y reescribe la nota con el ID. Nunca
   crea nada nuevo; si no encuentra la oportunidad, indica cómo proceder.

## Requisito único

Estar **logueado en www.odoo.com** (portal de partners) y en el CRM de
origen en el mismo perfil de Chrome. La extensión comprueba la sesión del
portal y te avisa en el popup si falta o ha caducado; si la del CRM falta,
las acciones lo indican con un mensaje claro.

## Instalación

1. Descarga el ZIP de la [última release](https://github.com/OctupusTechnologies/octupus-lead-sync/releases/latest/download/octupus-lead-sync.zip)
   (o clona el repositorio) y descomprímelo.
2. Abre Chrome y ve a `chrome://extensions`.
3. Activa el **Modo de desarrollador** (esquina superior derecha).
4. Pulsa **"Cargar descomprimida"** y selecciona la carpeta que contiene
   `manifest.json`.

## Configuración

Clic derecho en el icono → **Opciones** (o botón del popup):

- **URL del portal**: `https://www.odoo.com` (valor por defecto).
- **URL del CRM de Octupus**: `https://octupus.odoo.com` (valor por
  defecto). La usa el service worker para el listado de leads activos del
  popup, que funciona sin pestaña de Odoo abierta.
- **Etiqueta de origen**: texto añadido como `Origen: …` en la descripción
  (por defecto "Octupus").
- **Enviar también las notas internas como comentarios** (activado por
  defecto): incluye las notas 📝 del chatter en lo que se sube al portal,
  además de los comentarios 💬.
- **Probar sesión**: verifica que la cookie de odoo.com es válida y muestra
  con qué usuario estás conectado.

Al guardar se valida que las dos URLs sean http(s) y, si alguna no está bajo
`*.odoo.com`, Chrome pide el permiso de host de ese dominio
(`optional_host_permissions` del manifest). Sin ese permiso la sincronización
con ese dominio falla, y la página de Opciones lo avisa.

## Uso

**Widget flotante (recomendado)**: abre cualquier lead en Odoo (vista
formulario). Abajo a la derecha aparece el widget:

- **"🐙 Enviar a odoo.com"** (morado) → crea la oportunidad en el portal,
  rellena el contacto, deja la nota y sincroniza los comentarios.
- **"🐙 Sincronizado · #ID ↗"** (verde) → el lead ya está en el portal; clic
  para abrir la oportunidad. Debajo, tres acciones separadas:
  - **"📇 Actualizar contacto en odoo.com"** — vuelve a empujar los datos de
    contacto (solo los campos con valor).
  - **"⬆️ Enviar mensajes a odoo.com"** — publica en el portal los mensajes
    nuevos del chatter del lead.
  - **"⬇️ Traer mensajes de odoo.com"** — importa como **notas internas**
    del lead los mensajes escritos en el portal (Odoo, cliente…), con autor
    y fecha. Sin ecos: lo que subimos lleva `[src#id]` y nunca se trae de
    vuelta; lo traído lleva `[odoo#id]` y nunca se reenvía.
- **"🔗 Re-vincular"** en el estado ámbar y **"⚠️ Estado desconocido"** si el
  chatter no se pudo leer. Todos los botones llevan tooltip explicativo y el
  resultado de cada acción se muestra en un aviso sobre el botón.

**Popup**: pulsa el icono de la extensión con un lead abierto para las
mismas acciones, además del estado de la sesión de odoo.com, el historial de
envíos y errores (últimas 50 entradas) y el **listado de leads activos** del
CRM: los 15 con actividad más reciente, con su etapa y el badge 🐙 #ID si ya
están sincronizados. El estado se resuelve leyendo de golpe las notas 🐙 del
CRM (una sola consulta, hasta 200 notas). Clic en un lead lo abre en el CRM.
El listado funciona sin ninguna pestaña de Odoo abierta porque lo consulta el
service worker con la sesión del navegador.

## Estructura

```
octupus-lead-sync/
├── manifest.json        # Manifest V3 (permisos: storage, cookies)
├── src/
│   ├── shared.js        # constantes (mensajes, claves de storage, marcas 🐙),
│   │                    #   helpers puros y transporte JSON-RPC; expone
│   │                    #   globalThis.OctupusShared en los tres contextos
│   ├── bridge.js        # content script: widget flotante, lectura del lead
│   │                    #   y del chatter con tu sesión, notas 🐙
│   ├── background.js    # service worker: create_opp_portal, contacto y
│   │                    #   comentarios contra el portal con tu sesión
│   ├── popup.html/js/css    # sesión, acciones, leads activos e historial
│   ├── options.html/js/css  # configuración del portal y del CRM
│   └── common.css       # paleta y base compartida por popup y opciones
├── test/                # tests unitarios de shared.js (node --test)
├── icons/               # logo (SVG fuente y PNG 16/32/48/128)
├── package.json         # sin build: solo lint (ESLint), formato (Prettier) y tests
├── eslint.config.mjs · .prettierrc · .editorconfig
├── README.md            # guía de uso (portada del sitio de documentación)
├── CHANGELOG.md         # cambios por versión
├── docs/
│   ├── ARQUITECTURA.md  # este documento
│   └── hooks/           # hook de MkDocs que inyecta README y CHANGELOG
├── mkdocs.yml           # sitio de documentación (MkDocs Material)
└── .github/workflows/docs.yml  # despliegue a GitHub Pages
```

La documentación se publica en
<https://octupustechnologies.github.io/octupus-lead-sync/> con cada push a
`main` (GitHub Actions → GitHub Pages). Para verla en local:
`pip install mkdocs-material && mkdocs serve`.

## Desarrollo

La extensión es JavaScript plano sin paso de build: se carga descomprimida
tal cual. `package.json` solo aporta herramientas de calidad:

```
npm install        # una vez
npm run check      # lint (ESLint) + formato (Prettier) + tests (node --test)
npm run format     # aplica el formato
```

Convenciones del código:

- **`src/shared.js`** concentra todo lo que comparten los tres contextos
  (service worker, content script y páginas): tipos de mensaje `MSG.*`,
  claves de `chrome.storage` `STORAGE.*`, marcas de trazabilidad `MARK.*`,
  helpers puros y el transporte JSON-RPC. Los content scripts no admiten
  `import` y no hay bundler, así que se carga como script clásico (antes que
  el resto, ver `manifest.json` y los `<script>` de las páginas) y expone el
  namespace congelado `globalThis.OctupusShared`. Lo que necesiten dos
  archivos va ahí, nunca duplicado.
- Los mensajes entre contextos se despachan con una **tabla `tipo → handler`**
  en `background.js` y `bridge.js`. Añadir un mensaje es añadir la constante
  en `MSG` y una entrada en la tabla; el listener común se encarga de la
  respuesta asíncrona y de convertir excepciones en `{ok:false, error}`.
- Los límites (nº de mensajes leídos, páginas del portal, tamaño del
  historial…) y la paleta del widget son constantes con nombre, no números
  o colores sueltos.
- Los tests (`test/`) cubren los helpers puros de `shared.js` (parsers de
  marcadores, slug, mensajes del portal…). La lógica que habla con Odoo se
  prueba a mano en el navegador: recarga la extensión en `chrome://extensions`
  y las pestañas de Odoo abiertas.
- Las funciones del content script llevan prefijo `octupus` para
  distinguirlas del código de Odoo en las trazas de DevTools.

## Limitaciones conocidas

- Requiere sesión activa en www.odoo.com; si caduca, el envío falla y queda
  registrado en el popup (el lead no se marca como enviado; reintenta desde
  el widget).
- El widget solo se inyecta en instancias origen `https://*.odoo.com`. Para
  un dominio propio hay que añadir su patrón en `content_scripts.matches` del
  `manifest.json`. El listado de leads del popup sí admite un CRM en dominio
  propio: basta con conceder el permiso de host que Chrome pide al guardar
  Opciones.
- El widget detecta el lead por la URL (`#id=…&model=crm.lead` en Odoo ≤16 y
  `/odoo/crm/<id>` en Odoo 17+); en un registro sin guardar (URL sin id) no
  aparece.
