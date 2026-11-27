import type { IGetCostosOperacionesByTlqvCodeRepository } from '../../../adapters/repositories/spreadsheet-api/costos-operaciones/IGetCostosOperacionesByTlqvCodeRepository';
import type { IGetMeliOrderDetailRepository } from '../../../adapters/repositories/mercadolibre-api/orders/IGetMeliOrderDetailRepository';
import type { IGetTlqvOrderDetailsRepository } from '../../../adapters/repositories/tlqv/order-details/IGetTlqvOrderDetailsRepository';
import type { MeliOrderDetail } from '../../../entities/mercadolibre/orders/MeliOrderDetail';
import type { GetCostosOperacionesByTlqvCodeResponse } from '../../../entities/spreadsheet-api/costos-operaciones/CostosOperaciones';
import type {
  GetTlqvOrderDetailsResponse,
  TlqvOrderDetails,
} from '../../../entities/tlqv/order-details/TlqvOrderDetails';
import type {
  CreateXubioInvoiceResponse,
  XubioInvoice,
} from '../../../entities/xubio/facturas/XubioInvoice';
import {
  resolveXubioInvoiceLetterFromFiscalCondition,
  type ResolveXubioInvoiceLetterResponse,
} from '../../xubio/facturas/ResolveXubioInvoiceLetterInteractor';
import type { CreateXubioClienteFromTlqvResponse } from '../clientes/CreateXubioClienteFromTlqvInteractor';
import { parseMoneyLikeNumber } from './BuildXubioInvoiceFromTlqvInteractor';
import {
  buildClienteFlowBlockers,
  buildXubioInvoiceCreationBlocker,
  normalizeRequiredTlqvCode,
  validateIssueDateTolerance,
  type ICreateXubioClienteFromTlqvUseCase,
  type ICreateXubioInvoiceRepository,
} from './CreateTlqvInvoiceFlowInteractor';

/** The only concept of these invoices: "Producto" in Xubio. */
export const MELI_ORDER_XUBIO_PRODUCT_ID = 2672923;
const VAT_21_FACTOR = 1.21;
const DEFAULT_POINT_OF_SALE_ID = 216731;
const DEFAULT_WAREHOUSE_ID = -2;
const SUPPORTED_CURRENCY_ID = 'ARS';
const CANCELLED_ORDER_STATUS = 'cancelled';
const MAX_ITEM_DESCRIPTION_LENGTH = 200;
const FALLBACK_ITEM_DESCRIPTION = 'Producto';
const SALE_PRICE_TOLERANCE_IN_CENTS = 100;
const COSTOS_SALE_PRICE_FIELD = 'Precio de venta';

export type MeliOrderInvoiceFlowStepName =
  'meli_order' | 'amount_check' | 'client' | 'invoice_creation';

export interface MeliOrderInvoiceFlowBlocker {
  code: string;
  message: string;
  step: MeliOrderInvoiceFlowStepName;
}

export interface MeliOrderInvoiceFlowStep {
  name: MeliOrderInvoiceFlowStepName;
  status: 'completed' | 'blocked' | 'skipped';
  message?: string;
  blockers?: MeliOrderInvoiceFlowBlocker[];
}

export interface CreateMeliOrderInvoiceFlowCommand {
  tlqvCode: string;
  /** Defaults to true: builds the invoice and returns it without issuing. */
  dryRun?: boolean;
  issueDate?: string;
}

export interface MeliOrderInvoiceBuild {
  invoiceLetter: ResolveXubioInvoiceLetterResponse;
  meliOrderIds: string[];
  /** What the buyer paid for the products, shipping excluded. */
  totalAmount: number;
  /**
   * The amount sent to Xubio: `totalAmount` on a letter B invoice, and
   * `totalAmount / 1.21` on a letter A one, where Xubio adds the VAT.
   */
  amountSentToXubio: number;
  invoice: XubioInvoice;
}

/** The two amounts the check compared, kept in the answer for diagnosis. */
export interface MeliOrderAmountCheck {
  /** What the buyer paid for the products according to Mercado Libre. */
  meliTotalAmount: number;
  /** "Precio de venta" in costos-operaciones. */
  costosSalePrice: number;
  differenceInCents: number;
  toleranceInCents: number;
}

interface CreateMeliOrderInvoiceFlowBaseResponse {
  tlqvCode: string;
  dryRun: boolean;
  steps: MeliOrderInvoiceFlowStep[];
  meliOrders?: MeliOrderDetail[];
  amountCheck?: MeliOrderAmountCheck;
  clienteFlow?: CreateXubioClienteFromTlqvResponse;
  xubioClienteId?: number;
  invoiceBuild?: MeliOrderInvoiceBuild;
  createdInvoice?: CreateXubioInvoiceResponse;
}

export type CreateMeliOrderInvoiceFlowResponse =
  | (CreateMeliOrderInvoiceFlowBaseResponse & {
      status: 'completed';
      canContinue: true;
    })
  | (CreateMeliOrderInvoiceFlowBaseResponse & {
      status: 'blocked';
      canContinue: false;
      blockers: MeliOrderInvoiceFlowBlocker[];
    });

/**
 * Builds the cliente use case for one sale, reading the buyer from the given
 * source instead of asking Ops API again.
 */
export type CreateClienteUseCaseFactory = (
  orderDetailsRepository: IGetTlqvOrderDetailsRepository,
) => ICreateXubioClienteFromTlqvUseCase;

/**
 * Invoices a sale straight from its Mercado Libre order: one "Producto" line
 * for what the buyer paid, shipping excluded.
 *
 * It is the flow for sales delivered on the day, which have no row in the
 * TLQV sheet to take concepts from. The TLQV only serves to find the order:
 * Ops API links it to its Mercado Libre order number, and mercadolibre-api
 * returns the amount and the buyer's billing data.
 *
 * Before anything is created, the amount is cross-checked against "Precio de
 * venta" in costos-operaciones, with the same $1 tolerance the sheet-based
 * flow uses: Mercado Libre says what was charged, the sheet says what was
 * sold for, and an invoice only goes out when both agree.
 *
 * The cliente step is the one the sheet-based flow uses — same duplicate
 * guard, same search in Xubio, same AFIP lookup — fed with the billing data
 * Mercado Libre reports. A DNI becomes a consumidor final; a CUIT is checked
 * against AFIP, and that answer decides the letter.
 */
export class CreateMeliOrderInvoiceFlowInteractor {
  constructor(
    private readonly opsOrderDetailsRepository: IGetTlqvOrderDetailsRepository,
    private readonly meliOrderDetailRepository: IGetMeliOrderDetailRepository,
    private readonly costosOperacionesRepository: IGetCostosOperacionesByTlqvCodeRepository,
    private readonly createClienteUseCaseFactory: CreateClienteUseCaseFactory,
    private readonly createXubioInvoiceRepository?: ICreateXubioInvoiceRepository,
    private readonly getTodayIsoDate: () => string = () =>
      new Date().toISOString().slice(0, 10),
  ) {}

  async execute(
    command: CreateMeliOrderInvoiceFlowCommand,
  ): Promise<CreateMeliOrderInvoiceFlowResponse> {
    const tlqvCode = normalizeRequiredTlqvCode(command.tlqvCode);
    const dryRun = command.dryRun ?? true;
    const steps: MeliOrderInvoiceFlowStep[] = [];
    const base = { tlqvCode, dryRun, steps };

    const issueDateValidation = validateIssueDateTolerance({
      issueDate: command.issueDate,
      todayIsoDate: this.getTodayIsoDate(),
    });
    if (!issueDateValidation.valid) {
      return block(
        base,
        'invoice_creation',
        atStep('invoice_creation', [issueDateValidation.blocker]),
      );
    }
    const issueDate = issueDateValidation.issueDate;

    const orderLookup = await this.getMeliOrders(tlqvCode);
    if (orderLookup.status === 'blocked') {
      return block(base, 'meli_order', [orderLookup.blocker]);
    }
    const { opsOrderDetails, meliOrders } = orderLookup;
    const meliOrderIds = meliOrders.map((order) => order.id);
    steps.push({
      name: 'meli_order',
      status: 'completed',
      message:
        meliOrders.length === 1
          ? `Orden ${meliOrderIds[0]} obtenida de Mercado Libre.`
          : `${meliOrders.length} órdenes del mismo carrito obtenidas de Mercado Libre.`,
    });

    // Checked before the cliente step on purpose: a sale whose amount does
    // not add up must not leave a cliente created in Xubio behind.
    const amountValidation = await this.validateAmountAgainstCostos(
      tlqvCode,
      sumTotalAmount(meliOrders),
    );
    if (amountValidation.status === 'blocked') {
      return block(
        { ...base, meliOrders, amountCheck: amountValidation.amountCheck },
        'amount_check',
        [amountValidation.blocker],
      );
    }
    const amountCheck = amountValidation.amountCheck;
    steps.push({
      name: 'amount_check',
      status: 'completed',
      message: `El importe de Mercado Libre coincide con "${COSTOS_SALE_PRICE_FIELD}" de costos-operaciones.`,
    });

    const clienteFlow = await this.createClienteUseCaseFactory(
      createFixedOrderDetailsRepository(
        buildOrderDetailsFromMeli(tlqvCode, opsOrderDetails, meliOrders),
      ),
    ).execute({ tlqvCode });

    if (!clienteFlow.canContinue) {
      return block(
        { ...base, meliOrders, amountCheck, clienteFlow },
        'client',
        atStep('client', buildClienteFlowBlockers(clienteFlow)),
        'El flujo de cliente no puede continuar.',
      );
    }

    const xubioClienteId = clienteFlow.xubioClienteResult.cliente?.clienteId;
    steps.push({
      name: 'client',
      status: 'completed',
      message:
        clienteFlow.status === 'created'
          ? 'Cliente creado en Xubio.'
          : 'Cliente ya existente en Xubio.',
    });
    const withCliente = {
      ...base,
      meliOrders,
      amountCheck,
      clienteFlow,
      xubioClienteId,
    };

    if (xubioClienteId === undefined) {
      return block(withCliente, 'invoice_creation', [
        {
          code: 'XUBIO_CLIENTE_ID_NOT_AVAILABLE',
          message:
            'No tenemos el ID del cliente Xubio en la respuesta actual; sin ese ID no se puede emitir la factura.',
          step: 'invoice_creation',
        },
      ]);
    }

    const invoiceBuild = buildInvoice({
      tlqvCode,
      customerId: xubioClienteId,
      fiscalCondition: clienteFlow.fiscalInfo.condicionImpositiva,
      meliOrders,
      issueDate,
    });

    if (dryRun) {
      steps.push({
        name: 'invoice_creation',
        status: 'skipped',
        message: 'Factura armada. No se emitió porque dryRun es true.',
      });

      return {
        ...withCliente,
        status: 'completed',
        canContinue: true,
        invoiceBuild,
      };
    }

    if (this.createXubioInvoiceRepository === undefined) {
      return block({ ...withCliente, invoiceBuild }, 'invoice_creation', [
        {
          code: 'INVOICE_CREATION_REPOSITORY_NOT_CONFIGURED',
          message:
            'El repositorio de creación de facturas Xubio no está configurado.',
          step: 'invoice_creation',
        },
      ]);
    }

    let createdInvoice: CreateXubioInvoiceResponse;
    try {
      createdInvoice = await this.createXubioInvoiceRepository.create({
        invoice: invoiceBuild.invoice,
      });
    } catch (error: unknown) {
      return block(
        { ...withCliente, invoiceBuild },
        'invoice_creation',
        atStep('invoice_creation', [buildXubioInvoiceCreationBlocker(error)]),
      );
    }

    steps.push({
      name: 'invoice_creation',
      status: 'completed',
      message: 'Factura emitida en Xubio.',
    });

    return {
      ...withCliente,
      status: 'completed',
      canContinue: true,
      invoiceBuild,
      createdInvoice,
    };
  }

  /**
   * Compares what Mercado Libre charged with "Precio de venta" in
   * costos-operaciones. It fails closed: if the sheet cannot be read, has no
   * row for the TLQV or has no price, the invoice is blocked rather than
   * issued unverified.
   */
  private async validateAmountAgainstCostos(
    tlqvCode: string,
    meliTotalAmount: number,
  ): Promise<
    | { status: 'ok'; amountCheck: MeliOrderAmountCheck }
    | {
        status: 'blocked';
        blocker: MeliOrderInvoiceFlowBlocker;
        amountCheck?: MeliOrderAmountCheck;
      }
  > {
    const blocked = (
      code: string,
      message: string,
      amountCheck?: MeliOrderAmountCheck,
    ) => ({
      status: 'blocked' as const,
      blocker: { code, message, step: 'amount_check' as const },
      amountCheck,
    });

    let costosResponse: GetCostosOperacionesByTlqvCodeResponse;
    try {
      costosResponse = await this.costosOperacionesRepository.getByTlqvCode({
        tlqvCode,
      });
    } catch (error: unknown) {
      return blocked(
        'COSTOS_OPERACIONES_LOOKUP_FAILED',
        `No se pudo consultar costos-operaciones para ${tlqvCode}. ${readErrorMessage(error)}`,
      );
    }

    if (!costosResponse.found) {
      return blocked(
        'COSTOS_OPERACIONES_NOT_FOUND',
        `${tlqvCode} no existe en la solapa costos-operaciones; no se puede validar el importe de la factura.`,
      );
    }

    const costosSalePrice = parseMoneyLikeNumber(
      costosResponse.item.data[COSTOS_SALE_PRICE_FIELD],
    );
    if (costosSalePrice === 0) {
      return blocked(
        'COSTOS_OPERACIONES_SALE_PRICE_MISSING',
        `${tlqvCode} no tiene "${COSTOS_SALE_PRICE_FIELD}" válido en costos-operaciones; no se puede validar el importe de la factura.`,
      );
    }

    const differenceInCents = Math.abs(
      Math.round(meliTotalAmount * 100) - Math.round(costosSalePrice * 100),
    );
    const amountCheck: MeliOrderAmountCheck = {
      meliTotalAmount,
      costosSalePrice,
      differenceInCents,
      toleranceInCents: SALE_PRICE_TOLERANCE_IN_CENTS,
    };
    if (differenceInCents <= SALE_PRICE_TOLERANCE_IN_CENTS) {
      return { status: 'ok', amountCheck };
    }

    return blocked(
      'INVOICE_TOTAL_SALE_PRICE_MISMATCH',
      `El importe de la orden en Mercado Libre (${meliTotalAmount.toFixed(2)}) no coincide con "${COSTOS_SALE_PRICE_FIELD}" en costos-operaciones (${costosSalePrice.toFixed(2)}) para ${tlqvCode}. Diferencia: ${(differenceInCents / 100).toFixed(2)} (tolerancia: ${(SALE_PRICE_TOLERANCE_IN_CENTS / 100).toFixed(2)}).`,
      amountCheck,
    );
  }

  /**
   * Finds the Mercado Libre orders behind the TLQV and checks they can be
   * invoiced. Nothing is assumed when a lookup fails: an order that could not
   * be read is a blocker, never an empty invoice.
   */
  private async getMeliOrders(tlqvCode: string): Promise<
    | {
        status: 'found';
        opsOrderDetails: TlqvOrderDetails;
        meliOrders: MeliOrderDetail[];
      }
    | { status: 'blocked'; blocker: MeliOrderInvoiceFlowBlocker }
  > {
    const blocked = (code: string, message: string) => ({
      status: 'blocked' as const,
      blocker: { code, message, step: 'meli_order' as const },
    });

    let opsResponse: GetTlqvOrderDetailsResponse;
    try {
      opsResponse = await this.opsOrderDetailsRepository.getByTlqvCode({
        tlqvCode,
      });
    } catch (error: unknown) {
      return blocked(
        'ORDER_DETAILS_LOOKUP_FAILED',
        `No se pudo consultar ${tlqvCode} en Ops API. ${readErrorMessage(error)}`,
      );
    }

    if (!opsResponse.found) {
      return blocked(
        'ORDER_DETAILS_NOT_FOUND',
        `${tlqvCode} no existe en Ops API.`,
      );
    }

    const opsOrderDetails = opsResponse.orderDetails;
    const meliOrderIds = opsOrderDetails.meliOrderIds ?? [];
    if (meliOrderIds.length === 0) {
      return blocked(
        'MELI_ORDER_NOT_LINKED',
        `${tlqvCode} no tiene una orden de Mercado Libre asociada en Ops API; no hay de dónde tomar el importe ni el comprador.`,
      );
    }

    const meliOrders: MeliOrderDetail[] = [];
    for (const orderId of meliOrderIds) {
      try {
        const response = await this.meliOrderDetailRepository.getByOrderId({
          orderId,
        });
        if (!response.found) {
          return blocked(
            'MELI_ORDER_NOT_FOUND',
            `Mercado Libre no devolvió la orden ${orderId} de ${tlqvCode}.`,
          );
        }
        meliOrders.push(response.order);
      } catch (error: unknown) {
        return blocked(
          'MELI_ORDER_LOOKUP_FAILED',
          `No se pudo consultar la orden ${orderId} de ${tlqvCode} en Mercado Libre. ${readErrorMessage(error)}`,
        );
      }
    }

    const cancelled = meliOrders.find(
      (order) => order.status.toLowerCase() === CANCELLED_ORDER_STATUS,
    );
    if (cancelled !== undefined) {
      return blocked(
        'MELI_ORDER_CANCELLED',
        `La orden ${cancelled.id} de ${tlqvCode} figura cancelada en Mercado Libre y no se factura.`,
      );
    }

    const foreignCurrency = meliOrders.find(
      (order) => order.currencyId !== SUPPORTED_CURRENCY_ID,
    );
    if (foreignCurrency !== undefined) {
      return blocked(
        'MELI_ORDER_CURRENCY_NOT_SUPPORTED',
        `La orden ${foreignCurrency.id} de ${tlqvCode} está en ${foreignCurrency.currencyId}; solo se facturan órdenes en pesos.`,
      );
    }

    if (sumTotalAmount(meliOrders) <= 0) {
      return blocked(
        'MELI_ORDER_TOTAL_INVALID',
        `${tlqvCode} tiene un importe total de ${sumTotalAmount(meliOrders).toFixed(2)} en Mercado Libre; no hay nada que facturar.`,
      );
    }

    const billing = meliOrders[0].billing;
    if (
      billing === null ||
      normalizeDigits(billing.identificationNumber) === null
    ) {
      return blocked(
        'MELI_BILLING_INFO_MISSING',
        `Mercado Libre no informó el documento del comprador de ${tlqvCode}; sin eso no se puede identificar al cliente.`,
      );
    }

    return { status: 'found', opsOrderDetails, meliOrders };
  }
}

function block(
  base: CreateMeliOrderInvoiceFlowBaseResponse,
  step: MeliOrderInvoiceFlowStepName,
  blockers: MeliOrderInvoiceFlowBlocker[],
  message?: string,
): CreateMeliOrderInvoiceFlowResponse {
  base.steps.push({ name: step, status: 'blocked', message, blockers });

  return { ...base, status: 'blocked', canContinue: false, blockers };
}

/** Re-tags blockers built by the sheet-based flow with this flow's step. */
function atStep(
  step: MeliOrderInvoiceFlowStepName,
  blockers: { code: string; message: string }[],
): MeliOrderInvoiceFlowBlocker[] {
  return blockers.map((blocker) => ({
    code: blocker.code,
    message: blocker.message,
    step,
  }));
}

/**
 * The buyer as Mercado Libre bills them, in the shape the cliente step reads.
 * The source is not Ops API, so its order-status rule does not apply: these
 * sales are delivered on the day and can always be invoiced.
 */
function buildOrderDetailsFromMeli(
  tlqvCode: string,
  opsOrderDetails: TlqvOrderDetails,
  meliOrders: MeliOrderDetail[],
): TlqvOrderDetails {
  const billing = meliOrders[0].billing;
  const documento = billing?.identificationNumber ?? null;
  const address = billing?.address ?? null;
  const buyerName = joinNonEmpty([billing?.firstName, billing?.lastName], ' ');

  return {
    tlqvCode,
    source: 'mercadolibre',
    saleNumber: opsOrderDetails.saleNumber ?? meliOrders[0].id,
    buyerData: {
      nombreDestinatario:
        buyerName ?? opsOrderDetails.buyerData.nombreDestinatario,
      cuitComprador: documento,
      cuitCompradorDigits: normalizeDigits(documento),
      direccion: joinNonEmpty(
        [address?.streetName, address?.streetNumber],
        ' ',
      ),
      ciudad: address?.cityName ?? null,
      provincia: address?.stateName ?? null,
      codigoPostal: address?.zipCode ?? null,
      telefono: opsOrderDetails.buyerData.telefono,
      email: opsOrderDetails.buyerData.email,
    },
    meliOrderIds: meliOrders.map((order) => order.id),
    rawPayload: { ops: opsOrderDetails.rawPayload, meliOrders },
  };
}

function createFixedOrderDetailsRepository(
  orderDetails: TlqvOrderDetails,
): IGetTlqvOrderDetailsRepository {
  return {
    getByTlqvCode: () => Promise.resolve({ found: true, orderDetails }),
  };
}

function buildInvoice(command: {
  tlqvCode: string;
  customerId: number;
  fiscalCondition: string | null | undefined;
  meliOrders: MeliOrderDetail[];
  issueDate: string;
}): MeliOrderInvoiceBuild {
  const invoiceLetter = resolveXubioInvoiceLetterFromFiscalCondition(
    command.fiscalCondition,
  );
  const totalAmount = sumTotalAmount(command.meliOrders);
  // Letter A: the net amount goes out and Xubio adds the 21% back. Letter B:
  // the final amount goes out as it is, VAT included and not broken out.
  const amountSentToXubio =
    invoiceLetter.letter === 'A'
      ? roundMoney(totalAmount / VAT_21_FACTOR)
      : totalAmount;
  const meliOrderIds = command.meliOrders.map((order) => order.id);

  return {
    invoiceLetter,
    meliOrderIds,
    totalAmount,
    amountSentToXubio,
    invoice: {
      type: 'Factura',
      letter: invoiceLetter.letter,
      customerId: command.customerId,
      issueDate: command.issueDate,
      dueDate: command.issueDate,
      pointOfSaleId: DEFAULT_POINT_OF_SALE_ID,
      description: `${command.tlqvCode} ML: ${meliOrderIds.join(', ')}`,
      exchangeRate: 1,
      items: [
        {
          productId: MELI_ORDER_XUBIO_PRODUCT_ID,
          warehouseId: DEFAULT_WAREHOUSE_ID,
          description: buildItemDescription(command.meliOrders),
          quantity: 1,
          unitPrice: amountSentToXubio,
          priceWithVat: invoiceLetter.letter === 'B' ? amountSentToXubio : 0,
          discountPercentage: 0,
        },
      ],
    },
  };
}

/** What was sold, so the invoice says more than "Producto". */
function buildItemDescription(meliOrders: MeliOrderDetail[]): string {
  const titles = meliOrders
    .flatMap((order) => order.items)
    .map((item) => {
      const title = item.title?.trim();
      if (title === undefined || title === '') {
        return null;
      }

      return item.quantity !== null && item.quantity > 1
        ? `${item.quantity} x ${title}`
        : title;
    })
    .filter((title): title is string => title !== null);

  if (titles.length === 0) {
    return FALLBACK_ITEM_DESCRIPTION;
  }

  const description = titles.join(' + ');
  return description.length > MAX_ITEM_DESCRIPTION_LENGTH
    ? `${description.slice(0, MAX_ITEM_DESCRIPTION_LENGTH - 1).trimEnd()}…`
    : description;
}

function sumTotalAmount(meliOrders: MeliOrderDetail[]): number {
  return roundMoney(
    meliOrders.reduce((sum, order) => sum + order.totalAmount, 0),
  );
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function normalizeDigits(value: string | null | undefined): string | null {
  const digits = (value ?? '').replace(/\D/g, '');
  return digits === '' ? null : digits;
}

function joinNonEmpty(
  parts: (string | null | undefined)[],
  separator: string,
): string | null {
  const joined = parts
    .map((part) => part?.trim() ?? '')
    .filter((part) => part !== '')
    .join(separator);

  return joined === '' ? null : joined;
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Error desconocido.';
}
