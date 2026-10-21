# Uso del streamer

[Volver al README](../README.md)

## Ver un video y su ficha

Abrir las carpetas del panel lateral y seleccionar un video. En móvil, el botón de menú abre el navegador de carpetas. La ficha aparece debajo del reproductor: duración, resolución, códec, fecha sugerida y evidencia de esa fecha. Si ya existe análisis visual, también aparecen título, resumen, personas observadas, momentos y lugares.

En móvil se desplaza la página completa. En escritorio se desplaza el área principal; la ficha no tiene su propio panel de scroll limitado. Pulsar una observación o un momento del análisis salta al segundo de su fotograma.

Un video puede reproducirse aunque todavía no esté inventariado. Una extensión reconocida no garantiza que su códec sea reproducible: la aplicación entrega el archivo original. Las extensiones listadas son MP4, MKV, WebM, MOV, AVI, M4V, FLV, WMV, MPG y MPEG.

## Buscar

El campo de búsqueda consulta nombres de archivo, título, resumen, descripciones, lugares, palabras clave y nombres confirmados. La búsqueda usa prefijos de palabras y exige que coincidan todas las palabras consideradas, hasta ocho. No es una búsqueda semántica: una frase parecida o un sinónimo pueden no coincidir.

Los filtros Desde/Hasta usan `recorded_at`, inclusive. Con un filtro de fecha, los videos sin fecha sugerida quedan fuera. La interfaz muestra 50 resultados por página y permite cargar más. El directorio «Personas identificadas» coloca el nombre elegido en la búsqueda textual: todavía no aplica un filtro exacto por identificador de persona.

## Interpretar fechas y descripciones

La fecha sugerida se acepta cuando las fuentes de captura encontradas en metadatos o en el nombre del archivo coinciden en un único día. Si hay conflicto o faltan fuentes, queda sin determinar. La fecha de modificación del archivo se conserva como evidencia técnica y no se usa por sí sola como fecha de grabación.

Las descripciones se basan en un máximo de cuatro imágenes. Pueden omitir personas o escenas situadas entre fotogramas. Las pistas de fecha visuales no cambian automáticamente la fecha sugerida. No hay transcripción de conversaciones ni un editor general de título, resumen o fecha.

## Dar nombre a las personas

1. Abrir un video con ficha visual y ubicar «Personas observadas».
2. Pulsar la descripción para ir al instante correspondiente.
3. Elegir un nombre existente o «Crear persona…» y escribirlo.
4. La primera edición pide el token del servidor. Queda en memoria hasta recargar o cerrar la página.
5. Para quitar una asociación, elegir «Sin identificar».

El servidor necesita `METADATA_EDIT_TOKEN`. Si no está configurado, la ficha informa que la edición no está habilitada. La clave de OpenRouter y el token de edición son credenciales diferentes.

Una observación puede describir un grupo; la interfaz actual permite un único nombre por observación. No hay comparación facial, agrupamiento automático ni propagación de identidad a otros videos. Al regenerar la ficha, las asociaciones anteriores no se aplican automáticamente; la interfaz permite elegir manualmente una observación de la ficha nueva y conserva constancia de la revisión. El catálogo de nombres permanece.

## Leer el progreso

| Indicador | Qué cuenta |
|---|---|
| Inventario técnico | Fichas técnicas terminadas / videos presentes en el índice, excluyendo `missing` |
| Fichas visuales | Fichas visuales terminadas / videos cuyo análisis técnico está listo |
| En cola visual | Elegibles con `visual_status` pendiente o nulo |
| En proceso visual | Registros marcados `running` |
| Esperando inventario técnico | Registros con estado técnico `pending` |
| Con error | Fallos de la etapa correspondiente |
| Último inventario | Estado y fecha del último recorrido registrado en SQLite |
| Solicitudes del proveedor | Solicitudes iniciadas hoy UTC respecto del límite configurado, si está activo |
| Último lote | Estado, fecha y último resultado/error de cada etapa |

Por ejemplo: 60 de 3.772 fichas técnicas y 3 de 60 fichas visuales representan **dos denominadores distintos**. Las otras 3.712 todavía necesitan datos técnicos. «Inventario completado» significa que se recorrió todo el árbol; no implica haber terminado todas las fichas.

La consulta se repite cada 15 segundos con la pestaña visible y al volver a ella. Los estados y lotes proceden de SQLite; el indicador de actividad contrasta el PID en el mismo host cuando está disponible. Tras un cierre abrupto pueden quedar estados `running`. Además, el recorrido actualiza `seen_count` cada 100 archivos; puede mostrar cero durante los primeros análisis lentos.

Si la consulta falla, aparece «Estado no disponible» y se reintenta. Las barras anteriores pueden permanecer visibles; no deben interpretarse como datos recién obtenidos. El panel no inicia ni detiene trabajos.
