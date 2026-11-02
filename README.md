# Al Toque - UPCH Campus

Aplicacion Node.js para pedidos, chat y Reels. El servidor sirve la interfaz y
las rutas `/api`; no se puede alojar como una pagina estatica en GitHub Pages.

## Desarrollo local

- Requiere Node.js 20.6 o posterior.
- Ejecuta `npm start` y abre `http://localhost:4173`.
- Copia `.env.example` a `.env` para configurar integraciones opcionales.
- Define `REELS_DELETE_PASSWORD` con una clave privada para habilitar la
  eliminacion de Reels. Sin ella, esa operacion falla de forma cerrada.
- Para enviar la confirmacion de suscripcion a recomendaciones, configura
  `RESEND_API_KEY` y `EMAIL_FROM` con una clave de Resend y una direccion de
  remitente cuyo dominio este verificado. La clave permanece solo en el
  servidor. Sin ambas variables, el envio responde con un error visible y no
  activa la casilla.

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
- `REELS_DELETE_PASSWORD`: contraseña privada para habilitar la eliminación
  de Reels.
- `RESEND_API_KEY`: clave privada de Resend para los correos de confirmacion.
- `EMAIL_FROM`: remitente de Resend con dominio verificado, por ejemplo
  `Al Toque Pe <hola@tudominio.pe>`.

El plan gratuito de Supabase tiene límites de base de datos y archivos; consulta
https://supabase.com/pricing. Los videos se limitan a 50 MiB para ajustarse al
límite del bucket gratuito definido en `supabase/schema.sql`.

## Despliegue gratuito en Render

`render.yaml` configura un servicio web Free sin disco persistente y usa
Supabase para conservar pedidos y Reels. Al crear el Blueprint, Render pedirá
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` y `REELS_DELETE_PASSWORD`; ingresa
los valores directamente en Render. No los compartas por chat ni los guardes en
Git.

Render Free puede dormir cuando no recibe tráfico y los proyectos gratuitos de
Supabase pueden pausarse tras una semana sin actividad. Los historiales y
videos locales existentes no se incluyen ni se migran.
