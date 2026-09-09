# 🐙 Octupus Lead Sync

📖 **Documentación en línea:** [octupustechnologies.github.io/octupus-lead-sync](https://octupustechnologies.github.io/octupus-lead-sync/)

Extensión de Chrome para el equipo de Octupus que **sincroniza leads de
nuestro CRM (`octupus.odoo.com`) con el portal de partners de odoo.com**
con un clic: crea la oportunidad en el portal, rellena los datos de
contacto, deja constancia en el chatter del lead y mueve los mensajes en
las dos direcciones. Sin claves API ni configuración complicada — usa tus
propias sesiones de navegador.

---

## Requisitos

- Google Chrome (o Edge/Brave, cualquier navegador Chromium).
- Sesión iniciada en **octupus.odoo.com** (tu usuario de siempre).
- Sesión iniciada en **www.odoo.com** con la cuenta que tiene acceso al
  portal de partners (donde ves `/my/opportunities`). Si puedes abrir
  [www.odoo.com/my/opportunities](https://www.odoo.com/my/opportunities)
  y ver el listado, estás listo.

## Instalación

1. Descarga la extensión: en este repositorio, botón verde **Code →
   Download ZIP**, y descomprime el archivo donde no lo vayas a borrar
   (p. ej. `Documentos/octupus-lead-sync`).
2. Abre Chrome y entra en `chrome://extensions`.
3. Activa el **Modo de desarrollador** (interruptor arriba a la derecha).
4. Pulsa **"Cargar descomprimida"** y selecciona la carpeta que
   descomprimiste (la que contiene `manifest.json`).
5. Opcional pero recomendable: fija la extensión en la barra (icono del
   puzle → chincheta junto a "Octupus Lead Sync").

**Para comprobar que todo está bien**: clic derecho en el icono de la
extensión → **Opciones** → botón **"Probar sesión"**. Debe decir "Sesión
activa ✔ — conectado como …". Si da error, inicia sesión en www.odoo.com
y vuelve a probar.

## Cómo se usa

Abre cualquier lead u oportunidad en el CRM de Octupus. Abajo a la
derecha aparece el **widget flotante**, que te dice en qué estado está y
qué puedes hacer:

| Botón | Qué significa / qué hace |
|---|---|
| 🐙 **Enviar lead a odoo.com** (morado) | El lead aún no está en el portal. Clic: crea la oportunidad, rellena el contacto, deja la nota de trazabilidad y sube los mensajes del chatter. |
| 🐙 **Sincronizado · #ID ↗** (verde) | Ya está en el portal. Clic: abre la oportunidad en odoo.com. |
| 📇 **Actualizar contacto en odoo.com** | Vuelve a enviar los datos de contacto del lead (nombre, email, teléfono, dirección). Úsalo si completaste el lead después de enviarlo. |
| ⬆️ **Enviar mensajes a odoo.com** | Publica en el portal los mensajes nuevos del chatter del lead (comentarios y notas). |
| ⬇️ **Traer mensajes de odoo.com** | Importa como notas internas lo que hayan escrito en el portal (el account manager de Odoo, el cliente…), con autor y fecha. |
| 🔗 **Re-vincular con el portal** (ámbar) | La nota de trazabilidad perdió el ID. Clic: busca la oportunidad en el portal y la reconecta. No crea nada. |
| ⚠️ **Estado desconocido · reintentar** (gris) | No se pudo leer el chatter (red, sesión). Clic para reintentar. Nunca envíes nada en este estado. |

El resultado de cada acción aparece en un aviso sobre el botón. El
**popup** (icono de la extensión en la barra) ofrece las mismas acciones
más el estado de la sesión de odoo.com, el historial de envíos y errores,
y un **listado de los leads activos** del CRM (los 15 con actividad más
reciente): cada uno muestra su etapa y un badge verde 🐙 #ID si ya está
sincronizado con el portal; clic en cualquiera lo abre en el CRM. El
listado funciona aunque no tengas ninguna pestaña de Odoo abierta.

## Qué hace por detrás (y por qué no duplica nada)

- Al enviar un lead, la extensión deja una **nota 🐙 en su chatter** con el
  ID y el enlace de la oportunidad del portal. Esa nota es la fuente de
  verdad: cualquier compañero, desde cualquier navegador, verá el lead
  como sincronizado.
- Antes de crear nada, comprueba **tres capas**: la nota del chatter, una
  búsqueda en el portal por título y email (si ya existe, la vincula en
  vez de duplicarla), y su registro local.
- Cada mensaje subido lleva la marca `[src#…]` y cada mensaje traído la
  marca `[odoo#…]`: así ningún mensaje se envía o se trae dos veces, ni
  rebota de vuelta (sin ecos), aunque varias personas usen la extensión
  sobre el mismo lead.
- Las notas internas de nuestro chatter se suben como comentarios al
  portal (configurable en Opciones), y lo traído del portal entra siempre
  como **nota interna** — el cliente nunca lo ve.

## Problemas comunes

| Síntoma | Solución |
|---|---|
| No aparece el widget en el lead | Recarga la pestaña de Odoo (los scripts se inyectan al cargar la página). Comprueba que la URL es de un lead concreto (vista formulario). |
| "No hay cookie de sesión…" o "Sesión caducada" | Inicia sesión en www.odoo.com en este mismo perfil de Chrome y reintenta. |
| ⚠️ Estado desconocido | Suele ser un corte puntual: clic para reintentar. Si persiste, revisa tu sesión de octupus.odoo.com. |
| "Ya existía en el portal: vinculado…" | No es un error: la oportunidad ya estaba en el portal y la extensión la ha conectado sin duplicar. |
| Envié el lead pero quiero pasarle los últimos mensajes | Botón ⬆️ "Enviar mensajes a odoo.com" — solo viajan los que falten. |

## Actualizar la extensión

Cuando haya versión nueva: descarga otra vez el ZIP (o `git pull` si
clonaste el repo), reemplaza la carpeta, y en `chrome://extensions` pulsa
el botón ↻ de la extensión. Después recarga las pestañas de Odoo abiertas.
Los cambios de cada versión están en [CHANGELOG.md](CHANGELOG.md).

## Soporte

Cualquier duda o comportamiento raro: escribe a **Sergio González**
(sergio.gonzalez@octupus.es) con el número de lead y una captura del
aviso de error del popup (el historial de errores está ahí).

---

Documentación técnica (arquitectura, endpoints, capas anti-duplicados):
[docs/ARQUITECTURA.md](docs/ARQUITECTURA.md)
