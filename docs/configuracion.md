# Instalación y configuración

[Volver al README](../README.md)

## Requisitos y rutas

Usar Node.js 22+, npm y ffmpeg/ffprobe. Para montar pCloud se necesitan rclone, FUSE y las credenciales configuradas por el administrador. systemd es opcional para ejecución local; Docker es una alternativa al proceso web instalado en el host.

Los tres procesos deben compartir exactamente `VIDEO_ROOT` y `DATA_DIR`. La base vive en disco local persistente. Por defecto, `DATA_DIR` es `data` junto a `metadata-store.js`, no necesariamente el directorio desde el que se invocó Node. Los archivos estáticos se resuelven desde el directorio del proyecto.

El proyecto no carga archivos `.env` automáticamente. Para una ejecución manual hay que exportar variables en la terminal, usar mecanismos de entorno de Node compatibles o inyectarlas desde el gestor de procesos. Un archivo en `/etc` solo afecta al servicio que lo declara en `EnvironmentFile`.

## Variables

| Variable | Valor del código | Proceso y efecto |
|---|---|---|
| `VIDEO_ROOT` | `/mnt/pcloud/My Videos` | Los tres; raíz de archivos |
| `DATA_DIR` | `data/` junto al módulo | Los tres; directorio SQLite |
| `PORT` | `3000` | Web; entero entre 1 y 65535; la unidad incluida usa `3001` |
| `METADATA_EDIT_TOKEN` | Sin definir | Web; habilita edición de nombres; mínimo 32 bytes |
| `ACCESS_TOKEN` | Sin definir | Web; protege API y reproducción con sesión por cookie. Sin definir, el acceso de red sigue abierto |
| `ACCESS_COOKIE_SECURE` | Desactivado | Web; `1` agrega `Secure` a la cookie, necesario detrás de HTTPS |
| `ACCESS_COOKIE_SAMESITE` | `Strict` | Web; `Strict`, `Lax` o `None`; `None` requiere `ACCESS_COOKIE_SECURE=1` |
| `CORS_ORIGINS` | Vacío | Web; lista separada por comas de orígenes HTTP(S) exactos autorizados para llamadas cross-origin |
| `INDEX_MODE` | Sin definir | Indexador; `inventory` evita ffprobe |
| `PROBE_TIMEOUT_MS` | `30000` | Indexador; timeout por ffprobe |
| `MAX_PROBES` | `50` | Indexador; intentos por recorrido; `0` sin límite |
| `RETRY_FAILED` | Desactivado | Indexador; exactamente `1` reintenta fallos técnicos |
| `OPENROUTER_API_KEY` | Sin definir | Visual; obligatoria |
| `OPENROUTER_MODEL` | `openrouter/free` | Visual; selector de modelo/router |
| `OPENROUTER_API_URL` | `https://openrouter.ai/api/v1/chat/completions` | Visual; endpoint de inferencia, exige HTTPS y no sigue redirecciones |
| `MAX_VISUAL` | `1` | Visual; lote entre 1 y 100; `0` no significa ilimitado |
| `MAX_VISUAL_ATTEMPTS` | `5` | Visual; intentos automáticos máximos por fingerprint, entre 1 y 20 |
| `MAX_VISUAL_REQUESTS_PER_DAY` | `0` | Visual; solicitudes iniciadas por día UTC; `0` desactiva el límite |
| `RETRY_VISUAL_FAILED` | Desactivado | Visual; exactamente `1` incluye fallos transitorios cuyo tiempo de espera ya venció |
| `VISUAL_VIDEO_ID` | Sin definir | Visual; ID positivo selecciona un solo video técnicamente listo, incluso si ya tiene ficha |

Validación al iniciar: `PROBE_TIMEOUT_MS` debe estar entre 1.000 y 600.000; `MAX_PROBES` entre 0 y 1.000.000 (0 significa sin límite); `MAX_VISUAL` entre 1 y 100; `MAX_VISUAL_ATTEMPTS` entre 1 y 20; `MAX_VISUAL_REQUESTS_PER_DAY` entre 0 y 5.000 (0 significa sin límite); `VISUAL_VIDEO_ID`, si se define, debe ser un entero positivo; los flags `RETRY_*` aceptan solo `0` o `1`. Un valor inválido detiene ese trabajador con un error explícito. Los errores de autenticación y las respuestas 4xx no se reintentan automáticamente; 429, 5xx y fallos transitorios esperan antes del próximo intento, con un máximo automático por versión del video.

La unidad visual del repositorio declara `MAX_VISUAL=5` y `RETRY_VISUAL_FAILED=1`. El archivo de entorno de systemd puede sobrescribir esas variables. Cada trabajador registra en SQLite los límites/modelo no secretos usados al arrancar. La interfaz muestra la última configuración registrada por cada etapa; no lee ni revela las claves del proveedor. También muestra el último lote y conserva hasta 200 ejecuciones recientes de cada etapa.

Los límites de cuota, precios y disponibilidad de los proveedores no están codificados como garantías del proyecto. Consultarlos en la cuenta del proveedor antes de ampliar el procesamiento. No hay control de presupuesto propio.

## Desarrollo local

```bash
npm ci
export VIDEO_ROOT='/mnt/pcloud/My Videos'
export DATA_DIR="$PWD/data"
PORT=3001 npm start
```

En otra terminal con las mismas rutas:

```bash
npm run inventory
MAX_PROBES=50 npm run index
```

Para un lote visual, suministrar `OPENROUTER_API_KEY` mediante el mecanismo de secretos elegido y ejecutar:

```bash
MAX_VISUAL=1 npm run analyze
```

No pasar claves reales en ejemplos compartidos ni incorporarlas al repositorio. Los scripts disponibles son `start`, `dev` (ambos ejecutan el mismo servidor sin recarga automática), `inventory`, `index` y `analyze`.

## Montaje con rclone

Configurar un remoto llamado `pcloud` con `rclone config` usando el usuario que ejecutará el montaje. Crear el directorio destino y revisar `rclone-pcloud.service` antes de instalarlo: incluye `User=jorge`, la ubicación de `rclone.conf`, la ruta del montaje y `fusermount3`.

La unidad utiliza caché VFS completa, máximo configurado de 10 GiB, buffer de 256 MiB y lectura por bloques. Se requiere espacio local para la caché. `--allow-other` exige la configuración correspondiente de FUSE; revisar acceso y permisos del montaje. `--allow-non-empty` permite cubrir un directorio no vacío: comprobar su contenido antes de montar.

```bash
sudo cp rclone-pcloud.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now rclone-pcloud.service
mountpoint '/mnt/pcloud/My Videos'
```

## Instalación con systemd

Adaptar `User`, `Group`, `WorkingDirectory`, `ExecStart`, `VIDEO_ROOT` y `DATA_DIR` a la máquina. La ruta Node de las unidades actuales es `/home/jorge/.hermes/node/bin/node`.

Crear `/etc/pcloud-video-visual.env` con `sudoedit`. Ejemplo de contenido; reemplazar el marcador de clave:

```ini
OPENROUTER_API_KEY=REEMPLAZAR_POR_LA_CLAVE
OPENROUTER_MODEL=openrouter/free
MAX_VISUAL=5
MAX_VISUAL_REQUESTS_PER_DAY=30
RETRY_VISUAL_FAILED=0
```

Este ejemplo elige cinco por lote, limita a 30 las solicitudes iniciadas en un día UTC y no reintenta fallidos automáticamente. El contador persiste en SQLite y se muestra en la interfaz; las fichas restantes quedan pendientes para el próximo lote manual después de renovarse el límite. Omitir `VISUAL_VIDEO_ID` para procesar la cola; dejarlo fijado provoca que cada arranque vuelva al mismo video.

Para editar identidades, crear `/etc/pcloud-video-metadata.env` con `sudoedit`:

```ini
METADATA_EDIT_TOKEN=REEMPLAZAR_POR_UN_TOKEN_ALEATORIO
```

Para restringir la biblioteca a personas con token, crear `/etc/pcloud-video-access.env`:

```ini
ACCESS_TOKEN=REEMPLAZAR_POR_UN_TOKEN_ALEATORIO_DE_32_BYTES_O_MAS
ACCESS_COOKIE_SECURE=1
ACCESS_COOKIE_SAMESITE=Strict
# Solo si una aplicación web en otro origen necesita llamar a la API:
# CORS_ORIGINS=https://mi-dominio.example
```

Generar el token, por ejemplo, con `openssl rand -hex 32`. El servidor pide el token una vez y entrega una sesión de 12 horas en una cookie `HttpOnly`; no se guarda en el navegador ni se agrega a las URLs. `ACCESS_COOKIE_SECURE=1` requiere HTTPS. Si el servicio se usa por HTTP local, omitirla y mantener `ACCESS_COOKIE_SAMESITE=Strict`. Para una aplicación en otro sitio que necesite enviar la cookie, configurar HTTPS, `ACCESS_COOKIE_SECURE=1` y `ACCESS_COOKIE_SAMESITE=None`; el navegador todavía puede bloquear cookies de terceros según sus políticas. Los orígenes CORS deben ser valores exactos como `https://app.example`, sin ruta ni barra final; por defecto se aceptan solicitudes same-origin y no se habilitan clientes cross-origin. La edición de identidades conserva además su token `METADATA_EDIT_TOKEN`.

El servidor agrega una política CSP y cabeceras de seguridad para la interfaz y la API, y oculta la cabecera `X-Powered-By`. La política permite Tailwind desde su CDN y las fuentes de Google Fonts usadas por `public/index.html`; si se cambia el origen de esos recursos, actualizar también la CSP en `server.js`.

Se puede generar un valor con `openssl rand -hex 32`. Son archivos distintos: la clave del proveedor no debe entregarse al navegador.

```bash
sudo chmod 600 /etc/pcloud-video-visual.env /etc/pcloud-video-metadata.env /etc/pcloud-video-access.env
sudo cp pcloud-video-streamer.service pcloud-video-indexer.service pcloud-video-indexer.timer pcloud-video-visual.service pcloud-video-visual.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now pcloud-video-streamer.service
sudo systemctl enable --now pcloud-video-indexer.timer
```

El temporizador técnico puede activar una ejecución al habilitarlo si ya pasó su plazo desde el arranque del equipo. No tener un indexador manual en ejecución al hacerlo.

| Unidad | Comportamiento |
|---|---|
| `rclone-pcloud.service` | Montaje continuo con reinicio automático |
| `pcloud-video-streamer.service` | Web continuo, puerto 3001, reinicio automático |
| `pcloud-video-indexer.service` | `oneshot`; un recorrido y hasta 50 intentos técnicos con valores por defecto |
| `pcloud-video-indexer.timer` | `OnBootSec=5min`, después `OnUnitInactiveSec=6h` |
| `pcloud-video-visual.service` | `oneshot` manual; termina al finalizar el lote |
| `pcloud-video-visual.timer` | Opcional; primer lote 15 min después del arranque, siguientes una hora después de terminar el lote anterior |

El temporizador técnico es relativo, no un calendario de horas fijas. `Persistent=true` aparece en el archivo, pero no debe interpretarse como recuperación garantizada de todas las ejecuciones omitidas de este temporizador relativo. La etapa visual no se inicia automáticamente cuando termina la técnica; el temporizador visual opcional continúa la cola en lotes separados.

Para activar la continuación visual, primero definir `MAX_VISUAL_REQUESTS_PER_DAY` en `/etc/pcloud-video-visual.env` con el máximo diario que se desea permitir. Verificar que la clave, el modelo y el endpoint sean correctos; los cambios de configuración levantan una pausa permanente del proveedor, mientras que errores de cuota/red tienen espera automática. Luego habilitar el timer:

```bash
sudo systemctl enable --now pcloud-video-visual.timer
systemctl list-timers pcloud-video-visual.timer
```

El timer no se habilita en la instalación inicial. Cada ejecución respeta `MAX_VISUAL`, el límite diario, los reintentos y el bloqueo común. Si se alcanza el límite diario, las fichas siguen pendientes; systemd las intentará en su siguiente intervalo, una vez renovado el contador UTC.

Cambiar código del servidor exige reiniciarlo. Ante `SIGTERM` o `SIGINT`, el servidor deja de aceptar conexiones, permite hasta 25 segundos para terminar las solicitudes activas y luego cierra las conexiones restantes; finalmente cierra SQLite. Los procesos de lote cargan el nuevo código en su próximo arranque. Los archivos estáticos se leen en las peticiones; recargar el navegador. Para cambios de unidades: copiar nuevamente, `daemon-reload` y reiniciar la unidad afectada. Cambiar solo el contenido de un `EnvironmentFile` requiere un nuevo arranque del proceso que lo consume.

## Docker

La imagen usa Node 22 sobre Debian Bookworm, instala dependencias nativas en una etapa de construcción e incluye ffmpeg en la imagen final. Ejecuta como UID/GID 1001 y solo arranca el servidor web por defecto.

```bash
docker build -t pcloud-video-streamer .
sudo install -d -o 1001 -g 1001 /var/lib/pcloud-video-metadata
docker run -d --name pcloud-streamer \
  -p 3000:3000 \
  -v '/mnt/pcloud/My Videos:/mnt/pcloud/My Videos:ro' \
  -v /var/lib/pcloud-video-metadata:/data \
  -e DATA_DIR=/data \
  --restart unless-stopped \
  pcloud-video-streamer
```

El ejemplo crea un directorio dedicado nuevo. Para usar datos existentes, respaldar primero y revisar permisos en lugar de cambiar propietarios sin inspección. El montaje pCloud debe existir previamente en el host y ser legible para UID 1001.

```bash
docker exec -e INDEX_MODE=inventory pcloud-streamer node indexer.js
docker exec -e MAX_PROBES=50 pcloud-streamer node indexer.js
```

Para visual, inyectar `OPENROUTER_API_KEY` de manera segura en el proceso y ejecutar `node visual-analyzer.js` con los mismos volúmenes. El Dockerfile no carga archivos de secretos por sí solo y no incorpora un planificador. Un archivo ignorado por Git no queda automáticamente excluido del contexto Docker: revisar `.dockerignore` si se agregan nuevos nombres de archivos sensibles.
