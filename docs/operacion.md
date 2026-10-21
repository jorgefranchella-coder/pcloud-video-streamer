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
| Muchas fichas visuales pendientes | Solo son elegibles las técnicas `done`. El timer visual es opcional y no queda habilitado por defecto; ver Configuración |
| `401` / `403` del proveedor | El trabajador pausa la etapa y no vuelve a llamar con la misma configuración. Revisar credencial/permisos; cambiar clave, modelo o endpoint y reiniciar el trabajador para reactivar |
| `429` | El lote se detiene y la ficha recibe una espera exponencial (inicia en cinco minutos, máximo 24 horas). Consultar la cuota; el siguiente arranque solo la toma cuando vence el plazo y `RETRY_VISUAL_FAILED=1` |
| Pausa de proveedor visible | `/api/index/status` incluye `visual_provider_control`; los fallos de cuota o red esperan hasta el horario indicado, y los errores de configuración requieren cambiar clave/modelo/endpoint |
| Presupuesto diario visual agotado | Revisar `visual_daily_budget` en `/api/index/status`; las fichas restantes siguen pendientes. El contador usa UTC y se renueva a las 00:00 UTC; iniciar otro lote después de ese momento |
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

Respaldar código/configuración, base SQLite, `DATA_DIR/evidence` y credenciales de rclone/proveedor por canales apropiados para cada contenido. Los originales de video son una fuente separada. La caché VFS y `node_modules` se pueden reconstruir; las confirmaciones manuales de personas no se recuperan simplemente volviendo a analizar.

Las imágenes de evidencia viven en `DATA_DIR/evidence/<video_id>/<revision>`. Además de la revisión activa, se conservan las anteriores mientras tengan identificaciones pendientes. Para respaldar base e imágenes como un conjunto coherente, detener servidor, timers, trabajadores y procesos manuales; anotar cuáles estaban activos para restaurarlos al terminar.

Con WAL activo, no copiar únicamente `videos.sqlite` mientras hay escritores: puede faltar información aún presente en el WAL. El comando genera una copia mediante la API SQLite de la dependencia instalada, verifica su integridad y copia las imágenes con permisos privados. También aborta si detecta un bloqueo de trabajador con PID vivo en este host o un bloqueo registrado en otro host; limpia de la copia los bloqueos locales abandonados para que no queden atados a PID/host viejos. Ejecutarlo desde la raíz del proyecto:

```bash
sudo systemctl stop pcloud-video-indexer.timer pcloud-video-visual.timer
sudo systemctl stop pcloud-video-indexer.service pcloud-video-visual.service pcloud-video-streamer.service
pgrep -af 'node (indexer|visual-analyzer|server)\.js'
DATA_DIR="$PWD/data" npm run backup -- /ruta/privada/pcloud-video-backups
```

Si el timer visual no está instalado, quitarlo del comando. Si `pgrep` muestra procesos manuales, esperar a que terminen o detenerlos antes de copiar. Cada copia queda en un directorio fechado con `videos.sqlite`, `evidence/` si existe, `manifest.json` y un archivo `COMPLETE`. El programa falla si la base no pasa `integrity_check`. Verificar la copia antes de replicarla a un destino independiente:

```bash
npm run verify-backup -- /ruta/privada/pcloud-video-backups/pcloud-video-FECHA-PID
sudo systemctl start pcloud-video-streamer.service
```

El verificador comprueba el marcador, integridad SQLite, claves foráneas, tablas requeridas y cantidad/tamaño total de evidencia frente al manifiesto. Reactivar solo los timers que estaban activos antes del respaldo. Este procedimiento no sustituye una restauración de prueba; este documento todavía no ejecutó una.

## Restauración

Detener timer, servidor y ambos servicios de lote; verificar también procesos manuales. Evitar cualquier escritor durante la restauración. Conservar el directorio de datos actual completo, incluidos WAL/SHM, en otra ubicación; no mezclar esos archivos con la base restaurada.

Restaurar siempre a un `DATA_DIR` nuevo que todavía no exista. El comando verifica primero el respaldo, copia la base y las evidencias, y vuelve a comprobar integridad, claves foráneas y tamaño de las evidencias:

```bash
npm run restore-data -- \
  /ruta/privada/pcloud-video-backups/pcloud-video-FECHA-PID \
  /home/jorge/orca/workspaces/Video-Home/meta-data-videos/data-restored
```

La ruta destino contiene `videos.sqlite`, `evidence/` si estaba en el respaldo y `RESTORE_COMPLETE`. Si falla una comprobación, el comando elimina la carpeta destino que acaba de crear. Apuntar `DATA_DIR` a esa ruta nueva en el servidor, el indexador y el analizador visual; deben compartir exactamente la misma base. Asignar permisos al usuario de systemd y aplicar `daemon-reload` si cambió un archivo de entorno.

Iniciar primero el servidor y revisar interfaz/API, conteos, nombres confirmados y rutas de una muestra. Mantener el directorio anterior y el respaldo para poder revertir. Reactivar después solo los timers que estaban activos antes de la restauración; el timer visual es opcional y queda deshabilitado por defecto.

## Desarrollo y comprobaciones

No hay `npm test` ni suite automatizada. Antes de cambios de código, revisar sintaxis, probar API y UX contra una base temporal y usar videos de prueba para evitar regenerar fichas reales. No simular un recorrido completo sobre una raíz vacía usando la base de producción.

Para documentación, comprobar enlaces locales, consistencia con nombres de variables/rutas y ausencia de credenciales. Las mejoras y comprobaciones de regresión propuestas están en [Mejoras](mejoras.md).
