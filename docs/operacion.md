# Operación, diagnóstico y recuperación

[Volver al README](../README.md)

## Estado observado el 21 de octubre de 2026

Fotografía de la API y systemd tomada durante esta revisión; no representa un estado permanente.

| Dato | Resultado |
|---|---|
| Biblioteca inventariada | 3.772 videos |
| Fichas técnicas listas / pendientes | 60 / 3.712 |
| Fichas visuales listas | 3 |
| Elegibles esperando análisis visual | 57 |
| Último recorrido | ID 3, `done`, 3.772 vistos |
| Intervalo del recorrido | 13:39:44–13:46:01 UTC del 21/10/2026 (10:39:44–10:46:01 en São Paulo) |
| Resultado del lote técnico | 50 intentados, 50 procesados, 0 fallidos |
| Último lote visual observado | Un video intentado y guardado; servicio finalizado correctamente |
| Unidad técnica en systemd | Aún registra el `core-dump` anterior del arranque de las 06:31 locales |
| Temporizador técnico | Habilitado; intervalo de 6 horas tras inactividad |
| Temporizador visual | No existe en el proyecto ni apareció entre los temporizadores consultados |

El recorrido exitoso se ejecutó directamente como `jorge`, con las mismas rutas del servicio. Por eso el resultado correcto en SQLite no limpió el fallo histórico de systemd. No se determinó la causa del SIGSEGV anterior; no corresponde atribuirlo a créditos del proveedor ni a ffprobe sin evidencia adicional.

## Consulta de estado

```bash
curl -fsS http://127.0.0.1:3001/api/index/status
systemctl status pcloud-video-streamer.service pcloud-video-indexer.service pcloud-video-visual.service --no-pager
systemctl list-timers --all 'pcloud-video-*' --no-pager
journalctl -u pcloud-video-indexer.service -n 50 --no-pager
journalctl -u pcloud-video-visual.service -n 50 --no-pager
```

`inactive (dead)` después de un `oneshot` exitoso es normal. Consultar `Result`, las últimas líneas del registro y los conteos de fichas. El proceso puede finalizar correctamente aunque algún video haya fallado. El endpoint informa estados de la base; no consulta systemd ni confirma la existencia de procesos activos.

## Ejecutar otro lote

Comprobar el montaje y que no haya procesos manuales antes de iniciar la misma etapa:

```bash
mountpoint '/mnt/pcloud/My Videos'
pgrep -af 'node (indexer|visual-analyzer)\.js'
sudo systemctl start pcloud-video-indexer.service
```

El comando espera al final del recorrido. Después se puede iniciar la etapa visual:

```bash
sudo systemctl start pcloud-video-visual.service
```

No es necesario esperar a que toda la biblioteca tenga ficha técnica: el visual toma los videos ya listos. Un arranque no vacía necesariamente la cola. El indexador usa por defecto 50 intentos; el visual usa el lote efectivo de su entorno y puede tener un selector puntual.

Para ver cómo avanza en otra terminal:

```bash
journalctl -fu pcloud-video-visual.service
```

Un `export MAX_VISUAL=5` en la terminal que invoca `systemctl` no cambia el entorno del servicio. Editar `/etc/pcloud-video-visual.env` con `sudoedit`. Revisar `MAX_VISUAL`, `RETRY_VISUAL_FAILED` y `VISUAL_VIDEO_ID` sin publicar el contenido completo del archivo.

Para cambiar los límites técnicos de systemd, usar `sudo systemctl edit pcloud-video-indexer.service` con un override:

```ini
[Service]
Environment=MAX_PROBES=50
Environment=PROBE_TIMEOUT_MS=30000
```

Aplicar `sudo systemctl daemon-reload`; el siguiente arranque usará esos valores. `MAX_PROBES=0` elimina el límite de intentos, pero puede producir una ejecución larga sobre pCloud. No hay pausa/reanudación controlada: detener un proceso puede dejar su estado de base como `running`.

## Ejecución técnica sin privilegios de systemd

Es posible ejecutar el indexador como el usuario con acceso a los videos y a la base. Un bloqueo SQLite compartido impide que el indexador y el analizador visual recorran o modifiquen la biblioteca al mismo tiempo; también se mantiene la exclusión por etapa para evitar dos instancias iguales. La segunda instancia termina indicando qué bloqueo está ocupado. No borrar manualmente `process_locks` mientras el proceso propietario siga vivo.

```bash
cd /home/jorge/orca/workspaces/Video-Home/meta-data-videos
VIDEO_ROOT='/mnt/pcloud/My Videos' \
DATA_DIR='/home/jorge/orca/workspaces/Video-Home/meta-data-videos/data' \
MAX_PROBES=50 /home/jorge/.hermes/node/bin/node indexer.js
```

Esta ejecución no cambia el estado de la unidad systemd. El analizador visual también puede ejecutarse directamente, pero necesita acceso legítimo a la clave. Un archivo `/etc/pcloud-video-visual.env` de root con modo 600 solo será leído por systemd antes de lanzar el proceso como `jorge`; no es legible por una terminal de ese usuario.

## Fallos frecuentes

| Síntoma | Comprobación y acción |
|---|---|
| Solo una ficha visual por ejecución | Ver tamaño efectivo del lote y selector `VISUAL_VIDEO_ID`; leer el contador `Visual batch` del registro. No asumir una causa sin revisar configuración |
| Muchas fichas visuales pendientes | Solo son elegibles las técnicas `done`. No hay encadenamiento ni timer visual |
| `401` / `403` del proveedor | Revisar credencial, acceso y configuración desde el archivo protegido; no compartir la clave |
| `429` | El lote se detiene y la ficha recibe una espera exponencial (inicia en cinco minutos, máximo 24 horas). Consultar la cuota; el siguiente arranque solo la toma cuando vence el plazo y `RETRY_VISUAL_FAILED=1` |
| JSON inválido o esquema incompatible | Revisar `visual_error`; el proveedor debe aceptar imágenes y salida estructurada. Reintentar de forma acotada o revisar el modelo |
| `ffprobe` o `ffmpeg` lento | Ver montaje, caché y archivo actual. Un timeout de proceso no garantiza respuesta inmediata de una lectura FUSE bloqueada |
| Contador recorrido en cero | Se persiste cada 100 archivos; contrastar crecimiento de fichas y proceso activo |
| `running` tras un cierre abrupto | La interfaz marca `stale` cuando el PID del mismo host ya no existe. El indexador reconcilia recorridos abandonados al iniciar; el analizador visual programa el video interrumpido para reintento diferido. No borrar el bloqueo mientras su proceso siga vivo |
| SIGSEGV / `core-dump` | Consultar journal y, si está instalado, `coredumpctl info`; revisar runtime Node y módulo nativo. La causa observada sigue sin determinar |
| Servicio técnico sigue `failed` tras un lote manual exitoso | Son estados diferentes. `sudo systemctl reset-failed pcloud-video-indexer.service` limpia el registro de systemd; no repara ni procesa archivos |
| Video visible pero no reproducible | Comprobar códec del navegador y lectura remota. No existe transcodificación |
| No aparece el selector de nombres | Configurar `METADATA_EDIT_TOKEN` en el entorno del servidor y reiniciarlo |
| Búsqueda no encuentra un nombre | Confirmar asignación; búsqueda textual por prefijos. Revisar posibles inconsistencias entre la ruta PATCH antigua y el catálogo |

## Respaldo

Respaldar código/configuración, base SQLite y credenciales de rclone/proveedor por canales apropiados para cada contenido. Los originales de video son una fuente separada. La caché VFS y `node_modules` se pueden reconstruir; las confirmaciones manuales de personas no se recuperan simplemente volviendo a analizar.

Con WAL activo, no copiar únicamente `videos.sqlite` mientras hay escritores: puede faltar información aún presente en el WAL. Desde la raíz del proyecto, una copia consistente puede crearse mediante la API de backup de la dependencia instalada:

```bash
video_backup_dir="${XDG_STATE_HOME:-$HOME/.local/state}/pcloud-video-backups"
mkdir -p "$video_backup_dir"
chmod 700 "$video_backup_dir"
DB_BACKUP="$video_backup_dir/videos-$(date +%Y%m%d-%H%M%S).sqlite" \
node <<'NODE'
const Database = require('better-sqlite3');
const path = require('path');
const source = path.join(process.env.DATA_DIR || path.join(process.cwd(), 'data'), 'videos.sqlite');
const db = new Database(source, { readonly: true });
db.backup(process.env.DB_BACKUP)
  .then(() => console.log('Respaldo completado'))
  .catch(error => { console.error(error.message); process.exitCode = 1; })
  .finally(() => db.close());
NODE
```

Ajustar `DATA_DIR` si la base no está en `./data`. El ejemplo guarda las copias fuera del repositorio, en un directorio privado del usuario. Replicarlas a un destino de respaldo independiente. Verificar integridad y lectura del respaldo antes de considerarlo recuperable; si se dispone de sqlite3:

```bash
sqlite3 /ruta/al/respaldo.sqlite 'PRAGMA integrity_check;'
```

Resultado esperado: `ok`. Este documento no ejecutó una restauración.

## Restauración

1. Detener timer, servidor y ambos servicios de lote; verificar también procesos manuales. Evitar cualquier escritor durante la sustitución.
2. Conservar el directorio de datos actual completo, incluidos WAL/SHM, en otra ubicación. No mezclar archivos WAL antiguos con una base restaurada.
3. Crear un nuevo `DATA_DIR`, colocar el backup consistente como `videos.sqlite` y asignar permisos al usuario del servicio.
4. Verificar integridad, conteos, nombres confirmados y rutas de una muestra. Mantener el respaldo previo para poder revertir.
5. Iniciar el servidor y revisar interfaz/API. Reactivar después el temporizador técnico. El visual sigue siendo manual.

## Desarrollo y comprobaciones

No hay `npm test` ni suite automatizada. Antes de cambios de código, revisar sintaxis, probar API y UX contra una base temporal y usar videos de prueba para evitar regenerar fichas reales. No simular un recorrido completo sobre una raíz vacía usando la base de producción.

Para documentación, comprobar enlaces locales, consistencia con nombres de variables/rutas y ausencia de credenciales. Las mejoras y comprobaciones de regresión propuestas están en [Mejoras](mejoras.md).
