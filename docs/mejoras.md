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
| P0 si hay acceso fuera de una red controlada | Proteger lectura y administración | Implementado en esta rama: `ACCESS_TOKEN` habilita sesión HttpOnly de 12 h para toda la API y el streaming; CORS queda same-origin por defecto y admite solo orígenes exactos configurados. La API envía `Cache-Control: no-store`, responde errores en JSON y limita la paginación; CSP y cabeceras del navegador limitan recursos, marcos y permisos. `METADATA_EDIT_TOKEN` requiere al menos 32 bytes. Configurar HTTPS y `ACCESS_COOKIE_SECURE=1` al exponerlo públicamente | S (en revisión) |
| P1 | Cola continua con límites | El técnico corre cada 6 h. Un timer visual opcional continúa la cola en lotes acotados, respeta pausas/cuotas y no queda habilitado por defecto; el panel informa si está instalado/activo y el próximo disparo. Pendiente: encadenar inmediatamente al terminar la etapa técnica y administrar la agenda desde la interfaz; no hay tabla general de trabajos | L (en curso) |
| P1 | Reintentos con espera y presupuesto | Esta rama registra intentos, causa y próxima ejecución, limita los intentos automáticos por fingerprint y aplica espera creciente hasta 24 h, excluyendo fallos de autenticación/4xx. También limita llamadas al proveedor por día UTC con contador SQLite visible y pausa global ante errores de autenticación/configuración, cuota, servicio o red. Pendiente: presupuesto monetario por período y control de pausa desde la interfaz | M (en curso) |
| P1 | Progreso que represente trabajos reales | Esta rama registra heartbeat, proceso vivo/obsoleto, video/fase actual, inicio/fin, último resultado y conserva hasta 200 ejecuciones por etapa; la interfaz muestra el último lote y estado de pausa del proveedor. Pendiente: próximo lote/calendario en la interfaz | M (en curso) |
| P1 | Configuración visible y validada | Esta rama valida límites/flags al arrancar y registra la configuración efectiva no secreta de cada trabajador; la interfaz muestra lote, selector, reintentos y video puntual. Pendiente: exponer ajustes operativos del coordinador cuando se implemente | S (en curso) |
| P1 | Diagnosticar el fallo de systemd | Persiste un SIGSEGV histórico aunque el proceso manual terminó bien. Reproducir de forma controlada con el mismo Node, módulo nativo y entorno; capturar evidencia antes de declarar la causa resuelta | M |
| P1 | Correcciones humanas persistentes | Las asignaciones se guardan por revisión; las anteriores se pueden reconciliar manualmente, corregir de nombre o cerrar sin reasignar. El historial por video registra cambios humanos y conserva evidencia mientras haya revisiones pendientes. Pendiente: sugerir coincidencias entre observaciones con evidencia y métricas de confianza; nunca trasladarlas automáticamente | L (en curso) |
| P1 | Respaldo y migraciones comprobables | Los comandos `backup`, `verify-backup` y `restore-data` producen una copia privada; v2 incluye hashes SHA-256 de SQLite y evidencia, el verificador comprueba claves foráneas y referencias activas, y la restauración verifica también la copia final. Pendiente: recuperación de prueba ejecutada y migraciones numeradas; el esquema todavía se modifica al importar el módulo | M |
| P2 | Evidencia visual dentro de la ficha | Se guardan fotogramas asociados a personas/eventos/pistas de fecha; la API valida sesión, revisión activa o identidad histórica pendiente. La interfaz muestra la evidencia de ambas para apoyar la reconciliación y elimina las revisiones históricas ya cerradas en el siguiente análisis exitoso | M (en curso) |
| P2 | Búsqueda por persona exacta, carpeta y momento | La interfaz filtra por ID/carpeta, prioriza relevancia FTS, muestra snippets y abre el resultado en el segundo del evento mejor alineado con la consulta. Pendiente: búsqueda dentro del audio (si se habilita transcripción) | M (en curso) |
| P2 | Mejoras de reproducción y acceso móvil | El stream admite rangos simples y cancela lecturas al desconectar; el reproductor distingue errores de red, decodificación y formato/códec. Pendiente: soporte multipart, compilar estilos locales y revisar foco/teclado | M (en curso) |
| P2 | Catálogo de personas administrable | Renombrar, fusionar y deshacer con historial autorizado; la búsqueda se actualiza transaccionalmente. Pendiente: asignar varias identidades a una observación grupal | M (en curso) |
| P2 | Muestreo por duración y escenas | Cuatro fotogramas fijos pueden perder eventos. Muestreo adaptativo con máximo de imágenes/bytes y medición de cobertura frente a un conjunto revisado | L |
| P3 | Audio, consulta semántica y sugerencias de identidad | No están implementados. Evaluarlos por separado, con consentimiento/configuración explícita para nuevos datos enviados y evaluación de errores frente a confirmaciones humanas | L |

## Diseño propuesto para continuar automáticamente

Mantener SQLite y procesos separados en la primera evolución. La selección visual actual usa el estado persistido por video y el timer opcional continúa lotes; aún no hay tabla general `jobs` con etapa, propietario del claim y heartbeat. Un coordinador podría añadirla para encadenar trabajo técnico y visual de la misma versión de archivo.

Un coordinador toma trabajos de forma atómica y ejecuta inicialmente un análisis técnico y un visual como máximo por etapa, con límites configurables. Puede empezar estrictamente secuencial si la lectura simultánea afecta al streamer. El trabajador termina o renueva su lease; otro proceso solo recupera un trabajo tras vencimiento comprobado.

Estados propuestos: `pending`, `running`, `done`, `retry_wait`, `failed` y `cancelled`. Ya existe un máximo diario configurable de solicitudes al proveedor, con contador persistente en SQLite y una pausa global persistente ante fallos de autenticación/configuración, cuota, servicio o red. Los errores de autenticación suspenden la etapa hasta que cambie la configuración; las cuotas y fallos temporales aplican una espera antes de permitir otro lote.

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
