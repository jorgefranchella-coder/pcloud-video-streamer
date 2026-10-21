# Referencia de la API HTTP

[Volver al README](../README.md)

Base local del despliegue systemd: `http://127.0.0.1:3001`. Todas las rutas de archivo son relativas a `VIDEO_ROOT`; codificar los valores al construir URLs. Las respuestas de datos son JSON; streaming entrega bytes del archivo. No hay prefijo de versión.

## Acceso

Las rutas GET son públicas para quien tenga acceso de red al servidor. Las dos rutas de edición exigen `Authorization: Bearer <METADATA_EDIT_TOKEN>`. El servidor permite CORS general y limita el cuerpo JSON de entrada a 4 KiB. No hay sesiones, usuarios ni autorización diferenciada por biblioteca.

Errores comunes de edición: `503` si no se configuró el token, `401` si no coincide, `400` para datos inválidos y `404` cuando no existe el video/observación solicitado. El middleware de Express puede emitir errores no JSON para cuerpos malformados o demasiado grandes; no existe un formato de error unificado.

## Rutas

| Método y ruta | Parámetros / función |
|---|---|
| `GET /api/list` | `path` opcional, raíz por defecto; lista carpetas y extensiones reconocidas |
| `GET /api/stream` | `path` obligatorio; entrega archivo, acepta rango simple |
| `GET /api/metadata` | `path` obligatorio; ficha del índice |
| `GET /api/index/status` | Conteos y último recorrido |
| `GET /api/search` | `q`, `from`, `to`, `limit`, `offset` |
| `GET /api/people` | Catálogo de nombres y cantidades |
| `PUT /api/metadata/person` | Asociación de una observación con un nombre |
| `PATCH /api/metadata/people` | Lista general de nombres de compatibilidad |

No existen endpoints para iniciar, pausar o cancelar análisis, renombrar/fusionar personas, editar fechas ni regenerar fichas desde la web.

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

La implementación maneja el formato simple `bytes=inicio-fin` o `bytes=inicio-`. No implementa adecuadamente todos los casos del protocolo, como rangos de sufijo o múltiples rangos. La ruta de streaming no restringe por extensión: puede entregar cualquier archivo regular accesible dentro de `VIDEO_ROOT`, aunque no aparezca en el listado.

## Ficha

`GET /api/metadata?path=...` devuelve la fila de `videos`, más las versiones parseadas de sus JSON, `identified_people` y `can_edit_people`. Un archivo puede existir en el montaje y devolver `404` aquí si todavía no está indexado. Ruta inválida: `400`.

Campos principales:

| Grupo | Campos |
|---|---|
| Identidad y estado | `id`, `relative_path`, `fingerprint`, `size_bytes`, `mtime_ms`, `status`, `error` |
| Técnico | `duration_ms`, `width`, `height`, `codec`, `technical` |
| Fecha | `recorded_at`, `date_precision`, `date_source`, `date_candidates` |
| Visual | `visual_status`, `visual_title`, `visual_summary`, `visual_uncertainty`, `visual_error` |
| Contenido visual | `visual_people`, `visual_events`, `visual_places`, `visual_keywords`, `visual_date_clues` |
| Procedencia | `visual_model`, `visual_prompt_version`, `visual_usage_json`, `visual_fingerprint`, `visual_analyzed_at` |
| Confirmaciones | `confirmed_people`, `identified_people`, `can_edit_people` |

El uso del proveedor se devuelve como texto JSON en `visual_usage_json`. Los campos originales `*_json` también acompañan a sus versiones parseadas; no hay un DTO separado.

Las listas `visual_people`, `visual_events` y `visual_date_clues` contienen objetos `{ "description": "...", "at_seconds": 12 }`. `identified_people` es un objeto con índices de observación como claves, por ejemplo `{ "0": { "id": 7, "name": "Jorge" } }`. No garantiza identidad automática ni correspondencia persistente después de un reanálisis.

## Progreso

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

No se exponen PID, estado de systemd, archivo actualmente procesado, próxima ejecución ni historial de lotes visuales.

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
| `limit` | Por defecto 50, entre 1 y 100 |
| `offset` | Por defecto 0, mínimo 0 |

Respuesta `{ "items": [...], "limit": 50, "offset": 0 }`. Cada item incluye ID, ruta, fecha/fuente, estado técnico, título y resumen visual. No incluye total, snippets ni puntuación. No existen filtros `person_id` o carpeta. La ordenación es fecha descendente con fechas desconocidas al final, seguida por ruta.

## Personas

`GET /api/people` devuelve:

```json
{
  "items": [
    { "id": 7, "name": "Jorge", "appearances": 2, "videos": 1 }
  ]
}
```

`appearances` cuenta asociaciones, no personas detectadas de forma independiente. Dos observaciones del mismo individuo en un video cuentan como dos apariciones y un video. El catálogo puede incluir nombres sin asociaciones. La consulta actual no excluye asociaciones a videos `missing`.

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

`PATCH /api/metadata/people` acepta `{ "path": "Familia/clip.mp4", "names": ["Jorge"] }`, hasta 20 nombres de 1–80 caracteres, y devuelve `{ "names": [...] }`. Reemplaza la lista general; no crea filas en el catálogo ni asignaciones por observación. Su reconstrucción actual del texto FTS puede omitir nombres del catálogo ya asociados: preferir el flujo PUT de la interfaz y tratar la unificación de ambos mecanismos como mejora pendiente.
