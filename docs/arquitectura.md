# Arquitectura y modelo de datos

[Volver al README](../README.md)

## Componentes y circulación de datos

```mermaid
flowchart LR
  PC[pCloud] --> RC[rclone y caché VFS]
  RC --> FS[VIDEO_ROOT montado]
  FS --> WEB[server.js / Express]
  WEB --> UI[Navegador y reproductor]
  FS --> IDX[indexer.js + ffprobe]
  IDX --> DB[(SQLite local + FTS5)]
  DB --> VA[visual-analyzer.js]
  FS --> FF[ffmpeg: fotogramas JPEG]
  FF --> VA
  VA --> OR[OpenRouter Chat Completions]
  OR --> VA
  VA --> DB
  DB --> WEB
  UI --> EDIT[Asignación manual de personas]
  EDIT --> WEB
  WEB --> DB
```

La aplicación lee archivos a través del montaje; no utiliza directamente la API de pCloud. rclone administra credenciales, acceso remoto y caché. Aunque solo se envían fotogramas a OpenRouter, leer y buscar posiciones con ffprobe/ffmpeg puede descargar una cantidad importante del archivo a la caché local.

El servidor, el indexador y el analizador son procesos independientes que comparten una base SQLite local. La API no ofrece rutas para arrancar trabajos. systemd incluye un temporizador técnico y otro visual opcional; el visual no se habilita durante la instalación. El indexador y el analizador reclaman en una transacción un bloqueo SQLite común para toda la biblioteca y otro propio de su etapa; una segunda tarea concurrente termina con error. Los bloqueos huérfanos del mismo host se recuperan al detectar que el PID ya no existe.

## Inventario y extracción técnica

`indexer.js` recorre recursivamente `VIDEO_ROOT`, omite enlaces simbólicos y reconoce las extensiones definidas en el código. Cada video se identifica por su ruta relativa única. Su fingerprint es `tamaño:mtimeRedondeadoEnMilisegundos`; no es un hash del contenido.

Cada recorrido hace upsert de archivos vistos. Un archivo nuevo, modificado o previamente marcado `missing` vuelve a `pending`. Cambiar el fingerprint invalida los campos técnicos y visuales, pero hoy no elimina inmediatamente las filas de asociaciones de personas: ver [Mejoras](mejoras.md).

El modo normal analiza archivos elegibles mediante ffprobe, de uno en uno, con timeout configurado de 30 segundos y hasta 4 MiB de salida. Omite archivos terminados sin cambios y los fallidos sin cambios salvo `RETRY_FAILED=1`. El límite de 50 afecta a intentos de análisis, no al número de archivos recorridos. Incluso al alcanzar ese límite continúa el inventario completo.

Tras un recorrido completo, los registros no vistos quedan `missing`; no se borran. Si hay un fallo de lectura que interrumpe el recorrido, no se aplica ese marcado global. También se rechaza un recorrido vacío si ya había videos registrados. Un fallo individual de ffprobe puede coexistir con un recorrido `done`: consultar ambos niveles.

Las fechas candidatas proceden de etiquetas de captura de contenedor/streams, de una fecha en el nombre base del archivo y de su mtime. Se valida el día calendario. Solo se elige `recorded_at` cuando las fuentes distintas de mtime contienen un único día; se guarda precisión `day`. No se infiere de carpetas, audio o imágenes.

## Análisis visual

1. Reclama en una transacción el bloqueo común de biblioteca y el de la etapa visual, registra la configuración sin secretos y exige `OPENROUTER_API_KEY`. Si una instancia anterior dejó filas `running`, las convierte en fallidas con reintento diferido.
2. Selecciona videos con estado técnico `done`, prioriza pendientes y después fallidos transitorios vencidos cuando `RETRY_VISUAL_FAILED=1`. `VISUAL_VIDEO_ID` selecciona un video concreto para regenerarlo. El máximo automático de intentos por fingerprint es cinco por defecto.
3. Comprueba ruta real, tamaño y mtime contra el fingerprint guardado.
4. Extrae imágenes al 8 %, 35 %, 65 % y 92 % de la duración, redondeando a segundos y eliminando duplicados. Usa el segundo cero si no hay duración o es menor a dos segundos.
5. Genera JPEG de hasta 768 × 768 conservando proporciones, con 45 segundos de timeout por extracción. Rechaza una imagen mayor de 700.000 bytes. Si falla algún fotograma puede continuar con los restantes; si fallan todos, falla el video.
6. Envía las imágenes en memoria, codificadas en base64, y sus tiempos al endpoint `/chat/completions` usando HTTPS y sin seguir redirecciones. Solicita JSON Schema, soporte de parámetros y un máximo de 2.000 tokens de salida, con timeout de 120 segundos. Limita la respuesta normal a 1 MiB y los cuerpos de error a 16 KiB.
7. Parsea JSON y valida tipos, tamaños de listas e índices de fotogramas. Convierte cada referencia en `at_seconds`. El prompt vigente es `visual-v2` y pide textos en español sin nombres inferidos.
8. Revalida el archivo antes de guardar. Persiste ficha, nueva revisión, modelo configurado, versión de prompt, uso reportado y fingerprint; reconstruye el texto de búsqueda. Las asociaciones anteriores quedan guardadas como pendientes de revisión y no se aplican a la revisión nueva.

Los errores 401/403 y otros 4xx del proveedor detienen el lote y pausan la etapa hasta que cambie la clave, el modelo o el endpoint. Los 429, 5xx y fallos de red detienen el lote y pausan llamadas hasta vencer una espera exponencial. Fallos transitorios individuales reciben reintento diferido; respuestas rechazadas no se reintentan automáticamente. El límite automático por fingerprint es configurable. Otros fallos individuales pueden registrarse y permitir que el lote termine con código cero. Por eso «servicio finalizado con éxito» no garantiza que todas sus fichas hayan tenido éxito.

No hay caché persistente de fotogramas, historial de versiones completas de fichas visuales ni tabla general de trabajos. Sí se guardan los intentos y próximas fechas por video, un contador diario de solicitudes y un historial acotado de ejecuciones de trabajadores. `visual_model` guarda el selector configurado; con un router no identifica necesariamente el modelo efectivo que atendió la solicitud.

## SQLite

Archivo: `DATA_DIR/videos.sqlite`. Se habilitan WAL, claves foráneas y espera de hasta 5 segundos ante bloqueo. Los procesos crean tablas y columnas faltantes al importar `metadata-store.js`, dentro de una transacción `BEGIN IMMEDIATE` para serializar arranques y revertir los cambios si la inicialización falla. No existe un sistema completo de migraciones versionadas. `user_version=1` se utiliza para la reconstrucción inicial del índice FTS.

| Tabla | Propósito y campos principales |
|---|---|
| `videos` | `id`, ruta única, tamaño, mtime, fingerprint; estado y error técnicos; duración/resolución/códec; fecha/evidencia; estado, título, resumen, incertidumbre, JSON de contenido y uso visual; modelo/prompt; marcas temporales; `last_seen_scan` |
| `scans` | ID, inicio, fin, estado, cantidad vista y error del recorrido |
| `process_locks` | Bloqueo de etapa con token, PID, host y adquisición |
| `worker_runs` | Último estado de ejecución, heartbeat, archivo/fase actual y resultado/error |
| `worker_run_history` | Historial acotado a 200 ejecuciones recientes por etapa |
| `visual_daily_requests` | Solicitudes visuales iniciadas por día UTC |
| `visual_provider_control` | Pausa persistente por error de configuración o espera de proveedor |
| `DATA_DIR/evidence/<video_id>/<revision>/*.jpg` | Fotogramas usados como evidencia; la API autenticada sirve la revisión activa y conserva las anteriores mientras tengan identidades pendientes de revisión |
| `worker_configuration` | Configuración efectiva no secreta registrada por cada etapa |
| `people` | ID, nombre único con colación SQLite `NOCASE`, creación y destino de fusión opcional |
| `video_person_observations` | Clave `(video_id, analysis_revision, observation_index)`, descripción/segundo observados, persona, confirmación y fecha opcional de revisión; conserva identidades anteriores sin asignarlas a otra ficha |
| `person_merge_history` | Historial de fusiones de catálogo, destino, estado y tiempos; conserva origen archivado para permitir deshacer |
| `person_merge_observations` | Observaciones movidas por fusión, para restaurarlas si siguen asignadas al destino |
| `video_person_identity_history` | Registro cronológico de altas, cambios, bajas y reconciliaciones humanas de identidades por revisión |
| `video_fts` | FTS5 sobre ruta, título, resumen y texto visual agregado; contenido externo en `videos`, sincronizado con triggers |

Los campos JSON almacenan candidatos de fecha, resumen técnico, personas observadas, eventos, lugares, palabras clave, pistas de fecha, uso y nombres generales confirmados. La API conserva los campos JSON originales y agrega versiones parseadas.

Cada análisis visual recibe `visual_revision`; las asignaciones se ligan a esa revisión y guardan una copia de descripción/segundo. Tras regenerar o cambiar el fingerprint, la ficha no hereda esas identidades; la API ofrece las no revisadas en `stale_identifications`. Reasignar una observación anterior a una actual registra la revisión en la misma transacción que guarda la nueva asignación. También se puede cerrar una identificación anterior sin reasignarla; la decisión queda registrada como `dismissed`. Las observaciones no tienen ID estable entre revisiones, recorte de rostro o embedding. `confirmed_people_json` es una lista general de nombres anterior al catálogo; se mantiene mediante una ruta PATCH de compatibilidad.

## Estados

| Entidad | Estados usados |
|---|---|
| Video técnico | `pending`, `done`, `failed`, `missing` |
| Video visual | Nulo se interpreta como pendiente; `pending`, `running`, `done`, `failed` |
| Recorrido | `running`, `done`, `failed`, `interrupted`; al tomar el bloqueo, el siguiente indexador marca como interrumpidos los recorridos que quedaron `running` |

`process_locks` serializa indexador y analizador visual con un bloqueo común, además del bloqueo propio de cada etapa. Usa PID y nombre de host para identificar al propietario y recuperar registros abandonados en el mismo servidor. `worker_runs` conserva la actividad actual; `worker_run_history` mantiene hasta 200 ejecuciones por etapa. `stale` se infiere cuando el PID local desaparece. La recuperación automática presupone que los procesos usan la misma base SQLite local y el mismo host; no es un coordinador distribuido para bases compartidas entre servidores.

## Búsqueda e interfaz

FTS5 usa tokenización Unicode con eliminación de diacríticos. Se extraen hasta ocho palabras de la consulta, cada una como prefijo, combinadas con AND. Se filtran fechas inclusivas y se excluyen `missing`. Con consulta, los resultados priorizan relevancia; sin consulta, se ordenan por fecha descendente y ruta. La búsqueda devuelve videos, no segmentos coincidentes.

`public/app.js` administra árbol, reproducción, fichas, búsqueda, directorio de personas y consulta periódica del progreso. No hay framework ni compilación del frontend. Tailwind se descarga desde CDN y la tipografía desde Google Fonts. El token de edición permanece en memoria de la página.

## Límites de acceso y privacidad

La validación de rutas usa resolución absoluta, límites relativos y comprobación del destino real cuando existe. El servidor escucha en `0.0.0.0`. Si `ACCESS_TOKEN` se configura, la API y el streaming requieren una cookie de sesión HttpOnly; sin él, el acceso permanece abierto por compatibilidad. CORS admite same-origin y orígenes exactos configurados. Las mutaciones de nombres requieren además su bearer token con comparación de tiempo constante.

Los nombres y las rutas del árbol se agregan como texto y nodos DOM, no como HTML ejecutable. SQLite, los registros y las fichas contienen información personal. Los fotogramas se envían a OpenRouter y al proveedor seleccionado por ese servicio; la política de retención depende del proveedor y no la controla este código. La autorización de envío de fotogramas ya forma parte del alcance del proyecto; el audio sigue fuera del procesamiento actual.
