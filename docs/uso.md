# Uso del streamer

[Volver al README](../README.md)

## Ver un video y su ficha

Abrir las carpetas del panel lateral y seleccionar un video. En móvil, el botón de menú abre el navegador de carpetas. La ficha aparece debajo del reproductor: duración, resolución, códec, fecha sugerida y evidencia de esa fecha. Si el archivo incluye tags de ubicación o de fabricante/modelo de cámara reconocidos por ffprobe, se muestran sus valores y origen. Si ya existe análisis visual, también aparecen título, resumen, personas observadas, momentos y lugares.

La ubicación y el dispositivo solo aparecen si esos tags estaban guardados en el propio archivo. Si la ubicación incluye coordenadas, la aplicación muestra un enlace opcional a OpenStreetMap; al abrirlo, ese sitio recibe las coordenadas. No se convierten automáticamente en ciudad o dirección. SQLite conserva estos datos para búsqueda; la aplicación no escribe tags en el video.

Para guardar una copia portable de la ficha, usá «Exportar ficha JSON junto al video». La acción requiere edición habilitada y crea `<nombre-del-video>.metadata.json` en la misma carpeta. Incluye la ficha vigente, el fingerprint del video y las identidades confirmadas. Si el sidecar ya existe, no se sobrescribe; la exportación no modifica el video original.

Cuando el video no tiene una revisión visual local, aparece «Importar ficha JSON». La aplicación solo lee el sidecar vecino, si es un JSON reconocido menor a 2 MiB y su ruta y fingerprint de tamaño/mtime coinciden con el video actual. Ese fingerprint no es un hash del contenido. La importación no reemplaza fichas ni identidades locales existentes. Restaura identidades de las observaciones narrativas y ubicación/dispositivo si faltan localmente; los resúmenes de rostros se conservan en el sidecar, pero no se asignan sin volver a crear y revisar los embeddings localmente.

En móvil se desplaza la página completa. En escritorio se desplaza el área principal; la ficha no tiene su propio panel de scroll limitado. Pulsar una observación o un momento del análisis salta al segundo de su fotograma.

Un video puede reproducirse aunque todavía no esté inventariado. Una extensión reconocida no garantiza que su códec sea reproducible: la aplicación entrega el archivo original. Las extensiones listadas son MP4, MKV, WebM, MOV, AVI, M4V, FLV, WMV, MPG y MPEG.

## Buscar

La búsqueda consulta nombres de archivo, título, resumen, descripciones, lugares, palabras clave, nombres confirmados y tags de ubicación presentes en el archivo. Usa prefijos de palabras y exige que coincidan todas las palabras consideradas, hasta ocho. Los resultados pueden filtrarse por fecha, persona o carpeta. La descripción narrativa usa el modelo remoto configurado y las identidades faciales se procesan localmente. La aplicación no convierte coordenadas en nombres de ciudades.

Los filtros Desde/Hasta usan `recorded_at`, inclusive. Con un filtro de fecha, los videos sin fecha sugerida quedan fuera. La interfaz muestra 50 resultados por página y permite cargar más. El directorio «Personas identificadas» filtra por el ID elegido, incluso cuando hay personas con nombres iguales.

## Interpretar fechas y descripciones

La fecha sugerida se acepta cuando las fuentes de captura encontradas en metadatos o en el nombre del archivo coinciden en un único día. Si hay conflicto o faltan fuentes, queda sin determinar. La fecha de modificación del archivo se conserva como evidencia técnica y no se usa por sí sola como fecha de grabación.

Las descripciones se basan en un máximo de cuatro imágenes. Pueden omitir personas o escenas situadas entre fotogramas. Las pistas de fecha visuales no cambian automáticamente la fecha sugerida. No hay transcripción de conversaciones ni un editor general de título, resumen o fecha.

## Dar nombre a las personas

### Identificar rostros localmente

Cuando el indexador facial está instalado y activo, «Revisar rostros sin nombre» abre la bandeja de detecciones. El indexador compara cada detección con los rostros confirmados de las identidades. Con similitud de 0,80 o más, asigna automáticamente la identidad mejor puntuada; entre 0,50 y menos de 0,80 muestra recomendaciones para que las confirmes manualmente. Los rostros por debajo de 0,50 quedan sin asignar. Los umbrales se configuran con `FACE_AUTO_ASSIGNMENT_THRESHOLD` y `FACE_SUGGESTION_THRESHOLD`.

Seleccioná una persona existente o escribí un nombre nuevo. Marcá los vecinos que consideres de la misma persona y pulsá «Asignar identidad». La operación confirma únicamente el rostro base y los vecinos seleccionados. Si una persona no te interesa, marcá su rostro y las apariciones similares que quieras excluir y pulsá «Ignorar». Se eliminan los embeddings guardados y esas detecciones no vuelven a la bandeja al reindexar el mismo video, fingerprint y versión del índice; las identidades confirmadas no se pueden ignorar desde este control. La pestaña «Asignados automáticamente» permite inspeccionar los resultados de ≥0,80 y corregir una identidad si hace falta. La decisión se aplica a las apariciones seleccionadas: otros videos o fotogramas no seleccionados deben revisarse por separado. Las identidades confirmadas aparecen en la ficha del video, el directorio y la búsqueda exacta por persona.

El detector y los embeddings se ejecutan en el servidor. Las miniaturas se vuelven a extraer del video cuando abrís la bandeja, se muestran en la sesión autenticada y no se guardan ni se envían a OpenRouter. La descripción narrativa del video sigue usando el proveedor/modelo remoto configurado. Las caras pequeñas, ocultas o de perfil pueden pasar inadvertidas; revisá cada grupo antes de asignarlo.

Si la bandeja está vacía, puede no haber videos procesados aún. El progreso «Rostros procesados localmente» muestra cuántos videos faltan y cuántas detecciones esperan revisión.

1. Abrir un video con ficha visual y ubicar «Personas observadas».
2. Pulsar la descripción para ir al instante correspondiente.
3. Elegir una o más identidades en la lista. Para seleccionar varias, mantener Ctrl (Windows/Linux) o ⌘ (macOS), y luego pulsar «Guardar selección».
4. Usar «Crear persona y agregar» para sumar un nombre nuevo a la selección actual.
5. Dejar la lista sin selecciones para quitar todas las identidades de esa observación.
6. Con el acceso a la biblioteca habilitado, la misma sesión autoriza las ediciones; no se pide un token adicional al cambiar personas.

El servidor necesita `METADATA_EDIT_TOKEN` para habilitar la edición. Cuando también está configurado `ACCESS_TOKEN`, iniciás sesión una vez y la misma sesión permite editar. La sesión dura 30 días por defecto; si se limpia la cookie, se usa navegación privada o vence, hay que iniciar sesión de nuevo. Sin `ACCESS_TOKEN`, el modo local conserva el token Bearer de edición.

Una observación narrativa puede describir un grupo y guardar varias identidades; la bandeja facial trabaja con detecciones individuales y permite revisar vecinos por similitud. Las asignaciones automáticas guardan su origen, puntaje y umbral en SQLite; el progreso informa cuántas hay. Una similitud alta no es una probabilidad y puede producir falsos positivos, por lo que el umbral debe revisarse con ejemplos etiquetados. Las asignaciones pueden corregirse desde el flujo de edición de identidades. Si el archivo cambia, las detecciones dejan de contar como vigentes y deben indexarse de nuevo; el catálogo de nombres permanece.

## Leer el progreso

| Indicador | Qué cuenta |
|---|---|
| Inventario técnico | Fichas técnicas terminadas / videos presentes en el índice, excluyendo `missing` |
| Fichas visuales | Fichas visuales terminadas / videos cuyo análisis técnico está listo |
| Rostros procesados localmente | Videos con embeddings faciales vigentes / videos técnicamente listos; también muestra cuántos rostros esperan revisión |
| En cola visual | Elegibles con `visual_status` pendiente o nulo |
| En proceso visual | Registros marcados `running` |
| Esperando inventario técnico | Registros con estado técnico `pending` |
| Con error | Fallos de la etapa correspondiente |
| Último inventario | Estado y fecha del último recorrido registrado en SQLite |
| Solicitudes del proveedor | Solicitudes iniciadas hoy UTC respecto del límite configurado, si está activo |
| Último lote | Estado, fecha y último resultado/error de cada etapa |

Al elegir una persona del directorio, la búsqueda filtra por su ID y no mezcla otras personas con el mismo nombre. Editar el texto de búsqueda quita ese filtro exacto.

Dentro de una carpeta, activar «Buscar solo en esta carpeta» limita los resultados a esa ruta y sus subcarpetas. En la raíz la opción no está disponible.

Por ejemplo: 60 de 3.772 fichas técnicas y 3 de 60 fichas visuales representan **dos denominadores distintos**. Las otras 3.712 todavía necesitan datos técnicos. «Inventario completado» significa que se recorrió todo el árbol; no implica haber terminado todas las fichas.

La consulta se repite cada 15 segundos con la pestaña visible y al volver a ella. Los estados y lotes proceden de SQLite; el indicador de actividad contrasta el PID en el mismo host cuando está disponible. Tras un cierre abrupto pueden quedar estados `running`. Además, el recorrido actualiza `seen_count` cada 100 archivos; puede mostrar cero durante los primeros análisis lentos.

Si la consulta falla, aparece «Estado no disponible» y se reintenta. Las barras anteriores pueden permanecer visibles; no deben interpretarse como datos recién obtenidos. El panel no inicia ni detiene trabajos.
