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
| P0 si hay acceso fuera de una red controlada | Proteger lectura y administración | Implementado en esta rama: `ACCESS_TOKEN` habilita sesión HttpOnly de 12 h con vencimiento firmado y comprobado por el servidor; CORS queda same-origin por defecto y admite solo orígenes exactos configurados. La interfaz vuelve a autenticar y reintenta una llamada API si venció la sesión. La API envía `Cache-Control: no-store`, responde errores en JSON, limita la paginación y el streaming acepta solo extensiones de video. CSP y cabeceras del navegador limitan recursos, marcos y permisos. `METADATA_EDIT_TOKEN` requiere al menos 32 bytes. Configurar HTTPS y `ACCESS_COOKIE_SECURE=1` al exponerlo públicamente | S (incluido en esta rama) |
| P1 | Cola continua con límites | Hay un pipeline optativo que ejecuta inventario técnico y luego un lote visual; respeta bloqueos, límites y reintentos. El panel muestra sus timers y ofrece pausa/reanudación administrativa auditada. Pendiente: cola general durable con trabajos reclamados por lease y agenda configurable; la continuidad todavía depende de timers systemd | L (en curso) |
| P1 | Reintentos con espera y presupuesto | Se registran intentos, causa y próxima ejecución; hay espera creciente hasta 24 h, límite diario de solicitudes y umbral mensual sobre el costo `usage.cost` reportado por OpenRouter, visibles en el panel. El umbral monetario detiene lotes al alcanzar el costo acumulado; el proveedor informa costos después de responder, por lo que puede excederse en una llamada y no se contabilizan errores sin respuesta. Pendiente: presupuesto previo por solicitud y controles de pausa desde la interfaz | M (en curso) |
| P1 | Progreso que represente trabajos reales | Se registra heartbeat, proceso vivo/obsoleto, video/fase actual, inicio/fin y último resultado; la interfaz muestra configuración, timers, costo mensual reportado y permite pausar/reanudar nuevas tareas. Pendiente: vista de agenda unificada, edad por elemento en cola y control de reintento/orden de lotes | M (en curso) |
| P1 | Configuración visible y validada | Se validan y registran límites/flags; la interfaz muestra lote, selector, reintentos, presupuesto visual y estado/próxima ejecución de timers instalados. Pendiente: editar agenda y controles operativos desde una pantalla autenticada | S (en curso) |
| P1 | Diagnosticar el fallo de systemd | Persiste un SIGSEGV histórico aunque el proceso manual terminó bien. Reproducir de forma controlada con el mismo Node, módulo nativo y entorno; capturar evidencia antes de declarar la causa resuelta | M |
| P1 | Correcciones humanas persistentes | Las asignaciones se guardan por revisión y las anteriores se reconcilian manualmente o se cierran sin reasignar. La interfaz ahora sugiere hasta tres observaciones por similitud textual y cercanía temporal, preselecciona solo la primera y exige confirmación explícita. El puntaje es heurístico, no una probabilidad ni reconocimiento facial. Pendiente: evaluar sugerencias con confirmaciones humanas y comparar fotogramas de evidencia; nunca trasladar automáticamente | L (en curso) |
| P1 | Respaldo y migraciones comprobables | Los comandos `backup`, `verify-backup` y `restore-data` producen una copia privada; el verificador comprueba integridad, referencias y hashes, y la restauración vuelve a verificar la copia final. La inicialización es atómica y `schema_migrations` registra una línea base y migraciones numeradas hasta la versión 3. Pendiente: restauración de prueba ejecutada y mover las compatibilidades históricas de arranque al registro de migraciones | M |
| P2 | Evidencia visual dentro de la ficha | Se guardan fotogramas asociados a personas/eventos/pistas de fecha; la API valida sesión, revisión activa o identidad histórica pendiente. La interfaz muestra la evidencia de ambas para apoyar la reconciliación y elimina las revisiones históricas ya cerradas en el siguiente análisis exitoso | M (en curso) |
| P2 | Búsqueda por persona exacta, carpeta y momento | La interfaz filtra por ID/carpeta, prioriza relevancia FTS, muestra snippets y abre el resultado en el segundo del evento mejor alineado con la consulta. Pendiente: búsqueda dentro del audio (si se habilita transcripción) | M (en curso) |
| P2 | Mejoras de reproducción y acceso móvil | El stream admite rangos simples y cancela lecturas al desconectar; el reproductor distingue errores de red, decodificación y formato/códec. Esta rama añade foco/estado accesible al menú móvil, nombre al diálogo de personas y anuncios de ficha y video; el progreso se mantiene navegable sin anuncios periódicos. Las respuestas de navegación obsoletas se ignoran y las carpetas vacías o con error tienen estados visibles y opción de reintento. Pendiente: recorrido integral de teclado y lector de pantalla, soporte multipart y compilar estilos locales | M (en curso) |
| P2 | Catálogo de personas administrable | Renombrar, fusionar y deshacer con historial autorizado; la búsqueda se actualiza transaccionalmente. Pendiente: asignar varias identidades a una observación grupal | M (en curso) |
| P2 | Muestreo por duración y escenas | La selección se ajusta a la duración y tiene un máximo configurable de ocho fotogramas; se conserva en cada ficha el método y la lista de segundos seleccionados. `VISUAL_SCENE_SAMPLING=1` busca cambios de escena con una pasada local a 0,5 fps y baja resolución, con fallback a muestreo temporal si ffmpeg falla. Pendiente: medir recall frente a un conjunto revisado; la detección de escenas aumenta uso de CPU | L (en curso) |
| P3 | Audio, consulta semántica y sugerencias de identidad | No están implementados. Evaluarlos por separado, con consentimiento/configuración explícita para nuevos datos enviados y evaluación de errores frente a confirmaciones humanas | L |

## Diseño propuesto para continuar automáticamente

Mantener SQLite y procesos separados. El pipeline optativo coordina por secuencia las dos etapas, mientras `automation_control` conserva la pausa global y los timers retoman la cola según calendario; todavía no hay tabla general `jobs` con etapa, propietario del claim, versión del fingerprint y lease.

Un coordinador toma trabajos de forma atómica y ejecuta inicialmente un análisis técnico y un visual como máximo por etapa, con límites configurables. Puede empezar estrictamente secuencial si la lectura simultánea afecta al streamer. El trabajador termina o renueva su lease; otro proceso solo recupera un trabajo tras vencimiento comprobado.

Estados propuestos: `pending`, `running`, `done`, `retry_wait`, `failed` y `cancelled`. Ya existe un máximo diario configurable de solicitudes al proveedor, con contador persistente en SQLite y una pausa global persistente ante fallos de autenticación/configuración, cuota, servicio o red. Los errores de autenticación suspenden la etapa hasta que cambie la configuración; las cuotas y fallos temporales aplican una espera antes de permitir otro lote.

La interfaz muestra progreso, cuota, presupuesto y estado de pausa junto al archivo actual y último resultado. Ya existe un control web autenticado para pausar y reanudar nuevas tareas; registra que la acción llegó desde la interfaz, aunque el token compartido no identifica a una persona. Reintentar un video desde la web todavía requiere un endpoint administrativo auditado. No ejecutar comandos systemd arbitrarios a partir de entrada del navegador.

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
