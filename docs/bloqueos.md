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
- [Notas de crédito](#notas-de-crédito)
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

- Si existe: no hacer nada más. En la próxima sincronización aparecerá en Madre.
- Si no existe: reintentar.

Si se reintenta sin mirar y la factura sí existía, quedan dos facturas con CAE para la misma venta, y una hay que anularla con nota de crédito. Por eso este caso **nunca se reintenta solo**.

### `XUBIO_INVOICE_CREATION_FAILED`

Xubio rechazó la factura. El mensaje trae lo que respondió.

**Qué hacer:** leer el motivo. Suele ser un dato del cliente o de un producto. Tampoco se reintenta solo.

### `XUBIO_CLIENTE_ID_NOT_AVAILABLE` · `INVOICE_CREATION_REPOSITORY_NOT_CONFIGURED`

Fallas internas: no se obtuvo el ID del cliente, o el servicio arrancó sin la conexión a Xubio configurada.

**Qué hacer:** avisar a desarrollo.

---

## Notas de crédito

### `NO_LIVE_INVOICE`

El TLQV no tiene facturas en Madre.

**Qué hacer:** si la factura se emitió hace poco, puede que Madre todavía no la tenga: esperar a la próxima sincronización (cada 2 horas) o correr un [backfill](api.md#backfill-de-comprobantes-en-cola).

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

Todos los demás quedan bloqueados para que alguien los revise. En particular, **nada que haya llegado a enviar un comprobante a Xubio se reintenta solo**.

Al facturar **de a una** no hay reintento del flujo, pero las lecturas de planilla y de Xubio se reintentan internamente.
