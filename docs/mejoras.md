# Mejoras propuestas y prioridades

[Volver al README](../README.md)

Propuesta basada en la revisión del código y la operación del 21/10/2026. La implementación de estas mejoras se está trabajando en ramas de entrega; consultar el estado de cada elemento en esta tabla y los cambios del repositorio. El objetivo es completar la biblioteca de forma confiable y permitir recuperar recuerdos por personas, hechos y fechas sin perder confirmaciones humanas.

## Orden recomendado

Primero resolver seguridad de la interfaz, integridad de asociaciones y exclusión entre trabajadores. Después automatizar la continuidad del procesamiento con límites y recuperación. Sobre esa base, ampliar la revisión de fichas y la búsqueda. Agregar más capacidad visual antes de resolver esos puntos aumentaría la cantidad de resultados difíciles de supervisar.

Esfuerzo relativo: S = cambio acotado; M = varios módulos y comprobaciones; L = componente o flujo nuevo. No son compromisos de calendario.

| Prioridad | Mejora | Evidencia actual y resultado esperado | Esfuerzo |
|---|---|---|---|
| P0 | Eliminar interpolación de datos en HTML | Nombres y rutas del listado ahora se agregan con `textContent` y propiedades DOM; las plantillas HTML restantes contienen solo SVG y mensajes estáticos. Los errores se escriben como texto | S (incluido en esta rama) |
| P0 | Exclusión mutua y recuperación por trabajo | Esta rama incorpora un bloqueo SQLite común a indexador y analizador visual, además de bloqueos por etapa. Recupera estados visuales y recorridos `running` abandonados solo después de adquirir los bloqueos | M (incluido en esta rama) |
| P0 | Preservar coherencia de identidades | Esta rama versiona observaciones, conserva asignaciones anteriores como pendientes de revisión, permite reasignarlas manualmente a una observación actual y registra esa revisión en la misma transacción. También las invalida al cambiar el fingerprint, mantiene nombres activos en FTS y revierte la escritura visual si falla la actualización condicional | M (incluido en esta rama) |
| P0 si hay acceso fuera de una red controlada | Proteger lectura y administración | Implementado en esta rama: `ACCESS_TOKEN` habilita sesión HttpOnly persistente de 30 días por defecto, con vencimiento firmado y comprobado por el servidor; la sesión habilita lectura y edición si `METADATA_EDIT_TOKEN` activa las rutas. CORS queda same-origin por defecto y admite solo orígenes exactos configurados. La interfaz vuelve a autenticar y reintenta una llamada API si venció la sesión. La API envía `Cache-Control: no-store`, responde errores en JSON, limita la paginación y el streaming acepta solo extensiones de video. CSP y cabeceras del navegador limitan recursos, marcos y permisos. `METADATA_EDIT_TOKEN` requiere al menos 32 bytes. Configurar HTTPS y `ACCESS_COOKIE_SECURE=1` al exponerlo públicamente | S (incluido en esta rama) |
| P1 | Cola continua con límites | Hay un pipeline optativo que ejecuta inventario técnico y luego un lote visual; respeta bloqueos, límites y reintentos. El panel muestra sus timers y ofrece pausa/reanudación administrativa auditada. Pendiente: cola general durable con trabajos reclamados por lease y agenda configurable; la continuidad todavía depende de timers systemd | L (en curso) |
| P1 | Reintentos con espera y presupuesto | Se registran intentos, causa y próxima ejecución; los reintentos vencidos ahora se eligen antes que los videos pendientes, evitando que queden relegados hasta vaciar toda la cola. Hay espera creciente hasta 24 h, límite diario de solicitudes y umbral mensual sobre el costo `usage.cost` reportado por OpenRouter. Con límite activo, se exige una reserva configurable antes de cada solicitud; el costo final puede superar esa reserva y no se contabilizan errores sin respuesta. Pendiente: consultar precios actuales del proveedor en lugar de estimar solo con costos observados | M (en curso) |
| P1 | Progreso que represente trabajos reales | Se registra heartbeat, proceso vivo/obsoleto, video/fase actual, inicio/fin y último resultado; la interfaz muestra configuración, timers, costo mensual reportado y permite pausar/reanudar nuevas tareas. Los análisis técnicos y visuales fallidos pueden volver a la cola manualmente desde su ficha, con historial acotado; el visual reinicia explícitamente sus intentos. Pendiente: vista de agenda unificada, edad por elemento en cola y orden de lotes | M (implementación en esta rama) |
| P1 | Configuración visible y validada | Se validan y registran límites/flags; la interfaz muestra lote, selector, reintentos, presupuesto visual y estado/próxima ejecución de timers instalados. Pendiente: editar agenda y controles operativos desde una pantalla autenticada | S (en curso) |
| P1 | Diagnosticar el fallo de systemd | Diagnóstico del SIGSEGV histórico: el informe de Apport muestra `/usr/bin/node` 18.19.1 cargando `better-sqlite3` 13.0.3; el paquete declara Node `>=22` y la traza cae en `node::Environment::TryLoadAddon`. Los servicios ahora usan Hermes Node 22.23.1 y completaron ejecuciones posteriores. No reproducir con Node 18: está fuera del rango soportado | S (causa identificada; cambio de runtime aplicado) |
| P1 | Correcciones humanas persistentes | Las asignaciones se guardan por revisión y las anteriores se reconcilian manualmente o se cierran sin reasignar. La interfaz sugiere hasta tres observaciones por similitud textual y cercanía temporal, preselecciona solo la primera, presenta los fotogramas anterior y actual para comparar y exige confirmación explícita. El puntaje es heurístico, no una probabilidad ni reconocimiento facial. Pendiente: evaluar sugerencias con confirmaciones humanas; nunca trasladar automáticamente | L (en curso) |
| P1 | Respaldo y migraciones comprobables | Los comandos `backup`, `verify-backup` y `restore-data` producen una copia privada; el verificador comprueba integridad, referencias y hashes, y la restauración vuelve a verificar la copia final. La inicialización es atómica y `schema_migrations` registra una línea base y migraciones numeradas hasta la versión 13. Pendiente: restauración de prueba ejecutada y mover las compatibilidades históricas de arranque al registro de migraciones | M |
| P2 | Evidencia visual dentro de la ficha | Se guardan fotogramas asociados a personas/eventos/pistas de fecha; la API valida sesión, revisión activa o identidad histórica pendiente. La interfaz muestra la evidencia de ambas fichas para apoyar la reconciliación y maneja fotogramas ausentes con un mensaje; elimina las revisiones históricas ya cerradas en el siguiente análisis exitoso | M (implementado en esta rama) |
| P2 | Reconocer de forma asistida a las mismas personas | Indexación local YuNet + SFace desplegada: runtime y modelos presentes y timer activo en systemd. La interfaz incluye el control para ignorar de forma persistente las detecciones seleccionadas, borrar sus embeddings y conservar la exclusión al reindexar el mismo video/fingerprint; las identidades confirmadas quedan protegidas. El streamer debe reiniciarse para aplicar el cambio y ejecutar la migración 13, que vuelve a limpiar embeddings conservados por peticiones de rechazo al servidor anterior. Pendiente: revisar precision/recall con etiquetas humanas | L (implementado en código; despliegue pendiente) |
| P2 | Búsqueda por persona exacta, carpeta y momento | La interfaz filtra por ID/carpeta, prioriza relevancia FTS, muestra snippets y abre el resultado en el segundo del evento mejor alineado con la consulta. Pendiente: búsqueda dentro del audio (si se habilita transcripción) y evaluación con consultas reales | M (implementación en esta rama) |
| P2 | Enriquecimiento con metadata nativa y portabilidad de fichas | Esta rama lee ubicación y tags de cámara/dispositivo, conserva la procedencia, los muestra y permite buscarlos. Exporta e importa sidecars JSON con fingerprint: no sobrescribe archivos ni fichas locales, restaura metadata técnica si falta y asignaciones narrativas por nombre. Pendiente: revisar cobertura real tras el reindexado y diseñar cómo volver a vincular identidades faciales sin exportar embeddings | M |
| P2 | Mejoras de reproducción y acceso móvil | El stream admite rangos simples y cancela lecturas al desconectar; el reproductor distingue errores de red, decodificación y formato/códec. Esta rama añade indicador global de foco de teclado, menú móvil accesible, nombre al diálogo de personas y anuncios de ficha y video; el progreso se mantiene navegable sin anuncios periódicos. Las respuestas de navegación obsoletas se ignoran y las carpetas vacías o con error tienen estados visibles y opción de reintento. Pendiente: recorrido integral de teclado y lector de pantalla, soporte multipart y compilar estilos locales | M (en curso) |
| P2 | Catálogo de personas administrable | Renombrar, fusionar y deshacer con historial autorizado; búsqueda, conteos, fusiones y deshacer incluyen identidades múltiples por observación. La interfaz admite selecciones múltiples, altas desde el streamer y conserva en el historial los conjuntos previos y nuevos de cada asignación grupal. Pendiente: revisión de accesibilidad del control | M (implementación en esta rama) |
| P2 | Muestreo visual por duración | La selección se ajusta a la duración y tiene un máximo configurable de ocho fotogramas; se conserva en cada ficha el método y la lista de segundos seleccionados. Se retiró el muestreo por cambios de escena y todo su código operativo; la etapa visual usa muestreo temporal. Pendiente: medir cobertura frente a un conjunto revisado | M (implementado en esta rama) |
| P3 | Audio y evaluación de sugerencias de identidad | La descripción no transcribe audio. La bandeja facial ya muestra vecinos como sugerencias, pero no se midieron precisión/recall con confirmaciones humanas. Evaluar transcripción por separado, con configuración explícita para nuevos datos enviados | L |

## Identificación asistida de personas

La etapa local `face-indexer.js` es independiente del análisis narrativo. Extrae una muestra espaciada, usa YuNet para localizar/alinear y SFace para crear descriptores. La interfaz ofrece una bandeja de caras sin nombre y busca vecinos contra la biblioteca indexada. Solo una aceptación explícita asocia las observaciones con `people.id`; una coincidencia cercana solo sugiere un nombre. El proceso de descripción de videos sigue usando `OPENROUTER_MODEL`.

La implementación almacena descriptores numéricos y marcas de tiempo, no recortes faciales persistentes. Los recortes se procesan en memoria y se descartan; la bandeja los genera bajo demanda desde el video original y los sirve con la sesión autenticada. Los vectores se guardan localmente junto con SQLite. La bandeja muestra sugerencias por identidad, calculadas con la mejor similitud contra observaciones confirmadas, y solo las presenta si superan `FACE_SUGGESTION_THRESHOLD` (por defecto 0.5). Elegir una sugerencia completa el selector, pero exige una confirmación explícita para asignar. El umbral es provisional y sirve para filtrar sugerencias, no es una probabilidad ni una asignación automática; debe calibrarse con etiquetas revisadas por el usuario.

De las opciones evaluadas, YOLOv8 detecta personas pero no identifica quiénes son. CompreFace ofrece una API REST y catálogo de sujetos, pero su distribución estándar exige AVX; la configuración Docker documenta `-Xmx4g`. El servidor actual informa un Intel Celeron N4500, dos CPU y 3,6 GiB de RAM, y no reporta AVX en `lscpu`, por lo que no es compatible con el host disponible. DeepFace ofrece una API Python y `face_recognition` facilita comparar rostros, pero ambas alternativas aún necesitan una prueba de instalación, memoria, velocidad y licencia de los pesos en esta máquina; no se deben asumir livianas por tener API o ejemplos de video. Fuentes: [requisitos de CompreFace](https://github.com/exadel-inc/CompreFace/blob/master/README.md), [opciones de instalación y JVM](https://github.com/exadel-inc/CompreFace/blob/master/docs/Installation-options.md), [API REST de CompreFace](https://github.com/exadel-inc/CompreFace/blob/master/docs/Rest-API-description.md), [API de DeepFace](https://github.com/serengil/deepface/blob/master/README.md).

Piloto e implementación: **YuNet + SFace de OpenCV**, ambos ejecutables en CPU mediante OpenCV DNN. YuNet localiza y alinea el rostro; SFace genera el descriptor para compararlo con otros rostros. YuNet se describe como liviano y detecta caras desde aproximadamente 10 × 10 píxeles, pero eso no garantiza buen reconocimiento en caras pequeñas, borrosas o de perfil. OpenCV publica 0,363 como referencia de similitud coseno para SFace, pero la aplicación no usa ese valor para aceptar/rechazar identidades: falta calibrarlo con ejemplos reales confirmados. [YuNet](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet), [ejemplo oficial de umbral SFace](https://docs.opencv.org/4.9.0/d0/dd4/tutorial_dnn_face.html). El directorio de YuNet declara MIT y el de SFace declara Apache 2.0; conservar esas licencias junto con los pesos si se distribuyen.

Flujo implementado: tomar hasta 24 fotogramas por video, espaciados según duración (intervalo objetivo 20 s), reducirlos a un lado máximo configurable, descartar caras menores a 48 px y guardar los vectores. La bandeja muestra caras sin identificar; al elegir una, busca hasta 12 vecinos de cualquier video indexado y ofrece la persona conocida más cercana como sugerencia sin confirmarla. Se puede asignar el rostro base y los vecinos seleccionados a una persona existente o a un nombre nuevo, o descartar la cara base. La búsqueda exacta, el directorio de personas y las fusiones incluyen asignaciones faciales.

Se guardan localmente el vector normalizado, dimensiones/modelo, video/fingerprint, segundo, rectángulo de la cara, confianza de detección, identidad confirmada y estado de revisión. Los recortes se generan desde el original solo cuando se abre la bandeja y se sirven con la sesión autenticada; no se persisten ni se envían a OpenRouter. Vectores y asignaciones son datos sensibles: están en SQLite y forman parte de sus copias protegidas. Si el rendimiento de lotes resulta insuficiente, el mismo contrato permite mover la etapa a un worker local separado.

### Resultado del piloto local (21/10/2026)

Se instaló OpenCV contrib en un virtualenv temporal y se descargaron los modelos de OpenCV Zoo a `/tmp`; no se instaló ningún servicio ni dependencia global y no se modificó SQLite. Se procesaron nueve fotogramas de tres videos montados desde pCloud; solo se leyeron tres puntos de cada archivo y se enviaron cero imágenes fuera del equipo. El primero y el segundo no produjeron caras. El tercero produjo cinco detecciones en tres fotogramas y vectores SFace de 128 dimensiones. Una pareja entre fotogramas obtuvo similitud coseno 1,0 y las demás comparaciones observadas rondaron 0; esto valida que el índice puede encontrar vecinos obvios, no que el match sea una identidad correcta. La implementación actual ya usa este contrato de almacenamiento y revisión.

En paisaje, la detección tardó 108–193 ms por fotograma y el proceso alcanzó alrededor de 167 MiB de RSS. En vertical grande tardó 684–784 ms y llegó a unos 261 MiB; el indexador ahora limita el lado mayor a 960 px. El host puede ejecutar ambos modelos en CPU sin AVX, aunque el tiempo depende del video y del montaje. El piloto no midió precisión/recall: hace falta que el usuario etiquete ejemplos y revise vecinos antes de fijar umbrales o automatizar lotes. El timer nuevo queda optativo hasta instalar runtime/modelos.

## Diseño propuesto para continuar automáticamente

Mantener SQLite y procesos separados. El pipeline optativo coordina por secuencia las dos etapas, mientras `automation_control` conserva la pausa global y los timers retoman la cola según calendario; todavía no hay tabla general `jobs` con etapa, propietario del claim, versión del fingerprint y lease.

Un coordinador toma trabajos de forma atómica y ejecuta inicialmente un análisis técnico y un visual como máximo por etapa, con límites configurables. Puede empezar estrictamente secuencial si la lectura simultánea afecta al streamer. El trabajador termina o renueva su lease; otro proceso solo recupera un trabajo tras vencimiento comprobado.

Estados propuestos: `pending`, `running`, `done`, `retry_wait`, `failed` y `cancelled`. Ya existe un máximo diario configurable de solicitudes al proveedor, con contador persistente en SQLite y una pausa global persistente ante fallos de autenticación/configuración, cuota, servicio o red. Los errores de autenticación suspenden la etapa hasta que cambie la configuración; las cuotas y fallos temporales aplican una espera antes de permitir otro lote.

La interfaz muestra progreso, cuota, presupuesto y estado de pausa junto al archivo actual y último resultado. Ya existe un control web autenticado para pausar y reanudar nuevas tareas; registra que la acción llegó desde la interfaz, aunque el token compartido no identifica a una persona. Los reintentos manuales técnicos y visuales desde una ficha fallida tienen endpoints auditados y el panel expone las últimas 20 solicitudes. No ejecutar comandos systemd arbitrarios a partir de entrada del navegador.

Criterios de aceptación:

- Tras habilitar el flujo, los elegibles avanzan entre etapas sin intervención por cada video.
- Reiniciar el servidor o un trabajador no duplica análisis ni pierde fichas terminadas.
- Un 429 deja el trabajo en espera visible; no provoca una secuencia inmediata de peticiones.
- Dos trabajadores no reclaman el mismo trabajo; dos inventarios no invalidan archivos mutuamente.
- La pausa detiene nuevos trabajos y explica qué pasa con el que ya estaba en curso.
- Límite de lote, cuota y selector puntual efectivos se pueden inspeccionar sin exponer credenciales.

## Revisiones, evidencia y personas

Separar `analysis_versions` de `user_overrides`. Cada observación necesita un ID asociado a su versión de análisis y a evidencia temporal. Conservar las confirmaciones anteriores como historial; ante un reanálisis, presentar las observaciones nuevas y pedir reconciliación cuando cambien. Nunca trasladar un nombre únicamente porque ocupa el mismo índice de lista.

El cambio de fingerprint debe invalidar enlaces activos y su texto de búsqueda en la misma transacción. La persistencia del análisis también debe revertir todas las operaciones si su actualización condicional detecta un fingerprint cambiado; hoy el borrado de asociaciones puede haberse confirmado antes de detectar `changes=0`.

El catálogo debería admitir renombrar y fusionar identidades, recuperar una asociación eliminada y excluir o señalar videos ausentes en sus conteos. Las sugerencias automáticas, si se incorporan en otra fase, deben presentarse como sugerencias pendientes de confirmación.

## Calidad y comprobaciones propuestas

Priorizar pruebas que cubran pérdidas de datos, exposición y recuperación, con una base aislada y un proveedor simulado:

- Rutas fuera de la raíz, enlaces simbólicos y nombres con caracteres HTML.
- Rangos HTTP válidos/inválidos y desconexión del cliente durante lectura.
- Fingerprint cambiado, archivo ausente y fallo parcial de recorrido sin marcado masivo incorrecto.
- Dos trabajadores, cierre abrupto, lease vencido y reanudación sin duplicados.
- JSON inválido, rechazo, timeout y 429/5xx sin consumo ilimitado de intentos.
- Asignación, búsqueda, desasignación, PATCH de compatibilidad y regeneración con historial humano conservado.
- Respaldo con WAL activo y restauración verificable.
- En móvil y escritorio: scroll hasta el final, foco de diálogos, estados de error y navegación por teclado.

Medir duración por etapa, errores por causa, llamadas/uso reportado, bytes leídos, antigüedad de la cola y fichas que requirieron corrección. No presentar una fecha de finalización hasta disponer de varias ejecuciones representativas y límites de cuota conocidos.

## Secuencia de entrega sugerida

1. Corregir HTML dinámico, coherencia de asociaciones y exclusión entre procesos; validar configuración efectiva.
2. Incorporar una tabla general de trabajos con leases y controles de pausa; el pipeline optativo ya conecta las dos etapas, y el límite mensual reportado complementa la cuota diaria.
3. Añadir revisión con evidencia, historial humano y administración del catálogo.
4. Mejorar filtros, búsqueda por instantes y reproducción; evaluar muestreo adaptativo.
5. Evaluar audio o sugerencias de identidad como ampliaciones independientes con métricas de calidad.

Cada entrega debe tener criterios observables y una ruta de reversión de esquema/datos. La automatización de la biblioteca es la siguiente mejora funcional propuesta; las correcciones de P0 son sus requisitos previos.
