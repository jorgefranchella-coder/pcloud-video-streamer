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

El servidor, el indexador y el analizador son procesos independientes que comparten una base SQLite local. La API no ofrece rutas para arrancar trabajos. systemd ejecuta los procesos; solo el indexador tiene un temporizador incluido. El indexador y el analizador reclaman bloqueos SQLite separados antes de trabajar; una segunda instancia de la misma etapa termina con error. Los bloqueos huérfanos del mismo host se recuperan al detectar que el PID ya no existe.

## Inventario y extracción técnica

`indexer.js` recorre recursivamente `VIDEO_ROOT`, omite enlaces simbólicos y reconoce las extensiones definidas en el código. Cada video se identifica por su ruta relativa única. Su fingerprint es `tamaño:mtimeRedondeadoEnMilisegundos`; no es un hash del contenido.

Cada recorrido hace upsert de archivos vistos. Un archivo nuevo, modificado o previamente marcado `missing` vuelve a `pending`. Cambiar el fingerprint invalida los campos técnicos y visuales, pero hoy no elimina inmediatamente las filas de asociaciones de personas: ver [Mejoras](mejoras.md).

El modo normal analiza archivos elegibles mediante ffprobe, de uno en uno, con timeout configurado de 30 segundos y hasta 4 MiB de salida. Omite archivos terminados sin cambios y los fallidos sin cambios salvo `RETRY_FAILED=1`. El límite de 50 afecta a intentos de análisis, no al número de archivos recorridos. Incluso al alcanzar ese límite continúa el inventario completo.

Tras un recorrido completo, los registros no vistos quedan `missing`; no se borran. Si hay un fallo de lectura que interrumpe el recorrido, no se aplica ese marcado global. También se rechaza un recorrido vacío si ya había videos registrados. Un fallo individual de ffprobe puede coexistir con un recorrido `done`: consultar ambos niveles.

Las fechas candidatas proceden de etiquetas de captura de contenedor/streams, de una fecha en el nombre base del archivo y de su mtime. Se valida el día calendario. Solo se elige `recorded_at` cuando las fuentes distintas de mtime contienen un único día; se guarda precisión `day`. No se infiere de carpetas, audio o imágenes.

## Análisis visual

1. Reclama el bloqueo exclusivo de la etapa visual, exige `OPENROUTER_API_KEY` y restablece registros visuales `running` a `pending`. Ese restablecimiento solo ocurre cuando la instancia anterior dejó de existir y se pudo adquirir el bloqueo.
2. Selecciona videos con estado técnico `done`, por ID ascendente, hasta el límite del lote. `VISUAL_VIDEO_ID` sustituye esa selección por un video concreto y permite regenerarlo.
3. Comprueba ruta real, tamaño y mtime contra el fingerprint guardado.
4. Extrae imágenes al 8 %, 35 %, 65 % y 92 % de la duración, redondeando a segundos y eliminando duplicados. Usa el segundo cero si no hay duración o es menor a dos segundos.
5. Genera JPEG de hasta 768 × 768 conservando proporciones, con 45 segundos de timeout por extracción. Rechaza una imagen mayor de 700.000 bytes. Si falla algún fotograma puede continuar con los restantes; si fallan todos, falla el video.
6. Envía las imágenes en memoria, codificadas en base64, y sus tiempos al endpoint `/chat/completions`. Solicita JSON Schema, soporte de parámetros y un máximo de 2.000 tokens de salida, con timeout de 120 segundos.
7. Parsea JSON y valida tipos, tamaños de listas e índices de fotogramas. Convierte cada referencia en `at_seconds`. El prompt vigente es `visual-v2` y pide textos en español sin nombres inferidos.
8. Revalida el archivo antes de guardar. Persiste ficha, modelo configurado, versión de prompt, uso reportado y fingerprint; reconstruye el texto de búsqueda y elimina las asociaciones previas por observación dentro de una transacción.

Los errores 401, 403, 429 y 5xx del proveedor detienen el lote después de marcar el video fallido. Otros errores individuales pueden registrarse y permitir que el lote termine con código cero. Por eso «servicio finalizado con éxito» no garantiza que todas sus fichas hayan tenido éxito.

No hay caché persistente de fotogramas, historial de versiones, presupuesto diario, espera automática ante cuotas ni tabla de trabajos visuales. `visual_model` guarda el selector configurado; con un router no identifica necesariamente el modelo efectivo que atendió la solicitud.

## SQLite

Archivo: `DATA_DIR/videos.sqlite`. Se habilitan WAL, claves foráneas y espera de hasta 5 segundos ante bloqueo. Los procesos crean tablas y columnas faltantes al importar `metadata-store.js`; no existe un sistema completo de migraciones versionadas. `user_version=1` se utiliza para la reconstrucción inicial del índice FTS.

| Tabla | Propósito y campos principales |
|---|---|
| `videos` | `id`, ruta única, tamaño, mtime, fingerprint; estado y error técnicos; duración/resolución/códec; fecha/evidencia; estado, título, resumen, incertidumbre, JSON de contenido y uso visual; modelo/prompt; marcas temporales; `last_seen_scan` |
| `scans` | ID, inicio, fin, estado, cantidad vista y error del recorrido |
| `people` | ID, nombre único con colación SQLite `NOCASE`, creación |
| `video_person_observations` | Clave `(video_id, observation_index)`, persona y confirmación; referencias a `videos` y `people` con borrado en cascada |
| `video_fts` | FTS5 sobre ruta, título, resumen y texto visual agregado; contenido externo en `videos`, sincronizado con triggers |

Los campos JSON almacenan candidatos de fecha, resumen técnico, personas observadas, eventos, lugares, palabras clave, pistas de fecha, uso y nombres generales confirmados. La API conserva los campos JSON originales y agrega versiones parseadas.

Las observaciones tienen descripción y segundo, pero no ID estable propio, recorte de rostro o embedding. Los nombres se asignan a la posición de una observación en la lista. `confirmed_people_json` es una lista general de nombres anterior al catálogo; se mantiene mediante una ruta PATCH de compatibilidad.

## Estados

| Entidad | Estados usados |
|---|---|
| Video técnico | `pending`, `done`, `failed`, `missing` |
| Video visual | Nulo se interpreta como pendiente; `pending`, `running`, `done`, `failed` |
| Recorrido | `running`, `done`, `failed`; existe un registro histórico `interrupted`, pero el indexador actual no lo genera al recibir señales |

`process_locks` serializa instancias del indexador entre sí y del analizador entre sí. Usa PID y nombre de host para identificar al propietario y recuperar registros abandonados en el mismo servidor. La recuperación automática presupone que los procesos usan la misma base SQLite local y el mismo host; no es un coordinador distribuido para bases compartidas entre servidores.

## Búsqueda e interfaz

FTS5 usa tokenización Unicode con eliminación de diacríticos. Se extraen hasta ocho palabras de la consulta, cada una como prefijo, combinadas con AND. Se filtran fechas inclusivas, se excluyen `missing` y se ordena por fecha descendente y ruta; no por relevancia. La búsqueda devuelve videos, no segmentos coincidentes.

`public/app.js` administra árbol, reproducción, fichas, búsqueda, directorio de personas y consulta periódica del progreso. No hay framework ni compilación del frontend. Tailwind se descarga desde CDN y la tipografía desde Google Fonts. El token de edición permanece en memoria de la página.

## Límites de acceso y privacidad

La validación de rutas usa resolución absoluta, límites relativos y comprobación del destino real cuando existe. La API de lectura y streaming no exige autenticación, escucha en `0.0.0.0` y permite CORS de forma general. Solo las mutaciones de nombres requieren bearer token con comparación de tiempo constante.

El árbol y las rutas de navegación interpolan nombres en `innerHTML`; es un riesgo de inyección HTML que debe corregirse. SQLite, los registros y las fichas contienen información personal. Los fotogramas se envían a OpenRouter y al proveedor seleccionado por ese servicio; la política de retención depende del proveedor y no la controla este código. La autorización de envío de fotogramas ya forma parte del alcance del proyecto; el audio sigue fuera del procesamiento actual.
