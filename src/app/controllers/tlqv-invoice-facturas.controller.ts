import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Query,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import {
  TLQV_INVOICE_FLOW_STOP_AFTER_VALUES,
  type TlqvInvoiceFlowStopAfter,
} from '../../core/interactors/tlqv-invoice/facturas/CreateTlqvInvoiceFlowInteractor';
import { InternalApiKeyGuard } from '../guards/internal-api-key.guard';
import { ApiInternalEndpoint } from '../modules/shared/swagger/internal-api-docs.decorators';
import { TlqvInvoiceCaeBulkQueueService } from '../services/tlqv-invoice-cae-bulk-queue.service';
import { TlqvInvoiceEntregaEnElDiaBulkQueueService } from '../services/tlqv-invoice-entrega-en-el-dia-bulk-queue.service';
import { TlqvInvoiceFacturasBulkQueueService } from '../services/tlqv-invoice-facturas-bulk-queue.service';
import { TlqvInvoiceNotaCreditoBulkQueueService } from '../services/tlqv-invoice-nota-credito-bulk-queue.service';
import { TlqvInvoiceFacturasService } from '../services/tlqv-invoice-facturas.service';

@ApiTags('TLQV Invoice - Facturas')
@Controller('internal/tlqv-invoice/facturas')
@UseGuards(InternalApiKeyGuard)
export class TlqvInvoiceFacturasController {
  constructor(
    private readonly tlqvInvoiceFacturasService: TlqvInvoiceFacturasService,
    private readonly tlqvInvoiceFacturasBulkQueueService: TlqvInvoiceFacturasBulkQueueService,
    private readonly tlqvInvoiceNotaCreditoBulkQueueService: TlqvInvoiceNotaCreditoBulkQueueService,
    private readonly tlqvInvoiceCaeBulkQueueService: TlqvInvoiceCaeBulkQueueService,
    private readonly tlqvInvoiceEntregaEnElDiaBulkQueueService: TlqvInvoiceEntregaEnElDiaBulkQueueService,
  ) {}

  @ApiInternalEndpoint()
  @ApiOperation({
    summary: 'Crear factura Xubio desde un TLQV',
    description:
      'Interactor padre del flujo de facturación. Valida el TLQV, crea/valida cliente Xubio, obtiene la data fuente desde las solapas TLQV y MADRE, arma el payload y emite la factura cuando dryRun=false.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['tlqvCode'],
      properties: {
        tlqvCode: {
          type: 'string',
          example: 'TLQV-1569',
        },
        stopAfter: {
          type: 'string',
          enum: [...TLQV_INVOICE_FLOW_STOP_AFTER_VALUES],
          default: 'source_data',
          description: 'Permite cortar el flujo para debuggear paso por paso.',
        },
        dryRun: {
          type: 'boolean',
          default: true,
          description:
            'Cuando es true, nunca emite la factura aunque stopAfter sea invoice_creation.',
        },
        issueDate: {
          type: 'string',
          example: '2026-07-25',
          description:
            'Fecha de emisión en formato YYYY-MM-DD. Opcional. Permite hasta 10 días hacia atrás desde la fecha actual.',
        },
        fechaFactura: {
          type: 'string',
          example: '2026-07-25',
          description:
            'Alias operativo de issueDate. No enviar ambos con valores diferentes.',
        },
      },
      example: {
        tlqvCode: 'TLQV-1569',
        stopAfter: 'source_data',
        dryRun: true,
      },
    },
  })
  @ApiOkResponse({
    description: 'Flujo completado hasta la etapa solicitada o bloqueado.',
    schema: {
      example: {
        status: 'completed',
        canContinue: true,
        tlqvCode: 'TLQV-1569',
        stopAfter: 'source_data',
        dryRun: true,
        steps: [
          {
            name: 'client',
            status: 'completed',
            message: 'Cliente creado en Xubio.',
          },
          {
            name: 'source_data',
            status: 'completed',
            message: 'Datos obtenidos desde solapas TLQV y MADRE.',
          },
        ],
        xubioClienteId: 10270718,
        nextStep: 'invoice_creation',
      },
    },
  })
  @Post('create-from-tlqv')
  createFromTlqv(
    @Body()
    body: {
      tlqvCode?: string;
      stopAfter?: string;
      dryRun?: boolean;
      issueDate?: string;
      fechaFactura?: string;
    } = {},
  ) {
    return this.tlqvInvoiceFacturasService.createFromTlqv({
      tlqvCode: readRequiredBodyString(body.tlqvCode, 'tlqvCode'),
      stopAfter: readOptionalStopAfter(body.stopAfter),
      dryRun: readOptionalBoolean(body.dryRun, 'dryRun'),
      issueDate: readOptionalIssueDate(body.issueDate, body.fechaFactura),
    });
  }

  @ApiInternalEndpoint()
  @ApiOperation({
    summary: 'Crear factura Xubio desde la orden de Mercado Libre de un TLQV',
    description: [
      'Para ventas que se entregan en el día y no tienen fila en la planilla.',
      'Busca en Ops API la orden de Mercado Libre del TLQV, toma de ahí el',
      'importe (sin envío) y los datos de facturación del comprador, y emite',
      'una factura con un solo concepto, "Producto". Factura B: importe final.',
      'Factura A: importe neto, y Xubio suma el 21%. dryRun=true (por defecto)',
      'arma la factura y la devuelve sin emitirla.',
    ].join(' '),
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['tlqvCode'],
      properties: {
        tlqvCode: { type: 'string', example: 'TLQV-23500' },
        dryRun: {
          type: 'boolean',
          default: true,
          description: 'Para emitir la factura real enviar false.',
        },
        issueDate: {
          type: 'string',
          example: '2026-11-27',
          description:
            'Fecha de emisión YYYY-MM-DD. Opcional. Hasta 10 días hacia atrás.',
        },
        fechaFactura: {
          type: 'string',
          example: '2026-11-27',
          description: 'Alias de issueDate.',
        },
      },
      example: { tlqvCode: 'TLQV-23500', dryRun: true },
    },
  })
  @ApiOkResponse({
    description: 'Factura armada, emitida o bloqueada.',
    schema: {
      example: {
        status: 'completed',
        canContinue: true,
        tlqvCode: 'TLQV-23500',
        dryRun: true,
        steps: [
          { name: 'meli_order', status: 'completed' },
          { name: 'client', status: 'completed' },
          { name: 'invoice_creation', status: 'skipped' },
        ],
        xubioClienteId: 10503039,
        invoiceBuild: {
          invoiceLetter: { letter: 'B', matchedRule: 'CONSUMIDOR_FINAL' },
          meliOrderIds: ['2000019813708728'],
          totalAmount: 386749.16,
          amountSentToXubio: 386749.16,
        },
      },
    },
  })
  @Post('create-from-meli-order')
  createFromMeliOrder(
    @Body()
    body: {
      tlqvCode?: string;
      dryRun?: boolean;
      issueDate?: string;
      fechaFactura?: string;
    } = {},
  ) {
    return this.tlqvInvoiceFacturasService.createFromMeliOrder({
      tlqvCode: readRequiredBodyString(body.tlqvCode, 'tlqvCode'),
      dryRun: readOptionalBoolean(body.dryRun, 'dryRun'),
      issueDate: readOptionalIssueDate(body.issueDate, body.fechaFactura),
    });
  }

  @ApiInternalEndpoint()
  @ApiOperation({
    summary: 'Enviar la factura de un TLQV al comprador por Mercado Libre',
    description: [
      'Toma la factura vigente del TLQV, verifica en Xubio que ya tenga CAE,',
      'descarga su PDF y lo adjunta a la venta de Mercado Libre, donde lo ve',
      'el comprador. No envía una factura sin CAE ni una anulada por nota de',
      'crédito, y no la envía dos veces: si Mercado Libre ya tiene una, la',
      'saltea salvo que se indique force=true. dryRun=true (por defecto) hace',
      'todas las verificaciones y descarga el PDF, sin subirlo. La subida no',
      'se puede deshacer.',
    ].join(' '),
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['tlqvCode'],
      properties: {
        tlqvCode: { type: 'string', example: 'TLQV-19989' },
        dryRun: {
          type: 'boolean',
          default: true,
          description: 'Para subir la factura de verdad enviar false.',
        },
        force: {
          type: 'boolean',
          default: false,
          description:
            'Subir aunque la venta ya tenga una factura en Mercado Libre: la factura nueva después de una nota de crédito.',
        },
      },
      example: { tlqvCode: 'TLQV-19989', dryRun: true },
    },
  })
  @ApiOkResponse({
    description: 'Enviada, lista para enviar, salteada o bloqueada.',
    schema: {
      example: {
        status: 'ready',
        tlqvCode: 'TLQV-19989',
        dryRun: true,
        invoice: {
          xubioTransactionId: 77777299,
          numeroDocumento: 'B-00008-00003981',
          cae: '86395384692268',
          fechaEmision: '2026-09-30',
          importeTotal: 910628.23,
        },
        meliOrderId: '2000018498993478',
        meliPackId: '2000018498993478',
        pdf: { fileName: 'B-00008-00003981.pdf', sizeInBytes: 107461 },
        blockers: [],
      },
    },
  })
  @Post('send-to-meli')
  sendInvoiceToMeli(
    @Body()
    body: {
      tlqvCode?: string;
      dryRun?: boolean;
      force?: boolean;
    } = {},
  ) {
    return this.tlqvInvoiceFacturasService.sendInvoiceToMeli({
      tlqvCode: readRequiredBodyString(body.tlqvCode, 'tlqvCode'),
      dryRun: readOptionalBoolean(body.dryRun, 'dryRun'),
      force: readOptionalBoolean(body.force, 'force'),
    });
  }

  @ApiInternalEndpoint()
  @ApiOperation({
    summary: 'Emitir nota de crédito que anula la factura vigente de un TLQV',
    description: [
      'Lee la factura vigente del TLQV en Madre y emite una nota de crédito',
      'que la anula, copiando los conceptos tal como se facturaron.',
      'dryRun=true (por defecto) arma la nota de crédito y la devuelve sin',
      'emitirla. Si la factura ya tiene una nota de crédito asociada responde',
      'skipped y no emite otra: una nota de crédito duplicada lleva su propio',
      'CAE.',
    ].join(' '),
  })
  @ApiBody({
    required: true,
    schema: {
      type: 'object',
      properties: {
        tlqvCode: { type: 'string', example: 'TLQV-18997' },
        dryRun: { type: 'boolean', example: true },
        issueDate: { type: 'string', example: '2026-09-17' },
      },
      required: ['tlqvCode'],
    },
  })
  @Post('nota-credito')
  createNotaCredito(
    @Body()
    body: {
      tlqvCode?: string;
      dryRun?: boolean;
      issueDate?: string;
    } = {},
  ) {
    return this.tlqvInvoiceFacturasService.createNotaCreditoFromTlqv({
      tlqvCode: readRequiredBodyString(body.tlqvCode, 'tlqvCode'),
      dryRun: readOptionalBoolean(body.dryRun, 'dryRun'),
      issueDate: readOptionalIssueDate(body.issueDate, undefined),
    });
  }

  @ApiInternalEndpoint()
  @ApiOperation({
    summary: 'Emitir notas de crédito en bulk',
    description: [
      'Encola una nota de crédito por TLQV. dryRun=true (por defecto) arma',
      'cada una sin emitirla. Los TLQV cuya factura ya tiene nota de crédito',
      'se reportan como skipped. El avance se sigue por Bull Board o por',
      'GET bulk/nota-credito/:batchId.',
    ].join(' '),
  })
  @ApiBody({
    required: true,
    schema: {
      type: 'object',
      properties: {
        tlqvCodes: {
          type: 'array',
          items: { type: 'string' },
          example: ['TLQV-18997', 'TLQV-18966'],
        },
        dryRun: { type: 'boolean', example: true },
        issueDate: { type: 'string', example: '2026-09-17' },
      },
      required: ['tlqvCodes'],
    },
  })
  @Post('bulk/nota-credito')
  enqueueNotaCreditoBulk(
    @Body()
    body: {
      tlqvCodes?: unknown;
      dryRun?: boolean;
      issueDate?: string;
    } = {},
  ) {
    return this.tlqvInvoiceNotaCreditoBulkQueueService.enqueueBulk({
      tlqvCodes: readRequiredTlqvCodes(body.tlqvCodes),
      dryRun: readOptionalBoolean(body.dryRun, 'dryRun'),
      issueDate: readOptionalIssueDate(body.issueDate, undefined),
    });
  }

  @ApiInternalEndpoint()
  @ApiOperation({
    summary: 'Últimos batches de notas de crédito',
    description: [
      'Resumen de las corridas recientes, para el panel. Lee lo que sigue en',
      'la cola: el historial permanente de lo emitido está en Madre',
      '(documentKind=CREDIT_NOTE) y el de lo que falló, en los issues.',
    ].join(' '),
  })
  @Get('bulk/nota-credito')
  listNotaCreditoBatches(@Query('limit') limit?: string) {
    return this.tlqvInvoiceNotaCreditoBulkQueueService.listRecentBatches(
      limit === undefined
        ? undefined
        : readRequiredPositiveInteger(limit, 'limit'),
    );
  }

  @ApiInternalEndpoint()
  @ApiOperation({ summary: 'Estado de un batch de notas de crédito' })
  @Get('bulk/nota-credito/:batchId')
  getNotaCreditoBatchStatus(@Param('batchId') batchId: string) {
    return this.tlqvInvoiceNotaCreditoBulkQueueService.getBatchStatus(
      readRequiredBodyString(batchId, 'batchId'),
    );
  }

  @ApiInternalEndpoint()
  @ApiOperation({
    summary: 'Pedir el CAE de un comprobante',
    description: [
      'Le pide a AFIP, a través de Xubio, el CAE de una factura o de una nota',
      'de crédito. Se indica el TLQV (pide el de todos sus comprobantes que',
      'todavía no lo tengan, del más viejo al más nuevo) o el ID del',
      'comprobante en Xubio (transaccionId), uno de los dos. Un comprobante',
      'que ya tiene CAE se saltea. dryRun=true (por defecto) solo muestra qué',
      'pediría. Un CAE otorgado no se puede deshacer: el comprobante solo se',
      'anula con una nota de crédito.',
    ].join(' '),
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        tlqvCode: { type: 'string', example: 'TLQV-22281' },
        transaccionId: {
          type: 'integer',
          example: 79915082,
          description: 'ID del comprobante en Xubio. Alternativa a tlqvCode.',
        },
        dryRun: {
          type: 'boolean',
          default: true,
          description: 'Para pedir el CAE de verdad enviar false.',
        },
      },
      example: { tlqvCode: 'TLQV-22281', dryRun: true },
    },
  })
  @ApiOkResponse({
    description: 'CAE otorgado, listo para pedir, salteado o bloqueado.',
    schema: {
      example: {
        status: 'authorized',
        tlqvCode: 'TLQV-22281',
        dryRun: false,
        results: [
          {
            status: 'authorized',
            transaccionId: 79915082,
            dryRun: false,
            comprobante: {
              transaccionId: 79915082,
              numeroDocumento: 'A-00008-00004095',
              tipo: 1,
              fecha: '2026-11-26',
              importeTotal: 622999,
              cliente: 'CASA MAINI SRL',
              descripcion: 'TLQV-22281 ML: 2000019102174568',
              cae: '86484580124007',
              caeFechaVto: '2026-12-06',
            },
            blockers: [],
          },
        ],
        blockers: [],
      },
    },
  })
  @Post('cae')
  requestCae(
    @Body()
    body: {
      tlqvCode?: string;
      transaccionId?: unknown;
      dryRun?: boolean;
    } = {},
  ) {
    const tlqvCode = readOptionalBodyString(body.tlqvCode);
    const dryRun = readOptionalBoolean(body.dryRun, 'dryRun');

    if ((tlqvCode === undefined) === (body.transaccionId === undefined)) {
      throw new BadRequestException(
        'Send either tlqvCode or transaccionId, exactly one of them',
      );
    }

    if (tlqvCode !== undefined) {
      return this.tlqvInvoiceFacturasService.requestCaeForTlqv({
        tlqvCode,
        dryRun,
      });
    }

    return this.tlqvInvoiceFacturasService.requestCae({
      transaccionId: readPositiveIntegerValue(
        body.transaccionId,
        'transaccionId',
      ),
      dryRun,
    });
  }

  @ApiInternalEndpoint()
  @ApiOperation({
    summary: 'Pedir el CAE de varios comprobantes',
    description: [
      'Encola un pedido de CAE por comprobante. Acepta TLQVs (toma todos sus',
      'comprobantes), IDs de comprobante de Xubio, o las dos cosas. Se',
      'procesan de a uno y del más viejo al más nuevo, que es el orden en que',
      'AFIP autoriza cada numeración. Los que ya tienen CAE se saltean.',
      'dryRun=true (por defecto) no pide nada. El avance se sigue por Bull',
      'Board o por GET bulk/cae/:batchId.',
    ].join(' '),
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        tlqvCodes: {
          type: 'array',
          items: { type: 'string' },
          example: ['TLQV-22281', 'TLQV-22323'],
        },
        transaccionIds: {
          type: 'array',
          items: { type: 'integer' },
          example: [79915082],
        },
        dryRun: { type: 'boolean', default: true },
      },
      example: { tlqvCodes: ['TLQV-22281', 'TLQV-22323'], dryRun: true },
    },
  })
  @Post('bulk/cae')
  enqueueCaeBulk(
    @Body()
    body: {
      tlqvCodes?: unknown;
      transaccionIds?: unknown;
      dryRun?: boolean;
    } = {},
  ) {
    const tlqvCodes =
      body.tlqvCodes === undefined ? [] : readRequiredTlqvCodes(body.tlqvCodes);
    const transaccionIds =
      body.transaccionIds === undefined
        ? []
        : readPositiveIntegerList(body.transaccionIds, 'transaccionIds');

    if (tlqvCodes.length === 0 && transaccionIds.length === 0) {
      throw new BadRequestException(
        'Send tlqvCodes, transaccionIds, or both, with at least one item',
      );
    }

    return this.tlqvInvoiceCaeBulkQueueService.enqueueBulk({
      tlqvCodes,
      transaccionIds,
      dryRun: readOptionalBoolean(body.dryRun, 'dryRun'),
    });
  }

  @ApiInternalEndpoint()
  @ApiOperation({ summary: 'Estado de un batch de pedido de CAE' })
  @Get('bulk/cae/:batchId')
  getCaeBatchStatus(@Param('batchId') batchId: string) {
    return this.tlqvInvoiceCaeBulkQueueService.getBatchStatus(
      readRequiredBodyString(batchId, 'batchId'),
    );
  }

  @ApiInternalEndpoint()
  @ApiOperation({
    summary:
      'Entrega en el día en bulk: facturar, pedir el CAE y enviar a Mercado Libre',
    description: [
      'Para ventas con entrega en el día. Encola un trabajo por TLQV y los',
      'procesa de a uno. Cada trabajo emite la factura desde la orden de',
      'Mercado Libre, pide su CAE y adjunta el PDF a la venta. Si una etapa no',
      'puede seguir, se detiene ahí y lo ya hecho queda hecho. Volver a enviar',
      'la venta la retoma: no emite otra factura, no pide otro CAE y no manda',
      'la factura dos veces. dryRun=true (por defecto) no emite, no pide y no',
      'envía nada. El avance se sigue por Bull Board o por',
      'GET bulk/entrega-en-el-dia/:batchId.',
    ].join(' '),
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['tlqvCodes'],
      properties: {
        tlqvCodes: {
          type: 'array',
          minItems: 1,
          items: { type: 'string' },
          example: ['TLQV-23500', 'TLQV-23501'],
        },
        dryRun: {
          type: 'boolean',
          default: true,
          description:
            'Para facturar, pedir el CAE y enviar de verdad, mandar false.',
        },
        issueDate: {
          type: 'string',
          example: '2026-11-27',
          description:
            'Fecha de emisión YYYY-MM-DD, común a todas. Opcional. Hasta 10 días hacia atrás.',
        },
        fechaFactura: {
          type: 'string',
          example: '2026-11-27',
          description: 'Alias de issueDate.',
        },
      },
      example: { tlqvCodes: ['TLQV-23500', 'TLQV-23501'], dryRun: true },
    },
  })
  @Post('bulk/entrega-en-el-dia')
  enqueueEntregaEnElDiaBulk(
    @Body()
    body: {
      tlqvCodes?: unknown;
      dryRun?: boolean;
      issueDate?: string;
      fechaFactura?: string;
    } = {},
  ) {
    return this.tlqvInvoiceEntregaEnElDiaBulkQueueService.enqueueBulk({
      tlqvCodes: readRequiredTlqvCodes(body.tlqvCodes),
      dryRun: readOptionalBoolean(body.dryRun, 'dryRun'),
      issueDate: readOptionalIssueDate(body.issueDate, body.fechaFactura),
    });
  }

  @ApiInternalEndpoint()
  @ApiOperation({ summary: 'Estado de un batch de entrega en el día' })
  @Get('bulk/entrega-en-el-dia/:batchId')
  getEntregaEnElDiaBatchStatus(@Param('batchId') batchId: string) {
    return this.tlqvInvoiceEntregaEnElDiaBulkQueueService.getBatchStatus(
      readRequiredBodyString(batchId, 'batchId'),
    );
  }

  @ApiInternalEndpoint()
  @ApiOperation({
    summary: 'Crear facturas Xubio en bulk desde TLQVs',
    description:
      'Encola un job BullMQ por TLQV para crear facturas sin bloquear la respuesta HTTP. Cada job usa el mismo flujo individual create-from-tlqv, con stopAfter=invoice_creation y reintentos configurados en la cola.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['tlqvCodes'],
      properties: {
        tlqvCodes: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'string',
          },
          example: ['TLQV-15783', 'TLQV-15723'],
        },
        dryRun: {
          type: 'boolean',
          default: true,
          description:
            'Por seguridad default true. Para emitir facturas reales enviar false.',
        },
        issueDate: {
          type: 'string',
          example: '2026-08-01',
          description:
            'Fecha de emisión común para todas las facturas. Formato YYYY-MM-DD.',
        },
        fechaFactura: {
          type: 'string',
          example: '2026-08-01',
          description:
            'Alias operativo de issueDate. No enviar ambos con valores diferentes.',
        },
      },
      example: {
        tlqvCodes: ['TLQV-15783', 'TLQV-15723'],
        dryRun: false,
        issueDate: '2026-08-01',
      },
    },
  })
  @ApiOkResponse({
    description: 'Jobs encolados en BullMQ.',
    schema: {
      example: {
        status: 'queued',
        queueName: 'tlqv-invoice-facturas-bulk',
        jobName: 'create-from-tlqv',
        batchId: 'tlqv-invoice-bulk-2026-08-01T15-00-00-000Z-a1b2c3d4',
        totalRequested: 2,
        totalUnique: 2,
        totalDuplicated: 0,
        totalQueued: 2,
        issueDate: '2026-08-01',
        dryRun: false,
        attempts: 3,
        concurrency: 1,
        bullBoardPath: '/admin/queues',
        jobIdPattern:
          'tlqv-invoice:tlqv-invoice-bulk-2026-08-01T15-00-00-000Z-a1b2c3d4:TLQV-XXXX',
        sampleJobs: [
          {
            jobId:
              'tlqv-invoice:tlqv-invoice-bulk-2026-08-01T15-00-00-000Z-a1b2c3d4:TLQV-15783',
            tlqvCode: 'TLQV-15783',
          },
        ],
      },
    },
  })
  @Post('bulk/create-from-tlqv')
  bulkCreateFromTlqv(
    @Body()
    body: {
      tlqvCodes?: unknown;
      dryRun?: boolean;
      issueDate?: string;
      fechaFactura?: string;
    } = {},
  ) {
    return this.tlqvInvoiceFacturasBulkQueueService.enqueueBulk({
      tlqvCodes: readRequiredTlqvCodes(body.tlqvCodes),
      dryRun: readOptionalBoolean(body.dryRun, 'dryRun'),
      issueDate: readOptionalIssueDate(body.issueDate, body.fechaFactura),
    });
  }

  @ApiInternalEndpoint()
  @ApiOperation({
    summary: 'Consultar estado de un batch bulk',
    description:
      'Cuenta los jobs BullMQ del batch por estado (completed/failed/active/waiting/delayed/paused) y resume el resultado de cada TLQV (creado, bloqueado, saltado). Pensado para pollear desde un panel mientras se procesa un bulk/create-from-tlqv.',
  })
  @ApiParam({
    name: 'batchId',
    example: 'tlqv-invoice-bulk-2026-08-01T15-00-00-000Z-a1b2c3d4',
  })
  @ApiOkResponse({
    description: 'Estado agregado del batch y detalle por TLQV.',
    schema: {
      example: {
        batchId: 'tlqv-invoice-bulk-2026-08-01T15-00-00-000Z-a1b2c3d4',
        queueName: 'tlqv-invoice-facturas-bulk',
        found: true,
        totalJobs: 2,
        counts: {
          completed: 1,
          failed: 0,
          active: 0,
          waiting: 1,
          delayed: 0,
          paused: 0,
        },
        results: {
          created: 1,
          skipped: 0,
          blocked: 0,
          failed: 0,
          pending: 1,
        },
        jobs: [
          {
            jobId:
              'tlqv-invoice:tlqv-invoice-bulk-2026-08-01T15-00-00-000Z-a1b2c3d4:TLQV-15783',
            tlqvCode: 'TLQV-15783',
            state: 'completed',
            attemptsMade: 1,
            status: 'completed',
            created: true,
            skipped: false,
            transaccionId: 76318348,
            numeroDocumento: 'A-00008-00002667',
          },
        ],
      },
    },
  })
  @Get('bulk/:batchId')
  getBulkBatchStatus(@Param('batchId') batchId: string) {
    return this.tlqvInvoiceFacturasBulkQueueService.getBatchStatus(
      readRequiredBodyString(batchId, 'batchId'),
    );
  }

  @ApiInternalEndpoint()
  @ApiOperation({
    summary: 'Eliminar factura Xubio por transacción',
    description:
      'Elimina un comprobante de venta en Xubio usando el transaccionId devuelto por el endpoint de creación. Útil para pruebas controladas antes de pedir CAE.',
  })
  @ApiOkResponse({
    description: 'Factura eliminada en Xubio.',
    schema: {
      example: {
        transaccionId: 75226596,
        deleted: true,
      },
    },
  })
  @Delete(':transaccionId')
  deleteByTransaccionId(@Param('transaccionId') transaccionId: string) {
    return this.tlqvInvoiceFacturasService.deleteByTransaccionId({
      transaccionId: readRequiredPositiveInteger(
        transaccionId,
        'transaccionId',
      ),
    });
  }
}

function readRequiredBodyString(
  value: string | undefined,
  field: string,
): string {
  if (value === undefined || value.trim() === '') {
    throw new BadRequestException(`${field} is required`);
  }

  return value.trim();
}

function readRequiredTlqvCodes(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new BadRequestException('tlqvCodes must be a non-empty array');
  }

  if (value.length === 0) {
    throw new BadRequestException('tlqvCodes must contain at least one TLQV');
  }

  return value.map((item, index) => {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new BadRequestException(
        `tlqvCodes[${index}] must be a non-empty string`,
      );
    }

    return item.trim();
  });
}

function readOptionalStopAfter(
  value: string | undefined,
): TlqvInvoiceFlowStopAfter | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }

  const normalized = value.trim();
  if (
    !TLQV_INVOICE_FLOW_STOP_AFTER_VALUES.includes(
      normalized as TlqvInvoiceFlowStopAfter,
    )
  ) {
    throw new BadRequestException(
      `stopAfter must be one of: ${TLQV_INVOICE_FLOW_STOP_AFTER_VALUES.join(', ')}`,
    );
  }

  return normalized as TlqvInvoiceFlowStopAfter;
}

function readOptionalBoolean(
  value: boolean | undefined,
  field: string,
): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new BadRequestException(`${field} must be a boolean`);
  }

  return value;
}

function readOptionalIssueDate(
  issueDate: string | undefined,
  fechaFactura: string | undefined,
): string | undefined {
  const normalizedIssueDate = readOptionalBodyString(issueDate);
  const normalizedFechaFactura = readOptionalBodyString(fechaFactura);

  if (
    normalizedIssueDate !== undefined &&
    normalizedFechaFactura !== undefined &&
    normalizedIssueDate !== normalizedFechaFactura
  ) {
    throw new BadRequestException(
      'issueDate and fechaFactura cannot have different values',
    );
  }

  const value = normalizedIssueDate ?? normalizedFechaFactura;
  if (value === undefined) {
    return undefined;
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new BadRequestException('issueDate must have YYYY-MM-DD format');
  }

  return value;
}

function readOptionalBodyString(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }

  return value.trim();
}

function readPositiveIntegerValue(value: unknown, field: string): number {
  // A number, or digits in a string: panels send either. Nothing else, so a
  // comprobante is never picked by a value that had to be guessed.
  const numberValue =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value.trim())
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isSafeInteger(numberValue) || numberValue < 1) {
    throw new BadRequestException(`${field} must be a positive integer`);
  }

  return numberValue;
}

function readPositiveIntegerList(value: unknown, field: string): number[] {
  if (!Array.isArray(value)) {
    throw new BadRequestException(`${field} must be an array`);
  }

  return value.map((item, index) =>
    readPositiveIntegerValue(item, `${field}[${index}]`),
  );
}

function readRequiredPositiveInteger(value: string, field: string): number {
  const numberValue = Number(value.trim());
  if (!Number.isInteger(numberValue) || numberValue < 1) {
    throw new BadRequestException(`${field} must be a positive integer`);
  }

  return numberValue;
}
