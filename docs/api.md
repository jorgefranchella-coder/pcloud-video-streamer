# Referencia de la API HTTP

[Volver al README](../README.md)

Base local del despliegue systemd: `http://127.0.0.1:3001`. Todas las rutas de archivo son relativas a `VIDEO_ROOT`; codificar los valores al construir URLs. Las respuestas de datos son JSON; streaming entrega bytes del archivo. No hay prefijo de versión.

## Acceso

Si `ACCESS_TOKEN` está configurado, toda la API y la reproducción requieren una sesión por cookie `HttpOnly` persistente durante 30 días por defecto (`ACCESS_COOKIE_MAX_AGE_SECONDS`). La interfaz solicita el token al iniciar sesión; el token no aparece en URLs ni en enlaces de video. Si una llamada API detecta que la sesión venció, vuelve a solicitarlo y reintenta esa petición una vez. `GET /api/access/status` informa si se requiere acceso y si la sesión actual está autenticada; `POST /api/access/session` recibe `{ "token": "..." }`; `DELETE /api/access/session` cierra la sesión. Sin `ACCESS_TOKEN`, el acceso conserva el comportamiento abierto anterior. Las rutas de edición siguen deshabilitadas si falta `METADATA_EDIT_TOKEN`; cuando hay sesión de biblioteca, esa sesión también autoriza las ediciones y no se vuelve a pedir otro token. Sin sesión de biblioteca, las instalaciones locales pueden usar `Authorization: Bearer <METADATA_EDIT_TOKEN>`. CORS permite solicitudes same-origin y, solo si se configura, los orígenes HTTP(S) exactos de `CORS_ORIGINS`; un origen no autorizado recibe `403`. Las respuestas `/api` usan `Cache-Control: no-store`. El cuerpo JSON está limitado a 4 KiB.

Errores comunes de edición: `503` si no se configuró el token, `401` si no coincide, `400` para datos inválidos y `404` cuando no existe el video/observación solicitado. JSON malformado devuelve `400`, cuerpos mayores a 4 KiB devuelven `413` y otros fallos internos del API devuelven `500`; los errores no incluyen detalles internos. Una ruta `/api` inexistente devuelve `404` con `{ "error": "API route not found" }` (si hay autenticación, primero debe existir una sesión válida).

## Rutas

| Método y ruta | Parámetros / función |
|---|---|
| `GET /api/access/status` | Indica si el acceso está protegido y si la sesión actual es válida |
| `POST /api/access/session` | Recibe `{ "token": "..." }` y establece cookie HttpOnly |
| `DELETE /api/access/session` | Elimina la cookie de sesión |
| `GET /api/list` | `path` opcional, raíz por defecto; lista carpetas y extensiones reconocidas |
| `GET /api/stream` | `path` obligatorio y extensión de video reconocida; entrega archivo y acepta rango simple |
| `GET /api/metadata` | `path` obligatorio; ficha del índice y estado/propuesta de redacción vigente en `refinement` |
| `POST /api/metadata/export` | `{ "path": "..." }`; crea `<video>.metadata.json` con fingerprint, ficha actual y nombres confirmados. Solo escribe si no existe un sidecar; requiere edición habilitada y sesión/Bearer autorizado |
| `POST /api/metadata/import` | `{ "path": "..." }`; valida e importa el sidecar vecino si coincide el fingerprint y todavía no existe una revisión visual. No restaura embeddings faciales ni sobrescribe fichas; requiere edición habilitada |
| `POST /api/jellyfin/preview` | `{ "path": "..." }`; busca por ruta exacta en Jellyfin y devuelve los campos que cambiarían y `refinement_token` para confirmar esa vista previa. No modifica Jellyfin; requiere edición habilitada y variables Jellyfin |
| `POST /api/jellyfin/sync` | `{ "path": "...", "fingerprint": "...", "visual_revision": "...", "refinement_token": "..." }`; vuelve a validar ficha y redacción tras la vista previa y escribe en Jellyfin. Requiere edición habilitada |
| `POST /api/refinement/review` | `{ "path": "...", "input_hash": "...", "action": "approved", "title": "...", "summary": "..." }` o `action: "rejected"`; revisa una propuesta vigente y requiere edición |
| `GET /api/refinement/review-queue` | Devuelve hasta 200 propuestas vigentes pendientes, con ruta, texto editable y ficha visual original; requiere sesión de lectura |
| `POST /api/refinement/retry` | `{ "path": "...", "input_hash": "..." }`; reinicia los intentos de una propuesta fallida vigente; requiere edición |
| `POST /api/index/run` | `{ "process": "technical" | "visual" | "faces" | "refinement" | "pipeline" }`; inicia en el momento un lote del proceso seleccionado, responde `202` con el PID y estado, y rechaza con `409` si la automatización está pausada o la biblioteca está ocupada. Requiere autorización de edición |
| `GET /api/metadata/evidence` | `path`, `revision`, `at_seconds`; JPEG de evidencia activa o de una identidad anterior pendiente |
| `GET /api/faces/inbox` | `after`, `limit`; rostros sin nombre de la versión facial configurada y progreso de indexación |
| `GET /api/faces/automatic` | `after`, `limit`; asignaciones faciales automáticas vigentes para auditar o corregir |
| `GET /api/faces/:id/neighbors` | Busca rostros sin identidad cercanos entre videos vigentes y recomienda identidades usando rostros confirmados; no asigna identidades |
| `GET /api/faces/:id/preview` | JPEG recortado generado bajo demanda desde pCloud; requiere la sesión de lectura y no se guarda en disco |
| `POST /api/faces/assign` | `{ "face_ids": [1, 2], "person_id": 7 }` o `{ "face_ids": [1], "person_name": "Nombre" }`; confirma identidades; requiere sesión autenticada o Bearer en modo local |
| `POST /api/faces/reject` | `{ "face_ids": [1, 2] }`; ignora detecciones sin identificar seleccionadas, elimina sus embeddings y las conserva excluidas al reindexar el mismo video, fingerprint y versión del índice; no afecta identidades confirmadas. Requiere sesión autenticada o Bearer en modo local |
| `POST /api/metadata/visual/retry` | `{ "path": "..." }`; pone un análisis fallido en cola, reinicia sus intentos y registra la acción; requiere sesión autenticada o Bearer en modo local |
| `POST /api/metadata/technical/retry` | `{ "path": "..." }`; devuelve una ficha técnica fallida a la cola del próximo inventario y registra la acción; requiere sesión autenticada o Bearer en modo local |
| `GET /api/index/status` | Conteos, último recorrido, progreso/timer de redacción y configuración efectiva no secreta registrada por cada trabajador |
| `GET /api/search` | `q`, `from`, `to`, `person_id`, `folder`, `limit`, `offset` |
| `GET /api/people` | Catálogo de nombres y cantidades |
| `PATCH /api/people/:id` | `{ "name": "..." }`; renombra y actualiza la búsqueda |
| `PATCH /api/people/:id/description` | `{ "description": "..." }`; guarda o borra el contexto editable de una persona, máximo 500 caracteres; requiere edición |
| `PATCH /api/people/:id/merge` | `{ "target_person_id": 7 }`; fusiona en el destino |
| `POST /api/people/merges/:id/undo` | Deshace una fusión activa |
| `PUT /api/metadata/person` | `{ "person_ids": [7, 8] }`; asigna varias identidades a una observación |
| `POST /api/metadata/person/review-stale` | Marca una identificación antigua revisada sin reasignarla |
| `PATCH /api/metadata/people` | Lista general de nombres de compatibilidad |

No existe un endpoint para cancelar trabajos ni editar fechas desde la web. Las rutas de escritura requieren `METADATA_EDIT_TOKEN` configurado; con `ACCESS_TOKEN`, la cookie de sesión autentica las escrituras sin un segundo token por acción. La exportación solo se ofrece con ficha técnica y visual vigentes; no sobrescribe archivos existentes ni modifica el video. La importación requiere ficha técnica lista, ausencia de una ficha visual previa, un sidecar regular menor a 2 MiB y un fingerprint idéntico con algoritmo conocido. Ese fingerprint compara tamaño y mtime redondeado; no es un hash criptográfico del contenido. La importación restaura asignaciones narrativas confirmadas por nombre y metadata técnica si falta localmente; un resumen facial no equivale a asignaciones faciales activas.

`GET /api/metadata` incluye `identified_faces`, un conteo por persona obtenido de embeddings confirmados localmente, y `jellyfin_configured`, un booleano sin secretos. El catálogo, las fusiones y los filtros exactos de búsqueda incluyen esas asignaciones. Las similitudes de `/neighbors` son cosenos de embeddings SFace, no probabilidades; el cliente debe presentarlas como sugerencias y pedir confirmación humana.

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

La implementación acepta un rango simple `bytes=inicio-fin`, `bytes=inicio-` o `bytes=-sufijo`; recorta un extremo final mayor que el tamaño del archivo. Los rangos múltiples no se sirven y reciben `416`. Si el cliente cierra la conexión, se destruye el stream de lectura. La ruta de streaming solo admite las extensiones de video enumeradas en [Uso](uso.md), aunque el archivo todavía no aparezca en el listado.

## Ficha

`GET /api/metadata?path=...` devuelve la fila de `videos`, más las versiones parseadas de sus JSON, `identified_people`, `identified_people_all`, `stale_identifications`, `identity_history` y `can_edit_people`. Las identidades de una revisión anterior aparecen en `stale_identifications` para revisión manual; nunca se aplican automáticamente a la nueva lista. Al reconciliar una de ellas desde la interfaz, `PUT /api/metadata/person` envía además `stale_observation: { "analysis_revision": "...", "observation_index": 0 }`. Se puede cambiar el nombre elegido durante la reconciliación. El servidor marca como revisada la asignación antigua y guarda la nueva en la misma transacción. `identity_history` lista hasta 100 cambios, del más reciente al más antiguo; las ediciones grupales incluyen los conjuntos de nombres anteriores y nuevos en `previous_people_json` y `people_json`. Un archivo puede existir en el montaje y devolver `404` aquí si todavía no está indexado. Ruta inválida: `400`.

`POST /api/metadata/person/review-stale` recibe `{ "path": "...", "analysis_revision": "...", "observation_index": 0 }`. Cierra la revisión pendiente sin crear una asignación en la ficha actual y registra `dismissed` en `identity_history`. Requiere autorización de edición; devuelve `404` si la identificación ya no está pendiente.

`visual_evidence` contiene los segundos de los fotogramas persistidos para respaldar personas, eventos o pistas de fecha. `GET /api/metadata/evidence?path=...&revision=...&at_seconds=...` devuelve un JPEG de la revisión activa o de una revisión anterior que todavía tenga una identificación pendiente; las revisiones anteriores solo se sirven para los segundos guardados en esas observaciones. La ruta requiere la misma sesión de acceso que la ficha; evidencia inexistente o ya revisada devuelve `404`.

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

Las listas `visual_people`, `visual_events` y `visual_date_clues` contienen objetos `{ "description": "...", "at_seconds": 12 }`. `visual_sampling` registra método y segundos de los fotogramas que se enviaron en la ficha vigente para poder medir cobertura después. `identified_people` conserva la primera identidad de cada observación por compatibilidad. `identified_people_all` devuelve todas como listas por índice, por ejemplo `{ "0": [{ "id": 7, "name": "Jorge" }, { "id": 8, "name": "Ana" }] }`. `PUT /api/metadata/person` acepta `person_ids: [7, 8]`; la primera queda como identidad principal para clientes anteriores. Las asignaciones son manuales y no garantizan correspondencia persistente después de un reanálisis.

## Progreso

`GET /api/index/status` incluye `worker_configuration.technical` y `worker_configuration.visual` después de que cada etapa haya iniciado. Incluye los límites efectivos, flags de reintento, modo puntual/modelo visual y hora del registro; nunca incluye `OPENROUTER_API_KEY` ni `METADATA_EDIT_TOKEN`. `manual_process_runs` informa los inicios solicitados desde la interfaz en este proceso del servidor.

También devuelve `schema_version` y `applied_migrations`, con las migraciones SQLite numeradas aplicadas.

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

`worker_activity` informa si el PID local sigue vivo, heartbeat, etapa y archivo actual sin exponer el PID. No expone estado de systemd ni historial completo de lotes visuales. `visual_manual_retries` y `technical_manual_retries` agregan solicitudes manuales recientes con hora UTC y ruta para que el panel pueda confirmar qué fichas se reencolaron.

`worker_configuration` registra la última configuración no secreta usada por cada etapa (`technical` y `visual`), además de `updated_at`. La configuración visual incluye lote, máximo de fotogramas. Si una etapa nunca inició, su entrada no existe. No representa un proceso vivo ni lee cambios posteriores en los archivos de entorno hasta el siguiente arranque.

`worker_activity` contiene las claves `indexer` y `visual-analyzer` después de su primer inicio, con `status`, `active`, `stale`, `started_at`, `heartbeat_at`, `current_video_id`, `current_path`, `phase`, `last_result`, `last_error` y `finished_at`. `stale=true` significa que el registro sigue en `running` pero el PID de este mismo host ya no existe.

`worker_history` contiene las últimas diez ejecuciones de cada etapa, con ID, estado, inicio, heartbeat, fin y último resultado/error. SQLite conserva como máximo 200 ejecuciones por etapa.

`visual_daily_budget` informa `utc_day`, solicitudes iniciadas, límite efectivo (`0` significa desactivado) y solicitudes restantes (`null` sin límite). El límite `MAX_VISUAL_REQUESTS_PER_DAY` se aplica antes de cada llamada al proveedor; el contador se persiste por fecha UTC en SQLite. Cuando se alcanza, las fichas no procesadas quedan pendientes para un lote posterior. Si está habilitado `pcloud-video-visual.timer`, systemd lo intentará en el siguiente intervalo; de lo contrario, hay que iniciar el servicio manualmente después de las 00:00 UTC.

`visual_monthly_budget` informa mes UTC, costo reportado acumulado, límite, restante y `reserve_per_request_usd`, el número de muestras y el costo máximo reciente de ese modelo. La reserva efectiva es el mayor entre `MAX_VISUAL_COST_RESERVE_PER_REQUEST_USD` y dos veces el `usage.cost` más alto de hasta 30 fichas completadas del mismo modelo en el mes UTC. `MAX_VISUAL_COST_PER_MONTH_USD=0` desactiva el umbral. Si está activo, el analizador requiere que el restante cubra la reserva configurable `MAX_VISUAL_COST_RESERVE_PER_REQUEST_USD` antes de enviar cada solicitud. La suma se calcula a partir del campo `usage.cost` guardado en fichas completadas; el proveedor reporta ese costo después de responder, por lo que la reserva reduce el riesgo pero no garantiza un tope financiero, y fallos sin respuesta no tienen costo contabilizado.

`visual_provider_control` indica si el analizador quedó pausado por fallo de configuración o está esperando cuota/red/proveedor. Los errores permanentes exigen cambiar clave, modelo o endpoint para despejar la pausa; las esperas temporales informan `paused_until`. No expone credenciales ni el fingerprint de configuración.

`visual_timer` consulta el estado de solo lectura de `pcloud-video-visual.timer`: indica si la unidad existe, está activa/habilitada, el último disparo y la próxima ejecución. Si el host no usa systemd o no se puede consultar, `load_state` es `unknown`; la ruta no activa ni modifica unidades.

`pipeline_timer` da la misma información de `pcloud-video-pipeline.timer`. `pipeline.js` ejecuta inventario técnico y, al completarlo, un lote visual limitado. La unidad y el timer son optativos; habilitarlos puede consumir cuota del proveedor.

`automation_control` informa si el procesamiento está pausado, cuándo y desde qué interfaz se cambió, más los últimos 20 eventos de un historial SQLite limitado a 200 entradas. `POST /api/index/control` recibe `{ "paused": true }` o `false` y requiere sesión autenticada o `Authorization: Bearer <METADATA_EDIT_TOKEN>` en modo local. El control detiene nuevas ejecuciones y evita que el analizador tome otro video; el inventario técnico o la solicitud visual que ya está en curso termina normalmente.

La interfaz permite iniciar bajo demanda el inventario técnico, el análisis visual, la indexación facial local, la redacción o el pipeline técnico + visual. Cada inicio ejecuta el mismo script Node que usan los timers, con la configuración del servicio web y los límites de lote de los servicios. Cada etapa tiene su propio bloqueo SQLite; el endpoint impide duplicar una etapa activa, mientras las demás pueden avanzar en paralelo. El control de pausa global debe estar reanudado. La pausa del proveedor visual bloquea el inicio manual visual hasta que venza o se corrija.

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

La búsqueda usa la ficha y el índice FTS5.

| Parámetro | Comportamiento |
|---|---|
| `q` | Se recorta a 100 caracteres; hasta ocho palabras Unicode, prefijos unidos con AND. Vacío lista sin condición FTS |
| `from`, `to` | Fechas reales `YYYY-MM-DD`, inclusivas sobre `recorded_at`; valores inválidos o un rango invertido devuelven `400` |
| `person_id` | ID positivo; filtra asociaciones manuales activas de la revisión actual. IDs inválidos devuelven `400` |
| `folder` | Ruta relativa; incluye esa carpeta y sus descendientes, con límite de ruta segura. Vacío omite el filtro; rutas inválidas devuelven `400` |
| `limit` | Por defecto 50, entero entre 1 y 100 |
| `offset` | Por defecto 0, entero entre 0 y 1.000.000 |

Respuesta `{ "items": [...], "limit": 50, "offset": 0, "has_more": false }`. `has_more` indica si existe al menos un elemento adicional para paginar. Cada item incluye ID, ruta, fecha/fuente, estado técnico, título, resumen visual y, si `q` no está vacío, un snippet FTS con las coincidencias delimitadas por `⟦` y `⟧`. `match_at_seconds` es el segundo del evento cuya descripción comparte más términos con la consulta; es `null` si ningún evento coincide. La interfaz usa ese segundo al abrir el resultado. Con consulta, el orden prioriza relevancia FTS (título y resumen tienen más peso); sin consulta, ordena por fecha descendente con fechas desconocidas al final y luego por ruta. No devuelve el puntaje de relevancia.

## Personas

`GET /api/people` devuelve:

```json
{
  "items": [
    { "id": 7, "name": "Jorge", "appearances": 2, "videos": 1 }
  ],
  "merges": [],
  "can_edit_people": true
}
```

`PATCH /api/people/:id` requiere sesión autenticada (o `Authorization: Bearer <METADATA_EDIT_TOKEN>` en modo local) y recibe `{ "name": "Nombre actualizado" }`. Actualiza el nombre del catálogo y reconstruye el texto de búsqueda de los videos con asociaciones vigentes. Devuelve `409` si otro registro ya usa ese nombre y `404` si la persona no existe.

`PATCH /api/people/:id/merge` recibe `{ "target_person_id": 7 }`. Mantiene el ID destino, mueve las asociaciones actuales e históricas, y archiva el ID origen. Cada fusión guarda las observaciones movidas y aparece en `merges`, las últimas 50 operaciones del historial. `POST /api/people/merges/:id/undo` restaura las asignaciones que aún apuntan al destino; las reasignaciones posteriores se conservan. Para evitar fusiones encadenadas difíciles de revertir, una persona involucrada en otra fusión activa debe deshacerse primero. IDs inválidos devuelven `400`, fusión conflictiva `409` y fusión inexistente `404`.

`appearances` cuenta asociaciones activas de la revisión vigente, no personas detectadas de forma independiente. Dos observaciones del mismo individuo en un video cuentan como dos apariciones y un video. El catálogo puede incluir nombres sin asociaciones; los videos `missing` no suman al conteo.

`PUT /api/metadata/person` recibe uno de estos cuerpos:

```json
{ "path": "Familia/clip.mp4", "analysis_revision": "revision-actual", "observation_index": 0, "person_name": "Jorge" }
```

```json
{ "path": "Familia/clip.mp4", "analysis_revision": "revision-actual", "observation_index": 0, "person_id": 7 }
```

```json
{ "path": "Familia/clip.mp4", "analysis_revision": "revision-actual", "observation_index": 0, "person_id": null }
```

El primer caso crea o reutiliza un nombre; el segundo asigna uno existente; el tercero quita la asignación. Usar una sola modalidad por petición: si se envía un nombre no vacío junto con ID, la lógica del nombre tiene precedencia. `analysis_revision` debe coincidir con la revisión actual que devolvió `GET /api/metadata`; si la ficha cambió, devuelve `409` y no guarda la asignación. El índice comienza en cero, debe ser entero y existir en una ficha visual `done`. El nombre se normaliza quitando espacios extremos y repetidos y admite hasta 80 caracteres.

Respuesta `{ "person": { "id": 7, "name": "Jorge" }, "people": [...] }`; al quitar una asignación, `person` es `null`. Persona desconocida: `400`; video/observación no disponible: `404`. Crear un nombre no asigna automáticamente el resto de sus apariciones.

`PATCH /api/metadata/people` acepta `{ "path": "Familia/clip.mp4", "analysis_revision": "revision-actual", "names": ["Jorge"] }`, hasta 20 nombres de 1–80 caracteres, y devuelve `{ "names": [...] }`. `analysis_revision` debe coincidir con la ficha actual; una revisión desactualizada devuelve `409`. Reemplaza la lista general; no crea filas en el catálogo ni asignaciones por observación. Al reconstruir el texto FTS conserva también los nombres de las asignaciones por observación, para que estas no desaparezcan de la búsqueda.
