import type { IMadreXubioComprobantesRepository } from '../../../adapters/repositories/madre-api/xubio/comprobantes/IMadreXubioComprobantesRepository';
import type {
  CreateMeliOrderInvoiceFlowCommand,
  CreateMeliOrderInvoiceFlowResponse,
} from './CreateMeliOrderInvoiceFlowInteractor';
import { normalizeRequiredTlqvCode } from './CreateTlqvInvoiceFlowInteractor';
import type { RequestCaeResponse } from './RequestCaeInteractor';
import type {
  SendInvoiceToMeliCommand,
  SendInvoiceToMeliResponse,
} from './SendInvoiceToMeliInteractor';
import { selectLiveInvoices } from './selectLiveInvoices';

export type CompleteMeliOrderSaleStage = 'invoice' | 'cae' | 'meli';

/**
 * `completed`: the sale has its factura, with CAE, in Mercado Libre.
 * `ready`: dry run, and this is what would be done. `blocked`: it stopped at
 * `stoppedAt`; what was done before that stays done.
 */
export type CompleteMeliOrderSaleStatus = 'completed' | 'ready' | 'blocked';

export interface CompleteMeliOrderSaleBlocker {
  stage: CompleteMeliOrderSaleStage;
  code: string;
  message: string;
}

export interface CompleteMeliOrderSaleCommand {
  tlqvCode: string;
  /** Defaults to true: nothing is issued, requested or uploaded. */
  dryRun?: boolean;
  issueDate?: string;
}

export interface CompleteMeliOrderSaleResponse {
  status: CompleteMeliOrderSaleStatus;
  tlqvCode: string;
  dryRun: boolean;
  stoppedAt?: CompleteMeliOrderSaleStage;
  invoice: {
    /**
     * `created`: issued now. `existing`: the sale already had one, and the run
     * went on with it. `ready`: dry run, it would be issued.
     */
    status: 'created' | 'existing' | 'ready' | 'blocked';
    transaccionId?: number;
    numeroDocumento?: string | null;
    totalAmount?: number;
  };
  cae: {
    /** `pending`: not reached, it comes after the stage before it. */
    status: 'authorized' | 'already_had' | 'ready' | 'pending' | 'blocked';
    cae?: string | null;
    caeFechaVto?: string | null;
  };
  meli: {
    status: 'sent' | 'already_sent' | 'ready' | 'pending' | 'blocked';
    meliOrderId?: string;
    meliPackId?: string | null;
  };
  /**
   * Whether the new factura was copied to Madre at once. `failed` does not
   * stop the run, but until the next backfill a second run for this sale would
   * not see the factura.
   */
  madreSync?: { status: 'synced' | 'failed'; message?: string };
  blockers: CompleteMeliOrderSaleBlocker[];
  /** The invoicing run as it answered, when it is what blocked. */
  invoiceFlow?: CreateMeliOrderInvoiceFlowResponse;
}

export interface ICreateMeliOrderInvoiceUseCase {
  execute(
    command: CreateMeliOrderInvoiceFlowCommand,
  ): Promise<CreateMeliOrderInvoiceFlowResponse>;
}

export interface IRequestCaeUseCase {
  execute(command: {
    transaccionId: number;
    dryRun?: boolean;
  }): Promise<RequestCaeResponse>;
}

export interface ISendInvoiceToMeliUseCase {
  execute(
    command: SendInvoiceToMeliCommand,
  ): Promise<SendInvoiceToMeliResponse>;
}

export interface ISyncComprobanteToMadreUseCase {
  execute(command: { transaccionId: number }): Promise<void>;
}

/**
 * Takes a sale delivered on the day all the way: issues its factura from the
 * Mercado Libre order, asks AFIP for the CAE and attaches the PDF to the sale
 * in Mercado Libre.
 *
 * Each stage is the same use case its own endpoint runs, with every check it
 * has; this only chains them and stops at the first one that cannot go on.
 *
 * It is made to be run again. Before issuing anything it looks for a factura
 * of the sale that still stands; a sale that stopped halfway has one, so the
 * second run does not issue another: it continues from there — the CAE is not requested twice and
 * Mercado Libre is not sent the same factura twice. For that to hold minutes
 * after a first run, the new factura is copied to Madre as soon as it exists,
 * instead of waiting for the backfill.
 */
export class CompleteMeliOrderSaleInteractor {
  constructor(
    private readonly createInvoiceUseCase: ICreateMeliOrderInvoiceUseCase,
    private readonly requestCaeUseCase: IRequestCaeUseCase,
    private readonly sendInvoiceToMeliUseCase: ISendInvoiceToMeliUseCase,
    private readonly syncComprobanteToMadreUseCase: ISyncComprobanteToMadreUseCase,
    private readonly madreXubioComprobantesRepository: IMadreXubioComprobantesRepository,
  ) {}

  async execute(
    command: CompleteMeliOrderSaleCommand,
  ): Promise<CompleteMeliOrderSaleResponse> {
    const tlqvCode = normalizeRequiredTlqvCode(command.tlqvCode);
    const dryRun = command.dryRun ?? true;
    const response: CompleteMeliOrderSaleResponse = {
      status: 'blocked',
      tlqvCode,
      dryRun,
      invoice: { status: 'blocked' },
      cae: { status: 'pending' },
      meli: { status: 'pending' },
      blockers: [],
    };
    const stopAt = (
      stage: CompleteMeliOrderSaleStage,
      blockers: { code: string; message: string }[],
    ): CompleteMeliOrderSaleResponse => {
      response.status = 'blocked';
      response.stoppedAt = stage;
      response[stage].status = 'blocked';
      response.blockers = blockers.map((blocker) => ({
        stage,
        code: blocker.code,
        message: blocker.message,
      }));
      return response;
    };

    // 1. The factura: the one the sale already has, or a new one.
    const standing = await this.findStandingInvoice(tlqvCode);
    if ('blocker' in standing) {
      // Without Madre there is no telling whether it was invoiced already.
      return stopAt('invoice', [standing.blocker]);
    }

    let transaccionId: number;
    if (standing.invoice !== null) {
      transaccionId = standing.invoice.transaccionId;
      response.invoice = { status: 'existing', ...standing.invoice };
    } else {
      const invoiceFlow = await this.createInvoiceUseCase.execute({
        tlqvCode,
        dryRun,
        issueDate: command.issueDate,
      });

      if (invoiceFlow.status === 'blocked') {
        response.invoiceFlow = invoiceFlow;
        return stopAt('invoice', invoiceFlow.blockers);
      }

      if (dryRun) {
        response.status = 'ready';
        response.invoice = {
          status: 'ready',
          totalAmount: invoiceFlow.invoiceBuild?.totalAmount,
        };
        return response;
      }

      const created = invoiceFlow.createdInvoice?.invoice;
      if (
        typeof created?.transaccionId !== 'number' ||
        created.transaccionId < 1
      ) {
        return stopAt('invoice', [
          {
            code: 'XUBIO_TRANSACCION_ID_MISSING',
            message: `Xubio emitió la factura de ${tlqvCode} pero no informó su ID. Buscala en Xubio y seguí con el pedido de CAE y el envío a Mercado Libre por separado.`,
          },
        ]);
      }

      transaccionId = created.transaccionId;
      response.invoice = {
        status: 'created',
        transaccionId,
        numeroDocumento: created.numeroDocumento ?? null,
        totalAmount:
          created.importeTotal ?? invoiceFlow.invoiceBuild?.totalAmount,
      };
      // Before anything else: from here on a second run has to find it.
      response.madreSync = await this.syncToMadre(transaccionId);
    }

    // 2. The CAE.
    const cae = await this.requestCaeUseCase.execute({ transaccionId, dryRun });
    response.invoice.numeroDocumento =
      cae.comprobante?.numeroDocumento ?? response.invoice.numeroDocumento;
    response.cae = {
      status: 'blocked',
      cae: cae.comprobante?.cae ?? null,
      caeFechaVto: cae.comprobante?.caeFechaVto ?? null,
    };

    if (cae.status === 'blocked') {
      return stopAt('cae', cae.blockers);
    }
    if (cae.status === 'ready') {
      // Dry run on a factura without CAE: Mercado Libre comes after it.
      response.cae.status = 'ready';
      response.status = 'ready';
      return response;
    }
    if (cae.status === 'authorized') {
      response.cae.status = 'authorized';
      // So Madre shows the CAE now, not at the next backfill.
      response.madreSync = await this.syncToMadre(transaccionId);
    } else {
      response.cae.status = 'already_had';
    }

    // 3. Mercado Libre.
    const sent = await this.sendInvoiceToMeliUseCase.execute({
      tlqvCode,
      transaccionId,
      dryRun,
    });
    response.meli = {
      status: 'blocked',
      meliOrderId: sent.meliOrderId,
      meliPackId: sent.meliPackId,
    };

    if (sent.status === 'blocked') {
      return stopAt('meli', sent.blockers);
    }
    if (sent.status === 'ready') {
      response.meli.status = 'ready';
      response.status = 'ready';
      return response;
    }

    response.meli.status = sent.status === 'sent' ? 'sent' : 'already_sent';
    response.status = 'completed';
    return response;
  }

  /** The factura of the sale that no nota de crédito cancelled, if any. */
  private async findStandingInvoice(tlqvCode: string): Promise<
    | {
        invoice: {
          transaccionId: number;
          numeroDocumento: string | null;
          totalAmount?: number;
        } | null;
      }
    | { blocker: { code: string; message: string } }
  > {
    try {
      const { items } =
        await this.madreXubioComprobantesRepository.findFullByTlqvCode({
          tlqvCode,
        });
      const [factura] = selectLiveInvoices(items).live;

      return {
        invoice:
          factura === undefined
            ? null
            : {
                transaccionId: factura.xubioTransactionId,
                numeroDocumento: factura.numeroDocumento ?? null,
                totalAmount: factura.importeTotal ?? undefined,
              },
      };
    } catch (error: unknown) {
      return {
        blocker: {
          code: 'COMPROBANTES_LOOKUP_FAILED',
          message: `No se pudieron leer los comprobantes de ${tlqvCode} en Madre, y sin eso no se sabe si ya tiene factura. ${readErrorMessage(error)}`,
        },
      };
    }
  }

  private async syncToMadre(
    transaccionId: number,
  ): Promise<{ status: 'synced' | 'failed'; message?: string }> {
    try {
      await this.syncComprobanteToMadreUseCase.execute({ transaccionId });
      return { status: 'synced' };
    } catch (error: unknown) {
      return {
        status: 'failed',
        message: `No se pudo copiar el comprobante ${transaccionId} a Madre. ${readErrorMessage(error)} Hasta la próxima sincronización, no vuelvas a correr esta venta: no vería la factura y emitiría otra.`,
      };
    }
  }
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Error desconocido.';
}
