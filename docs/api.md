# Referencia de la API

Todos los endpoints del servicio, agrupados por tema.

← [Volver al inicio](../README.md)

**URL base de producción:** `https://invoice.loquieroaca.com`

**Header obligatorio** en todos los endpoints `/internal/*`:

```
x-internal-api-key: <INVOICE_INTERNAL_API_KEY>
```

Los ejemplos usan dos variables de entorno para no repetir la URL y la clave:

```bash
export INVOICE_API_URL="https://invoice.loquieroaca.com"
export INVOICE_INTERNAL_API_KEY="..."
```

**Contenido**

| Grupo | Endpoints |
|---|---|
| [Facturas](#facturas) | Emitir una · Emitir desde la orden de Mercado Libre · Emitir en lote · Estado del lote · Entrega en el día: proceso completo en lote · Enviar a Mercado Libre · Eliminar |
| [CAE](#cae) | Pedir uno · Pedir en lote · Estado del lote |
| [Notas de crédito](#notas-de-crédito) | Emitir una · Emitir en lote · Últimos lotes · Estado del lote |
| [Clientes](#clientes) | Crear desde TLQV · Crear consumidor final · Crear con datos fiscales |
| [Consulta fiscal](#consulta-fiscal) | Condición fiscal en AFIP/ARCA |
| [Comprobantes](#comprobantes) | Validar un TLQV · Backfill en cola · Backfill inmediato |
| [Issues](#issues) | Listar · Por TLQV |
| [Estado del servicio](#estado-del-servicio) | Health check |

### Convenciones

- **`dryRun`** — todo endpoint que emite un comprobante lo acepta, y **por defecto es `true`**: arma el comprobante y lo devuelve sin mandarlo a Xubio. Para emitir hay que enviar `false` explícitamente.
- **Bloqueos** — una venta que no se puede facturar no devuelve error HTTP: responde `200` con `status: "blocked"` y la lista de `blockers`. Cada uno trae `code` y `message`. El catálogo está en [Bloqueos](bloqueos.md).
- **`madreSync`** — cuando una llamada emite un comprobante o consigue un CAE, la respuesta trae `madreSync`, que dice si se copió a Madre en el momento: `{ "status": "synced" }`, o `failed` con un `message`. Con `failed` el comprobante igual quedó emitido, pero no hay que volver a facturar esa venta hasta la próxima [sincronización](funcional.md#sincronización-con-madre).
- **Errores HTTP** — `400` si falta o es inválido un parámetro; `401` si falta o es incorrecta la clave.
- **Fechas** — siempre `YYYY-MM-DD`.

---

## Facturas

### Emitir una factura

```
POST /internal/tlqv-invoice/facturas/create-from-tlqv
```

Corre el flujo completo de facturación para un TLQV: valida, busca o crea el cliente, lee la planilla, arma la factura y —si `dryRun` es `false`— la emite.

Se ejecuta dentro de la misma llamada, sin cola. Las lecturas de planilla se reintentan solas si se cuelgan.

**Body**

| Campo | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `tlqvCode` | string | Sí | Código de la venta. Ej: `TLQV-22281`. |
| `stopAfter` | string | No | Hasta qué etapa avanzar: `client`, `source_data` o `invoice_creation`. **Por defecto `source_data`**: para llegar a la factura hay que enviar `invoice_creation`. |
| `dryRun` | boolean | No | Por defecto `true`. Con `true` nunca emite, aunque `stopAfter` sea `invoice_creation`. |
| `issueDate` | string | No | Fecha de emisión. Por defecto, hoy. Hasta 10 días hacia atrás; no puede ser futura. |
| `fechaFactura` | string | No | Alias de `issueDate`. No enviar ambos con valores distintos. |

**Ejemplo — ver qué factura saldría, sin emitir**

```bash
curl -s -X POST "$INVOICE_API_URL/internal/tlqv-invoice/facturas/create-from-tlqv" \
  -H "x-internal-api-key: $INVOICE_INTERNAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"tlqvCode":"TLQV-22281","stopAfter":"invoice_creation","dryRun":true}'
```

**Ejemplo — emitir**

```bash
curl -s -X POST "$INVOICE_API_URL/internal/tlqv-invoice/facturas/create-from-tlqv" \
  -H "x-internal-api-key: $INVOICE_INTERNAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"tlqvCode":"TLQV-22281","stopAfter":"invoice_creation","dryRun":false}'
```

**Respuesta — completado**

```json
{
  "status": "completed",
  "canContinue": true,
  "tlqvCode": "TLQV-22281",
  "stopAfter": "invoice_creation",
  "dryRun": false,
  "steps": [
    { "name": "client", "status": "completed", "message": "Cliente creado en Xubio." },
    { "name": "source_data", "status": "completed", "message": "Datos obtenidos desde solapas TLQV y MADRE." },
    { "name": "invoice_creation", "status": "completed" }
  ],
  "xubioClienteId": 10489494,
  "invoiceBuild": {
    "invoiceLetter": { "letter": "A", "matchedRule": "RESPONSABLE_INSCRIPTO" },
    "invoice": { "type": "Factura", "letter": "A", "items": [] },
    "itemMappings": []
  },
  "createdInvoice": {
    "invoice": { "transaccionId": 76318348, "numeroDocumento": "A-00008-00002667" }
  }
}
```

Campos útiles de la respuesta:

| Campo | Qué trae |
|---|---|
| `steps` | Cada etapa recorrida y cómo terminó. |
| `invoiceBuild.invoice` | La factura tal como se manda a Xubio: letra, cliente, fecha y conceptos. |
| `invoiceBuild.itemMappings` | De qué solapa y columna salió cada concepto, el valor leído, el importe enviado y si se omitió por venir en cero. Es lo que hay que mirar cuando un total no cierra. |
| `createdInvoice` | Solo si se emitió: número de comprobante y `transaccionId` de Xubio. |

**Respuesta — bloqueado**

```json
{
  "status": "blocked",
  "canContinue": false,
  "tlqvCode": "TLQV-22209",
  "steps": [
    { "name": "client", "status": "completed" },
    { "name": "source_data", "status": "completed" },
    {
      "name": "invoice_creation",
      "status": "blocked",
      "blockers": [{ "code": "INVOICE_TOTAL_SALE_PRICE_MISMATCH", "step": "invoice_creation", "message": "..." }]
    }
  ],
  "blockers": [
    {
      "code": "INVOICE_TOTAL_SALE_PRICE_MISMATCH",
      "step": "invoice_creation",
      "message": "El total calculado de la factura (311399.99) no coincide con \"Precio final\" de la solapa TLQV (345999.99) para TLQV-22209. Diferencia: 34600.00 (tolerancia: 1.00)."
    }
  ]
}
```

Cada bloqueo de este endpoint queda además guardado como [issue](#issues).

---

### Emitir una factura desde la orden de Mercado Libre

```
POST /internal/tlqv-invoice/facturas/create-from-meli-order
```

Para las [ventas con entrega en el día](funcional.md#ventas-con-entrega-en-el-día), que no tienen fila en la planilla. Toma el importe y los datos del comprador de la orden de Mercado Libre y emite una factura con un solo concepto, "Producto".

**Body**

| Campo | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `tlqvCode` | string | Sí | Código de la venta. |
| `dryRun` | boolean | No | Por defecto `true`: arma la factura y la devuelve sin emitirla. |
| `issueDate` | string | No | Fecha de emisión. Por defecto, hoy. Hasta 10 días hacia atrás. |
| `fechaFactura` | string | No | Alias de `issueDate`. |

A diferencia del endpoint habitual, no tiene `stopAfter`: siempre recorre el flujo completo, y `dryRun` decide si emite.

**Ejemplo — ver qué factura saldría**

```bash
curl -s -X POST "$INVOICE_API_URL/internal/tlqv-invoice/facturas/create-from-meli-order" \
  -H "x-internal-api-key: $INVOICE_INTERNAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"tlqvCode":"TLQV-23500","dryRun":true}'
```

**Respuesta**

```json
{
  "status": "completed",
  "canContinue": true,
  "tlqvCode": "TLQV-23500",
  "dryRun": true,
  "steps": [
    { "name": "meli_order", "status": "completed", "message": "Orden 2000019813708728 obtenida de Mercado Libre." },
    { "name": "amount_check", "status": "completed", "message": "El importe de Mercado Libre coincide con \"Precio de venta\" de costos-operaciones." },
    { "name": "client", "status": "completed", "message": "Cliente creado en Xubio." },
    { "name": "invoice_creation", "status": "skipped", "message": "Factura armada. No se emitió porque dryRun es true." }
  ],
  "amountCheck": {
    "meliTotalAmount": 386749.16,
    "costosSalePrice": 386749.16,
    "differenceInCents": 0,
    "toleranceInCents": 100
  },
  "xubioClienteId": 10503039,
  "invoiceBuild": {
    "invoiceLetter": { "letter": "B", "matchedRule": "CONSUMIDOR_FINAL" },
    "meliOrderIds": ["2000019813708728"],
    "totalAmount": 386749.16,
    "amountSentToXubio": 386749.16,
    "invoice": {
      "type": "Factura",
      "letter": "B",
      "customerId": 10503039,
      "description": "TLQV-23500 ML: 2000019813708728",
      "items": [
        {
          "productId": 2672923,
          "description": "Cámara De Acción 4k 30fps Go11-us, Portátil Para Vlogging, I Color",
          "quantity": 1,
          "unitPrice": 386749.16,
          "priceWithVat": 386749.16
        }
      ]
    }
  }
}
```

| Campo | Qué trae |
|---|---|
| `meliOrders` | Las órdenes de Mercado Libre tal como se leyeron. |
| `amountCheck` | Los dos importes que se compararon —el de Mercado Libre y el `Precio de venta` de costos-operaciones— y su diferencia en centavos. Viene también cuando el control bloquea. |
| `invoiceBuild.totalAmount` | Lo que pagó el cliente por los productos, sin envío. |
| `invoiceBuild.amountSentToXubio` | Lo que se manda a Xubio: igual al total en una B; el total ÷ 1,21 en una A. |
| `createdInvoice` | Solo si se emitió: número de comprobante y `transaccionId`. |

Cuando se emite, el último paso sale `completed` y aparece `createdInvoice`. Si no se puede facturar, responde `status: "blocked"` con los `blockers`, y queda guardado como [issue](#issues).

> El modo prueba **sí busca o crea al cliente en Xubio**: lo que no hace es emitir la factura. Si el control del importe no cierra, frena antes y no toca Xubio.

---

### Emitir facturas en lote

```
POST /internal/tlqv-invoice/facturas/bulk/create-from-tlqv
```

Encola una factura por TLQV y responde enseguida. Cada una corre el mismo flujo que la emisión individual, hasta `invoice_creation`.

Diferencias con la emisión individual:

- **Reintenta**: hasta 3 intentos por TLQV, con 30 segundos entre cada uno, cuando el bloqueo es temporal (AFIP caído, planilla o Madre sin respuesta).
- **Procesa de a una**, en orden.
- **No reintenta** si falló el envío de la factura a Xubio: no se sabe si llegó a emitirse, y repetirlo podría duplicarla.

**Body**

| Campo | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `tlqvCodes` | string[] | Sí | Lista de ventas. Los repetidos se descartan. |
| `dryRun` | boolean | No | Por defecto `true`. |
| `issueDate` | string | No | Fecha de emisión común a todas. |
| `fechaFactura` | string | No | Alias de `issueDate`. |

**Ejemplo**

```bash
curl -s -X POST "$INVOICE_API_URL/internal/tlqv-invoice/facturas/bulk/create-from-tlqv" \
  -H "x-internal-api-key: $INVOICE_INTERNAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"tlqvCodes":["TLQV-22323","TLQV-22992","TLQV-23240"],"dryRun":false}'
```

**Respuesta**

```json
{
  "status": "queued",
  "queueName": "tlqv-invoice-facturas-bulk",
  "jobName": "create-from-tlqv",
  "batchId": "tlqv-invoice-bulk-2026-08-01T15-00-00-000Z-a1b2c3d4",
  "totalRequested": 3,
  "totalUnique": 3,
  "totalDuplicated": 0,
  "totalQueued": 3,
  "dryRun": false,
  "attempts": 3,
  "concurrency": 1,
  "bullBoardPath": "/admin/queues",
  "sampleJobs": [
    { "jobId": "tlqv-invoice:tlqv-invoice-bulk-...:TLQV-22323", "tlqvCode": "TLQV-22323" }
  ]
}
```

Guardar el `batchId`: es lo que se usa para consultar el avance.

---

### Estado de un lote de facturas

```
GET /internal/tlqv-invoice/facturas/bulk/:batchId
```

Cuántas facturas del lote terminaron, cuántas siguen en espera y el resultado de cada TLQV. Pensado para consultarlo cada pocos segundos mientras el lote se procesa.

```bash
curl -s "$INVOICE_API_URL/internal/tlqv-invoice/facturas/bulk/$BATCH_ID" \
  -H "x-internal-api-key: $INVOICE_INTERNAL_API_KEY"
```

**Respuesta**

```json
{
  "batchId": "tlqv-invoice-bulk-2026-08-01T15-00-00-000Z-a1b2c3d4",
  "queueName": "tlqv-invoice-facturas-bulk",
  "found": true,
  "totalJobs": 2,
  "counts": { "completed": 1, "failed": 0, "active": 0, "waiting": 1, "delayed": 0, "paused": 0 },
  "results": { "created": 1, "skipped": 0, "blocked": 0, "failed": 0, "pending": 1 },
  "jobs": [
    {
      "jobId": "tlqv-invoice:tlqv-invoice-bulk-...:TLQV-15783",
      "tlqvCode": "TLQV-15783",
      "state": "completed",
      "attemptsMade": 1,
      "status": "completed",
      "created": true,
      "skipped": false,
      "transaccionId": 76318348,
      "numeroDocumento": "A-00008-00002667"
    }
  ]
}
```

| Campo | Significado |
|---|---|
| `results.created` | Facturas emitidas. |
| `results.skipped` | Terminaron sin emitir: típicamente, porque el lote corrió en modo prueba. |
| `results.blocked` | Frenadas por un [bloqueo](bloqueos.md). |
| `results.failed` | Agotaron los intentos, o fallaron por un error inesperado. |
| `results.pending` | Todavía en cola o procesándose. |

Los lotes terminados se van borrando de la cola con el tiempo. El registro permanente de lo emitido está en Xubio y en Madre; el de lo que falló, en los [issues](#issues).

---

### Entrega en el día: proceso completo en lote

```
POST /internal/tlqv-invoice/facturas/bulk/entrega-en-el-dia
```

Para ventas con entrega en el día. Por cada TLQV hace los tres pasos seguidos: **emite la factura** desde la orden de Mercado Libre, **pide el CAE** y **la envía a Mercado Libre**. Encola un trabajo por venta y los procesa de a uno. Cómo se comporta está en la [guía funcional](funcional.md#todo-de-una-vez-en-lote).

> **Con `dryRun: false` no hay vuelta atrás:** la factura sale con CAE y el comprador la recibe.

**Body**

| Campo | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `tlqvCodes` | string[] | Sí | Las ventas. Los repetidos se cuentan una vez. |
| `dryRun` | boolean | No | Por defecto `true`: arma cada factura y muestra qué haría, sin emitir, pedir el CAE ni enviar. |
| `issueDate` | string | No | Fecha de emisión, común a todas. Hasta 10 días atrás. |

```bash
curl -s -X POST "$INVOICE_API_URL/internal/tlqv-invoice/facturas/bulk/entrega-en-el-dia" \
  -H "x-internal-api-key: $INVOICE_INTERNAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"tlqvCodes":["TLQV-23500","TLQV-23501"],"dryRun":true}'
```

**Respuesta**

```json
{
  "status": "queued",
  "queueName": "tlqv-invoice-entrega-en-el-dia-bulk",
  "batchId": "tlqv-entrega-en-el-dia-2026-11-27T15-00-00-000Z-a1b2c3d4",
  "dryRun": true,
  "totalRequested": 2,
  "totalDuplicated": 0,
  "totalQueued": 2,
  "bullBoardPath": "/admin/queues",
  "tlqvCodes": ["TLQV-23500", "TLQV-23501"]
}
```

Guardar el `batchId`: es lo que se usa para consultar el avance.

#### Estado del lote

```
GET /internal/tlqv-invoice/facturas/bulk/entrega-en-el-dia/:batchId
```

```json
{
  "batchId": "tlqv-entrega-en-el-dia-2026-11-27T15-00-00-000Z-a1b2c3d4",
  "queueName": "tlqv-invoice-entrega-en-el-dia-bulk",
  "found": true,
  "totalJobs": 2,
  "counts": { "completed": 2, "failed": 0, "active": 0, "waiting": 0, "delayed": 0, "paused": 0 },
  "results": {
    "completed": 1,
    "ready": 0,
    "blocked": 1,
    "blockedAtInvoice": 0,
    "blockedAtCae": 1,
    "blockedAtMeli": 0,
    "failed": 0,
    "pending": 0
  },
  "jobs": [
    {
      "tlqvCode": "TLQV-23500",
      "state": "completed",
      "status": "completed",
      "stoppedAt": null,
      "invoiceStatus": "created",
      "transaccionId": 80000001,
      "numeroDocumento": "B-00008-00004100",
      "totalAmount": 386749.16,
      "caeStatus": "authorized",
      "cae": "86484580124099",
      "meliStatus": "sent",
      "meliOrderId": "2000019813708728",
      "blockerCodes": [],
      "message": null,
      "warning": null
    }
  ]
}
```

`results.pending` en `0` significa que el lote terminó.

| `status` de cada venta | Significado |
|---|---|
| `completed` | La venta tiene su factura, con CAE, cargada en Mercado Libre. |
| `ready` | Modo prueba: no hay nada que lo impida, y esto es lo que se haría. |
| `blocked` | Se detuvo en la etapa `stoppedAt`. El motivo está en `blockerCodes` y `message`. |

| `stoppedAt` | Cómo quedó la venta | Qué hacer |
|---|---|---|
| `invoice` | Sin factura. | Resolver el [bloqueo](bloqueos.md#ventas-con-entrega-en-el-día) y volver a mandarla. |
| `cae` | Con factura emitida, **sin CAE**. | Resolver el [motivo](bloqueos.md#pedido-de-cae) y volver a mandarla: sigue desde el CAE. |
| `meli` | Con factura y CAE, **sin enviar**. | Resolver el [motivo](bloqueos.md#envío-a-mercado-libre) y volver a mandarla: solo hace el envío. |

| Campo | Valores |
|---|---|
| `invoiceStatus` | `created` se emitió ahora · `existing` la venta ya tenía factura y se siguió con esa · `ready` modo prueba · `blocked` |
| `caeStatus` | `authorized` se obtuvo ahora · `already_had` ya lo tenía · `ready` modo prueba, se pediría · `pending` no se llegó · `blocked` |
| `meliStatus` | `sent` se envió ahora · `already_sent` Mercado Libre ya la tenía · `ready` modo prueba, se enviaría · `pending` no se llegó · `blocked` |
| `warning` | Aviso si la factura nueva no se pudo copiar a Madre en el momento. No frena la venta, pero **no hay que volver a mandarla** hasta la próxima sincronización: no vería la factura y emitiría otra. |

Cada venta se intenta **una sola vez** por lote. Las que se detienen quedan guardadas como [issue](#issues). Los lotes terminados se van borrando de la cola con el tiempo.

---

### Enviar la factura a Mercado Libre

```
POST /internal/tlqv-invoice/facturas/send-to-meli
```

Adjunta el PDF de la factura a la venta en Mercado Libre, donde lo ve el comprador. Qué controla y por qué está en la [guía funcional](funcional.md#enviar-la-factura-al-comprador).

> **La subida no se puede deshacer.** Correr primero en modo prueba.

**Body**

| Campo | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `tlqvCode` | string | Sí | Código de la venta. |
| `transaccionId` | number | No | ID en Xubio de la factura a enviar. Sin esto se envía la factura vigente que figura en Madre; con esto, esa factura puntual, que tiene que ser de esa venta. Sirve para una factura emitida hace minutos, que Madre todavía no tiene. |
| `dryRun` | boolean | No | Por defecto `true`: verifica todo y descarga el PDF, sin subirlo. |
| `force` | boolean | No | Por defecto `false`. Con `true` sube aunque la venta ya tenga una factura en Mercado Libre: es para la factura nueva después de una nota de crédito. |

**Ejemplo — ver qué se enviaría**

```bash
curl -s -X POST "$INVOICE_API_URL/internal/tlqv-invoice/facturas/send-to-meli" \
  -H "x-internal-api-key: $INVOICE_INTERNAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"tlqvCode":"TLQV-22281","dryRun":true}'
```

**Respuesta**

```json
{
  "status": "ready",
  "tlqvCode": "TLQV-22281",
  "dryRun": true,
  "invoice": {
    "xubioTransactionId": 79915082,
    "numeroDocumento": "A-00008-00004095",
    "cae": "86484580124007",
    "fechaEmision": "2026-11-26T00:00:00.000Z",
    "importeTotal": 622999
  },
  "meliOrderId": "2000019102174568",
  "meliPackId": "2000015640314189",
  "pdf": { "fileName": "A-00008-00004095.pdf", "sizeInBytes": 107407 },
  "blockers": []
}
```

| `status` | Significado |
|---|---|
| `ready` | Modo prueba: todo en orden, se enviaría esta factura. |
| `sent` | Subida a Mercado Libre. La respuesta agrega `meliResponse`, con lo que contestó Mercado Libre. |
| `skipped` | No se envió porque la venta **ya tiene una factura** en Mercado Libre (`MELI_INVOICE_ALREADY_SENT`). |
| `blocked` | No se puede enviar. El motivo está en `blockers`. |

| Campo | Qué trae |
|---|---|
| `invoice` | La factura que se envía: número, CAE e importe. |
| `meliOrderId` | La orden de Mercado Libre de la venta. |
| `meliPackId` | Dónde queda guardada en Mercado Libre: el carrito, o la venta misma. |
| `pdf` | Nombre y tamaño del archivo. |

Los motivos de bloqueo están en [Bloqueos](bloqueos.md#envío-a-mercado-libre).

---

### Eliminar una factura

```
DELETE /internal/tlqv-invoice/facturas/:transaccionId
```

Elimina un comprobante de venta en Xubio por su `transaccionId` (el que devuelve la emisión).

> Solo sirve para comprobantes **sin CAE**, típicamente pruebas. Un comprobante con CAE ya está informado a AFIP y se anula con una [nota de crédito](#notas-de-crédito).

```bash
curl -s -X DELETE "$INVOICE_API_URL/internal/tlqv-invoice/facturas/75226596" \
  -H "x-internal-api-key: $INVOICE_INTERNAL_API_KEY"
```

```json
{ "transaccionId": 75226596, "deleted": true }
```

---

## CAE

Emitir un comprobante y pedir su CAE son pasos separados. Cómo funciona el pedido y qué cuidados tiene está en la [guía funcional](funcional.md#el-cae).

> **Un CAE otorgado no se puede deshacer.** El comprobante queda informado a AFIP y solo se anula con una nota de crédito. Correr primero en modo prueba.

### Pedir el CAE

```
POST /internal/tlqv-invoice/facturas/cae
```

Pide el CAE de una factura o de una nota de crédito. Espera la respuesta de AFIP, así que puede tardar varios segundos.

**Body** — se envía `tlqvCode` **o** `transaccionId`, uno de los dos.

| Campo | Tipo | Descripción |
|---|---|---|
| `tlqvCode` | string | Código de la venta. Pide el CAE de **todos** sus comprobantes que todavía no lo tengan, del más viejo al más nuevo. |
| `transaccionId` | number | ID del comprobante en Xubio (el que devuelve la emisión). Pide el CAE de ese solo. |
| `dryRun` | boolean | Por defecto `true`: muestra qué pediría, sin pedir nada. |

**Ejemplo — ver qué se pediría**

```bash
curl -s -X POST "$INVOICE_API_URL/internal/tlqv-invoice/facturas/cae" \
  -H "x-internal-api-key: $INVOICE_INTERNAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"tlqvCode":"TLQV-22281","dryRun":true}'
```

**Ejemplo — pedir el CAE de un comprobante**

```bash
curl -s -X POST "$INVOICE_API_URL/internal/tlqv-invoice/facturas/cae" \
  -H "x-internal-api-key: $INVOICE_INTERNAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"transaccionId":79915082,"dryRun":false}'
```

**Respuesta por `transaccionId`**

```json
{
  "status": "authorized",
  "transaccionId": 79915082,
  "dryRun": false,
  "comprobante": {
    "transaccionId": 79915082,
    "numeroDocumento": "A-00008-00004095",
    "tipo": 1,
    "fecha": "2026-11-26",
    "importeTotal": 622999,
    "cliente": "CASA MAINI SRL",
    "descripcion": "TLQV-22281 ML: 2000019102174568",
    "cae": "86484580124007",
    "caeFechaVto": "2026-12-06"
  },
  "blockers": []
}
```

**Respuesta por `tlqvCode`** — lo mismo, una vez por comprobante, dentro de `results`:

```json
{
  "status": "authorized",
  "tlqvCode": "TLQV-22281",
  "dryRun": false,
  "results": [ { "status": "authorized", "transaccionId": 79915082, "comprobante": { "...": "..." }, "blockers": [] } ],
  "blockers": []
}
```

| `status` | Significado |
|---|---|
| `ready` | Modo prueba: el comprobante no tiene CAE y se pediría. |
| `authorized` | AFIP otorgó el CAE. Viene en `comprobante.cae`, con su vencimiento en `caeFechaVto`. |
| `skipped` | El comprobante **ya tenía CAE** (`ALREADY_HAS_CAE`). No se pidió otro. |
| `blocked` | No se obtuvo. El motivo está en `blockers`. |

Por `tlqvCode`, el `status` general es el peor de sus comprobantes: `blocked` si alguno lo está; si no, `authorized`; si no, `ready`; y `skipped` solo cuando ninguno necesitaba CAE.

`comprobante.tipo` es `1` para una factura y `3` para una nota de crédito.

Los motivos de bloqueo están en [Bloqueos](bloqueos.md#pedido-de-cae).

---

### Pedir el CAE en lote

```
POST /internal/tlqv-invoice/facturas/bulk/cae
```

Encola un pedido de CAE por comprobante y responde enseguida. Se procesan **de a uno y del más viejo al más nuevo**, sin importar el orden en que se envíen.

**Body** — `tlqvCodes`, `transaccionIds`, o los dos.

| Campo | Tipo | Descripción |
|---|---|---|
| `tlqvCodes` | string[] | Ventas. Entran al lote todos los comprobantes de cada una. |
| `transaccionIds` | number[] | Comprobantes sueltos, por su ID de Xubio. |
| `dryRun` | boolean | Por defecto `true`. |

```bash
curl -s -X POST "$INVOICE_API_URL/internal/tlqv-invoice/facturas/bulk/cae" \
  -H "x-internal-api-key: $INVOICE_INTERNAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"tlqvCodes":["TLQV-22281","TLQV-22323"],"dryRun":true}'
```

**Respuesta**

```json
{
  "status": "queued",
  "queueName": "tlqv-invoice-cae-bulk",
  "batchId": "tlqv-cae-2026-11-27T15-00-00-000Z-a1b2c3d4",
  "dryRun": true,
  "totalQueued": 2,
  "tlqvCodesWithoutComprobante": [],
  "bullBoardPath": "/admin/queues",
  "comprobantes": [
    { "transaccionId": 79862126, "tlqvCode": "TLQV-22323", "numeroDocumento": "A-00008-00004073" },
    { "transaccionId": 79915082, "tlqvCode": "TLQV-22281", "numeroDocumento": "A-00008-00004095" }
  ]
}
```

| Campo | Qué trae |
|---|---|
| `batchId` | Identificador del lote, para consultar su estado. |
| `comprobantes` | Lo que entró al lote, en el orden en que se va a procesar. |
| `tlqvCodesWithoutComprobante` | Ventas pedidas que **no tienen comprobantes en Madre** y quedaron afuera. Si se emitieron hace poco, pedirlas por `transaccionIds`. |

Los comprobantes que ya tienen CAE entran al lote y terminan como `skipped`. Si no se puede leer Madre, responde `503` y no encola nada.

---

### Estado de un lote de CAE

```
GET /internal/tlqv-invoice/facturas/bulk/cae/:batchId
```

```json
{
  "batchId": "tlqv-cae-2026-11-27T15-00-00-000Z-a1b2c3d4",
  "queueName": "tlqv-invoice-cae-bulk",
  "found": true,
  "totalJobs": 2,
  "counts": { "completed": 2, "failed": 0, "active": 0, "waiting": 0, "delayed": 0, "paused": 0 },
  "results": { "authorized": 1, "ready": 0, "skipped": 1, "blocked": 0, "failed": 0, "pending": 0 },
  "jobs": [
    {
      "transaccionId": 79862126,
      "tlqvCode": "TLQV-22323",
      "state": "completed",
      "status": "skipped",
      "numeroDocumento": "A-00008-00004073",
      "cae": "86474277857526",
      "caeFechaVto": "2026-12-04",
      "blockerCodes": ["ALREADY_HAS_CAE"],
      "message": "El comprobante A-00008-00004073 ya tiene CAE (86474277857526). No se pide otro."
    }
  ]
}
```

`results.pending` en `0` significa que el lote terminó. Cada trabajo se intenta **una sola vez**; lo que quedó `blocked` se puede volver a pedir, de a uno o en otro lote. Los lotes terminados se van borrando de la cola con el tiempo: el registro permanente es el comprobante en Xubio.

---

## Notas de crédito

Cómo funcionan y en qué orden usarlas está en la [guía funcional](funcional.md#notas-de-crédito).

### Emitir una nota de crédito

```
POST /internal/tlqv-invoice/facturas/nota-credito
```

Anula la factura vigente del TLQV, copiando sus conceptos tal como se facturaron.

**Body**

| Campo | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `tlqvCode` | string | Sí | Venta cuya factura se anula. |
| `dryRun` | boolean | No | Por defecto `true`. |
| `issueDate` | string | No | Fecha de la nota de crédito. Por defecto, hoy. |

**Ejemplo — primero en modo prueba**

```bash
curl -s -X POST "$INVOICE_API_URL/internal/tlqv-invoice/facturas/nota-credito" \
  -H "x-internal-api-key: $INVOICE_INTERNAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"tlqvCode":"TLQV-19989","dryRun":true}'
```

**Respuesta**

```json
{
  "status": "skipped",
  "tlqvCode": "TLQV-19989",
  "dryRun": true,
  "cancelledInvoice": {
    "xubioTransactionId": 77777299,
    "numeroDocumento": "B-00008-00003981",
    "letra": "B",
    "importeTotal": 910628.23
  },
  "notaCredito": {
    "type": "NotaCredito",
    "letter": "B",
    "customerId": 10503039,
    "issueDate": "2026-10-06",
    "pointOfSaleId": 216731,
    "relatedDocument": { "id": 77777299 },
    "items": [
      { "productId": 2461025, "description": "Pagos por cuenta y orden", "quantity": 1, "unitPrice": 210498.55 }
    ]
  },
  "blockers": []
}
```

| `status` | Significado |
|---|---|
| `created` | Se emitió en Xubio. |
| `skipped` | No se emitió: era modo prueba, o la factura ya estaba anulada (en ese caso `blockers` trae `ALREADY_CANCELLED`). |
| `blocked` | No se pudo armar. Ver `blockers`. |

Cuando se emite, la respuesta agrega `createdNotaCredito` y `caeStatus`:

```json
"caeStatus": { "cae": null, "fiscalmenteEmitido": false, "pendiente": true }
```

`pendiente: true` significa que la nota existe en Xubio pero todavía no tiene CAE. Hay que pedirlo: en Xubio, o con el [pedido de CAE](#cae).

**Antes de emitir**, conviene revisar en la respuesta de prueba que `cancelledInvoice` sea la factura correcta y que la suma de los `items` dé el `importeTotal`.

---

### Emitir notas de crédito en lote

```
POST /internal/tlqv-invoice/facturas/bulk/nota-credito
```

Encola una nota de crédito por TLQV. Se procesan de a una, y **cada una se intenta una sola vez**: no hay reintentos automáticos sobre un documento fiscal.

**Body**

| Campo | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `tlqvCodes` | string[] | Sí | Ventas cuyas facturas se anulan. |
| `dryRun` | boolean | No | Por defecto `true`. |
| `issueDate` | string | No | Fecha común a todas. |

```bash
curl -s -X POST "$INVOICE_API_URL/internal/tlqv-invoice/facturas/bulk/nota-credito" \
  -H "x-internal-api-key: $INVOICE_INTERNAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"tlqvCodes":["TLQV-18997","TLQV-18966"],"dryRun":false}'
```

Devuelve `status: "queued"` y un `batchId`, con el mismo formato que el [lote de facturas](#emitir-facturas-en-lote). Las notas que quedan bloqueadas se guardan como [issues](#issues).

---

### Últimos lotes de notas de crédito

```
GET /internal/tlqv-invoice/facturas/bulk/nota-credito?limit=20
```

Resumen de las corridas recientes, de la más nueva a la más vieja. Sirve para que el panel muestre qué se corrió sin que nadie haya anotado el `batchId`.

```json
{
  "queueName": "tlqv-invoice-nota-credito-bulk",
  "total": 1,
  "batches": [
    {
      "batchId": "...",
      "requestedAt": "2026-09-17T14:02:11.000Z",
      "dryRun": false,
      "total": 23,
      "created": 23,
      "skipped": 0,
      "blocked": 0,
      "failed": 0,
      "pending": 0
    }
  ]
}
```

Lee lo que sigue en la cola, que se va limpiando. El historial permanente de las notas emitidas está en Madre.

---

### Estado de un lote de notas de crédito

```
GET /internal/tlqv-invoice/facturas/bulk/nota-credito/:batchId
```

Mismo formato que el [estado de un lote de facturas](#estado-de-un-lote-de-facturas). Cada elemento de `jobs` trae además:

| Campo | Significado |
|---|---|
| `blockerCodes` | Motivos, si quedó bloqueada o salteada. |
| `notaCreditoNumeroDocumento` | Número de la nota emitida. |
| `notaCreditoCae` | El CAE, si ya lo tiene. |
| `fiscalmenteEmitido` | `false` mientras falte el CAE. |
| `failedReason` | Detalle del error, si falló. |

---

## Clientes

Normalmente no hace falta llamarlos: la emisión de facturas ya busca o crea al cliente. Sirven para preparar un cliente por adelantado o para resolver un caso puntual.

### Crear el cliente de un TLQV

```
POST /internal/tlqv-invoice/clientes/create-from-tlqv
```

Corre solo la etapa de cliente: valida que la venta no esté facturada y esté en un estado facturable, busca los datos del pedido, consulta AFIP/ARCA y crea al cliente en Xubio si no existe.

| Campo | Tipo | Obligatorio |
|---|---|---|
| `tlqvCode` | string | Sí |

```bash
curl -s -X POST "$INVOICE_API_URL/internal/tlqv-invoice/clientes/create-from-tlqv" \
  -H "x-internal-api-key: $INVOICE_INTERNAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"tlqvCode":"TLQV-14921"}'
```

```json
{
  "status": "created",
  "canContinue": true,
  "tlqvCode": "TLQV-14921",
  "documentoTipo": "CUIT",
  "fiscalInfo": {
    "razonSocial": "ARTURO GUTIERREZ",
    "condicionImpositiva": "MONOTRIBUTO",
    "provincia": "BUENOS AIRES"
  },
  "xubioClienteResult": { "status": "created", "created": true }
}
```

| `status` | Significado |
|---|---|
| `created` | Se creó el cliente en Xubio. |
| `already_exists` | Ya existía; se usa esa ficha. |
| `invalid_fiscal_document` | AFIP no reconoció el CUIT y no se pudo cargar como consumidor final. Queda un issue. |
| `blocked` | No se pudo continuar. Ver `blockers`. |

---

### Crear un consumidor final desde un issue

```
POST /internal/tlqv-invoice/clientes/create-consumidor-final-from-issue
```

Para una venta que quedó con un issue `INVALID_FISCAL_DOCUMENT`: crea al comprador en Xubio como Consumidor Final, identificado por DNI.

| Campo | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `tlqvCode` | string | Sí | |
| `issueId` | number | No | Si no se envía, usa el issue abierto del TLQV. |
| `dni` | string | No | Si no se envía, intenta derivarlo del documento guardado en el issue. |

```bash
curl -s -X POST "$INVOICE_API_URL/internal/tlqv-invoice/clientes/create-consumidor-final-from-issue" \
  -H "x-internal-api-key: $INVOICE_INTERNAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"tlqvCode":"TLQV-7734","dni":"44482399"}'
```

> Usarlo solo para personas físicas. Una empresa no puede ser consumidor final.

---

### Crear un cliente con datos fiscales

```
POST /internal/xubio/clientes
```

Crea un cliente en Xubio directamente, cuando ya se tienen sus datos. No consulta AFIP ni valida nada del TLQV.

| Campo | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `cuit` | string | Sí | |
| `razonSocial` | string | Sí | |
| `condicionImpositiva` | string | Sí | Ej: `MONOTRIBUTO`, `RESPONSABLE INSCRIPTO`. |
| `categoriaFiscalCodigo` | string | No | `MT`, `RI`, `CF` o `EX`. Si no se envía, se deduce de `condicionImpositiva`. |
| `documentoTipo` | string | No | `CUIT` (por defecto) o `CUIL`. |
| `nombre`, `primerNombre`, `primerApellido` | string | No | |
| `direccion`, `codigoPostal`, `provincia` | string | No | |
| `descripcion` | string | No | |
| `tlqvCode` | string | No | Para asociar el cliente a una venta en los registros. |

```json
{
  "status": "created",
  "created": true,
  "cliente": { "clienteId": 10256469, "nombre": "ARTURO GUTIERREZ", "razonSocial": "ARTURO GUTIERREZ", "cuit": "20-42433388-4" }
}
```

---

## Consulta fiscal

### Condición fiscal en AFIP/ARCA

```
POST /internal/tus-facturas/afip-info
```

Consulta la razón social y la condición fiscal de un CUIT, a través de TusFacturas.

| Campo | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `documentoNro` | string | Sí | El CUIT, con o sin guiones. |
| `cuit` | string | No | Alias de `documentoNro`. |
| `documentoTipo` | string | No | Por defecto `CUIT`. La consulta de AFIP no responde a `CUIL`. |
| `tlqvCode` | string | No | Si se envía y el documento es inválido, deja un issue asociado a esa venta. |

```bash
curl -s -X POST "$INVOICE_API_URL/internal/tus-facturas/afip-info" \
  -H "x-internal-api-key: $INVOICE_INTERNAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"documentoNro":"20-42433388-4"}'
```

```json
{
  "status": "found",
  "found": true,
  "afipInfo": {
    "documentoNro": "20-42433388-4",
    "documentoTipo": "CUIT",
    "razonSocial": "ARTURO GUTIERREZ",
    "condicionImpositiva": "MONOTRIBUTO",
    "direccion": "OBLIGADO 3645",
    "provincia": "BUENOS AIRES",
    "estado": "ACTIVO"
  }
}
```

Si AFIP no reconoce el documento, responde `status: "invalid_document"`. Si AFIP/ARCA está caído, el endpoint responde con error `500` en lugar de dar el documento por inválido: "no lo encontré" y "no pude preguntar" no son lo mismo.

---

## Comprobantes

### Validar un TLQV antes de facturar

```
POST /internal/xubio/comprobantes/tlqv-invoice/prepare
```

Responde si la venta ya tiene una factura vigente. Es el mismo control de duplicados que usa la emisión.

| Campo | Tipo | Obligatorio |
|---|---|---|
| `tlqvCode` | string | Sí |

```json
{
  "status": "READY",
  "canContinue": true,
  "tlqvCode": "TLQV-7734",
  "isBilled": false,
  "billingValidationAvailable": true,
  "blockers": []
}
```

| `status` | Significado |
|---|---|
| `READY` | No tiene factura vigente; se puede facturar. |
| `BLOCKED` | Ya está facturada (`ALREADY_BILLED`), o no se pudo consultar Madre (`BILLING_VALIDATION_UNAVAILABLE`). |

---

### Backfill de comprobantes (en cola)

```
POST /internal/xubio/comprobantes/backfill
```

Copia a Madre los comprobantes de venta de Xubio de un rango de fechas. Responde enseguida y procesa en segundo plano.

> **No hace falta correrlo a mano en el día a día**: ya corre solo cada 2 horas sobre los últimos 7 días. Sirve para recargar un período viejo.

| Campo | Tipo | Por defecto | Descripción |
|---|---|---|---|
| `fechaDesde` | string | `2025-01-01` | Inicio del rango, inclusive. |
| `fechaHasta` | string | hoy | Fin del rango, inclusive. |
| `batchSize` | number | 10 | Comprobantes por tanda de guardado. |
| `windowSizeDays` | number | 1 | Días por ventana de consulta a Xubio. |
| `xubioLimit` | number | 100 | Comprobantes por página. No superar 100: valores mayores vuelven inestable el paginado de Xubio. |

```bash
curl -s -X POST "$INVOICE_API_URL/internal/xubio/comprobantes/backfill" \
  -H "x-internal-api-key: $INVOICE_INTERNAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"fechaDesde":"2026-09-01","fechaHasta":"2026-09-30"}'
```

```json
{
  "syncRunId": 23,
  "jobId": "sync-run-23",
  "queueName": "xubio-comprobantes-backfill",
  "status": "queued",
  "fechaDesde": "2026-09-01",
  "fechaHasta": "2026-09-30",
  "batchSize": 10,
  "windowSizeDays": 1,
  "xubioLimit": 100
}
```

El avance se sigue en Bull Board o en los logs del servicio.

---

### Backfill de comprobantes (inmediato)

```
POST /internal/xubio/comprobantes/backfill/run-now
```

Igual que el anterior, pero corre dentro de la llamada y devuelve el resultado final. Usarlo solo para rangos cortos; uno largo termina en timeout.

```json
{
  "syncRunId": 534,
  "status": "completed",
  "totalListed": 168,
  "totalDetailRequests": 168,
  "totalInserted": 0,
  "totalUpdated": 168,
  "totalFailed": 0
}
```

`totalInserted` son comprobantes que Madre no tenía; `totalUpdated`, los que ya tenía y se refrescaron.

---

## Issues

### Listar issues

```
GET /internal/tlqv-invoice/issues
```

Ventas que no se pudieron facturar, con su motivo.

| Parámetro | Descripción |
|---|---|
| `status` | `open`, `resolved` o `ignored`. |
| `reason` | Uno de los motivos listados en la [guía funcional](funcional.md#registro-de-problemas). |
| `limit` | Cantidad máxima. |

```bash
curl -s "$INVOICE_API_URL/internal/tlqv-invoice/issues?status=open&limit=50" \
  -H "x-internal-api-key: $INVOICE_INTERNAL_API_KEY"
```

```json
{
  "items": [
    {
      "id": 196,
      "tlqvCode": "TLQV-22209",
      "reason": "TLQV_INVOICE_FLOW_BLOCKED",
      "source": "invoice_api",
      "status": "open",
      "message": "invoice_creation | INVOICE_TOTAL_SALE_PRICE_MISMATCH: El total calculado de la factura...",
      "occurrenceCount": 2,
      "lastSeenAt": "2026-11-24T19:44:51.000Z"
    }
  ]
}
```

El `message` tiene el formato `etapa | CÓDIGO: explicación`. El campo `metadata` guarda la respuesta completa del flujo, incluidos los conceptos que se habían armado.

---

### Issues de un TLQV

```
GET /internal/tlqv-invoice/issues/:tlqvCode
```

Todos los issues de una venta.

```bash
curl -s "$INVOICE_API_URL/internal/tlqv-invoice/issues/TLQV-22209" \
  -H "x-internal-api-key: $INVOICE_INTERNAL_API_KEY"
```

---

## Estado del servicio

### Health check

```
GET /
```

No requiere clave. Responde `Hello World!` si el servicio está arriba.
