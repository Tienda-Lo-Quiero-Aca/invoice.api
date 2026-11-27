import type { IGetTlqvOrderDetailsRepository } from '../../../adapters/repositories/tlqv/order-details/IGetTlqvOrderDetailsRepository';
import type { MeliOrderDetail } from '../../../entities/mercadolibre/orders/MeliOrderDetail';
import type { TlqvOrderDetails } from '../../../entities/tlqv/order-details/TlqvOrderDetails';
import { CreateXubioClienteFromTlqvInteractor } from '../clientes/CreateXubioClienteFromTlqvInteractor';
import type { CreateXubioClienteFromTlqvResponse } from '../clientes/CreateXubioClienteFromTlqvInteractor';
import {
  CreateMeliOrderInvoiceFlowInteractor,
  type CreateClienteUseCaseFactory,
} from './CreateMeliOrderInvoiceFlowInteractor';

const TODAY = '2026-11-27';
const TLQV = 'TLQV-23500';
const ORDER_ID = '2000019813708728';

describe('CreateMeliOrderInvoiceFlowInteractor', () => {
  describe('consumidor final with DNI (order 2000019813708728)', () => {
    it('builds a letter B invoice with one "Producto" line for what the buyer paid, without issuing it on dryRun', async () => {
      const dependencies = createDependencies();
      const interactor = createInteractor(dependencies);

      const result = await interactor.execute({ tlqvCode: 'tlqv-23500' });

      expect(result.status).toBe('completed');
      expect(result.dryRun).toBe(true);
      expect(dependencies.createInvoice.create).not.toHaveBeenCalled();
      expect(result.invoiceBuild?.invoiceLetter.letter).toBe('B');
      expect(result.invoiceBuild?.totalAmount).toBe(386749.16);
      expect(result.invoiceBuild?.invoice).toEqual({
        type: 'Factura',
        letter: 'B',
        customerId: 10503039,
        issueDate: TODAY,
        dueDate: TODAY,
        pointOfSaleId: 216731,
        description: `${TLQV} ML: ${ORDER_ID}`,
        exchangeRate: 1,
        items: [
          {
            productId: 2672923,
            warehouseId: -2,
            description:
              'Cámara De Acción 4k 30fps Go11-us, Portátil Para Vlogging, I Color',
            quantity: 1,
            // The $386,749.16 already has the seller discount taken off the
            // $453,999 list price, and carries no shipping.
            unitPrice: 386749.16,
            priceWithVat: 386749.16,
            discountPercentage: 0,
          },
        ],
      });
      expect(result.steps.map((step) => [step.name, step.status])).toEqual([
        ['meli_order', 'completed'],
        ['amount_check', 'completed'],
        ['client', 'completed'],
        ['invoice_creation', 'skipped'],
      ]);
    });

    it('hands the cliente step the buyer as Mercado Libre bills them', async () => {
      const dependencies = createDependencies();
      const interactor = createInteractor(dependencies);

      await interactor.execute({ tlqvCode: TLQV });

      const orderDetails = await readOrderDetailsGivenToClienteStep(
        dependencies.orderDetailsRepositories,
      );
      // Not `ops_api`: the order-status rule of the sheet-based flow must not
      // apply to sales that are delivered on the day.
      expect(orderDetails.source).toBe('mercadolibre');
      expect(orderDetails.buyerData).toEqual({
        nombreDestinatario: 'Dante Daniel Castro',
        cuitComprador: '24574352',
        cuitCompradorDigits: '24574352',
        direccion: 'Avenida 2 de Abril 3449',
        ciudad: 'San Salvador de Jujuy',
        provincia: 'Jujuy',
        codigoPostal: '4604',
        telefono: null,
        email: null,
      });
    });

    it('issues the invoice when dryRun is false', async () => {
      const dependencies = createDependencies();
      const interactor = createInteractor(dependencies);

      const result = await interactor.execute({
        tlqvCode: TLQV,
        dryRun: false,
      });

      expect(result.status).toBe('completed');
      expect(dependencies.createInvoice.create).toHaveBeenCalledTimes(1);
      expect(dependencies.createInvoice.create).toHaveBeenCalledWith({
        invoice: result.invoiceBuild?.invoice,
      });
      expect(result.createdInvoice?.invoice.numeroDocumento).toBe(
        'B-00008-00004100',
      );
    });

    it('creates the buyer as consumidor final with their DNI through the real cliente step', async () => {
      const dependencies = createDependencies();
      const createdClientes: unknown[] = [];
      const xubioClientes = {
        create: jest.fn((command: { cliente: unknown }) => {
          createdClientes.push(command.cliente);
          return Promise.resolve({
            status: 'created' as const,
            created: true,
            cliente: {
              clienteId: 10600001,
              nombre: 'Dante Daniel Castro',
              rawPayload: {},
            },
            rawPayload: {},
          });
        }),
      };
      // The real cliente interactor, with only its edges mocked: this is the
      // piece the whole flow relies on for a DNI to end up as a B invoice.
      dependencies.createClienteUseCaseFactory = jest.fn(
        (orderDetailsRepository: IGetTlqvOrderDetailsRepository) =>
          new CreateXubioClienteFromTlqvInteractor(
            createMadreWithoutInvoices(),
            [orderDetailsRepository],
            {
              // What the TusFacturas repository answers for a document that
              // is not an 11-digit CUIT, without calling AFIP.
              getAfipInfo: jest.fn().mockResolvedValue({
                found: false,
                status: 'invalid_document',
                invalidDocument: {
                  documentoNro: '24574352',
                  documentoNroDigits: '24574352',
                  documentoTipo: 'CUIT',
                  message: 'documentoNro must contain 11 digits',
                  messages: ['documentoNro must contain 11 digits'],
                  rawPayload: {},
                },
              }),
            },
            xubioClientes,
            undefined,
            () => new Date('2026-11-27T12:00:00.000Z'),
            {
              findByName: jest
                .fn()
                .mockResolvedValue({ clientes: [], rawPayload: [] }),
              listAll: jest
                .fn()
                .mockResolvedValue({ clientes: [], rawPayload: [] }),
            },
          ),
      );
      const interactor = createInteractor(dependencies);

      const result = await interactor.execute({ tlqvCode: TLQV });

      expect(result.status).toBe('completed');
      expect(createdClientes).toHaveLength(1);
      expect(createdClientes[0]).toEqual(
        expect.objectContaining({
          nombre: 'Dante Daniel Castro',
          identificacionTributaria: { codigo: 'DNI' },
          categoriaFiscal: { codigo: 'CF' },
          direccion: 'Avenida 2 de Abril 3449',
          provincia: { nombre: 'Jujuy' },
        }),
      );
      expect(result.xubioClienteId).toBe(10600001);
      expect(result.invoiceBuild?.invoiceLetter.letter).toBe('B');
      expect(result.invoiceBuild?.invoice.items[0].priceWithVat).toBe(
        386749.16,
      );
    });
  });

  it('sends a letter A invoice net of the 21% for Xubio to add back', async () => {
    const dependencies = createDependencies({
      clienteFlow: createClienteFlow('RESPONSABLE INSCRIPTO'),
    });
    const interactor = createInteractor(dependencies);

    const result = await interactor.execute({ tlqvCode: TLQV });

    expect(result.invoiceBuild?.invoiceLetter.letter).toBe('A');
    expect(result.invoiceBuild?.totalAmount).toBe(386749.16);
    // 386,749.16 / 1.21
    expect(result.invoiceBuild?.amountSentToXubio).toBe(319627.4);
    expect(result.invoiceBuild?.invoice.items).toEqual([
      expect.objectContaining({
        productId: 2672923,
        unitPrice: 319627.4,
        priceWithVat: 0,
      }),
    ]);
  });

  it('issues a single invoice for a pack, adding up its orders', async () => {
    const dependencies = createDependencies({
      meliOrderIds: [ORDER_ID, '2000019813708730'],
      costosSalePrice: '$400,000.00',
    });
    dependencies.meliOrders.getByOrderId
      .mockResolvedValueOnce({ found: true, order: createMeliOrder() })
      .mockResolvedValueOnce({
        found: true,
        order: createMeliOrder({
          id: '2000019813708730',
          totalAmount: 13250.84,
          items: [
            {
              itemId: 'MLA2',
              title: 'Tarjeta De Memoria 128gb',
              sellerSku: 'B0X',
              quantity: 2,
              unitPrice: 6625.42,
            },
          ],
        }),
      });
    const interactor = createInteractor(dependencies);

    const result = await interactor.execute({ tlqvCode: TLQV });

    expect(result.invoiceBuild?.totalAmount).toBe(400000);
    expect(result.invoiceBuild?.invoice.description).toBe(
      `${TLQV} ML: ${ORDER_ID}, 2000019813708730`,
    );
    expect(result.invoiceBuild?.invoice.items).toEqual([
      expect.objectContaining({
        quantity: 1,
        unitPrice: 400000,
        description:
          'Cámara De Acción 4k 30fps Go11-us, Portátil Para Vlogging, I Color + 2 x Tarjeta De Memoria 128gb',
      }),
    ]);
  });

  it('never bills shipping or financing, even when the buyer paid them', async () => {
    const dependencies = createDependencies();
    dependencies.meliOrders.getByOrderId.mockResolvedValue({
      found: true,
      // paidAmount includes $12,000 of shipping; totalAmount does not.
      order: createMeliOrder({ totalAmount: 386749.16, paidAmount: 398749.16 }),
    });
    const interactor = createInteractor(dependencies);

    const result = await interactor.execute({ tlqvCode: TLQV });

    expect(result.invoiceBuild?.totalAmount).toBe(386749.16);
  });

  describe('amount check against costos-operaciones', () => {
    it('reads "Precio de venta" for the TLQV and keeps both amounts in the answer', async () => {
      const dependencies = createDependencies();
      const interactor = createInteractor(dependencies);

      const result = await interactor.execute({ tlqvCode: TLQV });

      expect(dependencies.costosOperaciones.getByTlqvCode).toHaveBeenCalledWith(
        { tlqvCode: TLQV },
      );
      expect(result.amountCheck).toEqual({
        meliTotalAmount: 386749.16,
        costosSalePrice: 386749.16,
        differenceInCents: 0,
        toleranceInCents: 100,
      });
    });

    it.each(['$386,750.16', '$386,748.16'])(
      'lets the invoice through when the amounts differ by up to $1 (%s)',
      async (costosSalePrice) => {
        const dependencies = createDependencies({ costosSalePrice });
        const interactor = createInteractor(dependencies);

        const result = await interactor.execute({
          tlqvCode: TLQV,
          dryRun: false,
        });

        expect(result.status).toBe('completed');
        expect(dependencies.createInvoice.create).toHaveBeenCalledTimes(1);
      },
    );

    it('blocks when they differ by more than $1, before the cliente is touched', async () => {
      // The sheet still has the $453,999 list price; Mercado Libre charged
      // $386,749.16 after the seller discount.
      const dependencies = createDependencies({
        costosSalePrice: '$453,999.00',
      });
      const interactor = createInteractor(dependencies);

      const result = await interactor.execute({
        tlqvCode: TLQV,
        dryRun: false,
      });

      expectBlocked(
        result,
        'INVOICE_TOTAL_SALE_PRICE_MISMATCH',
        'amount_check',
      );
      if (result.status !== 'blocked') {
        throw new Error('Expected blocked response');
      }
      expect(result.blockers[0].message).toContain('386749.16');
      expect(result.blockers[0].message).toContain('453999.00');
      expect(result.blockers[0].message).toContain('Diferencia: 67249.84');
      expect(result.amountCheck?.differenceInCents).toBe(6724984);
      // Nothing may be left behind in Xubio for a sale that does not add up.
      expect(dependencies.createClienteUseCaseFactory).not.toHaveBeenCalled();
      expect(dependencies.createInvoice.create).not.toHaveBeenCalled();
    });

    it('compares what the buyer paid, not the net amount of a letter A invoice', async () => {
      const dependencies = createDependencies({
        clienteFlow: createClienteFlow('RESPONSABLE INSCRIPTO'),
      });
      const interactor = createInteractor(dependencies);

      const result = await interactor.execute({ tlqvCode: TLQV });

      // $319,627.40 goes to Xubio, but the sheet is compared with $386,749.16.
      expect(result.status).toBe('completed');
      expect(result.amountCheck?.meliTotalAmount).toBe(386749.16);
    });

    it('blocks when the TLQV has no row in costos-operaciones (fails closed)', async () => {
      const dependencies = createDependencies();
      dependencies.costosOperaciones.getByTlqvCode.mockResolvedValue({
        found: false,
        tlqvCode: TLQV,
        reason: 'not_found',
      });
      const interactor = createInteractor(dependencies);

      const result = await interactor.execute({ tlqvCode: TLQV });

      expectBlocked(result, 'COSTOS_OPERACIONES_NOT_FOUND', 'amount_check');
      expect(dependencies.createClienteUseCaseFactory).not.toHaveBeenCalled();
    });

    it('blocks when costos-operaciones cannot be read', async () => {
      const dependencies = createDependencies();
      dependencies.costosOperaciones.getByTlqvCode.mockRejectedValue(
        new Error('timeout of 30000ms exceeded'),
      );
      const interactor = createInteractor(dependencies);

      const result = await interactor.execute({
        tlqvCode: TLQV,
        dryRun: false,
      });

      expectBlocked(result, 'COSTOS_OPERACIONES_LOOKUP_FAILED', 'amount_check');
      expect(dependencies.createInvoice.create).not.toHaveBeenCalled();
    });

    it.each(['', '$0.00'])(
      'blocks when "Precio de venta" is not loaded (%p)',
      async (costosSalePrice) => {
        const dependencies = createDependencies({ costosSalePrice });
        const interactor = createInteractor(dependencies);

        const result = await interactor.execute({ tlqvCode: TLQV });

        expectBlocked(
          result,
          'COSTOS_OPERACIONES_SALE_PRICE_MISSING',
          'amount_check',
        );
      },
    );

    it('is not consulted when Mercado Libre could not be read', async () => {
      const dependencies = createDependencies();
      dependencies.meliOrders.getByOrderId.mockRejectedValue(
        new Error('timeout'),
      );
      const interactor = createInteractor(dependencies);

      await interactor.execute({ tlqvCode: TLQV });

      expect(
        dependencies.costosOperaciones.getByTlqvCode,
      ).not.toHaveBeenCalled();
    });
  });

  describe('blocks instead of issuing', () => {
    it('when the sale already has an invoice', async () => {
      const dependencies = createDependencies({
        clienteFlow: {
          status: 'blocked',
          canContinue: false,
          tlqvCode: TLQV,
          prepare: {} as never,
          blockers: [
            {
              code: 'ALREADY_BILLED',
              message: `${TLQV} already has an invoice comprobante in Madre.`,
            },
          ],
        },
      });
      const interactor = createInteractor(dependencies);

      const result = await interactor.execute({
        tlqvCode: TLQV,
        dryRun: false,
      });

      expectBlocked(result, 'ALREADY_BILLED', 'client');
      expect(dependencies.createInvoice.create).not.toHaveBeenCalled();
    });

    it('when Ops API has no Mercado Libre order linked to the TLQV', async () => {
      const dependencies = createDependencies({ meliOrderIds: [] });
      const interactor = createInteractor(dependencies);

      const result = await interactor.execute({ tlqvCode: TLQV });

      expectBlocked(result, 'MELI_ORDER_NOT_LINKED', 'meli_order');
      expect(dependencies.meliOrders.getByOrderId).not.toHaveBeenCalled();
      expect(dependencies.createClienteUseCaseFactory).not.toHaveBeenCalled();
    });

    it('when the TLQV is not in Ops API', async () => {
      const dependencies = createDependencies();
      dependencies.opsOrderDetails.getByTlqvCode.mockResolvedValue({
        found: false,
        tlqvCode: TLQV,
        source: 'ops_api',
      });
      const interactor = createInteractor(dependencies);

      const result = await interactor.execute({ tlqvCode: TLQV });

      expectBlocked(result, 'ORDER_DETAILS_NOT_FOUND', 'meli_order');
    });

    it('when Mercado Libre cannot be read, rather than guessing an amount', async () => {
      const dependencies = createDependencies();
      dependencies.meliOrders.getByOrderId.mockRejectedValue(
        new Error('timeout of 30000ms exceeded'),
      );
      const interactor = createInteractor(dependencies);

      const result = await interactor.execute({
        tlqvCode: TLQV,
        dryRun: false,
      });

      expectBlocked(result, 'MELI_ORDER_LOOKUP_FAILED', 'meli_order');
      expect(dependencies.createInvoice.create).not.toHaveBeenCalled();
    });

    it('when Mercado Libre does not know the order', async () => {
      const dependencies = createDependencies();
      dependencies.meliOrders.getByOrderId.mockResolvedValue({
        found: false,
        orderId: ORDER_ID,
      });
      const interactor = createInteractor(dependencies);

      const result = await interactor.execute({ tlqvCode: TLQV });

      expectBlocked(result, 'MELI_ORDER_NOT_FOUND', 'meli_order');
    });

    it('when the order is cancelled in Mercado Libre', async () => {
      const dependencies = createDependencies();
      dependencies.meliOrders.getByOrderId.mockResolvedValue({
        found: true,
        order: createMeliOrder({ status: 'cancelled' }),
      });
      const interactor = createInteractor(dependencies);

      const result = await interactor.execute({ tlqvCode: TLQV });

      expectBlocked(result, 'MELI_ORDER_CANCELLED', 'meli_order');
    });

    it('when the order is not in pesos', async () => {
      const dependencies = createDependencies();
      dependencies.meliOrders.getByOrderId.mockResolvedValue({
        found: true,
        order: createMeliOrder({ currencyId: 'USD' }),
      });
      const interactor = createInteractor(dependencies);

      const result = await interactor.execute({ tlqvCode: TLQV });

      expectBlocked(result, 'MELI_ORDER_CURRENCY_NOT_SUPPORTED', 'meli_order');
    });

    it('when Mercado Libre did not report who to bill', async () => {
      const dependencies = createDependencies();
      dependencies.meliOrders.getByOrderId.mockResolvedValue({
        found: true,
        order: createMeliOrder({ billing: null }),
      });
      const interactor = createInteractor(dependencies);

      const result = await interactor.execute({ tlqvCode: TLQV });

      expectBlocked(result, 'MELI_BILLING_INFO_MISSING', 'meli_order');
      expect(dependencies.createClienteUseCaseFactory).not.toHaveBeenCalled();
    });

    it('when the issue date is not valid, before looking anything up', async () => {
      const dependencies = createDependencies();
      const interactor = createInteractor(dependencies);

      const result = await interactor.execute({
        tlqvCode: TLQV,
        issueDate: '2026-12-25',
      });

      expectBlocked(result, 'INVALID_INVOICE_ISSUE_DATE', 'invoice_creation');
      expect(dependencies.opsOrderDetails.getByTlqvCode).not.toHaveBeenCalled();
    });

    it('and says to check Xubio first when it never answered the invoice', async () => {
      const dependencies = createDependencies();
      dependencies.createInvoice.create.mockRejectedValue(
        Object.assign(new Error('timeout of 30000ms exceeded'), {
          outcomeUnknown: true,
        }),
      );
      const interactor = createInteractor(dependencies);

      const result = await interactor.execute({
        tlqvCode: TLQV,
        dryRun: false,
      });

      expectBlocked(
        result,
        'XUBIO_INVOICE_OUTCOME_UNKNOWN',
        'invoice_creation',
      );
    });
  });
});

function expectBlocked(
  result: Awaited<ReturnType<CreateMeliOrderInvoiceFlowInteractor['execute']>>,
  code: string,
  step: string,
): void {
  expect(result.status).toBe('blocked');
  if (result.status !== 'blocked') {
    throw new Error('Expected blocked response');
  }
  expect(result.canContinue).toBe(false);
  expect(result.blockers).toEqual([expect.objectContaining({ code, step })]);
  expect(result.steps[result.steps.length - 1]).toEqual(
    expect.objectContaining({ name: step, status: 'blocked' }),
  );
}

async function readOrderDetailsGivenToClienteStep(
  repositories: IGetTlqvOrderDetailsRepository[],
): Promise<TlqvOrderDetails> {
  const response = await repositories[0].getByTlqvCode({ tlqvCode: TLQV });
  if (!response.found) {
    throw new Error('Expected the cliente step to receive order details');
  }

  return response.orderDetails;
}

function createInteractor(
  dependencies: ReturnType<typeof createDependencies>,
): CreateMeliOrderInvoiceFlowInteractor {
  return new CreateMeliOrderInvoiceFlowInteractor(
    dependencies.opsOrderDetails,
    dependencies.meliOrders,
    dependencies.costosOperaciones,
    dependencies.createClienteUseCaseFactory as CreateClienteUseCaseFactory,
    dependencies.createInvoice,
    () => TODAY,
  );
}

function createDependencies(
  options: {
    meliOrderIds?: string[];
    clienteFlow?: CreateXubioClienteFromTlqvResponse;
    /** "Precio de venta" as costos-operaciones holds it. */
    costosSalePrice?: string;
  } = {},
) {
  const clienteFlow = options.clienteFlow ?? createClienteFlow();
  const orderDetailsRepositories: IGetTlqvOrderDetailsRepository[] = [];

  return {
    /** What the flow handed to the cliente step, in call order. */
    orderDetailsRepositories,
    opsOrderDetails: {
      getByTlqvCode: jest.fn().mockResolvedValue({
        found: true,
        orderDetails: {
          tlqvCode: TLQV,
          source: 'ops_api',
          saleNumber: ORDER_ID,
          // What Ops API holds for the sale; billing comes from Mercado Libre.
          buyerData: {
            nombreDestinatario: 'DANI_CASTROAR',
            telefono: null,
            email: null,
          },
          meliOrderIds: options.meliOrderIds ?? [ORDER_ID],
          rawPayload: {},
        } satisfies TlqvOrderDetails,
      }),
    },
    meliOrders: {
      getByOrderId: jest
        .fn()
        .mockResolvedValue({ found: true, order: createMeliOrder() }),
    },
    costosOperaciones: {
      getByTlqvCode: jest
        .fn()
        .mockResolvedValue(createCostosRow(options.costosSalePrice)),
    },
    createClienteUseCaseFactory: jest.fn(
      (orderDetailsRepository: IGetTlqvOrderDetailsRepository) => {
        orderDetailsRepositories.push(orderDetailsRepository);
        return { execute: jest.fn().mockResolvedValue(clienteFlow) };
      },
    ) as jest.Mock,
    createInvoice: {
      create: jest.fn().mockResolvedValue({
        invoice: {
          transaccionId: 79000001,
          numeroDocumento: 'B-00008-00004100',
        },
        rawPayload: {},
        xubioPayload: {} as never,
      }),
    },
  };
}

function createCostosRow(salePrice = '$386,749.16') {
  return {
    found: true as const,
    tlqvCode: TLQV,
    item: {
      rowNumber: 18000,
      data: { OPERACIÓN: TLQV, 'Precio de venta': salePrice },
    },
  };
}

function createClienteFlow(
  condicionImpositiva = 'CONSUMIDOR FINAL',
): CreateXubioClienteFromTlqvResponse {
  return {
    status: 'already_exists',
    canContinue: true,
    tlqvCode: TLQV,
    prepare: {} as never,
    fiscalInfo: {
      documentoNro: '24.574.352',
      documentoNroDigits: '24574352',
      documentoTipo: 'CUIT',
      razonSocial: 'Dante Daniel Castro',
      condicionImpositiva,
      rawPayload: {},
    },
    xubioClienteResult: {
      status: 'already_exists',
      created: false,
      cliente: {
        clienteId: 10503039,
        nombre: 'Dante Daniel Castro',
        rawPayload: {},
      },
      rawPayload: {},
    },
  };
}

/** Order 2000019813708728 as mercadolibre-api returned it. */
function createMeliOrder(
  overrides: Partial<MeliOrderDetail> = {},
): MeliOrderDetail {
  return {
    id: ORDER_ID,
    packId: '2000016292307607',
    status: 'paid',
    currencyId: 'ARS',
    totalAmount: 386749.16,
    paidAmount: 386749.16,
    items: [
      {
        itemId: 'MLA1694487515',
        title:
          'Cámara De Acción 4k 30fps Go11-us, Portátil Para Vlogging, I Color',
        sellerSku: 'B0FPQ5PRP9',
        quantity: 1,
        unitPrice: 386749.16,
      },
    ],
    billing: {
      firstName: 'Dante Daniel',
      lastName: 'Castro',
      identificationType: 'DNI',
      identificationNumber: '24574352',
      taxpayerTypeDescription: 'Consumidor Final',
      address: {
        streetName: 'Avenida 2 de Abril',
        streetNumber: '3449',
        cityName: 'San Salvador de Jujuy',
        stateName: 'Jujuy',
        zipCode: '4604',
      },
    },
    rawPayload: {},
    ...overrides,
  };
}

function createMadreWithoutInvoices() {
  return {
    createSyncRun: jest.fn(),
    updateSyncRun: jest.fn(),
    upsertBatch: jest.fn(),
    findByTlqvCodes: jest.fn(),
    findByTlqvCode: jest.fn(),
    findFullByTlqvCode: jest.fn().mockResolvedValue({ items: [] }),
    existsByTlqvCode: jest
      .fn()
      .mockResolvedValue({ tlqvCode: TLQV, exists: false }),
  };
}
