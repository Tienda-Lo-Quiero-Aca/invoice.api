# Bloqueos

Motivos por los que una venta no se factura. Para cada uno: qué significa y qué hacer.

← [Volver al inicio](../README.md)

Un bloqueo **no es un error del sistema**: es el bot negándose a emitir un comprobante que no puede verificar. Aparece en la respuesta de la API (`blockers`) y queda guardado como issue para verlo en el panel, con este formato:

```
etapa | CÓDIGO: explicación
```

**Contenido**

- [Los más frecuentes](#los-más-frecuentes)
- [Etapa cliente](#etapa-cliente)
- [Etapa datos](#etapa-datos)
- [Etapa factura](#etapa-factura)
- [Ventas con entrega en el día](#ventas-con-entrega-en-el-día)
- [Notas de crédito](#notas-de-crédito)
- [Envío a Mercado Libre](#envío-a-mercado-libre)
- [Pedido de CAE](#pedido-de-cae)
- [Consumidor final desde un issue](#consumidor-final-desde-un-issue)
- [Cuáles se reintentan solos](#cuáles-se-reintentan-solos)

---

## Los más frecuentes

| Código | En una línea | Qué hacer |
|---|---|---|
| [`ALREADY_BILLED`](#already_billed) | La venta ya tiene factura. | Nada. Si hay que refacturar, primero la nota de crédito. |
| [`ORDER_STATUS_NOT_INVOICEABLE`](#order_status_not_invoiceable) | El pedido todavía no llegó a Buenos Aires. | Esperar. |
| [`TLQV_SALE_CANCELLED`](#tlqv_sale_cancelled) | "Precio final" está vacío: venta cancelada. | Nada, no se factura. |
| [`TLQV_COMISIONES_FLETE_MISSING`](#tlqv_comisiones_flete_missing) | Falta cargar comisiones o flete doméstico. | Completar la planilla y reintentar. |
| [`INVOICE_TOTAL_SALE_PRICE_MISMATCH`](#invoice_total_sale_price_mismatch) | Los conceptos no suman lo que pagó el cliente. | Revisar la fila en la planilla. |
| [`XUBIO_INVOICE_OUTCOME_UNKNOWN`](#xubio_invoice_outcome_unknown) | Xubio no contestó al emitir. | **Mirar en Xubio antes de reintentar.** |
| [`FISCAL_INFO_UNAVAILABLE`](#fiscal_info_unavailable) | AFIP/ARCA no respondió. | Reintentar más tarde. |

---

## Etapa cliente

### `ALREADY_BILLED`

La venta ya tiene una factura vigente en Madre. Una factura anulada por nota de crédito no cuenta.

**Qué hacer:** nada, es el control de duplicados funcionando. Si la factura existente está mal, emitir la nota de crédito, pedirle el CAE y recién después refacturar.

### `BILLING_VALIDATION_UNAVAILABLE`

No se pudo consultar Madre para saber si la venta ya está facturada. Ante la duda, el bot no factura.

**Qué hacer:** reintentar. En lote se reintenta solo. Si persiste, revisar que Madre API esté respondiendo.

### `ORDER_DETAILS_NOT_FOUND`

Ni Ops API ni Flokzu tienen datos del pedido para ese TLQV.

**Qué hacer:** verificar que el código esté bien escrito y que la venta exista en Ops.

### `ORDER_STATUS_NOT_INVOICEABLE`

El pedido no está en un estado facturable. Los estados válidos son `ETIQUETA_IMPRESA`, `RECIBIDO_BUENOS_AIRES`, `DESPACHADA_BUENOS_AIRES` y `ENTREGADO`. El mensaje indica en qué estado está.

**Qué hacer:** esperar a que el pedido avance. No hay nada que corregir.

### `MISSING_BUYER_CUIT`

El pedido no tiene CUIT del comprador.

**Qué hacer:** cargarlo en el pedido y reintentar.

### `FISCAL_INFO_UNAVAILABLE`

TusFacturas no pudo consultar AFIP/ARCA. No significa que el CUIT sea inválido: significa que no se pudo preguntar.

**Qué hacer:** reintentar más tarde. En lote se reintenta solo.

### `INVALID_FISCAL_DOCUMENT`

AFIP/ARCA no reconoce el CUIT del comprador, y es un CUIT de empresa (empieza con 30, 33 o 34), así que no se lo puede cargar como consumidor final.

**Qué hacer:** revisar el CUIT. Si en realidad es una persona física con el documento mal cargado, corregirlo en el pedido.

### `MISSING_FISCAL_RAZON_SOCIAL` · `MISSING_FISCAL_CONDICION_IMPOSITIVA`

AFIP reconoció el CUIT pero no devolvió la razón social o la condición fiscal. Sin eso no se puede crear el cliente ni definir la letra.

**Qué hacer:** revisar la situación fiscal del comprador en AFIP. Suele ser una inscripción incompleta.

### `XUBIO_EXISTING_CLIENT_LOOKUP_FAILED`

Falló la búsqueda del cliente en Xubio. El mensaje trae el detalle.

**Qué hacer:** si el detalle dice `invalid_client` o `Client authentication failed`, las credenciales de Xubio dejaron de funcionar — ver [Operación](operacion.md#las-credenciales-de-xubio-dejaron-de-funcionar). Si es otro error, reintentar.

### `XUBIO_EXISTING_CLIENT_NOT_FOUND`

Xubio dijo que el cliente ya existe, pero el bot no logró encontrar la ficha para usarla.

**Qué hacer:** buscar al cliente a mano en Xubio. Suele haber una ficha duplicada o con el CUIT mal cargado.

### `CLIENT_FLOW_BLOCKED`

Bloqueo genérico de la etapa de cliente, cuando no hay un motivo más específico.

**Qué hacer:** correr [crear el cliente de un TLQV](api.md#crear-el-cliente-de-un-tlqv) para ver el detalle.

---

## Etapa datos

### `SPREADSHEET_SOURCE_DATA_UNAVAILABLE`

La planilla no respondió, aun después de reintentar.

**Qué hacer:** reintentar. En lote se reintenta solo.

### `TLQV_SHEET_ITEM_NOT_FOUND`

El TLQV no tiene fila en la solapa TLQV de la planilla. El mensaje agrega lo que se encontró en la solapa de stock de Buenos Aires, para orientar.

**Qué hacer:** cargar la venta en la solapa TLQV.

### `MADRE_SHEET_ITEM_NOT_FOUND`

El TLQV no tiene fila en la solapa MADRE.

**Qué hacer:** cargar la venta en la solapa MADRE.

### `SOURCE_DATA_NOT_AVAILABLE`

No están disponibles las dos solapas necesarias para armar la factura.

**Qué hacer:** igual que los dos anteriores: revisar que la venta esté en ambas solapas.

---

## Etapa factura

### `INVALID_INVOICE_ISSUE_DATE`

La fecha de emisión no es válida: tiene mal el formato, es futura, o tiene más de 10 días de antigüedad.

**Qué hacer:** enviar una fecha `YYYY-MM-DD` dentro de los últimos 10 días.

### `ANTI_DUMPING_NOT_SUPPORTED`

La venta trae un importe en la columna `Anti Dumping`. Todavía no está definido con qué concepto de Xubio se factura.

**Qué hacer:** facturarla a mano en Xubio.

### `TLQV_SALE_CANCELLED`

La columna `Precio final` está vacía. Así marca la planilla una venta cancelada.

**Qué hacer:** nada. Si la venta no está cancelada, completar `Precio final` y reintentar.

### `TLQV_COMISIONES_FLETE_MISSING`

`Comisiones externas` o `Flete doméstico` están vacíos en la solapa TLQV. El mensaje dice cuál.

**Qué hacer:** completar la columna y reintentar. Si la venta realmente no tuvo ese costo, cargar `0`: una celda vacía se interpreta como "falta cargar", no como cero.

### `INVOICE_TOTAL_SALE_PRICE_MISMATCH`

La suma de los conceptos no coincide con `Precio final`, por más de $1. El mensaje trae los dos importes y la diferencia.

**Qué hacer:** revisar la fila en la planilla. Las causas habituales:

- Un concepto cargado con un importe equivocado.
- `Precio final` que no refleja un descuento aplicado a la venta.
- Una columna de importes sin completar.

Para ver de dónde salió cada número, correr la factura en modo prueba y mirar `invoiceBuild.itemMappings` — ver [API](api.md#emitir-una-factura).

### `INVOICE_BUILD_FAILED`

No se pudo armar la factura. El mensaje trae el motivo; el más común es que todos los conceptos vinieron en cero.

**Qué hacer:** revisar la fila de la planilla.

### `XUBIO_INVOICE_DATE_SEQUENCE_ERROR`

Xubio rechazó la factura porque ya existe un comprobante con fecha posterior en la misma numeración. AFIP exige que las fechas vayan en orden.

**Qué hacer:** emitir con la fecha de hoy, o con una fecha igual o posterior a la del último comprobante emitido.

### `XUBIO_INVOICE_OUTCOME_UNKNOWN`

Se mandó la factura a Xubio y **no hubo respuesta**: se cortó la conexión, venció el tiempo de espera o Xubio devolvió un error interno. No se sabe si la factura llegó a emitirse.

**Qué hacer:** **entrar a Xubio y buscar si la factura de ese TLQV existe, antes de reintentar.**

- Si existe: no hacer nada más. En la próxima sincronización aparecerá en Madre. Hasta entonces no volver a facturar esa venta: el control de duplicados todavía no la ve.
- Si no existe: reintentar.

Si se reintenta sin mirar y la factura sí existía, quedan dos facturas con CAE para la misma venta, y una hay que anularla con nota de crédito. Por eso este caso **nunca se reintenta solo**.

### `XUBIO_INVOICE_CREATION_FAILED`

Xubio rechazó la factura. El mensaje trae lo que respondió.

**Qué hacer:** leer el motivo. Suele ser un dato del cliente o de un producto. Tampoco se reintenta solo.

### `XUBIO_CLIENTE_ID_NOT_AVAILABLE` · `INVOICE_CREATION_REPOSITORY_NOT_CONFIGURED`

Fallas internas: no se obtuvo el ID del cliente, o el servicio arrancó sin la conexión a Xubio configurada.

**Qué hacer:** avisar a desarrollo.

---

## Ventas con entrega en el día

Propios del proceso que factura [desde la orden de Mercado Libre](funcional.md#ventas-con-entrega-en-el-día). Ese proceso comparte además todos los de la [etapa cliente](#etapa-cliente) y los de emisión en Xubio de la [etapa factura](#etapa-factura).

### `MELI_ORDER_NOT_LINKED`

Ops API no tiene una orden de Mercado Libre asociada a ese TLQV. Sin la orden no hay de dónde tomar el importe ni el comprador.

**Qué hacer:** verificar la venta en Ops. Si no es una venta de Mercado Libre, este proceso no aplica.

### `MELI_ORDER_NOT_FOUND`

Mercado Libre no reconoce el número de orden que tiene Ops.

**Qué hacer:** revisar el número de orden cargado en Ops para esa venta.

### `MELI_ORDER_LOOKUP_FAILED` · `ORDER_DETAILS_LOOKUP_FAILED`

No se pudo consultar Mercado Libre, o no se pudo consultar Ops API. No se factura con datos a medias.

**Qué hacer:** reintentar. Si el detalle menciona `MELI_API_INTERNAL_API_KEY` o un error `401`, falta o está mal la clave del servicio de Mercado Libre — ver [configuración](tecnico.md#variables-de-entorno).

### `MELI_ORDER_CANCELLED`

La orden figura cancelada en Mercado Libre.

**Qué hacer:** nada, no se factura.

### `MELI_BILLING_INFO_MISSING`

Mercado Libre no informó el documento del comprador. Sin eso no se puede identificar al cliente.

**Qué hacer:** facturarla a mano, o reintentar más tarde: a veces Mercado Libre demora en devolver los datos de facturación.

### `INVOICE_TOTAL_SALE_PRICE_MISMATCH` (en este proceso)

El importe que informa Mercado Libre no coincide con `Precio de venta` de costos-operaciones, por más de $1. El mensaje trae los dos importes y la diferencia.

**Qué hacer:** revisar cuál de los dos está mal. Lo habitual es que la planilla tenga el precio de lista y la venta se haya cobrado con un descuento, o al revés. Se corrige el `Precio de venta` en costos-operaciones y se reintenta.

### `COSTOS_OPERACIONES_NOT_FOUND` · `COSTOS_OPERACIONES_SALE_PRICE_MISSING`

La venta no está en la solapa costos-operaciones, o está pero sin `Precio de venta`. Sin ese dato no se puede controlar el importe, y no se factura.

**Qué hacer:** cargar la venta, o su precio, en costos-operaciones y reintentar.

### `COSTOS_OPERACIONES_LOOKUP_FAILED`

La planilla no respondió, aun después de reintentar.

**Qué hacer:** reintentar.

### `MELI_ORDER_CURRENCY_NOT_SUPPORTED` · `MELI_ORDER_TOTAL_INVALID`

La orden no está en pesos, o su importe es cero. Son controles de seguridad; no deberían aparecer en una venta normal.

**Qué hacer:** revisar la orden en Mercado Libre.

---

### `XUBIO_TRANSACCION_ID_MISSING`

Solo en el [proceso completo en lote](funcional.md#todo-de-una-vez-en-lote). Xubio emitió la factura pero no informó cuál es, y sin eso no se puede seguir con el CAE.

**Qué hacer:** buscar la factura en Xubio y seguir a mano: [pedir el CAE](api.md#cae) y [enviarla](api.md#enviar-la-factura-a-mercado-libre).

### Bloqueos del proceso completo en lote

El [proceso completo](funcional.md#todo-de-una-vez-en-lote) no tiene bloqueos propios: usa los de cada etapa. El resultado dice en cuál se detuvo.

| Se detuvo en | Bloqueos posibles |
|---|---|
| `invoice` | Los de esta sección y los de la [etapa cliente](#etapa-cliente). |
| `cae` | Los de [pedido de CAE](#pedido-de-cae). |
| `meli` | Los de [envío a Mercado Libre](#envío-a-mercado-libre). |

En los tres casos, una vez resuelto el motivo, se vuelve a mandar la venta al lote y sigue desde donde quedó.

---

## Notas de crédito

### `NO_LIVE_INVOICE`

El TLQV no tiene facturas en Madre.

**Qué hacer:** las facturas que emite el bot se copian a Madre en el momento. Si esta se cargó a mano en Xubio hace poco, puede que Madre todavía no la tenga: esperar a la próxima sincronización (cada 2 horas) o correr un [backfill](api.md#backfill-de-comprobantes-en-cola).

### `ALREADY_CANCELLED`

La factura ya tiene una nota de crédito asociada. La respuesta sale como `skipped` y no se emite otra.

**Qué hacer:** nada.

### `INVOICE_HAS_NO_ITEMS`

La factura guardada en Madre no tiene conceptos para copiar.

**Qué hacer:** correr un backfill del día de esa factura para recargarla, y reintentar.

### `INVOICE_DATA_INCOMPLETE`

A la factura guardada en Madre le falta el cliente o el punto de venta.

**Qué hacer:** igual que el anterior.

### `COMPROBANTES_LOOKUP_FAILED`

No se pudo leer Madre. No se emite nada.

**Qué hacer:** reintentar.

### `NOTA_CREDITO_CREATION_FAILED`

Xubio rechazó la nota de crédito, o no respondió.

**Qué hacer:** leer el motivo y **verificar en Xubio si la nota llegó a crearse antes de reintentar**, por la misma razón que en `XUBIO_INVOICE_OUTCOME_UNKNOWN`.

---

## Envío a Mercado Libre

Propios de [enviar la factura al comprador](funcional.md#enviar-la-factura-al-comprador).

### `INVOICE_WITHOUT_CAE`

La factura todavía no tiene CAE en Xubio. Sin CAE no es válida para el cliente, y no se envía.

**Qué hacer:** [pedir el CAE](api.md#cae) y reintentar.

### `COMPROBANTE_NOT_AN_INVOICE` · `COMPROBANTE_TLQV_MISMATCH`

Solo cuando se pide enviar una factura puntual por su ID de Xubio. El comprobante indicado no es una factura, o su descripción en Xubio no nombra a esa venta. No se envía, para no mandarle al comprador una nota de crédito o la factura de otro.

**Qué hacer:** revisar el ID.

### `MELI_INVOICE_ALREADY_SENT`

La venta ya tiene una factura cargada en Mercado Libre. La respuesta sale como `skipped` y no se sube otra.

**Qué hacer:** nada, si es la misma factura. Si es una factura nueva —después de una nota de crédito—, reenviar con `force: true`.

### `NO_LIVE_INVOICE` (en este proceso)

La venta no tiene una factura vigente: o no tiene ninguna en Madre, o todas están anuladas por nota de crédito. El mensaje dice cuál de las dos.

**Qué hacer:** si la factura se cargó a mano en Xubio hace poco, esperar a la próxima sincronización (cada 2 horas) o correr un [backfill](api.md#backfill-de-comprobantes-en-cola); las que emite el bot ya están en Madre. Si está anulada, primero hay que emitir la factura nueva.

### `MELI_ORDER_NOT_LINKED` (en este proceso)

La venta no tiene una orden de Mercado Libre en Ops. No hay adónde enviar la factura.

**Qué hacer:** nada, si la venta no es de Mercado Libre.

### `MELI_INVOICE_UPLOAD_FAILED`

Mercado Libre no aceptó la factura, o no respondió. El mensaje trae lo que contestó.

**Qué hacer:** reintentar. A diferencia de la emisión de facturas, acá reintentar es seguro: si la subida había llegado a hacerse, el reintento lo detecta y no la duplica. Si se repite, revisar el detalle del mensaje.

### `INVOICE_PDF_UNAVAILABLE` · `INVOICE_PDF_TOO_LARGE`

No se pudo descargar el PDF de Xubio, lo que bajó no es un PDF, o pesa más de lo que acepta Mercado Libre (10 MB).

**Qué hacer:** reintentar. Si persiste, probar imprimir la factura desde Xubio para ver si el problema está ahí.

### `XUBIO_COMPROBANTE_LOOKUP_FAILED` · `MELI_INVOICE_STATUS_LOOKUP_FAILED` · `COMPROBANTES_LOOKUP_FAILED` · `ORDER_DETAILS_LOOKUP_FAILED`

No se pudo consultar Xubio, Mercado Libre, Madre u Ops. No se envía nada sin poder verificar.

**Qué hacer:** reintentar.

---

## Pedido de CAE

Propios de [pedir el CAE](funcional.md#el-cae). No se guardan como issue: el comprobante sigue sin CAE en Xubio, y eso es lo que queda a la vista.

### `ALREADY_HAS_CAE`

El comprobante ya tiene CAE. La respuesta sale como `skipped` y no se pide otro.

**Qué hacer:** nada.

### `CAE_REJECTED`

AFIP o Xubio no otorgaron el CAE. El mensaje trae el motivo tal como lo informó Xubio.

**Qué hacer:** leer el motivo. Los más comunes:

- **Hay un comprobante anterior de la misma numeración sin CAE.** Pedir primero el de ese.
- **Los datos del cliente no coinciden con AFIP.** Pasa si se editó la ficha del cliente después de emitir. Revisar la ficha en Xubio.
- **La fecha del comprobante quedó fuera del plazo** que AFIP admite para autorizarlo.

Una vez corregido, volver a pedirlo.

### `CAE_REQUEST_OUTCOME_UNKNOWN`

Xubio no respondió al pedido, o no se pudo volver a leer el comprobante para confirmar el resultado.

**Qué hacer:** volver a pedirlo. Es seguro: antes de pedir se verifica que el comprobante no tenga CAE, así que si AFIP ya lo había otorgado, la respuesta sale `skipped` con el CAE.

### `NO_COMPROBANTE`

La venta no tiene comprobantes en Madre.

**Qué hacer:** verificar el código. Si el comprobante se cargó a mano en Xubio hace poco, pedir el CAE con su `transaccionId` o esperar a la próxima sincronización (cada 2 horas).

### `XUBIO_COMPROBANTE_LOOKUP_FAILED` · `COMPROBANTES_LOOKUP_FAILED` (en este proceso)

No se pudo leer el comprobante en Xubio, o los comprobantes de la venta en Madre. No se le pide nada a AFIP sin poder verificar antes.

**Qué hacer:** reintentar.

---

## Consumidor final desde un issue

Solo aparecen en [crear un consumidor final desde un issue](api.md#crear-un-consumidor-final-desde-un-issue).

| Código | Significado | Qué hacer |
|---|---|---|
| `ISSUE_NOT_FOUND` | No hay un issue para ese TLQV. | Verificar el código o el `issueId`. |
| `ISSUE_NOT_OPEN` | El issue ya está resuelto o ignorado. | Nada. |
| `ISSUE_REASON_NOT_SUPPORTED` | El issue no es de tipo `INVALID_FISCAL_DOCUMENT`. | Este endpoint solo resuelve ese tipo. |
| `MISSING_DNI` | No se pudo deducir el DNI del documento guardado. | Enviar `dni` explícitamente. |
| `MISSING_BUYER_NAME` | El issue no tiene el nombre del comprador. | Crear el cliente con [datos fiscales](api.md#crear-un-cliente-con-datos-fiscales). |

---

## Cuáles se reintentan solos

Al facturar **en lote**, estos bloqueos se reintentan hasta 3 veces, con 30 segundos entre intentos, porque son temporales y repetir no tiene riesgo:

| Código | Por qué es seguro reintentar |
|---|---|
| `BILLING_VALIDATION_UNAVAILABLE` | Solo se consulta Madre. |
| `FISCAL_INFO_UNAVAILABLE` | Solo se consulta AFIP. |
| `SPREADSHEET_SOURCE_DATA_UNAVAILABLE` | Solo se lee la planilla. |

Todos los demás quedan bloqueados para que alguien los revise. En particular, **nada que haya llegado a enviar un comprobante a Xubio se reintenta solo**, y el pedido de CAE tampoco: se intenta una vez y, si no sale, se vuelve a pedir a mano.

Al facturar **de a una** no hay reintento del flujo, pero las lecturas de planilla y de Xubio se reintentan internamente.
