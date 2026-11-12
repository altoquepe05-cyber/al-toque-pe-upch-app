# Al Toque pe - UPCH Campus

Aplicacion Node.js para pedidos, chat y Reels. El servidor sirve la interfaz y
las rutas `/api`; no se puede alojar como una pagina estatica en GitHub Pages.

## Desarrollo local

- Requiere Node.js 20.6 o posterior.
- Ejecuta `npm start` y abre `http://localhost:4173`.
- Las imagenes y fuentes locales restantes se preparan en segundo plano despues
  del inicio. Los videos y servicios externos se cargan cuando se usan; la
  preparacion se omite si el navegador indica ahorro de datos o red 2G.
- Copia `.env.example` a `.env` para configurar integraciones opcionales.
- Define `REELS_DELETE_PASSWORD` con una clave privada para habilitar la
  eliminacion de Reels. Sin ella, esa operacion falla de forma cerrada.
- La casilla de recomendaciones registra el consentimiento en HubSpot y añade
  el contacto a la lista configurada. Los secretos permanecen solo en el
  servidor; si la integración falla, la casilla no se activa.
- Los mapas de recojo y entrega muestran Google Maps con la ruta peatonal de
  aproximadamente 67 m por la avenida Armendáriz y la calle Las Acacias. Tras
  confirmar el recojo, el mapa actualiza el origen con la ubicación GPS del
  repartidor. La ubicación se comparte en memoria con el cliente durante el
  pedido y se elimina al confirmar la entrega. El botón de navegación abre la
  ruta de Google Maps configurada en la interfaz.

### Suscripciones de marketing con HubSpot

La página de HubSpot compartida es un correo normal ya enviado; los nuevos
suscriptores no pueden añadirse retroactivamente a ese envío. Con la integración
actual, la aplicación registra el contacto, su consentimiento y su pertenencia a
la lista 9. No envía correos automáticamente.

Configura en Render `MARKETING_PROVIDER=hubspot`, `HUBSPOT_ACCESS_TOKEN`,
`HUBSPOT_LIST_ID=9` y `HUBSPOT_SUBSCRIPTION_ID`. El token requiere el alcance
`communication_preferences.read_write` para las preferencias, además de los
alcances CRM para contactos y listas. El ID de suscripción identifica el tipo
de correo para el que el contacto otorgó consentimiento. Configura el token
directamente en Render; no lo guardes en Git ni lo compartas por chat. La lista
debe permitir agregar contactos mediante la API.

Para obtener los IDs de los tipos de suscripción, consulta
`GET https://api.hubapi.com/communication-preferences/v4/definitions` con
`Authorization: Bearer <HUBSPOT_ACCESS_TOKEN>`. Sin autorización, HubSpot
responde `401`. Selecciona el tipo de marketing correspondiente en la
respuesta (`results[].id`) y asígnalo a `HUBSPOT_SUBSCRIPTION_ID`. La aplicación
actualiza el estado usando `POST
/communication-preferences/v4/statuses/{email}` con el canal `EMAIL` y la base
legal de consentimiento explícito.

Gmail OAuth sigue disponible como proveedor alternativo para la confirmación
simple: configura `MARKETING_PROVIDER=gmail` y las credenciales descritas en
`.env.example`. Esa opción no agrega contactos a HubSpot.

## Persistencia gratuita con Supabase

La app puede guardar los pedidos y el estado de Reels en Supabase, y los videos
en Supabase Storage. Ejecuta `supabase/schema.sql` en el SQL Editor de tu
proyecto Supabase. El bucket de videos es público para permitir reproducir los
Reels; la clave de servicio solo se usa en el servidor.

Configura estas variables en el servidor:

- `DATA_BACKEND=supabase`
- `SUPABASE_URL`: URL del proyecto Supabase.
- `SUPABASE_SERVICE_ROLE_KEY`: clave de servicio privada; no la incluyas en Git
  ni en el navegador.
- El Libro de Reclamaciones guarda los envíos en el estado privado del servidor
  (`complaints` en Supabase o `complaints.json` en desarrollo local). No hay una
  ruta pública para consultar los registros; el formulario envía los datos a
  `POST /api/complaints`.
- `REELS_DELETE_PASSWORD`: contraseña privada para habilitar la eliminación
  de Reels.
- `HUBSPOT_ACCESS_TOKEN`: token privado para la integración con HubSpot.
- `HUBSPOT_LIST_ID`: ID de la lista de contactos del workflow.
- `HUBSPOT_SUBSCRIPTION_ID`: ID del tipo de suscripción de correo.
- `MARKETING_PROVIDER`: `hubspot` para gestionar altas en HubSpot o `gmail` para
  enviar confirmaciones por Gmail OAuth.
- `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` y `GMAIL_USER`:
  credenciales opcionales para el proveedor Gmail.

El plan gratuito de Supabase tiene límites de base de datos y archivos; consulta
https://supabase.com/pricing. Los videos se limitan a 50 MiB para ajustarse al
límite del bucket gratuito definido en `supabase/schema.sql`.

## Despliegue gratuito en Render

`render.yaml` configura un servicio web Free sin disco persistente y usa
Supabase para conservar pedidos y Reels. Al crear el Blueprint, Render pedirá
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `REELS_DELETE_PASSWORD`,
`HUBSPOT_ACCESS_TOKEN` y `HUBSPOT_SUBSCRIPTION_ID`; ingresa los valores
directamente en Render. No los compartas por chat ni los guardes en Git.

Render Free puede dormir cuando no recibe tráfico y los proyectos gratuitos de
Supabase pueden pausarse tras una semana sin actividad. Los historiales y
videos locales existentes no se incluyen ni se migran.
