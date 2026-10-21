# Mejoras propuestas y prioridades

[Volver al README](../README.md)

Propuesta basada en la revisión del código y la operación del 21/10/2026. La implementación de estas mejoras se está trabajando en ramas de entrega; consultar el estado de cada elemento en esta tabla y los cambios del repositorio. El objetivo es completar la biblioteca de forma confiable y permitir recuperar recuerdos por personas, hechos y fechas sin perder confirmaciones humanas.

## Orden recomendado

Primero resolver seguridad de la interfaz, integridad de asociaciones y exclusión entre trabajadores. Después automatizar la continuidad del procesamiento con límites y recuperación. Sobre esa base, ampliar la revisión de fichas y la búsqueda. Agregar más capacidad visual antes de resolver esos puntos aumentaría la cantidad de resultados difíciles de supervisar.

Esfuerzo relativo: S = cambio acotado; M = varios módulos y comprobaciones; L = componente o flujo nuevo. No son compromisos de calendario.

| Prioridad | Mejora | Evidencia actual y resultado esperado | Esfuerzo |
|---|---|---|---|
| P0 | Eliminar interpolación de datos en HTML | Nombres y rutas del listado ahora se agregan con `textContent` y propiedades DOM; las plantillas HTML restantes contienen solo SVG y mensajes estáticos. Los errores se escriben como texto | S (en revisión) |
| P0 | Exclusión mutua y recuperación por trabajo | Esta rama incorpora un bloqueo SQLite común a indexador y analizador visual, además de bloqueos por etapa. Recupera estados visuales y recorridos `running` abandonados solo después de adquirir los bloqueos | M (en revisión) |
| P0 | Preservar coherencia de identidades | Esta rama versiona observaciones, conserva asignaciones anteriores como pendientes de revisión, permite reasignarlas manualmente a una observación actual y registra esa revisión en la misma transacción. También las invalida al cambiar el fingerprint, mantiene nombres activos en FTS y revierte la escritura visual si falla la actualización condicional | M (en revisión) |
| P0 si hay acceso fuera de una red controlada | Proteger lectura y administración | Implementado en esta rama: `ACCESS_TOKEN` habilita sesión HttpOnly de 12 h para toda la API y el streaming; CORS queda same-origin por defecto y admite solo orígenes exactos configurados. Las ediciones mantienen su autorización adicional. Configurar HTTPS y `ACCESS_COOKIE_SECURE=1` al exponerlo públicamente | S (en revisión) |
| P1 | Cola continua con límites | Técnico cada 6 h y visual manual; no hay encadenamiento. Un coordinador debe despachar elegibles, respetar pausas/cuotas y continuar sin comandos por cada ficha | L |
| P1 | Reintentos con espera y presupuesto | Esta rama registra intentos, causa y próxima ejecución, limita los intentos automáticos por fingerprint y aplica espera creciente hasta 24 h, excluyendo fallos de autenticación/4xx. Pendiente: presupuesto por período y modo de suspensión operativa | M (en curso) |
| P1 | Progreso que represente trabajos reales | Esta rama registra heartbeat, proceso vivo/obsoleto, video/fase actual, inicio/fin y último resultado. Pendiente: historial de ejecuciones y próximo lote/calendario | M (en curso) |
| P1 | Configuración visible y validada | Esta rama valida límites/flags al arrancar y registra la configuración efectiva no secreta de cada trabajador; la interfaz muestra lote, selector, reintentos y video puntual. Pendiente: exponer ajustes operativos del coordinador cuando se implemente | S (en curso) |
| P1 | Diagnosticar el fallo de systemd | Persiste un SIGSEGV histórico aunque el proceso manual terminó bien. Reproducir de forma controlada con el mismo Node, módulo nativo y entorno; capturar evidencia antes de declarar la causa resuelta | M |
| P1 | Correcciones humanas persistentes | No hay editor general ni historial; las asignaciones desaparecen al regenerar. Separar borrador del modelo de correcciones, conservar versiones y ofrecer reconciliación tras cambios | L |
| P1 | Respaldo y migraciones comprobables | Esquema se modifica al importar el módulo; no hay restauración automatizada validada. Migraciones numeradas, backup previo y recuperación comprobada sobre base temporal | M |
| P2 | Evidencia visual dentro de la ficha | Se conserva el segundo, pero no la imagen enviada. Guardar miniaturas con política de retención y mostrar la evidencia al confirmar nombres o hechos | M |
| P2 | Búsqueda por persona exacta, carpeta y momento | El directorio actual busca texto del nombre y devuelve videos completos. Agregar filtro por ID, carpeta, snippets y enlace al instante coincidente | M |
| P2 | Mejoras de reproducción y acceso móvil | Sin manejo completo de Range/errores de stream; UI depende de CDN. Validar rangos, cerrar streams al desconectar, explicar errores de códec, compilar estilos locales y revisar foco/teclado | M |
| P2 | Catálogo de personas administrable | No se puede renombrar, fusionar o deshacer; una observación grupal tiene un nombre único. Añadir operaciones auditadas, múltiples personas y confirmación por evidencia | M |
| P2 | Muestreo por duración y escenas | Cuatro fotogramas fijos pueden perder eventos. Muestreo adaptativo con máximo de imágenes/bytes y medición de cobertura frente a un conjunto revisado | L |
| P3 | Audio, consulta semántica y sugerencias de identidad | No están implementados. Evaluarlos por separado, con consentimiento/configuración explícita para nuevos datos enviados y evaluación de errores frente a confirmaciones humanas | L |

## Diseño propuesto para continuar automáticamente

Mantener SQLite y procesos separados en la primera evolución. Incorporar una tabla `jobs` con etapa, video/fingerprint, estado, número de intentos, prioridad, `next_attempt_at`, propietario del claim, heartbeat e inicio/fin. Un recorrido añade trabajos técnicos; una ficha técnica aprobada habilita el trabajo visual de la misma versión de archivo.

Un coordinador toma trabajos de forma atómica y ejecuta inicialmente un análisis técnico y un visual como máximo por etapa, con límites configurables. Puede empezar estrictamente secuencial si la lectura simultánea afecta al streamer. El trabajador termina o renueva su lease; otro proceso solo recupera un trabajo tras vencimiento comprobado.

Estados propuestos: `pending`, `running`, `done`, `retry_wait`, `failed` y `cancelled`. Añadir una pausa persistente, un máximo diario de solicitudes/imágenes y una política explícita cuando el proveedor no esté disponible. Los errores de autenticación deben suspender la etapa y pedir intervención; las cuotas deben diferir el trabajo, no consumir reintentos sin espera.

La interfaz mostraría «Procesando», «Esperando cuota», «Pausado» o «Sin trabajos», junto al archivo actual, último resultado y cantidades por etapa. Arrancar, pausar o reintentar desde la web requiere nuevos endpoints administrativos autenticados y registro de quién ejecutó la acción. No ejecutar comandos systemd arbitrarios a partir de entrada del navegador.

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
2. Incorporar trabajos persistentes, recuperación, reintentos y presupuesto; conectar etapas y agregar progreso real.
3. Añadir revisión con evidencia, historial humano y administración del catálogo.
4. Mejorar filtros, búsqueda por instantes y reproducción; evaluar muestreo adaptativo.
5. Evaluar audio o sugerencias de identidad como ampliaciones independientes con métricas de calidad.

Cada entrega debe tener criterios observables y una ruta de reversión de esquema/datos. La automatización de la biblioteca es la siguiente mejora funcional propuesta; las correcciones de P0 son sus requisitos previos.
