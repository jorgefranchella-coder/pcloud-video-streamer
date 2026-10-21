# Instalación y configuración

[Volver al README](../README.md)

## Requisitos y rutas

Usar Node.js 22+, npm y ffmpeg/ffprobe. Para montar pCloud se necesitan rclone, FUSE y las credenciales configuradas por el administrador. systemd es opcional para ejecución local; Docker es una alternativa al proceso web instalado en el host.

Los tres procesos deben compartir exactamente `VIDEO_ROOT` y `DATA_DIR`. La base vive en disco local persistente. Por defecto, `DATA_DIR` es `data` junto a `metadata-store.js`, no necesariamente el directorio desde el que se invocó Node. Ejecutar el servidor desde la raíz del proyecto: `express.static('public')` sí depende del directorio de trabajo.

El proyecto no carga archivos `.env` automáticamente. Para una ejecución manual hay que exportar variables en la terminal, usar mecanismos de entorno de Node compatibles o inyectarlas desde el gestor de procesos. Un archivo en `/etc` solo afecta al servicio que lo declara en `EnvironmentFile`.

## Variables

| Variable | Valor del código | Proceso y efecto |
|---|---|---|
| `VIDEO_ROOT` | `/mnt/pcloud/My Videos` | Los tres; raíz de archivos |
| `DATA_DIR` | `data/` junto al módulo | Los tres; directorio SQLite |
| `PORT` | `3000` | Web; la unidad incluida usa `3001` |
| `METADATA_EDIT_TOKEN` | Sin definir | Web; habilita edición de nombres |
| `INDEX_MODE` | Sin definir | Indexador; `inventory` evita ffprobe |
| `PROBE_TIMEOUT_MS` | `30000` | Indexador; timeout por ffprobe |
| `MAX_PROBES` | `50` | Indexador; intentos por recorrido; `0` sin límite |
| `RETRY_FAILED` | Desactivado | Indexador; exactamente `1` reintenta fallos técnicos |
| `OPENROUTER_API_KEY` | Sin definir | Visual; obligatoria |
| `OPENROUTER_MODEL` | `openrouter/free` | Visual; selector de modelo/router |
| `OPENROUTER_API_URL` | `https://openrouter.ai/api/v1/chat/completions` | Visual; endpoint de inferencia |
| `MAX_VISUAL` | `1` | Visual; lote entre 1 y 100; `0` no significa ilimitado |
| `RETRY_VISUAL_FAILED` | Desactivado | Visual; exactamente `1` incluye fallidos |
| `VISUAL_VIDEO_ID` | Sin definir | Visual; ID positivo selecciona un solo video técnicamente listo, incluso si ya tiene ficha |

La unidad visual del repositorio declara `MAX_VISUAL=5` y `RETRY_VISUAL_FAILED=1`. El archivo de entorno de systemd puede sobrescribir esas variables. En el último arranque observado se intentó un único video: revisar límites y selector puntual antes de asumir que se procesarán cinco. El contenido del archivo de secretos no se inspeccionó para este documento.

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
RETRY_VISUAL_FAILED=0
```

Este ejemplo elige cinco por lote y no reintenta fallidos automáticamente. Omitir `VISUAL_VIDEO_ID` para procesar la cola; dejarlo fijado provoca que cada arranque vuelva al mismo video.

Para editar identidades, crear `/etc/pcloud-video-metadata.env` con `sudoedit`:

```ini
METADATA_EDIT_TOKEN=REEMPLAZAR_POR_UN_TOKEN_ALEATORIO
```

Se puede generar un valor con `openssl rand -hex 32`. Son archivos distintos: la clave del proveedor no debe entregarse al navegador.

```bash
sudo chmod 600 /etc/pcloud-video-visual.env /etc/pcloud-video-metadata.env
sudo cp pcloud-video-streamer.service pcloud-video-indexer.service pcloud-video-indexer.timer pcloud-video-visual.service /etc/systemd/system/
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

El temporizador técnico es relativo, no un calendario de horas fijas. `Persistent=true` aparece en el archivo, pero no debe interpretarse como recuperación garantizada de todas las ejecuciones omitidas de este temporizador relativo. La etapa visual no se inicia automáticamente cuando termina la técnica.

Cambiar código del servidor exige reiniciarlo. Los procesos de lote cargan el nuevo código en su próximo arranque. Los archivos estáticos se leen en las peticiones; recargar el navegador. Para cambios de unidades: copiar nuevamente, `daemon-reload` y reiniciar la unidad afectada. Cambiar solo el contenido de un `EnvironmentFile` requiere un nuevo arranque del proceso que lo consume.

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
