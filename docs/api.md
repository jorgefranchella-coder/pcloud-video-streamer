# Referencia de la API HTTP

[Volver al README](../README.md)

Base local del despliegue systemd: `http://127.0.0.1:3001`. Todas las rutas de archivo son relativas a `VIDEO_ROOT`; codificar los valores al construir URLs. Las respuestas de datos son JSON; streaming entrega bytes del archivo. No hay prefijo de versión.

## Acceso

Si `ACCESS_TOKEN` está configurado, toda la API y la reproducción requieren una sesión por cookie `HttpOnly` de 12 horas. La interfaz solicita el token y lo intercambia por la cookie; el token no aparece en URLs ni en enlaces de video. `GET /api/access/status` informa si se requiere acceso y si la sesión actual está autenticada; `POST /api/access/session` recibe `{ "token": "..." }`; `DELETE /api/access/session` cierra la sesión. Sin `ACCESS_TOKEN`, el acceso conserva el comportamiento abierto anterior. Las dos rutas de edición exigen además `Authorization: Bearer <METADATA_EDIT_TOKEN>`. CORS permite solicitudes same-origin y, solo si se configura, los orígenes HTTP(S) exactos de `CORS_ORIGINS`; un origen no autorizado recibe `403`. El cuerpo JSON está limitado a 4 KiB.

Errores comunes de edición: `503` si no se configuró el token, `401` si no coincide, `400` para datos inválidos y `404` cuando no existe el video/observación solicitado. El middleware de Express puede emitir errores no JSON para cuerpos malformados o demasiado grandes; no existe un formato de error unificado.

## Rutas

| Método y ruta | Parámetros / función |
|---|---|
| `GET /api/access/status` | Indica si el acceso está protegido y si la sesión actual es válida |
| `POST /api/access/session` | Recibe `{ "token": "..." }` y establece cookie HttpOnly |
| `DELETE /api/access/session` | Elimina la cookie de sesión |
| `GET /api/list` | `path` opcional, raíz por defecto; lista carpetas y extensiones reconocidas |
| `GET /api/stream` | `path` obligatorio; entrega archivo, acepta rango simple |
| `GET /api/metadata` | `path` obligatorio; ficha del índice |
| `GET /api/metadata/evidence` | `path`, `revision`, `at_seconds`; JPEG de evidencia de la revisión activa |
| `GET /api/index/status` | Conteos, último recorrido y configuración efectiva no secreta registrada por cada trabajador |
| `GET /api/search` | `q`, `from`, `to`, `person_id`, `folder`, `limit`, `offset` |
| `GET /api/people` | Catálogo de nombres y cantidades |
| `PATCH /api/people/:id` | `{ "name": "..." }`; renombra con `METADATA_EDIT_TOKEN` y actualiza la búsqueda |
| `PUT /api/metadata/person` | Asociación de una observación con un nombre |
| `PATCH /api/metadata/people` | Lista general de nombres de compatibilidad |

No existen endpoints para iniciar, pausar o cancelar análisis, fusionar personas, editar fechas ni regenerar fichas desde la web. El catálogo permite renombrar personas con `METADATA_EDIT_TOKEN`.

## Directorios y reproducción

```bash
curl -fsS --get http://127.0.0.1:3001/api/list \
  --data-urlencode 'path=Familia'
```

Respuesta ilustrativa:

```json
{
  "path": "Familia",
  "items": [
    { "name": "2014", "type": "folder", "path": "Familia/2014" },
    { "name": "clip.mp4", "type": "video", "path": "Familia/clip.mp4" }
  ]
}
```

Orden: carpetas primero, luego nombres. `403` para rutas rechazadas, `404` para directorios inexistentes y `500` para otros fallos de lectura.

```bash
curl --get http://127.0.0.1:3001/api/stream \
  --data-urlencode 'path=Familia/clip.mp4' \
  -H 'Range: bytes=0-1023' --output /tmp/video-fragmento.bin
```

Con rango aceptado devuelve `206`, `Content-Range`, `Content-Length` y tipo MIME. Sin Range devuelve el archivo completo con `200`. Un rango rechazado devuelve `416` con `Content-Range: bytes */tamaño`. Ruta ausente: `400`; ruta fuera de raíz: `403`; archivo inexistente/no regular: `404`.

La implementación acepta un rango simple `bytes=inicio-fin`, `bytes=inicio-` o `bytes=-sufijo`; recorta un extremo final mayor que el tamaño del archivo. Los rangos múltiples no se sirven y reciben `416`. Si el cliente cierra la conexión, se destruye el stream de lectura. La ruta de streaming no restringe por extensión: puede entregar cualquier archivo regular accesible dentro de `VIDEO_ROOT`, aunque no aparezca en el listado.

## Ficha

`GET /api/metadata?path=...` devuelve la fila de `videos`, más las versiones parseadas de sus JSON, `identified_people`, `stale_identifications` y `can_edit_people`. Las identidades de una revisión anterior aparecen en `stale_identifications` para revisión manual; nunca se aplican automáticamente a la nueva lista. Al reasignar una de ellas desde la interfaz, `PUT /api/metadata/person` envía además `stale_observation: { "analysis_revision": "...", "observation_index": 0 }`. El servidor verifica y marca como revisada esa asignación anterior en la misma transacción que guarda la nueva. El registro histórico se conserva, pero deja de aparecer como pendiente. Un archivo puede existir en el montaje y devolver `404` aquí si todavía no está indexado. Ruta inválida: `400`.

`visual_evidence` contiene los segundos de los fotogramas persistidos para respaldar personas, eventos o pistas de fecha. `GET /api/metadata/evidence?path=...&revision=...&at_seconds=...` devuelve un JPEG solo si la revisión sigue vigente y el segundo está registrado en esa ficha. La ruta requiere la misma sesión de acceso que la ficha; una revisión anterior o evidencia ausente devuelve `404`.

Campos principales:

| Grupo | Campos |
|---|---|
| Identidad y estado | `id`, `relative_path`, `fingerprint`, `size_bytes`, `mtime_ms`, `status`, `error` |
| Técnico | `duration_ms`, `width`, `height`, `codec`, `technical` |
| Fecha | `recorded_at`, `date_precision`, `date_source`, `date_candidates` |
| Visual | `visual_status`, `visual_title`, `visual_summary`, `visual_uncertainty`, `visual_error`, `visual_attempts`, `visual_next_attempt_at`, `visual_error_class` |
| Contenido visual | `visual_people`, `visual_events`, `visual_places`, `visual_keywords`, `visual_date_clues`, `visual_evidence` |
| Procedencia | `visual_model`, `visual_prompt_version`, `visual_usage_json`, `visual_fingerprint`, `visual_analyzed_at`, `visual_revision` |
| Confirmaciones | `confirmed_people`, `identified_people`, `stale_identifications`, `can_edit_people` |

El uso del proveedor se devuelve como texto JSON en `visual_usage_json`. Los campos originales `*_json` también acompañan a sus versiones parseadas; no hay un DTO separado.

Las listas `visual_people`, `visual_events` y `visual_date_clues` contienen objetos `{ "description": "...", "at_seconds": 12 }`. `identified_people` es un objeto con índices de observación como claves, por ejemplo `{ "0": { "id": 7, "name": "Jorge" } }`. No garantiza identidad automática ni correspondencia persistente después de un reanálisis.

## Progreso

`GET /api/index/status` incluye `worker_configuration.technical` y `worker_configuration.visual` después de que cada etapa haya iniciado. Incluye los límites efectivos, flags de reintento, modo puntual/modelo visual y hora del registro; nunca incluye `OPENROUTER_API_KEY` ni `METADATA_EDIT_TOKEN`.

`GET /api/index/status` devuelve:

```json
{
  "counts": { "done": 60, "pending": 3712 },
  "visual_counts": { "done": 3, "pending": 3769 },
  "visual_ready_counts": { "done": 3, "pending": 57 },
  "last_scan": {
    "id": 3,
    "started_at": "2026-10-21 13:39:44",
    "completed_at": "2026-10-21 13:46:01",
    "status": "done",
    "seen_count": 3772,
    "error": null
  }
}
```

Ejemplo basado en la ejecución documentada, no respuesta fija. Las claves de estados con cero registros se omiten: consumirlas como cero. `last_scan` es `null` si no hay recorridos.

- `counts`: todos los registros, incluidos `missing` cuando existen.
- `visual_counts`: todos los videos salvo los técnicos `missing`; un estado visual nulo cuenta como `pending`.
- `visual_ready_counts`: solo videos técnicos `done`.
- Timestamps de SQLite: UTC, en texto sin sufijo de zona. La interfaz los interpreta como UTC y los muestra en hora local.

`worker_activity` informa si el PID local sigue vivo, heartbeat, etapa y archivo actual sin exponer el PID. No expone estado de systemd ni historial completo de lotes visuales.

`worker_configuration` registra la última configuración no secreta usada por cada etapa (`technical` y `visual`), además de `updated_at`. Si una etapa nunca inició, su entrada no existe. No representa un proceso vivo ni lee cambios posteriores en los archivos de entorno hasta el siguiente arranque.

`worker_activity` contiene las claves `indexer` y `visual-analyzer` después de su primer inicio, con `status`, `active`, `stale`, `started_at`, `heartbeat_at`, `current_video_id`, `current_path`, `phase`, `last_result`, `last_error` y `finished_at`. `stale=true` significa que el registro sigue en `running` pero el PID de este mismo host ya no existe.

`worker_history` contiene las últimas diez ejecuciones de cada etapa, con ID, estado, inicio, heartbeat, fin y último resultado/error. SQLite conserva como máximo 200 ejecuciones por etapa.

`visual_daily_budget` informa `utc_day`, solicitudes iniciadas, límite efectivo (`0` significa desactivado) y solicitudes restantes (`null` sin límite). El límite `MAX_VISUAL_REQUESTS_PER_DAY` se aplica antes de cada llamada al proveedor; el contador se persiste por fecha UTC en SQLite. Cuando se alcanza, las fichas no procesadas quedan pendientes para un lote posterior. Si está habilitado `pcloud-video-visual.timer`, systemd lo intentará en el siguiente intervalo; de lo contrario, hay que iniciar el servicio manualmente después de las 00:00 UTC.

`visual_provider_control` indica si el analizador quedó pausado por fallo de configuración o está esperando cuota/red/proveedor. Los errores permanentes exigen cambiar clave, modelo o endpoint para despejar la pausa; las esperas temporales informan `paused_until`. No expone credenciales ni el fingerprint de configuración.

`visual_timer` consulta el estado de solo lectura de `pcloud-video-visual.timer`: indica si la unidad existe, está activa/habilitada, el último disparo y la próxima ejecución. Si el host no usa systemd o no se puede consultar, `load_state` es `unknown`; la ruta no activa ni modifica unidades.

`visual_retry_wait` informa cuántos fallos tienen reintento pendiente y el próximo horario. Los errores transitorios usan espera exponencial hasta 24 horas; `429` comienza en cinco minutos y otros transitorios en un minuto. Cada fingerprint admite hasta `MAX_VISUAL_ATTEMPTS` intentos automáticos (por defecto cinco). Los errores `401`, `403` y otros `4xx` no reciben reintento automático. `RETRY_VISUAL_FAILED=1` es necesario para tomar fallos ya vencidos en una ejecución posterior.

## Búsqueda

```bash
curl -fsS --get http://127.0.0.1:3001/api/search \
  --data-urlencode 'q=Jorge cumpleaños' \
  --data-urlencode 'from=2010-01-01' \
  --data-urlencode 'to=2020-12-31' \
  --data-urlencode 'limit=50' \
  --data-urlencode 'offset=0'
```

| Parámetro | Comportamiento |
|---|---|
| `q` | Se recorta a 100 caracteres; hasta ocho palabras Unicode, prefijos unidos con AND. Vacío lista sin condición FTS |
| `from`, `to` | Formato `YYYY-MM-DD`, inclusivos sobre `recorded_at`; se valida forma, no calendario completo. Formatos inválidos se ignoran |
| `person_id` | ID positivo; filtra asociaciones manuales activas de la revisión actual. IDs inválidos devuelven `400` |
| `folder` | Ruta relativa; incluye esa carpeta y sus descendientes, con límite de ruta segura. Vacío omite el filtro; rutas inválidas devuelven `400` |
| `limit` | Por defecto 50, entre 1 y 100 |
| `offset` | Por defecto 0, mínimo 0 |

Respuesta `{ "items": [...], "limit": 50, "offset": 0 }`. Cada item incluye ID, ruta, fecha/fuente, estado técnico, título, resumen visual y, si `q` no está vacío, un snippet FTS con las coincidencias delimitadas por `⟦` y `⟧`. `match_at_seconds` es el segundo del evento cuya descripción comparte más términos con la consulta; es `null` si ningún evento coincide. La interfaz usa ese segundo al abrir el resultado. Con consulta, el orden prioriza relevancia FTS (título y resumen tienen más peso); sin consulta, ordena por fecha descendente con fechas desconocidas al final y luego por ruta. No devuelve el puntaje de relevancia.

## Personas

`GET /api/people` devuelve:

```json
{
  "items": [
    { "id": 7, "name": "Jorge", "appearances": 2, "videos": 1 }
  ],
  "can_edit_people": true
}
```

`PATCH /api/people/:id` requiere `Authorization: Bearer <METADATA_EDIT_TOKEN>` y recibe `{ "name": "Nombre actualizado" }`. Actualiza el nombre del catálogo y reconstruye el texto de búsqueda de los videos con asociaciones vigentes. Devuelve `409` si otro registro ya usa ese nombre y `404` si la persona no existe.

`appearances` cuenta asociaciones activas de la revisión vigente, no personas detectadas de forma independiente. Dos observaciones del mismo individuo en un video cuentan como dos apariciones y un video. El catálogo puede incluir nombres sin asociaciones; los videos `missing` no suman al conteo.

`PUT /api/metadata/person` recibe uno de estos cuerpos:

```json
{ "path": "Familia/clip.mp4", "observation_index": 0, "person_name": "Jorge" }
```

```json
{ "path": "Familia/clip.mp4", "observation_index": 0, "person_id": 7 }
```

```json
{ "path": "Familia/clip.mp4", "observation_index": 0, "person_id": null }
```

El primer caso crea o reutiliza un nombre; el segundo asigna uno existente; el tercero quita la asignación. Usar una sola modalidad por petición: si se envía un nombre no vacío junto con ID, la lógica del nombre tiene precedencia. El índice comienza en cero, debe ser entero y existir en una ficha visual `done`. El nombre se normaliza quitando espacios extremos y repetidos y admite hasta 80 caracteres.

Respuesta `{ "person": { "id": 7, "name": "Jorge" }, "people": [...] }`; al quitar una asignación, `person` es `null`. Persona desconocida: `400`; video/observación no disponible: `404`. Crear un nombre no asigna automáticamente el resto de sus apariciones.

`PATCH /api/metadata/people` acepta `{ "path": "Familia/clip.mp4", "names": ["Jorge"] }`, hasta 20 nombres de 1–80 caracteres, y devuelve `{ "names": [...] }`. Reemplaza la lista general; no crea filas en el catálogo ni asignaciones por observación. Al reconstruir el texto FTS conserva también los nombres de las asignaciones por observación, para que estas no desaparezcan de la búsqueda.
