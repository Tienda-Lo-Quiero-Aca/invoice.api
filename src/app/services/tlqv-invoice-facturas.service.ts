import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CreateTlqvInvoiceFlowInteractor,
  type CreateTlqvInvoiceFlowCommand,
  type CreateTlqvInvoiceFlowResponse,
} from '../../core/interactors/tlqv-invoice/facturas/CreateTlqvInvoiceFlowInteractor';
import {
  CompleteMeliOrderSaleInteractor,
  type CompleteMeliOrderSaleCommand,
  type CompleteMeliOrderSaleResponse,
} from '../../core/interactors/tlqv-invoice/facturas/CompleteMeliOrderSaleInteractor';
import {
  CreateMeliOrderInvoiceFlowInteractor,
  type CreateMeliOrderInvoiceFlowCommand,
  type CreateMeliOrderInvoiceFlowResponse,
} from '../../core/interactors/tlqv-invoice/facturas/CreateMeliOrderInvoiceFlowInteractor';
import {
  CreateNotaCreditoFromTlqvInteractor,
  type CreateNotaCreditoFromTlqvCommand,
  type CreateNotaCreditoFromTlqvResponse,
} from '../../core/interactors/tlqv-invoice/facturas/CreateNotaCreditoFromTlqvInteractor';
import {
  RequestCaeInteractor,
  type CaeBulkPlan,
  type RequestCaeForTlqvResponse,
  type RequestCaeResponse,
} from '../../core/interactors/tlqv-invoice/facturas/RequestCaeInteractor';
import {
  SendInvoiceToMeliInteractor,
  type SendInvoiceToMeliCommand,
  type SendInvoiceToMeliResponse,
} from '../../core/interactors/tlqv-invoice/facturas/SendInvoiceToMeliInteractor';
import { SyncXubioComprobanteToMadreInteractor } from '../../core/interactors/xubio/comprobantes/SyncXubioComprobanteToMadreInteractor';
import { DeleteXubioInvoiceInteractor } from '../../core/interactors/xubio/facturas/DeleteXubioInvoiceInteractor';
import type {
  DeleteXubioInvoiceCommand,
  DeleteXubioInvoiceResponse,
} from '../../core/entities/xubio/facturas/XubioInvoice';
import {
  COMPLETE_MELI_ORDER_SALE_INTERACTOR,
  CREATE_MELI_ORDER_INVOICE_FLOW_INTERACTOR,
  CREATE_NOTA_CREDITO_FROM_TLQV_INTERACTOR,
  CREATE_TLQV_INVOICE_FLOW_INTERACTOR,
  DELETE_XUBIO_INVOICE_INTERACTOR,
  REQUEST_CAE_INTERACTOR,
  SEND_INVOICE_TO_MELI_INTERACTOR,
  SYNC_XUBIO_COMPROBANTE_TO_MADRE_INTERACTOR,
} from '../modules/tlqv-invoice/facturas/tlqv-invoice-facturas.providers';
import { InvoiceClientIssueRecorderService } from './invoice-client-issue-recorder.service';

/**
 * Whether what was just written in Xubio — a new comprobante, or a CAE — was
 * copied to Madre at once. `failed` does not undo anything: Madre catches up
 * at the next backfill, and until then it does not reflect the change.
 */
export interface MadreSyncResult {
  status: 'synced' | 'failed';
  message?: string;
}

export type WithMadreSync<T> = T & { madreSync?: MadreSyncResult };

const ISSUE_SOURCE = 'tlqv_invoice_facturas_single';
const MELI_ORDER_ISSUE_SOURCE = 'tlqv_invoice_facturas_meli_order';

@Injectable()
export class TlqvInvoiceFacturasService {
  private readonly logger = new Logger(TlqvInvoiceFacturasService.name);

  constructor(
    @Inject(CREATE_TLQV_INVOICE_FLOW_INTERACTOR)
    private readonly createTlqvInvoiceFlowInteractor: CreateTlqvInvoiceFlowInteractor,
    @Inject(DELETE_XUBIO_INVOICE_INTERACTOR)
    private readonly deleteXubioInvoiceInteractor: DeleteXubioInvoiceInteractor,
    @Inject(CREATE_NOTA_CREDITO_FROM_TLQV_INTERACTOR)
    private readonly createNotaCreditoFromTlqvInteractor: CreateNotaCreditoFromTlqvInteractor,
    @Inject(CREATE_MELI_ORDER_INVOICE_FLOW_INTERACTOR)
    private readonly createMeliOrderInvoiceFlowInteractor: CreateMeliOrderInvoiceFlowInteractor,
    @Inject(SEND_INVOICE_TO_MELI_INTERACTOR)
    private readonly sendInvoiceToMeliInteractor: SendInvoiceToMeliInteractor,
    @Inject(REQUEST_CAE_INTERACTOR)
    private readonly requestCaeInteractor: RequestCaeInteractor,
    @Inject(COMPLETE_MELI_ORDER_SALE_INTERACTOR)
    private readonly completeMeliOrderSaleInteractor: CompleteMeliOrderSaleInteractor,
    @Inject(SYNC_XUBIO_COMPROBANTE_TO_MADRE_INTERACTOR)
    private readonly syncXubioComprobanteToMadreInteractor: SyncXubioComprobanteToMadreInteractor,
    private readonly invoiceClientIssueRecorder: InvoiceClientIssueRecorderService,
  ) {}

  /**
   * Invoices a sale from its Mercado Libre order. A blocked run is recorded as
   * an issue, the same way the sheet-based flow does, so it shows in the panel.
   */
  async createFromMeliOrder(
    command: CreateMeliOrderInvoiceFlowCommand,
  ): Promise<WithMadreSync<CreateMeliOrderInvoiceFlowResponse>> {
    const metadata = {
      flow: 'meli_order',
      dryRun: command.dryRun,
      issueDate: command.issueDate,
    };

    try {
      const response =
        await this.createMeliOrderInvoiceFlowInteractor.execute(command);

      if (response.status === 'blocked') {
        await this.invoiceClientIssueRecorder.recordBlocked({
          tlqvCode: command.tlqvCode,
          response,
          source: MELI_ORDER_ISSUE_SOURCE,
          metadata,
        });
      }

      return this.withMadreSync(
        response,
        response.createdInvoice?.invoice.transaccionId,
      );
    } catch (error: unknown) {
      await this.invoiceClientIssueRecorder.recordUnhandledFailure({
        tlqvCode: command.tlqvCode,
        error,
        source: MELI_ORDER_ISSUE_SOURCE,
        metadata,
      });

      throw error;
    }
  }

  async createFromTlqv(
    command: CreateTlqvInvoiceFlowCommand,
  ): Promise<WithMadreSync<CreateTlqvInvoiceFlowResponse>> {
    try {
      const response =
        await this.createTlqvInvoiceFlowInteractor.execute(command);

      if (response.status === 'blocked') {
        await this.invoiceClientIssueRecorder.recordBlocked({
          tlqvCode: command.tlqvCode,
          response,
          source: ISSUE_SOURCE,
          metadata: {
            dryRun: command.dryRun,
            issueDate: command.issueDate,
            stopAfter: command.stopAfter,
          },
        });
      }

      return this.withMadreSync(
        response,
        response.createdInvoice?.invoice.transaccionId,
      );
    } catch (error: unknown) {
      await this.invoiceClientIssueRecorder.recordUnhandledFailure({
        tlqvCode: command.tlqvCode,
        error,
        source: ISSUE_SOURCE,
        metadata: {
          dryRun: command.dryRun,
          issueDate: command.issueDate,
          stopAfter: command.stopAfter,
        },
      });

      throw error;
    }
  }

  sendInvoiceToMeli(
    command: SendInvoiceToMeliCommand,
  ): Promise<SendInvoiceToMeliResponse> {
    return this.sendInvoiceToMeliInteractor.execute(command);
  }

  /**
   * A sale delivered on the day, all the way: factura, CAE and Mercado Libre.
   */
  completeMeliOrderSale(
    command: CompleteMeliOrderSaleCommand,
  ): Promise<CompleteMeliOrderSaleResponse> {
    return this.completeMeliOrderSaleInteractor.execute(command);
  }

  /** The CAE of one comprobante, named by its Xubio ID. */
  async requestCae(command: {
    transaccionId: number;
    dryRun?: boolean;
  }): Promise<WithMadreSync<RequestCaeResponse>> {
    return this.withCaeMadreSync(
      await this.requestCaeInteractor.execute(command),
    );
  }

  /** The CAE of every comprobante of a TLQV that still lacks one. */
  async requestCaeForTlqv(command: {
    tlqvCode: string;
    dryRun?: boolean;
  }): Promise<
    Omit<RequestCaeForTlqvResponse, 'results'> & {
      results: WithMadreSync<RequestCaeResponse>[];
    }
  > {
    const response = await this.requestCaeInteractor.executeForTlqv(command);
    const results: WithMadreSync<RequestCaeResponse>[] = [];
    for (const result of response.results) {
      results.push(await this.withCaeMadreSync(result));
    }

    return { ...response, results };
  }

  planCaeBulk(command: {
    tlqvCodes?: string[];
    transaccionIds?: number[];
  }): Promise<CaeBulkPlan> {
    return this.requestCaeInteractor.planBulk(command);
  }

  async createNotaCreditoFromTlqv(
    command: CreateNotaCreditoFromTlqvCommand,
  ): Promise<WithMadreSync<CreateNotaCreditoFromTlqvResponse>> {
    const response =
      await this.createNotaCreditoFromTlqvInteractor.execute(command);

    // With the nota de crédito in Madre, the factura it cancels stops counting
    // as the one that stands: the sale can be invoiced again right away, and a
    // second nota de crédito for the same factura is refused.
    return this.withMadreSync(
      response,
      response.createdNotaCredito?.invoice.transaccionId,
    );
  }

  /** A CAE just granted is a change Madre has to show too. */
  private withCaeMadreSync(
    response: RequestCaeResponse,
  ): Promise<WithMadreSync<RequestCaeResponse>> {
    return this.withMadreSync(
      response,
      response.status === 'authorized' ? response.transaccionId : undefined,
    );
  }

  /**
   * Copies to Madre the comprobante a run just created or got a CAE for, and
   * says in the answer how that went. Madre is what the duplicate check reads
   * before invoicing: without this it would not know about a new factura
   * until the next backfill, and a second run for the same sale in between
   * would issue another one.
   *
   * It never fails the run: the comprobante already exists in Xubio, and that
   * is what the caller has to be told first.
   */
  private async withMadreSync<T extends object>(
    response: T,
    transaccionId: number | null | undefined,
  ): Promise<WithMadreSync<T>> {
    if (typeof transaccionId !== 'number' || transaccionId < 1) {
      return response;
    }

    try {
      await this.syncXubioComprobanteToMadreInteractor.execute({
        transaccionId,
      });

      return { ...response, madreSync: { status: 'synced' } };
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : 'Unknown error';
      this.logger.warn(
        `Madre sync failed ${JSON.stringify({ transaccionId, detail })}`,
      );

      return {
        ...response,
        madreSync: {
          status: 'failed',
          message: `El comprobante ${transaccionId} no se pudo copiar a Madre. ${detail} Madre se pone al día en la próxima sincronización (cada 2 horas). Hasta entonces el control de duplicados no ve este cambio: no vuelvas a facturar esta venta.`,
        },
      };
    }
  }

  deleteByTransaccionId(
    command: DeleteXubioInvoiceCommand,
  ): Promise<DeleteXubioInvoiceResponse> {
    return this.deleteXubioInvoiceInteractor.execute(command);
  }
}
