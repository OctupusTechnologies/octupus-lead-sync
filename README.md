# 🐙 Octupus Lead Sync — Extensión de Chrome

Extensión para enviar **leads del CRM de Odoo** (p. ej. `octupus.odoo.com`)
al **portal de partners de www.odoo.com** con un clic, usando el método
`crm.lead/create_opp_portal` y reutilizando la sesión que ya tienes iniciada
en odoo.com. El envío es **siempre manual**: tú decides qué lead viaja y
cuándo.

## Cómo funciona

1. Al abrir un lead en el backend de Odoo aparece un **widget flotante**
   (abajo a la derecha) que consulta el chatter y muestra el estado:
   **"🐙 Enviar a odoo.com"** si no está sincronizado, o
   **"🐙 Sincronizado · #ID"** (clic → abre la oportunidad en el portal) con
   el botón **"↻ Actualizar datos y comentarios"** si ya lo está.
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
5b. **Comentarios**: tras enviar o al pulsar "Actualizar datos", los mensajes
   del chatter del lead se publican en el chatter de la oportunidad remota
   vía `/mail/message/post`, en texto plano con autor, fecha y marcador
   `[src#id]`. Se envían los comentarios públicos (💬, "Enviar mensaje") y,
   con la opción "Enviar también las notas internas" activada (por defecto
   sí), las notas (📝, "Registrar nota"). Las notas de la propia extensión y
   las notificaciones de sistema nunca se envían. Dedupe en dos capas: antes
   de publicar se lee el chatter remoto y se extraen los marcadores
   `[src#id]` ya presentes (compartido entre usuarios/navegadores), más el
   registro en almacenamiento local (máx. 50 mensajes por lead).
   Ojo: publicar como comentario puede notificar por email a los seguidores
   de la oportunidad en odoo.com (p. ej. tu account manager).
6. Anti-duplicados en tres capas:
   - **Chatter (fuente de verdad)**: antes de enviar se busca la nota
     "Octupus Lead Sync" en el lead y se extrae el ID remoto; si existe, no
     se reenvía (aunque lo haya enviado otro compañero desde su navegador).
   - **Portal de odoo.com**: como usuario portal no se puede hacer
     `search_read` de `crm.lead`, así que se busca en el HTML de
     `/my/opportunities?search=<título>` y se compara el slug del enlace
     (`/my/opportunity/<slug>-<id>`) con el slug del título del lead. Si
     coincide exactamente **y ningún otro lead reclama ya ese ID** (se
     comprueba en las notas 🐙 del origen), se **vincula** la oportunidad
     existente sin crear duplicado y sin tocar los datos remotos. Si otro
     lead la reclama, se asume que es un negocio distinto con el mismo
     título y se crea una nueva.
   - **Almacenamiento local** de la extensión, como última capa.

   Seguridad ante fallos: si el chatter del lead no se puede leer, el envío
   se **cancela** (el widget muestra "Estado desconocido · reintentar") —
   nunca se crea "a ciegas". Y si el portal no devuelve el ID al crear, se
   recupera buscando la oportunidad recién creada por título.

7. **Re-vincular** (vía de escape): si una nota quedó sin ID remoto o la
   oportunidad se borró en el portal, el botón "🔁 Re-vincular" (widget y
   popup) re-busca por título y reescribe la nota con el ID. Nunca crea nada
   nuevo; si no encuentra la oportunidad, indica cómo proceder.

## Requisito único

Estar **logueado en www.odoo.com** (portal de partners) en el mismo perfil
de Chrome. La extensión lo comprueba y te avisa en el popup si la sesión
falta o ha caducado.

## Instalación

1. Abre Chrome y ve a `chrome://extensions`.
2. Activa el **Modo de desarrollador** (esquina superior derecha).
3. Pulsa **"Cargar descomprimida"** y selecciona la carpeta
   `octupus-lead-sync/`.

## Configuración

Clic derecho en el icono → **Opciones** (o botón del popup):

- **URL del portal**: `https://www.odoo.com` (valor por defecto).
- **Etiqueta de origen**: texto añadido como `Origen: …` en la descripción
  (por defecto "Octupus").
- **Probar sesión**: verifica que la cookie de odoo.com es válida y muestra
  con qué usuario estás conectado.

## Uso

**Widget flotante (recomendado)**: abre cualquier lead en Odoo (vista
formulario). Abajo a la derecha aparece el widget:

- **"🐙 Enviar a odoo.com"** (morado) → crea la oportunidad en el portal,
  rellena el contacto, deja la nota y sincroniza los comentarios.
- **"🐙 Sincronizado · #ID"** (verde) → el lead ya está en el portal; clic
  para abrir la oportunidad. Debajo, **"↻ Actualizar datos y comentarios"**
  vuelve a empujar el contacto actual y los mensajes nuevos del chatter.
- El resultado de cada acción se muestra en un aviso sobre el botón.

**Popup**: pulsa el icono de la extensión con un lead abierto para las
mismas acciones, además del estado de la sesión de odoo.com y el historial
de envíos y errores.

## Estructura

```
octupus-lead-sync/
├── manifest.json        # Manifest V3 (permisos: storage, cookies)
├── src/
│   ├── bridge.js        # content script: widget flotante, lectura del lead
│   │                    #   y del chatter con tu sesión, notas 🐙
│   ├── background.js    # service worker: create_opp_portal, contacto y
│   │                    #   comentarios contra el portal con tu sesión
│   ├── options.html/js  # configuración del portal
│   └── popup.html/js    # estado de sesión, acciones y últimos envíos
└── README.md
```

## Limitaciones conocidas

- Requiere sesión activa en www.odoo.com; si caduca, el envío falla y queda
  registrado en el popup (el lead no se marca como enviado; reintenta desde
  el widget).
- Funciona en instancias origen `https://*.odoo.com`. Para un dominio propio
  hay que añadir su patrón en `content_scripts.matches` del `manifest.json`.
- El widget detecta el lead por la URL (`#id=…&model=crm.lead` en Odoo ≤16 y
  `/odoo/crm/<id>` en Odoo 17+); en un registro sin guardar (URL sin id) no
  aparece.
