# 🐙 Octupus Lead Sync — Extensión de Chrome

Extensión que detecta cuándo conviertes un **lead a oportunidad** en Odoo
(p. ej. `octupus.odoo.com`) y lo registra automáticamente en el **portal de
partners de www.odoo.com** usando el método `crm.lead/create_opp_portal`,
reutilizando la sesión que ya tienes iniciada en odoo.com.

## Cómo funciona

1. Un script inyectado en la página de Odoo intercepta la llamada RPC del
   asistente **"Convertir a oportunidad"** (`crm.lead2opportunity.partner`,
   incluida la conversión masiva desde la vista de lista).
2. Al confirmarse la conversión, lee los datos del lead usando **tu propia
   sesión de Odoo** (no necesita credenciales de la instancia origen).
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
     coincide exactamente, se **vincula** la oportunidad existente (se
     guarda su ID y se añade la nota al chatter) sin crear duplicado y sin
     tocar los datos de contacto remotos.
   - **Almacenamiento local** de la extensión, como última capa.

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

**Automático**: trabaja en el CRM con normalidad. Al confirmar **"Convertir a
oportunidad"**, la extensión crea la oportunidad en el portal, muestra un
contador verde en el icono y deja la nota con el ID remoto en el lead.

**Manual**: abre cualquier lead en Odoo (vista formulario) y pulsa el icono
de la extensión. El popup lee el chatter del lead y muestra:

- Si **no** está sincronizado → botón **"Enviar lead #N a odoo.com"**
  (funciona con leads sin convertir y con la sincronización automática
  desactivada).
- Si **ya** está sincronizado → el ID remoto y el botón **"Actualizar datos
  del lead #N en odoo.com"**, que vuelve a empujar los datos de contacto
  actuales a la oportunidad remota (útil si completaste el lead después de
  enviarlo).

En el **popup** ves además el estado de la sesión de odoo.com, los últimos
envíos y el interruptor para activar/desactivar la sincronización automática.

## Estructura

```
octupus-lead-sync/
├── manifest.json        # Manifest V3 (permisos: storage, cookies)
├── src/
│   ├── injector.js      # (MAIN world) intercepta las RPC de conversión
│   ├── bridge.js        # (ISOLATED) lee el lead con tu sesión y avisa al SW
│   ├── background.js    # service worker: create_opp_portal con la sesión
│   ├── options.html/js  # configuración del portal
│   └── popup.html/js    # estado de sesión y últimos envíos
└── README.md
```

## Limitaciones conocidas

- Requiere sesión activa en www.odoo.com; si caduca, el envío falla y queda
  registrado en el popup (el lead no se marca como enviado, se puede
  reintentar volviendo a convertirlo o recargando).
- Funciona en instancias origen `https://*.odoo.com`. Para un dominio propio
  hay que añadir su patrón en `content_scripts.matches` del `manifest.json`.
- Compatible con Odoo 13–18 como origen (intercepta tanto XHR como `fetch`).
- Si la conversión hace una **fusión (merge)** de varios leads, se envía la
  oportunidad resultante que siga existiendo entre los registros activos.
