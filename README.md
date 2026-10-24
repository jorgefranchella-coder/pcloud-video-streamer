# Videos de pCloud: reproducción, fichas y búsqueda

Aplicación web progresiva instalable para explorar una biblioteca familiar montada con rclone, reproducir videos y encontrar escenas mediante fichas técnicas, descripciones visuales y personas identificadas. Sin conexión muestra una pantalla informativa; navegar la biblioteca y reproducir videos requiere acceso al servidor.

Documentación revisada contra el código el **21 de octubre de 2026**. Las cifras de ejecución se conservan como una fotografía fechada en [Operación](docs/operacion.md); el estado actual se consulta en la interfaz o en `/api/index/status`.

## Qué hace hoy

- Navegación por carpetas y reproducción HTML5 con peticiones HTTP Range.
- Inventario incremental en SQLite y extracción de duración, resolución, formato, fechas, ubicación y tags de cámara/dispositivo presentes en los archivos con `ffprobe`.
- Exportación e importación manual de fichas mediante sidecars JSON junto al video, sin reescribir el original y verificando su fingerprint.
- Análisis de hasta cuatro fotogramas mediante **OpenRouter Chat Completions**, con una ficha en español y referencias temporales.
- Búsqueda textual FTS5, filtros por fecha sugerida, persona exacta o carpeta, y paginación.
- Identificación facial local con YuNet + SFace: embeddings en SQLite, sugerencias de vecinos, asignación grupal y opción de ignorar detecciones sin conservar sus embeddings.
- El modelo de OpenRouter crea la descripción narrativa; los fotogramas para reconocimiento de personas se procesan en el servidor y nunca se envían al proveedor.
- Panel de progreso técnico, visual y de rostros locales, con lotes recientes y contador diario de solicitudes del proveedor.

El análisis narrativo no transcribe audio ni examina cada instante del video. Las coincidencias faciales son sugerencias; el usuario confirma cada grupo. La reproducción depende de los códecs que soporte el navegador; no hay transcodificación. Los indexadores visual y facial tienen temporizadores independientes y optativos.

## Documentación

| Documento | Contenido |
|---|---|
| [Uso de la interfaz](docs/uso.md) | Reproducción, búsqueda, fechas, personas y lectura del progreso |
| [Arquitectura y datos](docs/arquitectura.md) | Componentes, flujo, estados, esquema SQLite y límites |
| [Instalación y configuración](docs/configuracion.md) | Desarrollo, systemd, Docker, variables y credenciales |
| [Operación y recuperación](docs/operacion.md) | Ejecuciones, diagnóstico, respaldos, restauración y estado observado |
| [Referencia API](docs/api.md) | Rutas, parámetros, respuestas, autenticación y errores |
| [Mejoras propuestas](docs/mejoras.md) | Problemas encontrados, prioridades y criterios de aceptación |

Los archivos de [docs/plans](docs/plans/) conservan las propuestas originales. No representan por sí solos las funciones implementadas ni las instrucciones de despliegue vigentes.

## Arranque local

Requisitos: Node.js 22 o superior, npm, `ffmpeg` y `ffprobe`; un directorio de videos legible. Para pCloud: rclone, FUSE y un montaje configurado. `better-sqlite3` es un módulo nativo; una instalación sin binario compatible puede requerir Python, make y un compilador C++.

Desde la raíz del proyecto:

```bash
npm ci
export VIDEO_ROOT='/mnt/pcloud/My Videos'
export DATA_DIR="$PWD/data"
PORT=3001 npm start
```

En otra terminal, desde la misma raíz y con las mismas variables:

```bash
export VIDEO_ROOT='/mnt/pcloud/My Videos'
export DATA_DIR="$PWD/data"
npm run inventory
npm run index
```

`inventory` recorre el árbol sin ejecutar `ffprobe`. `index` vuelve a recorrerlo y analiza como máximo 50 archivos elegibles por ejecución. No ejecutar dos indexadores a la vez. Para el análisis visual, configurar la clave y los límites siguiendo [Configuración](docs/configuracion.md).

Abrir `http://localhost:3001`. Guardar SQLite en disco local persistente, fuera de pCloud. El servidor escucha en todas las interfaces y, por compatibilidad, queda abierto si `ACCESS_TOKEN` no está configurado. Para una biblioteca privada, configurar `ACCESS_TOKEN` y, al exponerla fuera de localhost, HTTPS con `ACCESS_COOKIE_SECURE=1`; ver [Configuración](docs/configuracion.md).

## Mapa del repositorio

```text
server.js                        Servidor web, API, reproducción y autorización de edición
metadata-store.js                SQLite, esquema, estados, búsquedas y personas
config.js                        Validación de configuración de los trabajadores
indexer.js                       Inventario y fichas técnicas
visual-analyzer.js               Fotogramas, petición a OpenRouter y persistencia visual
face-indexer.js                  Detección local YuNet, embeddings SFace e índice facial
scripts/extract-face-embeddings.py Procesamiento local de fotogramas sin persistir recortes
scripts/setup-face-runtime.sh    Virtualenv, modelos locales y verificación SHA-256
public/index.html                Interfaz y estilos
public/app.js                    Navegación, progreso, fichas, búsqueda y revisión de identidades
pcloud-video-streamer.service    Servidor HTTP
pcloud-video-indexer.service     Lote técnico
pcloud-video-indexer.timer       Ejecución técnica periódica
pcloud-video-visual.service      Lote visual manual
pcloud-video-face-indexer.service Indexación facial local
pcloud-video-face-indexer.timer   Procesamiento facial periódico optativo
rclone-pcloud.service            Montaje remoto
Dockerfile                      Imagen con Node y ffmpeg
package.json / package-lock.json Dependencias y scripts npm
scripts/                         Respaldo, verificación y restauración de DATA_DIR
data/                           SQLite local; excluido de Git
docs/                           Documentación y planes históricos
```

Las unidades systemd incluyen usuario y rutas específicos del servidor `nbcriancas`; deben adaptarse para otro equipo. No hay una suite automatizada de pruebas ni un script `npm test` en esta versión. Tampoco hay un archivo de licencia en el repositorio: la antigua mención a MIT no constituye documentación suficiente de una licencia.
