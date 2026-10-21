> **Documento histórico de planificación.** Puede describir funciones propuestas o detalles ya modificados. Para el estado implementado y la operación actual, consultar el [README](../../README.md) y la [documentación de arquitectura](../arquitectura.md).

# Plan técnico: fichas y búsqueda de videos de pCloud

## Objetivo

Recorrer los videos bajo `VIDEO_ROOT`, generar una ficha consultable para cada uno y permitir buscar por personas confirmadas, contenido y fecha desde la aplicación existente. El montaje de pCloud se trata como fuente de solo lectura. El índice y los archivos temporales viven fuera del montaje.

## Punto de partida comprobado

- El proyecto usa Node.js, Express y una interfaz web simple que navega carpetas y reproduce videos desde `/mnt/pcloud/My Videos`.
- El servidor tiene `ffmpeg`, `ffprobe` y `sqlite3`; el montaje está presente.
- El inventario inicial encontró 3.772 videos, sin errores de lectura de directorios. El equipo tiene aproximadamente 3,6 GiB de RAM y no dispone de `ollama` ni de GPU Nvidia detectada.
- La interfaz actual no tiene búsqueda, índice ni editor de fichas.

## Arquitectura

```text
pCloud montado (solo lectura)
        │
        ▼
escáner periódico ──► cola persistente en SQLite ──► trabajador de análisis
                           │                         │
                           │                         ├─ ffprobe: datos técnicos y fechas incrustadas
                           │                         ├─ ffmpeg: fotogramas y muestra de audio
                           │                         └─ modelo multimodal/transcripción: borrador
                           ▼                         │
                   fichas + evidencia ◄──────────────┘
                           │
                           ▼
                  API de búsqueda + interfaz actual
```

Separar el trabajador del proceso web evita que una extracción larga afecte la reproducción. Una sola base SQLite local basta para una primera versión; usar FTS5 para el texto de las fichas. Guardar la base y las miniaturas en un directorio persistente como `DATA_DIR`, con copia de seguridad periódica.

## Ficha propuesta

| Campo | Contenido y origen |
|---|---|
| `id`, `relative_path`, `size_bytes`, `mtime`, `fingerprint` | Identidad e invalidación de cambios. Ruta relativa al montaje; fingerprint inicial = ruta, tamaño y mtime. |
| `duration_ms`, `width`, `height`, `codec` | `ffprobe`. |
| `recorded_at`, `date_precision`, `date_source` | Fecha de captura con precisión día/mes/año o desconocida. Conservar por separado todas las fechas candidatas. |
| `title`, `summary`, `events`, `places`, `keywords` | Borrador generado a partir de imágenes, audio y contexto del archivo. |
| `people` | Personas **confirmadas por el usuario**; los rostros sin nombre se describen como “persona 1”, etc. |
| `segments` | Tramos con `start_ms`, `end_ms`, descripción y términos de búsqueda, para saltar al momento relevante. |
| `evidence` | Marca temporal del fotograma, tramo de transcripción o metadato que sustenta cada afirmación importante. |
| `status`, `model_version`, `reviewed_at`, `user_overrides` | Estado, reproducibilidad y correcciones manuales que prevalecen al reanalizar. |

La fecha de modificación de pCloud no se presenta como fecha de grabación. Prioridad sugerida: metadatos de captura incrustados, fecha explícita en nombre/ruta, fecha inferida con evidencia visual o verbal, y por último fecha de archivo como dato técnico. Si hay conflicto, conservar ambas fuentes y marcar la fecha de captura como pendiente de revisión.

## Flujo de procesamiento

1. **Inventario:** recorrer directorios de forma incremental, detectar extensiones admitidas y registrar ruta, tamaño y mtime. No descargar la biblioteca completa. Marcar archivos desaparecidos como `missing` sin borrar sus fichas de inmediato.
2. **Selección:** procesar solo archivos nuevos o cuyo fingerprint cambió. Encolar con estados `pending`, `running`, `done`, `needs_review` y `failed`; guardar intentos y error breve para poder reanudar.
3. **Extracción:** `ffprobe` para duración y metadatos. `ffmpeg` toma una miniatura y un número limitado de fotogramas repartidos a lo largo del video; para videos largos, usar muestreo por tramos y aumentar solo si hay cambios de escena o interés. Trabajar con archivos temporales de tamaño limitado y borrarlos tras el análisis.
4. **Audio:** detectar si hay voz y transcribir por fragmentos con marcas de tiempo cuando se habilite esta opción. El sonido puede aportar nombres y contexto, pero una mención no prueba que alguien aparezca en cámara.
5. **Análisis:** enviar fotogramas reducidos y, si existe, transcripción a un proveedor configurable. Pedir salida JSON con descripciones observables, tiempos, incertidumbre y evidencia. Validar el JSON antes de guardar. Registrar proveedor, modelo y versión del prompt.
6. **Revisión:** mostrar borrador, fotogramas y tiempos al usuario. Permitir corregir título, hechos, fecha y nombres; preservar correcciones en futuros análisis.
7. **Búsqueda:** indexar título, resumen, eventos, lugares, palabras clave y transcripción en FTS5; filtrar por fecha, persona confirmada y carpeta. Devolver fragmento de coincidencia, fuente y enlace al video en el instante relevante.

## Personas e identidad

La primera versión detecta y describe apariciones, sin asignar nombres automáticamente. La identidad se añade mediante confirmación del usuario en la ficha. Si luego se desea sugerencia automática, introducir un catálogo de personas con ejemplos etiquetados y una opción explícita para activar comparación facial; las sugerencias requieren confirmación y nunca se convierten solas en hechos. Esto evita confundir a familiares parecidos o inferir identidad por contexto.

## API e interfaz

- `GET /api/search?q=&from=&to=&person=&folder=&page=`: resultados con resumen y segmentos coincidentes.
- `GET /api/videos/:id/metadata`: ficha, evidencia y estado.
- `PATCH /api/videos/:id/metadata`: correcciones manuales de campos permitidos.
- `POST /api/index/scan`: inicia inventario; `POST /api/videos/:id/reanalyze`: reintento puntual. Restringir estas operaciones a administración.
- `GET /api/index/status`: conteos por estado, último barrido y errores.

En la UI, añadir buscador encima del árbol, resultados con miniatura y filtros, y ficha junto al reproductor. Al elegir un segmento, abrir el video en su marca de tiempo. Mostrar explícitamente “fecha estimada”, “persona por confirmar” y la evidencia correspondiente.

## Despliegue y operación

- Mantener la aplicación web actual y añadir un proceso trabajador independiente con acceso de lectura a `VIDEO_ROOT` y escritura a `DATA_DIR`.
- Limitar concurrencia inicial a un video; imponer topes de duración, número de fotogramas, tamaño de imagen, audio enviado y reintentos. Registrar tiempo y consumo por video.
- No guardar claves de proveedor en el repositorio; usar variables de entorno o credenciales del servicio. Restringir acceso al índice, miniaturas y API, ya que contienen información personal.
- Revisar acceso al servidor antes de exponer la búsqueda: hoy no hay autenticación y la comprobación de rutas usa un prefijo de texto. Resolver rutas contra `VIDEO_ROOT` y comprobar límites reales, incluidos enlaces simbólicos, tanto para lectura como para cualquier endpoint nuevo.
- Permitir modo `inventory-only` para conocer volumen y formatos antes de activar análisis de contenido. Mantener presupuesto máximo diario y pausa/reanudación del trabajador.
- El Dockerfile actual no incluye `ffmpeg`; incorporarlo si se usa Docker. La unidad systemd del reproductor apunta a un `WorkingDirectory` antiguo y debe actualizarse al desplegar los cambios.

## Entregas

### 1. Inventario y ficha técnica

Crear esquema SQLite, escáner reanudable, extracción con `ffprobe`, fecha candidata y endpoints de estado/ficha. Mostrar ficha básica en la UI y corregir la resolución de rutas. **Criterio de salida:** un barrido repetido no reprocesa archivos sin cambios y un archivo retirado queda marcado sin perder sus datos.

### 2. Borradores de contenido

Añadir extracción limitada de fotogramas, proveedor multimodal configurable, validación de salida y cola con reintentos. Empezar con una muestra pequeña elegida manualmente. **Criterio de salida:** las fichas contienen descripciones y evidencia temporal; los errores quedan visibles y se pueden reintentar.

### 3. Búsqueda y revisión

Añadir FTS5, filtros, resultados con salto al instante, edición de ficha y nombres confirmados. **Criterio de salida:** una corrección manual aparece en la búsqueda y sobrevive a un reanálisis.

### 4. Audio y ampliación

Incorporar transcripción segmentada, muestreo adaptativo, límites de presupuesto y procesamiento por lotes. Evaluar sugerencias de identidad solo si se autoriza y se prepara el catálogo de personas.

## Decisiones pendientes antes del análisis de contenido

1. **Privacidad/proveedor:** resuelto: el usuario autoriza enviar fotogramas a un servicio externo. El audio queda fuera del procesamiento actual.
2. **Volumen y presupuesto:** cantidad aproximada de videos, duración típica y presupuesto mensual aceptable para inferencia.
3. **Personas:** si se quiere solo etiquetado manual inicialmente o sugerencias faciales basadas en ejemplos confirmados.

Estas decisiones no impiden implementar la entrega 1 ni preparar las interfaces del proveedor. La elección concreta de modelo y sus precios se hará al iniciar la entrega 2, con datos actuales y una muestra representativa.
