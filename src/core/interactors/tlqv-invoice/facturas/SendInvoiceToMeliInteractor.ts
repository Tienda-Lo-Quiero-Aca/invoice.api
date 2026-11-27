import type { IMadreXubioComprobantesRepository } from '../../../adapters/repositories/madre-api/xubio/comprobantes/IMadreXubioComprobantesRepository';
import type { IMeliOrderInvoiceRepository } from '../../../adapters/repositories/mercadolibre-api/orders/IMeliOrderInvoiceRepository';
import type { IGetTlqvOrderDetailsRepository } from '../../../adapters/repositories/tlqv/order-details/IGetTlqvOrderDetailsRepository';
import type { IGetComprobanteDetailRepository } from '../../../adapters/repositories/xubio/comprobantes/IGetComprobanteDetailRepository';
import type {
  IGetXubioInvoicePdfRepository,
  XubioInvoicePdf,
} from '../../../adapters/repositories/xubio/facturas/IGetXubioInvoicePdfRepository';
import type { MadreXubioComprobante } from '../../../entities/madre-api/xubio/comprobantes/MadreXubioComprobante';
import type {
  MeliOrderInvoiceStatus,
  UploadMeliOrderInvoiceResponse,
} from '../../../entities/mercadolibre/orders/MeliOrderInvoice';
import type { GetTlqvOrderDetailsResponse } from '../../../entities/tlqv/order-details/TlqvOrderDetails';
import { normalizeRequiredTlqvCode } from './CreateTlqvInvoiceFlowInteractor';
import { selectLiveInvoices } from './selectLiveInvoices';

// What mercadolibre-api accepts per file.
const MAX_PDF_SIZE_IN_BYTES = 10 * 1024 * 1024;

export type SendInvoiceToMeliStatus = 'sent' | 'ready' | 'skipped' | 'blocked';

export type SendInvoiceToMeliBlockerCode =
  | 'COMPROBANTES_LOOKUP_FAILED'
  | 'NO_LIVE_INVOICE'
  | 'XUBIO_COMPROBANTE_LOOKUP_FAILED'
  | 'INVOICE_WITHOUT_CAE'
  | 'COMPROBANTE_NOT_AN_INVOICE'
  | 'COMPROBANTE_TLQV_MISMATCH'
  | 'ORDER_DETAILS_LOOKUP_FAILED'
  | 'ORDER_DETAILS_NOT_FOUND'
  | 'MELI_ORDER_NOT_LINKED'
  | 'MELI_INVOICE_STATUS_LOOKUP_FAILED'
  | 'MELI_INVOICE_ALREADY_SENT'
  | 'INVOICE_PDF_UNAVAILABLE'
  | 'INVOICE_PDF_TOO_LARGE'
  | 'MELI_INVOICE_UPLOAD_FAILED';

export interface SendInvoiceToMeliBlocker {
  code: SendInvoiceToMeliBlockerCode;
  message: string;
}

export interface SendInvoiceToMeliCommand {
  tlqvCode: string;
  /**
   * The factura to send, by its Xubio ID, instead of looking for the one that
   * stands in Madre. For a factura issued moments ago, which Madre does not
   * know yet. It still has to be a factura of this TLQV.
   */
  transaccionId?: number;
  /** Defaults to true: everything is checked and nothing is uploaded. */
  dryRun?: boolean;
  /**
   * Upload even though Mercado Libre already holds a factura for the sale —
   * the new factura after a nota de crédito.
   */
  force?: boolean;
}

export interface SendInvoiceToMeliResponse {
  /**
   * `sent`: uploaded. `ready`: dry run, it would be uploaded. `skipped`:
   * Mercado Libre already has a factura. `blocked`: it cannot be sent.
   */
  status: SendInvoiceToMeliStatus;
  tlqvCode: string;
  dryRun: boolean;
  invoice?: {
    xubioTransactionId: number;
    numeroDocumento: string | null;
    cae: string;
    fechaEmision: string | null;
    importeTotal: number | null;
  };
  meliOrderId?: string;
  /** Where Mercado Libre keeps the factura: the cart, or the sale itself. */
  meliPackId?: string | null;
  pdf?: { fileName: string; sizeInBytes: number };
  /** Mercado Libre's own answer to the upload, kept as it came. */
  meliResponse?: unknown;
  blockers: SendInvoiceToMeliBlocker[];
}

/**
 * Takes the factura of a TLQV from Xubio and attaches it to its Mercado Libre
 * sale, where the buyer sees it.
 *
 * The buyer does see it, and there is no way to take it back, so every check
 * runs before the upload and any doubt stops the run:
 *
 * - Only a factura that still stands is sent, never one a nota de crédito
 *   cancelled.
 * - Only with a CAE, and the CAE is read from Xubio at that moment: it is
 *   requested by hand, and Madre's copy can be hours behind.
 * - Not twice. Mercado Libre is asked first whether the sale already has a
 *   factura, which is also what makes a second run after a failure safe.
 */
export class SendInvoiceToMeliInteractor {
  constructor(
    private readonly madreXubioComprobantesRepository: IMadreXubioComprobantesRepository,
    private readonly comprobanteDetailRepository: IGetComprobanteDetailRepository,
    private readonly opsOrderDetailsRepository: IGetTlqvOrderDetailsRepository,
    private readonly invoicePdfRepository: IGetXubioInvoicePdfRepository,
    private readonly meliOrderInvoiceRepository: IMeliOrderInvoiceRepository,
  ) {}

  async execute(
    command: SendInvoiceToMeliCommand,
  ): Promise<SendInvoiceToMeliResponse> {
    const tlqvCode = normalizeRequiredTlqvCode(command.tlqvCode);
    const dryRun = command.dryRun ?? true;
    const force = command.force ?? false;
    const base = { tlqvCode, dryRun };
    const block = (
      code: SendInvoiceToMeliBlockerCode,
      message: string,
      extra: Partial<SendInvoiceToMeliResponse> = {},
    ): SendInvoiceToMeliResponse => ({
      ...base,
      ...extra,
      status: 'blocked',
      blockers: [{ code, message }],
    });

    // 1. The factura: the one named, or the one that stands for this TLQV.
    let factura: FacturaToSend;
    if (command.transaccionId !== undefined) {
      factura = { xubioTransactionId: command.transaccionId };
    } else {
      let comprobantes: MadreXubioComprobante[];
      try {
        comprobantes = (
          await this.madreXubioComprobantesRepository.findFullByTlqvCode({
            tlqvCode,
          })
        ).items;
      } catch (error: unknown) {
        return block(
          'COMPROBANTES_LOOKUP_FAILED',
          `No se pudieron leer los comprobantes de ${tlqvCode} en Madre. ${readErrorMessage(error)}`,
        );
      }

      const { facturas, live } = selectLiveInvoices(comprobantes);
      if (live.length === 0) {
        return block(
          'NO_LIVE_INVOICE',
          facturas.length === 0
            ? `${tlqvCode} no tiene facturas en Madre. Si se emitió hace poco, puede que todavía no se haya sincronizado.`
            : `Todas las facturas de ${tlqvCode} están anuladas por nota de crédito. No hay una factura vigente para enviar.`,
        );
      }
      factura = live[0];
    }

    // 2. Its CAE, asked to Xubio now.
    let cae: string | null;
    try {
      const { comprobante } = await this.comprobanteDetailRepository.getDetail({
        transaccionId: factura.xubioTransactionId,
      });
      cae = normalizeOptionalString(comprobante.cae ?? comprobante.CAE);

      if (command.transaccionId !== undefined) {
        // Named by ID, nothing vouched for it yet: the buyer must never get a
        // nota de crédito, nor the factura of somebody else's sale.
        factura = {
          xubioTransactionId: factura.xubioTransactionId,
          numeroDocumento: normalizeOptionalString(comprobante.numeroDocumento),
          fechaEmision: normalizeOptionalString(comprobante.fecha) ?? undefined,
          importeTotal:
            typeof comprobante.importetotal === 'number'
              ? comprobante.importetotal
              : null,
        };

        if (comprobante.tipo !== XUBIO_INVOICE_TYPE) {
          return block(
            'COMPROBANTE_NOT_AN_INVOICE',
            `El comprobante ${describeFactura(factura)} no es una factura. No se envía.`,
          );
        }
        if (!mentionsTlqv(comprobante.descripcion, tlqvCode)) {
          return block(
            'COMPROBANTE_TLQV_MISMATCH',
            `El comprobante ${describeFactura(factura)} no corresponde a ${tlqvCode} según su descripción en Xubio. No se envía.`,
          );
        }
      }
    } catch (error: unknown) {
      return block(
        'XUBIO_COMPROBANTE_LOOKUP_FAILED',
        `No se pudo consultar en Xubio la factura ${describeFactura(factura)}. ${readErrorMessage(error)}`,
      );
    }

    if (cae === null) {
      return block(
        'INVOICE_WITHOUT_CAE',
        `La factura ${describeFactura(factura)} de ${tlqvCode} todavía no tiene CAE. Pedí el CAE y reintentá: sin CAE la factura no es válida para el cliente.`,
      );
    }

    const invoice = {
      xubioTransactionId: factura.xubioTransactionId,
      numeroDocumento: factura.numeroDocumento ?? null,
      cae,
      fechaEmision: factura.fechaEmision ?? null,
      importeTotal: factura.importeTotal ?? null,
    };

    // 3. The Mercado Libre sale it belongs to.
    let opsResponse: GetTlqvOrderDetailsResponse;
    try {
      opsResponse = await this.opsOrderDetailsRepository.getByTlqvCode({
        tlqvCode,
      });
    } catch (error: unknown) {
      return block(
        'ORDER_DETAILS_LOOKUP_FAILED',
        `No se pudo consultar ${tlqvCode} en Ops API. ${readErrorMessage(error)}`,
        { invoice },
      );
    }

    if (!opsResponse.found) {
      return block(
        'ORDER_DETAILS_NOT_FOUND',
        `${tlqvCode} no existe en Ops API.`,
        { invoice },
      );
    }

    // A pack has several sales; any of them leads mercadolibre-api to the cart.
    const meliOrderId = opsResponse.orderDetails.meliOrderIds?.[0];
    if (meliOrderId === undefined) {
      return block(
        'MELI_ORDER_NOT_LINKED',
        `${tlqvCode} no tiene una orden de Mercado Libre asociada en Ops API; no hay adónde enviar la factura.`,
        { invoice },
      );
    }

    // 4. Whether Mercado Libre already has one.
    let meliStatus: MeliOrderInvoiceStatus;
    try {
      meliStatus = await this.meliOrderInvoiceRepository.getStatus({
        orderId: meliOrderId,
      });
    } catch (error: unknown) {
      return block(
        'MELI_INVOICE_STATUS_LOOKUP_FAILED',
        `No se pudo consultar en Mercado Libre si la orden ${meliOrderId} ya tiene factura. ${readErrorMessage(error)}`,
        { invoice, meliOrderId },
      );
    }

    const found = { invoice, meliOrderId, meliPackId: meliStatus.packId };
    if (meliStatus.hasInvoice && !force) {
      return {
        ...base,
        ...found,
        status: 'skipped',
        meliResponse: meliStatus.documents,
        blockers: [
          {
            code: 'MELI_INVOICE_ALREADY_SENT',
            message: `La orden ${meliOrderId} de ${tlqvCode} ya tiene una factura cargada en Mercado Libre. No se envía otra. Si esta es una factura nueva (después de una nota de crédito), reenviá con force=true.`,
          },
        ],
      };
    }

    // 5. The file.
    let pdf: XubioInvoicePdf;
    try {
      pdf = await this.invoicePdfRepository.getPdf({
        transaccionId: factura.xubioTransactionId,
      });
    } catch (error: unknown) {
      return block(
        'INVOICE_PDF_UNAVAILABLE',
        `No se pudo descargar de Xubio el PDF de la factura ${describeFactura(factura)}. ${readErrorMessage(error)}`,
        found,
      );
    }

    const pdfSummary = {
      fileName: buildFileName(factura),
      sizeInBytes: pdf.sizeInBytes,
    };
    if (pdf.sizeInBytes > MAX_PDF_SIZE_IN_BYTES) {
      return block(
        'INVOICE_PDF_TOO_LARGE',
        `El PDF de la factura ${describeFactura(factura)} pesa ${pdf.sizeInBytes} bytes y supera el máximo de ${MAX_PDF_SIZE_IN_BYTES} que acepta Mercado Libre.`,
        { ...found, pdf: pdfSummary },
      );
    }

    if (dryRun) {
      return {
        ...base,
        ...found,
        status: 'ready',
        pdf: pdfSummary,
        blockers: [],
      };
    }

    // 6. The upload.
    let uploaded: UploadMeliOrderInvoiceResponse;
    try {
      uploaded = await this.meliOrderInvoiceRepository.upload({
        orderId: meliOrderId,
        pdf: pdf.content,
        fileName: pdfSummary.fileName,
        force,
      });
    } catch (error: unknown) {
      return block(
        'MELI_INVOICE_UPLOAD_FAILED',
        `Mercado Libre no aceptó la factura ${describeFactura(factura)} para la orden ${meliOrderId}. ${readErrorMessage(error)} Se puede reintentar: si la subida llegó a hacerse, el reintento lo detecta y no la duplica.`,
        { ...found, pdf: pdfSummary },
      );
    }

    if (uploaded.status === 'already_has_invoice') {
      return {
        ...base,
        ...found,
        status: 'skipped',
        pdf: pdfSummary,
        meliResponse: uploaded.rawPayload,
        blockers: [
          {
            code: 'MELI_INVOICE_ALREADY_SENT',
            message: `La orden ${meliOrderId} de ${tlqvCode} ya tenía una factura cargada en Mercado Libre. No se envió otra.`,
          },
        ],
      };
    }

    return {
      ...base,
      ...found,
      status: 'sent',
      meliPackId: uploaded.packId ?? meliStatus.packId,
      pdf: pdfSummary,
      meliResponse: uploaded.rawPayload,
      blockers: [],
    };
  }
}

/** Xubio's `tipo` for a factura; 3 is a nota de crédito. */
const XUBIO_INVOICE_TYPE = 1;

/** What is needed of a factura, wherever it was read from. */
type FacturaToSend = Pick<MadreXubioComprobante, 'xubioTransactionId'> &
  Partial<
    Pick<
      MadreXubioComprobante,
      'numeroDocumento' | 'fechaEmision' | 'importeTotal'
    >
  >;

/** "TLQV-123" must not match the description of TLQV-1234. */
function mentionsTlqv(
  descripcion: string | null | undefined,
  tlqvCode: string,
): boolean {
  const number = /(\d+)$/.exec(tlqvCode)?.[1];
  if (number === undefined) {
    return false;
  }

  return new RegExp(`\\bTLQV\\s*-?\\s*0*${Number(number)}\\b`, 'i').test(
    descripcion ?? '',
  );
}

function describeFactura(factura: FacturaToSend): string {
  return factura.numeroDocumento ?? String(factura.xubioTransactionId);
}

/** The comprobante number makes the file recognisable for whoever opens it. */
function buildFileName(factura: FacturaToSend): string {
  const number = (factura.numeroDocumento ?? '').replace(/[^A-Za-z0-9-]/g, '');

  return number === ''
    ? `factura-${factura.xubioTransactionId}.pdf`
    : `${number}.pdf`;
}

function normalizeOptionalString(
  value: string | null | undefined,
): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Error desconocido.';
}
