# Arquitectura y configuración

Cómo está armado el código, con qué servicios habla y cómo se configura.

← [Volver al inicio](../README.md)

**Contenido**

1. [Capas del código](#capas-del-código)
2. [Dónde está cada cosa](#dónde-está-cada-cosa)
3. [Integraciones](#integraciones)
4. [Colas](#colas)
5. [Reintentos](#reintentos)
6. [Variables de entorno](#variables-de-entorno)
7. [Tests](#tests)
8. [Limitaciones conocidas](#limitaciones-conocidas)

---

## Capas del código

NestJS 11 con arquitectura hexagonal. La lógica de facturación no depende del framework ni de HTTP: vive en `src/core` y se prueba con mocks simples.

```
src/
├── core/                    Lógica de negocio, sin NestJS
│   ├── entities/            Tipos de dominio (factura, cliente, filas de planilla…)
│   ├── adapters/            Interfaces de lo que el negocio necesita de afuera
│   ├── driver/repository/   Implementaciones HTTP de esas interfaces
│   └── interactors/         Casos de uso
└── app/                     Todo lo que es NestJS
    ├── controllers/         Endpoints: validan la entrada y delegan
    ├── services/            Envuelven interactors; dueños de las colas
    ├── modules/             Módulos y providers: acá se cablea todo
    ├── guards/              Clave interna
    └── drivers/             Redis y utilidades de cola
```

La dirección de las dependencias es siempre hacia adentro: `app` conoce a `core`, nunca al revés. Un interactor recibe sus repositorios por constructor, como interfaces.

**Regla práctica:** si un cambio es sobre *qué* se factura o *cuándo* se bloquea, va en `core/interactors`. Si es sobre *cómo* se habla con un servicio externo, en `core/driver/repository`. Si es sobre endpoints, colas o configuración, en `app`.

---

## Dónde está cada cosa

| Necesito cambiar… | Archivo |
|---|---|
| Conceptos de la factura, IDs de Xubio, columnas de la planilla | `core/interactors/tlqv-invoice/facturas/BuildXubioInvoiceFromTlqvInteractor.ts` |
| Orden del flujo, controles previos, control del total | `core/interactors/tlqv-invoice/facturas/CreateTlqvInvoiceFlowInteractor.ts` |
| Facturación desde la orden de Mercado Libre | `core/interactors/tlqv-invoice/facturas/CreateMeliOrderInvoiceFlowInteractor.ts` |
| Envío de la factura a Mercado Libre | `core/interactors/tlqv-invoice/facturas/SendInvoiceToMeliInteractor.ts` |
| Regla de factura A o B | `core/interactors/xubio/facturas/ResolveXubioInvoiceLetterInteractor.ts` |
| Búsqueda y alta de clientes, estados facturables | `core/interactors/tlqv-invoice/clientes/CreateXubioClienteFromTlqvInteractor.ts` |
| Control de duplicados | `core/interactors/tlqv-invoice/preparacion/PrepareTlqvInvoiceInteractor.ts` |
| Pedido de CAE | `core/interactors/tlqv-invoice/facturas/RequestCaeInteractor.ts` |
| Entrega en el día: factura + CAE + envío | `core/interactors/tlqv-invoice/facturas/CompleteMeliOrderSaleInteractor.ts` |
| Copia inmediata de un comprobante a Madre | `core/interactors/xubio/comprobantes/SyncXubioComprobanteToMadreInteractor.ts` |
| Notas de crédito | `core/interactors/tlqv-invoice/facturas/CreateNotaCreditoFromTlqvInteractor.ts` |
| Backfill de comprobantes | `core/interactors/xubio/comprobantes/BackfillXubioComprobantesInteractor.ts` |
| Lo que se envía a Xubio al facturar | `core/driver/repository/xubio/facturas/CreateInvoiceRepository.ts` |
| Reintentos contra Xubio | `core/driver/repository/xubio/XubioRequestRetry.ts` |
| Reintentos contra la planilla | `core/driver/repository/spreadsheet-api/SpreadsheetApiRequestRetry.ts` |
| Lote de facturas, bloqueos que se reintentan | `app/services/tlqv-invoice-facturas-bulk-queue.service.ts` |
| Lote de notas de crédito | `app/services/tlqv-invoice-nota-credito-bulk-queue.service.ts` |
| Lote de pedidos de CAE | `app/services/tlqv-invoice-cae-bulk-queue.service.ts` |
| Lote de entrega en el día | `app/services/tlqv-invoice-entrega-en-el-dia-bulk-queue.service.ts` |
| Backfill programado | `app/services/xubio-comprobantes-backfill-queue.service.ts` |
| Swagger, Bull Board, puerto | `main.ts` |
| Sitio de documentación: páginas publicadas y menú | `app/drivers/docs/docs-site.router.ts` |

---

## Integraciones

| Servicio | Para qué | Qué se llama |
|---|---|---|
| **Xubio** | Sistema de facturación | `POST /API/1.1/TokenEndpoint` · `POST /API/1.1/facturar` · `GET/POST /API/1.1/clienteBean` · `GET/DELETE /API/1.1/comprobanteVentaBean` · `GET /API/1.1/imprimirPDF` |
| **TusFacturas** | Consulta fiscal en AFIP/ARCA | `POST /app/api/v2/clientes/afip-info` |
| **Madre API** | Copia de comprobantes e issues | `/api/internal/xubio/comprobantes` · `/api/internal/invoice/client-issues` |
| **Ops API** | Datos del pedido | `GET /api/order-details?tlqtNumber=` |
| **Flokzu** | Respaldo de los datos del pedido | Instancias de proceso |
| **mercadolibre-api** | Detalle de la orden de Mercado Libre, y subida de la factura a la venta | `GET /meli/orders/{id}` · `GET/POST /meli/orders/{id}/invoice` |
| **Spreadsheet API** | Planilla de importes | `GET /sheet/{planilla}/TLQV/{tlqv}` · `GET /sheet/{planilla}/MADRE/{tlqv}` · `GET /sheet/stock-bue/{tlqv}` · `GET /sheet/costos-operaciones/{tlqv}` |
| **Redis** | Colas | BullMQ |

### Notas por integración

**Xubio.** Autenticación OAuth `client_credentials`. El token se guarda en memoria y se renueva un minuto antes de vencer; ante un `401` se descarta y se pide uno nuevo. La letra del comprobante **no se envía**: Xubio la decide según la categoría fiscal del cliente. Una nota de crédito se asocia a su factura con `comprobante` = ID de transacción de la factura y `comprobanteAsociado` = 1.

**Xubio — PDF de un comprobante.** Son dos pasos: `imprimirPDF` devuelve un link (`urlPdf`) y ese link entrega el archivo. El link **no pide autenticación**: cualquiera que lo tenga descarga la factura, así que no hay que exponerlo fuera del servidor. El repositorio solo sigue links que apunten a Xubio y verifica que lo descargado sea realmente un PDF, porque ante algunos errores Xubio responde `200` con una página HTML.

**TusFacturas.** Devuelve `200` con `error: "S"` tanto para un CUIT inexistente como para una caída de ARCA. El repositorio distingue los dos casos por el texto del mensaje y, si es una caída, lanza `TusFacturasAfipInfoUnavailableError` en lugar de devolver "documento inválido". La consulta se hace siempre con `documento_tipo: CUIT`.

**Madre API.** Para los comprobantes sincronizados desde Xubio devuelve `productItems` vacío; los conceptos están en `rawDetailPayload.transaccionProductoItems`. Las notas de crédito leen de ahí, y toman el nombre del concepto de `producto.nombre` porque `descripcion` viene vacía.

**mercadolibre-api.** Es un servicio interno, no la API de Mercado Libre directa: junta en una respuesta lo que Mercado Libre reparte en cinco consultas. Usa su propia clave en `x-internal-api-key`. El proceso de entrega en el día reutiliza el paso de cliente del proceso habitual: le pasa los datos de facturación de Mercado Libre como si fueran el pedido, con origen `mercadolibre`, que es lo que hace que no se aplique la regla de estados facturables.

**Spreadsheet API.** Lee una hoja de Google en vivo, así que es lenta y cada tanto no responde. No soporta bien consultas en paralelo. Los nombres de columna se usan tal cual vienen en el encabezado. Cada proceso controla el importe contra una solapa distinta: el habitual contra `Precio final` de la solapa TLQV, y el de entrega en el día contra `Precio de venta` de costos-operaciones.

**Ops API.** Las ventas web traen los datos del comprador con el rótulo adelante (`"nombre : Juan"`); el repositorio lo limpia.

---

## Colas

Cinco colas BullMQ sobre Redis, visibles en Bull Board (`/admin/queues`).

| Cola | Qué procesa | Concurrencia | Intentos |
|---|---|---|---|
| `tlqv-invoice-facturas-bulk` | Una factura por trabajo | 1 | 3, con 30 s entre intentos |
| `tlqv-invoice-nota-credito-bulk` | Una nota de crédito por trabajo | 1 | 1 |
| `tlqv-invoice-cae-bulk` | Un pedido de CAE por trabajo | 1, fija | 1, fijo |
| `tlqv-invoice-entrega-en-el-dia-bulk` | Una venta por trabajo: factura, CAE y envío a Mercado Libre | 1, fija | 1, fijo |
| `xubio-comprobantes-backfill` | Sincronización Xubio → Madre | 1 | 3, con 30 s entre intentos |

- **La concurrencia en 1 es deliberada.** Xubio numera los comprobantes en orden; emitir en paralelo arriesga rechazos por secuencia de fechas.
- **Las notas de crédito no se reintentan**: cada trabajo escribe un documento fiscal.
- **Los pedidos de CAE van en orden y de a uno.** AFIP autoriza cada numeración en orden, así que el lote se encola por ID de comprobante ascendente. La concurrencia y los intentos de esta cola no se configuran: dos trabajos a la vez, o un reintento demorado, romperían ese orden.
- **El lote de entrega en el día encadena tres casos de uso que ya existen** (`CreateMeliOrderInvoiceFlowInteractor`, `RequestCaeInteractor`, `SendInvoiceToMeliInteractor`), sin lógica propia de facturación. Antes de emitir busca en Madre una factura vigente de la venta y, si la hay, sigue con esa: es lo que permite reenviar una venta que quedó a mitad de camino.
- **El ID de cada trabajo es determinístico** (`lote:TLQV`), así que reenviar un lote no encola dos veces la misma venta.
- **El backfill programado** se registra al arrancar el servicio con `upsertJobScheduler`. Vive en Redis, de modo que varias instancias acuerdan una sola corrida. Si `XUBIO_COMPROBANTES_BACKFILL_CRON_ENABLED` es `false`, el arranque lo elimina de Redis.

Cada trabajo de facturas bloqueado, y cada falla definitiva, se guarda como issue en Madre.

### Copia inmediata a Madre

El backfill corre cada 2 horas, y el control de duplicados lee Madre. Para que no quede una ventana en la que una factura recién emitida es invisible, todo lo que escribe en Xubio copia el comprobante a Madre enseguida (`SyncXubioComprobanteToMadreInteractor`): lee el detalle en Xubio y hace el mismo `upsert` que el backfill, sin corrida asociada.

| Qué | Dónde se dispara |
|---|---|
| Factura nueva (planilla o entrega en el día), nota de crédito nueva, CAE otorgado | `TlqvInvoiceFacturasService`, después del caso de uso. Lo usan los endpoints de a uno y las colas. |
| Lote de entrega en el día | `CompleteMeliOrderSaleInteractor`: una vez al emitir, antes de pedir el CAE, y otra al obtenerlo. |

**Lo eliminado en Xubio.** Madre no tiene baja de comprobantes. `XubioVerifiedMadreComprobantesRepository` envuelve al repositorio de Madre y, en `findFullByTlqvCode`, saca los comprobantes sin CAE que Xubio informa como inexistentes (`XubioComprobanteNotFoundError`, que se reconoce por el texto "La Factura de Venta no existe"). Todo lo que decide sobre los comprobantes de un TLQV —control de duplicados, notas de crédito, envío a Mercado Libre, lote de entrega en el día— pasa por ahí. El registro queda en Madre; solo se ignora.

Nunca hace fallar la operación: el comprobante ya existe en Xubio. El resultado va en `madreSync` (`synced` o `failed`) y una falla queda en el log. El backfill sigue siendo la red de seguridad.

---

## Reintentos

La regla general: **se reintenta lo que solo lee; no se reintenta lo que pudo haber escrito un comprobante.**

| Operación | Reintenta ante | No reintenta ante |
|---|---|---|
| Lecturas de Xubio | Sin respuesta, `408`, `429`, `5xx`. `401/403` renovando el token | Otros `4xx` |
| **`POST /facturar`** | Solo `429` y `401/403` | **Sin respuesta, `408`, `5xx`** |
| **`POST /solicitarCAE`** | Solo `429` y `401/403` | **Sin respuesta, `408`, `5xx`**. Después de pedir, siempre se vuelve a leer el comprobante: eso define el resultado. |
| Subida de la factura a Mercado Libre | Nada: no se reintenta sola | Todo. Pero repetirla a mano es seguro: antes de subir se consulta si la venta ya tiene factura. |
| Planilla | Sin respuesta, `408`, `429`, `5xx` | `404` (la fila no existe) |
| TusFacturas | `408`, `429`, `5xx` | Respuestas con `error: "S"` |

### Por qué `facturar` es distinto

Si Xubio no contesta, no hay forma de saber si la factura se creó. Repetir el envío puede dejar dos facturas con CAE para la misma venta. Por eso ese caso corta con `XUBIO_INVOICE_OUTCOME_UNKNOWN` y queda para revisión manual. Este comportamiento está fijo en `CreateInvoiceRepository` (`retryOnIndeterminateOutcome: false`) y no se puede cambiar por configuración.

El `429` sí se reintenta: es el único rechazo en el que Xubio no llegó a procesar nada.

---

## Variables de entorno

El servicio lee `.env` del directorio desde el que arranca. La plantilla está en `.env.example`.

### Servicio

| Variable | Por defecto | Descripción |
|---|---|---|
| `PORT` | `3000` | |
| `HOST` | `0.0.0.0` | |
| `INVOICE_INTERNAL_API_KEY` | — **obligatoria** | Clave del header `x-internal-api-key`. |
| `SWAGGER_ENABLED` | `true` | |
| `SWAGGER_PATH` | `/api/docs` | |
| `BULL_BOARD_ENABLED` | `true` | |
| `BULL_BOARD_BASE_PATH` | `/admin/queues` | |
| `DOCS_SITE_ENABLED` | `true` | Publica esta documentación como sitio. |
| `DOCS_SITE_PATH` | `/docs` | |
| `DOCS_SITE_USER` · `DOCS_SITE_PASSWORD` | — | Si están las dos, el sitio pide usuario y clave y publica todas las páginas. Sin ellas queda abierto y no publica la de operación. |

### Xubio

| Variable | Por defecto | Descripción |
|---|---|---|
| `XUBIO_BASE_URL` | `https://xubio.com` | |
| `XUBIO_BASIC_AUTHORIZATION` | — **obligatoria** | `client_id:secret_id` en base64. |
| `XUBIO_INVOICE_TIMEOUT_MS` | `30000` | Espera máxima al emitir. |
| `XUBIO_CAE_TIMEOUT_MS` | `60000` | Espera máxima al pedir un CAE. Xubio mantiene el pedido abierto mientras AFIP contesta. |
| `XUBIO_REQUEST_RETRY_ATTEMPTS` | `6` | |
| `XUBIO_REQUEST_RETRY_INITIAL_DELAY_MS` | `2000` | Se duplica en cada intento. |
| `XUBIO_REQUEST_RETRY_MAX_DELAY_MS` | `30000` | |
| `XUBIO_COMPROBANTES_LIST_LIMIT` | `100` | Comprobantes por página. No superar 100. |
| `XUBIO_COMPROBANTES_DETAIL_REQUEST_DELAY_MS` | `250` | Pausa entre consultas de detalle. |

### Backfill programado

| Variable | Por defecto | Descripción |
|---|---|---|
| `XUBIO_COMPROBANTES_BACKFILL_CRON_ENABLED` | `true` | En `false`, elimina la programación. |
| `XUBIO_COMPROBANTES_BACKFILL_CRON` | `0 */2 * * *` | Cada 2 horas. |
| `XUBIO_COMPROBANTES_BACKFILL_CRON_TZ` | `America/Argentina/Buenos_Aires` | |
| `XUBIO_COMPROBANTES_BACKFILL_CRON_LOOKBACK_DAYS` | `7` | Días hacia atrás que relee cada corrida. |

### Madre, Ops, TusFacturas, Flokzu, Mercado Libre

| Variable | Por defecto | Descripción |
|---|---|---|
| `MADRE_API_BASE_URL` | — **obligatoria** | |
| `MADRE_INTERNAL_API_KEY` | — **obligatoria** | |
| `MADRE_API_TIMEOUT_MS` | `20000` | |
| `OPS_API_BASE_URL` | `https://ops.api.loquieroaca.com` | |
| `OPS_API_TIMEOUT_MS` | `20000` | |
| `TUS_FACTURAS_BASE_URL` | `https://www.tusfacturas.app` | |
| `TUS_FACTURAS_USER_TOKEN` · `TUS_FACTURAS_API_KEY` · `TUS_FACTURAS_API_TOKEN` | — **obligatorias** | |
| `TUS_FACTURAS_COOKIE` | — | Opcional. |
| `FLOKZU_BASE_URL` · `FLOKZU_API_KEY` · `FLOKZU_USERNAME` | — | Respaldo de los datos del pedido. |
| `MELI_API_BASE_URL` | `https://api.meli.loquieroaca.com` | |
| `MELI_API_INTERNAL_API_KEY` | — | Clave de mercadolibre-api. **Obligatoria para facturar ventas con entrega en el día**; sin ella ese endpoint bloquea. |
| `MELI_API_TIMEOUT_MS` | `30000` | |
| `MELI_API_UPLOAD_TIMEOUT_MS` | `60000` | Espera máxima al consultar o subir la factura a Mercado Libre. |

### Planilla

| Variable | Por defecto | Descripción |
|---|---|---|
| `SPREADSHEET_API_BASE_URL` | `https://spreadsheet.loquieroaca.com` | |
| `SPREADSHEET_API_INVOICE_SPREADSHEET_NAME` | `prueba-lectura` | Planilla de donde se leen las solapas TLQV y MADRE. |
| `SPREADSHEET_API_TIMEOUT_MS` | `10000` | Se recomienda `30000`. |
| `SPREADSHEET_API_RETRY_ATTEMPTS` | `3` | |
| `SPREADSHEET_API_RETRY_INITIAL_DELAY_MS` | `500` | Se duplica en cada intento. |

### Redis

| Variable | Por defecto | Descripción |
|---|---|---|
| `REDIS_URL` | — | Si está, tiene prioridad sobre host y puerto. |
| `REDIS_HOST` · `REDIS_PORT` · `REDIS_DB` | `127.0.0.1` · `6379` · `0` | |
| `REDIS_USERNAME` · `REDIS_PASSWORD` | — | |
| `REDIS_TLS` | `false` | |
| `REDIS_CONNECT_TIMEOUT_MS` | `10000` | |
| `REDIS_KEEP_ALIVE_MS` | `30000` | |
| `REDIS_RETRY_MAX_DELAY_MS` | `2000` | |

### Variables de las colas

Cada cola acepta el mismo juego de variables, con su prefijo:

| Prefijo | Cola |
|---|---|
| `TLQV_INVOICE_FACTURAS_BULK_QUEUE_` | Lote de facturas |
| `TLQV_INVOICE_NOTA_CREDITO_BULK_QUEUE_` | Lote de notas de crédito |
| `XUBIO_COMPROBANTES_QUEUE_` | Backfill |

| Sufijo | Descripción |
|---|---|
| `CONCURRENCY` | Trabajos en simultáneo. Por defecto `1`. |
| `ATTEMPTS` | Intentos por trabajo. `3` en facturas y backfill, `1` en notas de crédito. |
| `RETRY_DELAY_MS` | Espera entre intentos. Por defecto `30000`. |
| `REMOVE_COMPLETE_COUNT` · `REMOVE_FAIL_COUNT` | Cuántos trabajos terminados conserva la cola. |
| `READY_TIMEOUT_MS` | Espera máxima a que Redis esté disponible al encolar. Por defecto `10000`. |

Las colas de pedidos de CAE (`tlqv-invoice-cae-bulk`) y de entrega en el día (`tlqv-invoice-entrega-en-el-dia-bulk`) no tienen variables: su configuración es fija.

---

## Tests

```bash
npm test             # 30 suites, 247 tests
npx tsc --noEmit
npm run lint
```

Los tests están junto al código (`*.spec.ts`) y cubren sobre todo `src/core`: interactors y repositorios. Usan mocks de los repositorios; no llaman a ningún servicio real.

Varios llevan el código de la venta real que originó el caso (`TLQV-22280`, `TLQV-19989`…), con los importes tal como estaban en la planilla. Son la documentación más precisa de por qué existe cada regla: antes de cambiar una, conviene leer su test.

**Convención:** todo arreglo de un problema de producción entra con un test que reproduce el caso.

---

## Limitaciones conocidas

**La fecha "de hoy" se calcula en UTC.** Cuando no se envía `issueDate`, el servicio usa la fecha UTC. Entre las 21:00 y las 23:59 de Argentina eso ya es el día siguiente. Hasta que se corrija, conviene enviar `issueDate` explícita al facturar de noche.

**Errores de negocio de Xubio con código `401`.** Xubio a veces responde `401` para errores que no son de autenticación —por ejemplo, el de secuencia de fechas—. El servicio los trata primero como un token vencido: renueva el token y reintenta antes de informar el error real. El resultado final es correcto, pero tarda más.

**Una venta cancelada puede dejar un cliente creado.** El control de `Precio final` vacío corre en la etapa de factura, después de la de cliente. Si alguien intenta facturar una venta cancelada, la factura se bloquea pero la ficha del cliente puede haberse creado.

**`src/app` casi no tiene tests.** La cobertura está en `src/core`. Controllers, services y colas se verifican a mano.

**`CONTEXTO_COMPLETO_INVOICE_API.txt` está desactualizado.** Es un relevamiento de agosto de 2026, anterior a varios cambios de fondo. Ante una diferencia, vale esta documentación y, por encima de todo, el código.
