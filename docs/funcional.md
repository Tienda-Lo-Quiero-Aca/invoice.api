# Guía funcional

Cómo factura el bot, explicado desde la facturación: qué necesita, qué controla, de dónde saca cada importe y en qué casos frena.

← [Volver al inicio](../README.md)

**Contenido**

1. [Qué necesita una venta para facturarse](#1-qué-necesita-una-venta-para-facturarse)
2. [El recorrido, paso a paso](#2-el-recorrido-paso-a-paso)
3. [Factura A o B](#3-factura-a-o-b)
4. [Conceptos de la factura](#4-conceptos-de-la-factura)
5. [Controles antes de emitir](#5-controles-antes-de-emitir)
6. [El CAE](#6-el-cae)
7. [Notas de crédito](#7-notas-de-crédito)
8. [Clientes](#8-clientes)
9. [Sincronización con Madre](#9-sincronización-con-madre)
10. [Registro de problemas](#10-registro-de-problemas)

---

## 1. Qué necesita una venta para facturarse

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

## 2. El recorrido, paso a paso

El flujo tiene tres etapas. Se puede cortar después de cualquiera con el parámetro `stopAfter`, para revisar antes de seguir.

### Etapa 1 — Cliente (`client`)

1. **¿Ya está facturada?** Consulta Madre. Si el TLQV tiene una factura vigente, frena. Una factura anulada por nota de crédito no cuenta como vigente, así que esa venta se puede volver a facturar.
2. **Datos del pedido.** Los pide a Ops API (con Flokzu como respaldo): comprador, CUIT, domicilio y estado.
3. **Estado.** Verifica que sea uno de los [estados facturables](#estados-facturables).
4. **Cliente en Xubio.** Busca si el comprador ya existe. Si no, consulta su condición fiscal en AFIP/ARCA y lo crea. Ver [Clientes](#8-clientes).

### Etapa 2 — Datos (`source_data`)

Lee la fila del TLQV en dos solapas de la planilla:

- **Solapa TLQV** — todos los importes de la factura y el `Precio final`.
- **Solapa MADRE** — el número de venta de Mercado Libre, que va en la descripción del comprobante.

### Etapa 3 — Factura (`invoice_creation`)

1. Aplica los [controles previos](#5-controles-antes-de-emitir).
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

## 3. Factura A o B

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

## 4. Conceptos de la factura

Cada concepto es un producto de Xubio. Todos se leen de la **solapa TLQV**. Si un concepto viene en cero o vacío, no se incluye en la factura (salvo los que son obligatorios — ver [controles](#5-controles-antes-de-emitir)).

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

## 5. Controles antes de emitir

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

## 6. El CAE

El bot **crea el comprobante en Xubio, pero no pide el CAE**. Ese paso se hace a mano en Xubio, tanto para facturas como para notas de crédito.

Mientras no tenga CAE, el comprobante existe en Xubio pero no para AFIP. Las respuestas de la API lo informan explícitamente (`caeStatus.pendiente: true`).

> **Importante:** no edites la ficha de un cliente en Xubio mientras tenga comprobantes sin CAE. Al pedir el CAE, AFIP valida los datos del cliente; si cambiaron, rechaza el comprobante.

---

## 7. Notas de crédito

Una nota de crédito anula una factura ya emitida. El bot:

1. Busca en Madre la **factura vigente** del TLQV (la más reciente que no esté anulada).
2. **Copia sus conceptos tal como se facturaron** — no los recalcula desde la planilla.
3. La emite con la misma letra, cliente y punto de venta, asociada a la factura original.

**Protecciones**

- Arranca en modo prueba (`dryRun: true`).
- Si la factura ya tiene una nota de crédito, responde `skipped` y no emite otra. Una nota de crédito duplicada lleva su propio CAE y habría que compensarla.
- En lote, cada nota se intenta una sola vez: no hay reintentos automáticos sobre un documento fiscal.

**Necesita Madre al día.** Lee la factura desde Madre, así que si se facturó hace minutos y el [backfill](#9-sincronización-con-madre) todavía no corrió, puede no encontrarla.

### Orden correcto para corregir una factura

Cuando hay que corregir una factura mal emitida (por ejemplo, salió B y debía ser A):

1. Emitir la **nota de crédito**.
2. Pedir el **CAE** de la nota de crédito, a mano en Xubio.
3. Recién entonces, **corregir la ficha del cliente** si hace falta.
4. Emitir la **factura nueva**.

Si se edita el cliente antes del paso 2, AFIP rechaza la nota de crédito.

---

## 8. Clientes

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

## 9. Sincronización con Madre

Madre guarda una copia de los comprobantes de venta de Xubio. De ahí salen dos cosas críticas:

- El **control de duplicados** — saber si un TLQV ya tiene factura.
- Las **notas de crédito** — leer la factura que hay que anular.

Si Madre se atrasa, el bot queda ciego: no puede distinguir una venta ya facturada de una nueva.

Por eso la copia se actualiza **sola cada 2 horas**, releyendo los últimos 7 días. Releer con superposición evita huecos si una corrida falla o si un comprobante se cargó tarde. También se puede disparar a mano desde la [API](api.md#comprobantes).

Si Madre no responde al momento de facturar, el bot **bloquea** en lugar de asumir que la venta no está facturada.

---

## 10. Registro de problemas

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
