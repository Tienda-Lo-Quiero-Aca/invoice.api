# Guía funcional

Cómo factura el bot, explicado desde la facturación: qué necesita, qué controla, de dónde saca cada importe y en qué casos frena.

← [Volver al inicio](../README.md)

**Contenido**

1. [Qué necesita una venta para facturarse](#qué-necesita-una-venta-para-facturarse)
2. [El recorrido, paso a paso](#el-recorrido-paso-a-paso)
3. [Factura A o B](#factura-a-o-b)
4. [Conceptos de la factura](#conceptos-de-la-factura)
5. [Controles antes de emitir](#controles-antes-de-emitir)
6. [Ventas con entrega en el día](#ventas-con-entrega-en-el-día)
7. [El CAE](#el-cae)
8. [Enviar la factura al comprador](#enviar-la-factura-al-comprador)
9. [Notas de crédito](#notas-de-crédito)
10. [Clientes](#clientes)
11. [Sincronización con Madre](#sincronización-con-madre)
12. [Registro de problemas](#registro-de-problemas)

---

## Qué necesita una venta para facturarse

Para que un TLQV salga facturado tienen que cumplirse todas estas condiciones:

| Condición | De dónde se lee |
|---|---|
| No tiene una factura vigente | Madre (copia de los comprobantes de Xubio) |
| El pedido está en un estado facturable | Ops API |
| El comprador tiene CUIT y AFIP/ARCA lo reconoce | Ops API + TusFacturas |
| La venta no está cancelada | Solapa TLQV · columna `Precio final` con valor |
| Comisiones y flete doméstico están cargados | Solapa TLQV · columnas `Comisiones externas` y `Flete doméstico` |
| La suma de los conceptos coincide con lo que pagó el cliente | Solapa TLQV · columna `Precio final` |

Si falla cualquiera, la venta queda **bloqueada** con un motivo. Nunca se emite una factura "a medias". El listado completo de motivos está en [Bloqueos](bloqueos.md).

### Estados facturables

El pedido tiene que estar en uno de estos estados en Ops API:

- `ETIQUETA_IMPRESA`
- `RECIBIDO_BUENOS_AIRES`
- `DESPACHADA_BUENOS_AIRES`
- `ENTREGADO`

Una venta en `DESPACHADA_USA`, por ejemplo, todavía no se factura: se factura cuando llega a Buenos Aires.

---

## El recorrido, paso a paso

El flujo tiene tres etapas. Se puede cortar después de cualquiera con el parámetro `stopAfter`, para revisar antes de seguir.

### Etapa 1 — Cliente (`client`)

1. **¿Ya está facturada?** Consulta Madre. Si el TLQV tiene una factura vigente, frena. Una factura anulada por nota de crédito no cuenta como vigente, así que esa venta se puede volver a facturar.
2. **Datos del pedido.** Los pide a Ops API (con Flokzu como respaldo): comprador, CUIT, domicilio y estado.
3. **Estado.** Verifica que sea uno de los [estados facturables](#estados-facturables).
4. **Cliente en Xubio.** Busca si el comprador ya existe. Si no, consulta su condición fiscal en AFIP/ARCA y lo crea. Ver [Clientes](#clientes).

### Etapa 2 — Datos (`source_data`)

Lee la fila del TLQV en dos solapas de la planilla:

- **Solapa TLQV** — todos los importes de la factura y el `Precio final`.
- **Solapa MADRE** — el número de venta de Mercado Libre, que va en la descripción del comprobante.

### Etapa 3 — Factura (`invoice_creation`)

1. Aplica los [controles previos](#controles-antes-de-emitir).
2. Arma la factura: letra, conceptos e importes.
3. Compara el total contra `Precio final`.
4. Si todo cierra y `dryRun` es `false`, la emite en Xubio.

### Datos fijos del comprobante

| Dato | Valor |
|---|---|
| Punto de venta | `00008` (ID Xubio 216731) |
| Fecha | La indicada, o la de hoy. Hasta 10 días hacia atrás; nunca futura. |
| Vencimiento | Igual a la fecha de emisión |
| Descripción | `TLQV-22281 ML: 2000019101982438` |
| Moneda | Pesos, cotización 1 |

---

## Factura A o B

La letra sale de la condición fiscal del comprador:

| Condición fiscal | Letra |
|---|---|
| Responsable Inscripto | **A** |
| Monotributo | **A** |
| Consumidor Final | **B** |
| Exento | **B** |
| Exterior | **B** |
| IVA no alcanzado | **B** |
| Cualquier otra, o desconocida | **B** |

La letra define dos cosas: **qué columna de la planilla se lee** para cada concepto, y **cómo se informa el IVA**:

- **Factura A** — los conceptos gravados se mandan netos y Xubio les suma el IVA.
- **Factura B** — todos los importes van finales, con el IVA incluido.

---

## Conceptos de la factura

Cada concepto es un producto de Xubio. Todos se leen de la **solapa TLQV**. Si un concepto viene en cero o vacío, no se incluye en la factura (salvo los que son obligatorios — ver [controles](#controles-antes-de-emitir)).

| Concepto | ID Xubio | Factura A | Factura B |
|---|---|---|---|
| Pagos por cuenta y orden | 2461025 | `Productoco` | `Productoco` |
| Derechos de importación | 2461058 | `DIFACTURA` | `DIFACTURA.B` |
| Tasa de estadística | 2461065 | `TEFACTURA` | `TEFACTURA.B` |
| IVA importación | 2461066 | `IVAFACTURA` | `IVAFACTURA` |
| Impuestos internos | 2826655 | `Imp Internos` × `tc impuesto` | `Imp Internos` × `tc impuesto` |
| Gastos documentales Aduana | 2461080 | `LAFACTURA.B` ÷ 1,21 | `LAFACTURA.B` |
| Comisiones externas | 2460999 | `Comisiones externas` ÷ 1,21 | `Comisiones externas` |
| Fletes domésticos | 2461000 | `Flete doméstico` ÷ 1,21 | `Flete doméstico` |
| Flete internacional | 2461081 | `FLETEINTERNACIONALA` | `FLETEINTERNACIONALB` |
| Flete U.S.A. | 3464973 | `FLETEUSAA` (col. AI) | `FLETEUSAB` (col. AJ) |
| Seguro Internacional | 3464974 | `SEGUROINTA` (col. AK) | `SEGUROINTB` (col. AL) |

### Los conceptos gravados al 21%

Cuatro conceptos llevan IVA: **Gastos documentales Aduana**, **Comisiones externas**, **Fletes domésticos** y **Seguro Internacional**.

En una **factura A** se mandan netos, y Xubio les suma el 21%:

- Los tres primeros se leen de una columna que ya trae el IVA incluido, y el bot la divide por 1,21 para obtener el neto.
- El seguro se lee de `SEGUROINTA`, que ya viene neto, y se manda tal cual.

En una **factura B** van con el IVA incluido, sin ninguna cuenta.

### Comisiones y cuotas

La columna `Comisiones externas` de la solapa TLQV ya incluye el costo de las cuotas cuando la venta se pagó financiada. Por eso no se suma aparte.

---

## Controles antes de emitir

Se aplican en este orden. El primero que no se cumple frena la factura.

| # | Control | Si no se cumple |
|---|---|---|
| 1 | La fecha de emisión es válida: hasta 10 días atrás, no futura | `INVALID_INVOICE_ISSUE_DATE` |
| 2 | La venta **no trae Anti Dumping**. Todavía no hay un concepto de Xubio definido para ese importe | `ANTI_DUMPING_NOT_SUPPORTED` |
| 3 | `Precio final` tiene valor. Vacío significa **venta cancelada** | `TLQV_SALE_CANCELLED` |
| 4 | `Comisiones externas` y `Flete doméstico` están cargados | `TLQV_COMISIONES_FLETE_MISSING` |
| 5 | La suma de los conceptos coincide con `Precio final` (tolerancia: $1) | `INVOICE_TOTAL_SALE_PRICE_MISMATCH` |

### Vacío no es lo mismo que cero

En `Comisiones externas` y `Flete doméstico`, una celda **vacía** bloquea: significa que nadie la cargó todavía. Un **0,00** cargado es válido: es una venta que realmente no tuvo ese costo.

### El control del total

Es la verificación fiscal principal. Antes de emitir, el bot suma todos los conceptos —contando el IVA que Xubio va a agregar en las facturas A— y lo compara con `Precio final` (columna AP de la solapa TLQV).

`Precio final` es lo que el cliente efectivamente pagó: ya tiene descontado el cupón de Mercado Libre. Si la suma difiere en más de $1, la factura no sale.

**Ejemplo** — TLQV-22281, factura A:

| Concepto | Va a Xubio | Con IVA |
|---|---:|---:|
| Pagos por cuenta y orden | 164.540,00 | 164.540,00 |
| IVA importación | 31.682,75 | 31.682,75 |
| Gastos documentales Aduana | 3.861,74 | 4.672,71 |
| Comisiones externas | 146.224,55 | 176.931,71 |
| Fletes domésticos | 6.024,79 | 7.290,00 |
| Flete internacional | 232.820,10 | 232.820,10 |
| Flete U.S.A. | 3.785,99 | 3.785,99 |
| Seguro Internacional | 1.054,34 | 1.275,75 |
| **Total** | | **622.999,01** |

`Precio final` de esa venta: **622.999,00**. La diferencia es de un centavo, dentro de la tolerancia → se emite.

---

## Ventas con entrega en el día

Hay ventas que se entregan en el día y **no pasan por la planilla**: no tienen fila en la solapa TLQV de donde tomar los conceptos. Para esas existe un segundo proceso, que arma la factura directamente con la **orden de Mercado Libre**.

Se dispara a mano, con un TLQV, desde su propio [endpoint](api.md#emitir-una-factura-desde-la-orden-de-mercado-libre). Quien factura elige cuál de los dos procesos usar; el control de duplicados impide que una misma venta salga por los dos.

### En qué se diferencia

| | Proceso habitual | Entrega en el día |
|---|---|---|
| De dónde salen los importes | Solapa TLQV de la planilla | Orden de Mercado Libre |
| Conceptos | Once: pagos por cuenta y orden, impuestos, comisiones, fletes… | **Uno solo: "Producto"** (ID Xubio 2672923) |
| Datos del comprador | Ops API | Datos de facturación de Mercado Libre |
| Estado del pedido | Tiene que estar en un estado facturable | No se controla: se pueden facturar siempre |
| Control del importe | Contra `Precio final` de la solapa TLQV | Contra `Precio de venta` de la solapa costos-operaciones |

### El recorrido

1. Con el TLQV, busca en **Ops API** el número de la orden de Mercado Libre.
2. Con ese número, trae de **Mercado Libre** el importe y los datos de facturación del comprador.
3. **Controla el importe**: lo que informa Mercado Libre tiene que coincidir con `Precio de venta` de costos-operaciones.
4. Busca o crea al **cliente** en Xubio, igual que el proceso habitual (ver [Clientes](#clientes)):
   - Comprador con **DNI** → Consumidor Final → factura B.
   - Comprador con **CUIT** → se consulta AFIP, y de ahí sale si es A o B.
5. Arma la factura con una línea "Producto" y, si no es modo prueba, la emite.

### Qué importe se factura

**Lo que el cliente pagó por los productos**: el precio ya con los descuentos aplicados, **sin el envío** ni el costo de financiación.

| Letra | Qué se manda a Xubio |
|---|---|
| **B** | El importe final, sin discriminar IVA. |
| **A** | El importe dividido por 1,21. Xubio le suma el 21%. |

**Ejemplo** — orden 2000019813708728:

| | |
|---|---:|
| Precio de lista | 453.999,00 |
| Descuento a cargo del vendedor | − 67.249,84 |
| **Lo que pagó el cliente** | **386.749,16** |

El comprador tiene DNI y es Consumidor Final → **factura B por $386.749,16**.

Si fuera Responsable Inscripto saldría una **A**: se mandan $319.627,40 netos y Xubio suma el IVA.

En una factura A el total puede diferir en un centavo de lo cobrado, por el redondeo al separar el IVA.

### El control del importe

Antes de tocar nada en Xubio, compara dos datos que vienen de lugares distintos:

- Lo que **Mercado Libre** dice que se cobró por los productos.
- El **`Precio de venta`** de la venta en la solapa costos-operaciones.

Si difieren en más de **$1**, la factura no sale. Tampoco sale si la venta no está en costos-operaciones, si no tiene precio cargado, o si la planilla no responde: ante la duda, no factura.

Se compara siempre lo que pagó el cliente. En una factura A, aunque a Xubio vaya el importe neto, el control se hace contra el total con IVA.

El control corre **antes** de buscar o crear al cliente, así una venta que no cierra no deja una ficha creada en Xubio.

### Compras de varios productos

Cuando el cliente paga varios productos juntos, Mercado Libre los registra como varias órdenes de un mismo carrito. Sale **una sola factura** por la suma de todas, con una única línea.

La descripción de la línea lleva el nombre de lo que se vendió, para que la factura no diga solamente "Producto".

### Lo que se mantiene igual

Control de duplicados, punto de venta 00008, fecha hasta 10 días atrás, modo prueba por defecto y **CAE pedido aparte**. Una orden que figura **cancelada** en Mercado Libre no se factura.

### Todo de una vez, en lote

Para estas ventas existe un [proceso en lote](api.md#entrega-en-el-día-proceso-completo-en-lote) que hace los tres pasos seguidos, venta por venta:

1. **Emite la factura** desde la orden de Mercado Libre, con todos los controles de arriba.
2. **Pide el CAE** de esa factura. Ver [El CAE](#el-cae).
3. **La envía a Mercado Libre**, donde la ve el comprador. Ver [Enviar la factura al comprador](#enviar-la-factura-al-comprador).

Se le pasa una lista de TLQV, los encola y los procesa **de a uno**: termina una venta completa antes de empezar la siguiente.

**Si una etapa no puede seguir, la venta se detiene ahí** y sigue con la próxima. Lo que ya se hizo queda hecho: si falló el CAE, la factura queda emitida sin CAE; si falló el envío, queda con CAE y sin enviar. El resultado dice en qué etapa se detuvo y por qué, y queda guardado como problema para verlo en el panel.

**Se puede volver a mandar la misma venta.** Antes de emitir, el proceso se fija si la venta ya tiene una factura vigente. Si la tiene, **no emite otra**: sigue desde donde quedó. Tampoco pide un CAE que ya tiene, ni manda a Mercado Libre una factura que ya está cargada. Una venta ya terminada, si se manda de nuevo, sale como completa sin tocar nada.

Eso funciona aunque se reenvíe a los pocos minutos, porque la factura nueva se [copia a Madre en el momento](#sincronización-con-madre).

**Arranca en modo prueba**, como todo: arma la factura y muestra qué haría, sin emitir, sin pedir el CAE y sin enviar.

> **Con `dryRun: false` no hay vuelta atrás.** La factura sale con CAE y el comprador la recibe. Corregirla después requiere una nota de crédito.

---

## El CAE

Emitir y pedir el CAE son **dos pasos separados**. Al emitir, el bot crea el comprobante en Xubio **sin CAE**, tanto si es una factura como una nota de crédito.

Mientras no tenga CAE, el comprobante existe en Xubio pero no para AFIP. Las respuestas de la API lo informan explícitamente (`caeStatus.pendiente: true`).

El CAE se pide después, de dos maneras: a mano en Xubio, o con el [pedido de CAE](api.md#cae) del bot, de a un comprobante o en lote.

### Cómo pide el CAE el bot

1. Lee el comprobante en Xubio.
2. Si **ya tiene CAE, no pide otro**: lo saltea.
3. Le pide a AFIP el CAE, a través de Xubio.
4. **Vuelve a leer el comprobante** y responde lo que encuentra ahí: tiene CAE, o no lo tiene y por qué.

El paso 4 es el que lo hace confiable. Si Xubio tarda o se corta la respuesta, el bot no adivina: mira el comprobante. Por eso **repetir un pedido es seguro** — si el CAE ya estaba otorgado, lo detecta y no lo pide de nuevo.

### Lo que hay que tener presente

**No se puede deshacer.** Con CAE, el comprobante ya está informado a AFIP. No se borra: se anula con una nota de crédito. Por eso el pedido arranca en modo prueba, que solo muestra qué comprobantes pediría.

**Va en orden.** AFIP autoriza cada numeración en orden: no da el CAE de la factura 4096 si la 4095 todavía no lo tiene. El bot siempre pide del comprobante más viejo al más nuevo, y en lote de a uno. Si uno se rechaza, es esperable que los que le siguen en la misma numeración también.

**Por TLQV o por comprobante.** Se puede pedir por código de venta —toma todos los comprobantes de esa venta que no tengan CAE— o por el ID del comprobante en Xubio. Por TLQV el comprobante tiene que estar en Madre; si se emitió hace minutos, conviene pedirlo por el ID que devolvió la emisión.

> **Importante:** no edites la ficha de un cliente en Xubio mientras tenga comprobantes sin CAE. Al pedir el CAE, AFIP valida los datos del cliente; si cambiaron, rechaza el comprobante.

---

## Enviar la factura al comprador

Una vez que la factura tiene CAE, se puede **adjuntar a la venta en Mercado Libre**. El comprador la ve en el detalle de su compra.

Sirve para las facturas de los dos procesos —el habitual y el de entrega en el día—, siempre que la venta sea de Mercado Libre. Se dispara a mano, por venta, desde su [endpoint](api.md#enviar-la-factura-a-mercado-libre).

### Qué hace

1. Busca la **factura vigente** del TLQV. Si hubo una nota de crédito y una factura nueva, toma la nueva.
2. Le pregunta a **Xubio** si ya tiene **CAE**.
3. Busca en **Ops** la orden de Mercado Libre de la venta.
4. Le pregunta a **Mercado Libre** si esa venta ya tiene una factura cargada.
5. Descarga el **PDF** de Xubio: el mismo que se imprime desde Xubio, con el CAE y el código QR.
6. Lo sube a Mercado Libre.

### Las tres reglas

**Sin CAE no se envía.** Una factura sin CAE todavía no es válida para el cliente. El CAE se consulta en Xubio en el momento, no en la copia de Madre, porque se pide después de emitir y Madre puede tener hasta dos horas de atraso.

**Una factura anulada no se envía.** Si todas las facturas de la venta tienen nota de crédito, no hay nada que mandar.

**No se envía dos veces.** Si Mercado Libre ya tiene una factura para esa venta, el proceso la saltea. Esto también hace seguro repetirlo: si una subida falló a mitad de camino, volver a intentar no duplica nada.

### Lo que hay que tener presente

**No se puede deshacer.** No existe forma de borrar una factura ya subida a Mercado Libre. Por eso el proceso arranca en modo prueba: hace todas las verificaciones, baja el PDF y muestra qué enviaría —número de factura, CAE, orden—, sin subir nada.

**Factura rehecha.** Si a una venta se le hizo nota de crédito y factura nueva, Mercado Libre ya tiene cargada la anterior. Para subir la nueva hay que pedirlo explícitamente (`force`).

**Compras de varios productos.** Se sube una sola vez; Mercado Libre la asocia al carrito completo.

**La factura tiene que estar en Madre.** Las que emite el bot están ahí [en el momento](#sincronización-con-madre). Una cargada a mano en Xubio puede tardar hasta la próxima sincronización.

---

## Notas de crédito

Una nota de crédito anula una factura ya emitida. El bot:

1. Busca en Madre la **factura vigente** del TLQV (la más reciente que no esté anulada).
2. **Copia sus conceptos tal como se facturaron** — no los recalcula desde la planilla.
3. La emite con la misma letra, cliente y punto de venta, asociada a la factura original.

**Protecciones**

- Arranca en modo prueba (`dryRun: true`).
- Si la factura ya tiene una nota de crédito, responde `skipped` y no emite otra. Una nota de crédito duplicada lleva su propio CAE y habría que compensarla.
- En lote, cada nota se intenta una sola vez: no hay reintentos automáticos sobre un documento fiscal.

**Lee la factura desde Madre.** Las facturas que emite el bot están ahí [en el momento](#sincronización-con-madre). Una cargada a mano en Xubio puede tardar hasta la próxima sincronización.

### Orden correcto para corregir una factura

Cuando hay que corregir una factura mal emitida (por ejemplo, salió B y debía ser A):

1. Emitir la **nota de crédito**.
2. Pedir el **CAE** de la nota de crédito, en Xubio o con el [pedido de CAE](api.md#cae).
3. Recién entonces, **corregir la ficha del cliente** si hace falta.
4. Emitir la **factura nueva**.

Si se edita el cliente antes del paso 2, AFIP rechaza la nota de crédito.

---

## Clientes

### Cómo se busca o se crea

1. **Busca en Xubio** si el comprador ya existe, por nombre y razón social. Si hay más de una ficha parecida, prefiere la que tiene el CUIT completo.
2. Si no existe, **consulta AFIP/ARCA** (a través de TusFacturas) con el CUIT del comprador. De ahí salen la razón social y la condición fiscal.
3. **Crea la ficha** en Xubio con:

| Dato | Valor |
|---|---|
| Identificación tributaria | CUIT |
| Categoría fiscal | Responsable Inscripto, Monotributo, Consumidor Final o Exento, según AFIP |
| Razón social | La que informa AFIP |
| Domicilio | El del pedido |
| Código interno | `TLQV-` + el CUIT sin guiones |
| Descripción | "Cliente creado automáticamente desde TLQV" |

### Si AFIP no reconoce el CUIT

Depende de a quién pertenece:

| Caso | Qué hace |
|---|---|
| CUIT de **persona física** (empieza con 20, 23, 24 o 27) | Lo carga como **Consumidor Final** con su DNI, y sale factura B. |
| CUIT de **empresa** (empieza con 30, 33 o 34) | **Bloquea.** Una empresa no puede ser consumidor final; hay que revisar el CUIT. |
| **AFIP/ARCA está caído** | **Bloquea** con `FISCAL_INFO_UNAVAILABLE`. No se puede saber la condición fiscal; se reintenta más tarde. |

### Consulta siempre por CUIT

La consulta fiscal se hace siempre como **CUIT**, nunca como CUIL. Una empresa no tiene CUIL, y la consulta de AFIP no responde a un CUIL ni siquiera para una persona.

---

## Sincronización con Madre

Madre guarda una copia de los comprobantes de venta de Xubio. De ahí salen dos cosas críticas:

- El **control de duplicados** — saber si un TLQV ya tiene factura.
- Las **notas de crédito** — leer la factura que hay que anular.

Si Madre se atrasa, el bot queda ciego: no puede distinguir una venta ya facturada de una nueva.

Por eso la copia se mantiene al día de dos maneras:

**En el momento, lo que hace el bot.** Cada vez que el bot emite una factura o una nota de crédito, o consigue un CAE, copia ese comprobante a Madre enseguida. Así el control de duplicados ya sabe de una factura segundos después de emitirla, y una venta con nota de crédito se puede volver a facturar sin esperar.

Si esa copia falla, el comprobante **queda emitido igual** y la respuesta lo avisa (`madreSync`). En ese caso no hay que volver a facturar esa venta hasta la próxima sincronización, porque el control todavía no la ve.

**Cada 2 horas, todo.** Una sincronización relee los últimos 7 días de Xubio. Es la que trae lo que se cargó a mano en Xubio y la que cubre cualquier copia inmediata que haya fallado. Releer con superposición evita huecos si una corrida falla o si un comprobante se cargó tarde. También se puede disparar a mano desde la [API](api.md#comprobantes).

Si Madre no responde al momento de facturar, el bot **bloquea** en lugar de asumir que la venta no está facturada.

---

## Registro de problemas

Cada venta que no se pudo facturar queda guardada en Madre como un *issue*, con el motivo completo. Es lo que muestra el panel.

| Motivo | Cuándo aparece |
|---|---|
| `TLQV_INVOICE_FLOW_BLOCKED` | El flujo frenó por alguno de los [bloqueos](bloqueos.md). El mensaje indica cuál. |
| `TLQV_INVOICE_JOB_FAILED` | Un trabajo del lote falló por un error inesperado. |
| `INVALID_FISCAL_DOCUMENT` | AFIP no reconoció el CUIT del comprador. |
| `XUBIO_CLIENT_ALREADY_EXISTS` | Xubio rechazó crear el cliente porque ya existe, y no se lo pudo recuperar. |
| `MISSING_BUYER_CUIT` | El pedido no tiene CUIT del comprador. |
| `MISSING_FISCAL_RAZON_SOCIAL` | AFIP no devolvió razón social. |
| `MISSING_FISCAL_CONDICION_IMPOSITIVA` | AFIP no devolvió condición fiscal. |

Un issue queda `open` hasta que se resuelve. Si la misma venta falla otra vez por el mismo motivo, no se duplica: se actualiza la fecha y suma una ocurrencia.
