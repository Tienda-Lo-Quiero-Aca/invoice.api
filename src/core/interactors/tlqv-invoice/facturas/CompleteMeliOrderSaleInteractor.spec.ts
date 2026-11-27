import { CompleteMeliOrderSaleInteractor } from './CompleteMeliOrderSaleInteractor';

const TLQV = 'TLQV-23500';
const ID = 80000001;
const NUMERO = 'B-00008-00004100';
const CAE = '86484580124099';

describe('CompleteMeliOrderSaleInteractor', () => {
  it('issues the factura, gets its CAE and sends it to Mercado Libre', async () => {
    const dependencies = createDependencies();
    const interactor = createInteractor(dependencies);

    const result = await interactor.execute({
      tlqvCode: 'tlqv-23500',
      dryRun: false,
      issueDate: '2026-11-27',
    });

    expect(dependencies.createInvoice.execute).toHaveBeenCalledWith({
      tlqvCode: TLQV,
      dryRun: false,
      issueDate: '2026-11-27',
    });
    expect(dependencies.requestCae.execute).toHaveBeenCalledWith({
      transaccionId: ID,
      dryRun: false,
    });
    // By ID: Mercado Libre gets the factura issued a moment ago.
    expect(dependencies.sendToMeli.execute).toHaveBeenCalledWith({
      tlqvCode: TLQV,
      transaccionId: ID,
      dryRun: false,
    });
    expect(result).toEqual({
      status: 'completed',
      tlqvCode: TLQV,
      dryRun: false,
      invoice: {
        status: 'created',
        transaccionId: ID,
        numeroDocumento: NUMERO,
        totalAmount: 386749.16,
      },
      cae: { status: 'authorized', cae: CAE, caeFechaVto: '2026-12-07' },
      meli: {
        status: 'sent',
        meliOrderId: '2000019813708728',
        meliPackId: '2000019813708728',
      },
      madreSync: { status: 'synced' },
      blockers: [],
    });
  });

  it('copies the new factura to Madre before asking for the CAE', async () => {
    const dependencies = createDependencies();
    const order: string[] = [];
    dependencies.syncToMadre.execute.mockImplementation(() => {
      order.push('madre');
      return Promise.resolve();
    });
    dependencies.requestCae.execute.mockImplementation(() => {
      order.push('cae');
      return Promise.resolve(caeAnswer('authorized'));
    });
    const interactor = createInteractor(dependencies);

    await interactor.execute({ tlqvCode: TLQV, dryRun: false });

    // First so a second run finds it; again so Madre shows the CAE.
    expect(order).toEqual(['madre', 'cae', 'madre']);
  });

  describe('on dryRun', () => {
    it('only builds the factura: nothing is issued, requested nor sent', async () => {
      const dependencies = createDependencies();
      dependencies.createInvoice.execute.mockResolvedValue(
        invoiceAnswer({ created: false }),
      );
      const interactor = createInteractor(dependencies);

      const result = await interactor.execute({ tlqvCode: TLQV });

      expect(dependencies.createInvoice.execute).toHaveBeenCalledWith(
        expect.objectContaining({ dryRun: true }),
      );
      expect(result.status).toBe('ready');
      expect(result.invoice).toEqual({
        status: 'ready',
        totalAmount: 386749.16,
      });
      expect(result.cae.status).toBe('pending');
      expect(result.meli.status).toBe('pending');
      expect(dependencies.requestCae.execute).not.toHaveBeenCalled();
      expect(dependencies.sendToMeli.execute).not.toHaveBeenCalled();
      expect(dependencies.syncToMadre.execute).not.toHaveBeenCalled();
    });
  });

  describe('stops at the first stage that cannot go on', () => {
    it('at the factura, and then asks for no CAE', async () => {
      const dependencies = createDependencies();
      const blocked = invoiceBlocked('INVOICE_TOTAL_SALE_PRICE_MISMATCH');
      dependencies.createInvoice.execute.mockResolvedValue(blocked);
      const interactor = createInteractor(dependencies);

      const result = await interactor.execute({
        tlqvCode: TLQV,
        dryRun: false,
      });

      expect(result.status).toBe('blocked');
      expect(result.stoppedAt).toBe('invoice');
      expect(result.blockers).toEqual([
        {
          stage: 'invoice',
          code: 'INVOICE_TOTAL_SALE_PRICE_MISMATCH',
          message: 'motivo',
        },
      ]);
      expect(result.invoiceFlow).toBe(blocked);
      expect(dependencies.requestCae.execute).not.toHaveBeenCalled();
      expect(dependencies.sendToMeli.execute).not.toHaveBeenCalled();
    });

    it('at the CAE, and then sends nothing to Mercado Libre', async () => {
      const dependencies = createDependencies();
      dependencies.requestCae.execute.mockResolvedValue({
        ...caeAnswer('blocked'),
        blockers: [{ code: 'CAE_REJECTED', message: 'AFIP lo rechazó' }],
      });
      const interactor = createInteractor(dependencies);

      const result = await interactor.execute({
        tlqvCode: TLQV,
        dryRun: false,
      });

      expect(result.status).toBe('blocked');
      expect(result.stoppedAt).toBe('cae');
      // The factura stays issued, and the answer says which one it is.
      expect(result.invoice).toEqual(
        expect.objectContaining({ status: 'created', transaccionId: ID }),
      );
      expect(result.cae.status).toBe('blocked');
      expect(result.meli.status).toBe('pending');
      expect(result.blockers).toEqual([
        { stage: 'cae', code: 'CAE_REJECTED', message: 'AFIP lo rechazó' },
      ]);
      expect(dependencies.sendToMeli.execute).not.toHaveBeenCalled();
    });

    it('at Mercado Libre, with the factura and its CAE already done', async () => {
      const dependencies = createDependencies();
      dependencies.sendToMeli.execute.mockResolvedValue({
        status: 'blocked',
        tlqvCode: TLQV,
        dryRun: false,
        meliOrderId: '2000019813708728',
        blockers: [
          { code: 'MELI_INVOICE_UPLOAD_FAILED', message: 'no respondió' },
        ],
      });
      const interactor = createInteractor(dependencies);

      const result = await interactor.execute({
        tlqvCode: TLQV,
        dryRun: false,
      });

      expect(result.status).toBe('blocked');
      expect(result.stoppedAt).toBe('meli');
      expect(result.invoice.status).toBe('created');
      expect(result.cae.status).toBe('authorized');
      expect(result.meli.status).toBe('blocked');
    });

    it('when Xubio issued the factura without saying which one it is', async () => {
      const dependencies = createDependencies();
      dependencies.createInvoice.execute.mockResolvedValue(
        invoiceAnswer({ transaccionId: null }),
      );
      const interactor = createInteractor(dependencies);

      const result = await interactor.execute({
        tlqvCode: TLQV,
        dryRun: false,
      });

      expect(result.stoppedAt).toBe('invoice');
      expect(result.blockers[0].code).toBe('XUBIO_TRANSACCION_ID_MISSING');
      expect(dependencies.requestCae.execute).not.toHaveBeenCalled();
    });
  });

  describe('a sale that already has a factura', () => {
    it('goes on with it instead of issuing another one', async () => {
      const dependencies = createDependencies();
      dependencies.madre.findFullByTlqvCode.mockResolvedValue({
        items: [madreFactura(ID, NUMERO, '2026-11-27')],
      });
      const interactor = createInteractor(dependencies);

      const result = await interactor.execute({
        tlqvCode: TLQV,
        dryRun: false,
      });

      expect(dependencies.createInvoice.execute).not.toHaveBeenCalled();
      expect(result.status).toBe('completed');
      expect(result.invoice).toEqual({
        status: 'existing',
        transaccionId: ID,
        numeroDocumento: NUMERO,
        totalAmount: 386749.16,
      });
      expect(dependencies.requestCae.execute).toHaveBeenCalledWith({
        transaccionId: ID,
        dryRun: false,
      });
      expect(dependencies.sendToMeli.execute).toHaveBeenCalledWith(
        expect.objectContaining({ transaccionId: ID }),
      );
    });

    it('asks for no CAE it already has and sends nothing Mercado Libre already has', async () => {
      const dependencies = createDependencies();
      dependencies.madre.findFullByTlqvCode.mockResolvedValue({
        items: [madreFactura(ID, NUMERO, '2026-11-27')],
      });
      dependencies.requestCae.execute.mockResolvedValue(caeAnswer('skipped'));
      dependencies.sendToMeli.execute.mockResolvedValue({
        ...meliAnswer('skipped'),
        blockers: [{ code: 'MELI_INVOICE_ALREADY_SENT', message: 'ya está' }],
      });
      const interactor = createInteractor(dependencies);

      const result = await interactor.execute({
        tlqvCode: TLQV,
        dryRun: false,
      });

      // Running a finished sale again changes nothing and reports it done.
      expect(result.status).toBe('completed');
      expect(result.cae.status).toBe('already_had');
      expect(result.meli.status).toBe('already_sent');
      expect(result.blockers).toEqual([]);
      // Nothing new in Xubio, so nothing to copy to Madre.
      expect(dependencies.syncToMadre.execute).not.toHaveBeenCalled();
    });

    it('takes the factura that stands, not one a nota de crédito cancelled', async () => {
      const dependencies = createDependencies();
      dependencies.madre.findFullByTlqvCode.mockResolvedValue({
        items: [
          madreFactura(70000001, 'B-00008-00003000', '2026-11-20'),
          {
            xubioTransactionId: 70000002,
            documentKind: 'CREDIT_NOTE',
            rawDetailPayload: { comprobante: 70000001 },
          },
          madreFactura(ID, NUMERO, '2026-11-27'),
        ],
      });
      const interactor = createInteractor(dependencies);

      const result = await interactor.execute({
        tlqvCode: TLQV,
        dryRun: false,
      });

      expect(result.invoice.transaccionId).toBe(ID);
    });

    it('issues a new one when the only factura was cancelled by a nota de crédito', async () => {
      const dependencies = createDependencies();
      dependencies.madre.findFullByTlqvCode.mockResolvedValue({
        items: [
          madreFactura(70000001, 'B-00008-00003000', '2026-11-20'),
          {
            xubioTransactionId: 70000002,
            documentKind: 'CREDIT_NOTE',
            rawDetailPayload: { comprobante: 70000001 },
          },
        ],
      });
      const interactor = createInteractor(dependencies);

      const result = await interactor.execute({
        tlqvCode: TLQV,
        dryRun: false,
      });

      expect(dependencies.createInvoice.execute).toHaveBeenCalledTimes(1);
      expect(result.invoice.status).toBe('created');
    });

    it('on dryRun shows what is left to do for it', async () => {
      const dependencies = createDependencies();
      dependencies.madre.findFullByTlqvCode.mockResolvedValue({
        items: [madreFactura(ID, NUMERO, '2026-11-27')],
      });
      dependencies.requestCae.execute.mockResolvedValue(caeAnswer('ready'));
      const interactor = createInteractor(dependencies);

      const result = await interactor.execute({ tlqvCode: TLQV });

      expect(result.status).toBe('ready');
      expect(result.invoice.status).toBe('existing');
      expect(result.cae.status).toBe('ready');
      // Without CAE there is nothing to check against Mercado Libre yet.
      expect(result.meli.status).toBe('pending');
      expect(dependencies.sendToMeli.execute).not.toHaveBeenCalled();
    });

    it('issues nothing when Madre cannot say whether it has one', async () => {
      const dependencies = createDependencies();
      dependencies.madre.findFullByTlqvCode.mockRejectedValue(
        new Error('timeout'),
      );
      const interactor = createInteractor(dependencies);

      const result = await interactor.execute({
        tlqvCode: TLQV,
        dryRun: false,
      });

      expect(result.stoppedAt).toBe('invoice');
      expect(result.blockers[0].code).toBe('COMPROBANTES_LOOKUP_FAILED');
      expect(dependencies.createInvoice.execute).not.toHaveBeenCalled();
      expect(dependencies.requestCae.execute).not.toHaveBeenCalled();
    });
  });

  it('goes on when the copy to Madre fails, and warns about running it again', async () => {
    const dependencies = createDependencies();
    dependencies.syncToMadre.execute.mockRejectedValue(new Error('HTTP 503'));
    const interactor = createInteractor(dependencies);

    const result = await interactor.execute({ tlqvCode: TLQV, dryRun: false });

    expect(result.status).toBe('completed');
    expect(result.madreSync?.status).toBe('failed');
    expect(result.madreSync?.message).toContain('no vuelvas a correr');
  });
});

function createInteractor(
  dependencies: ReturnType<typeof createDependencies>,
): CompleteMeliOrderSaleInteractor {
  return new CompleteMeliOrderSaleInteractor(
    dependencies.createInvoice,
    dependencies.requestCae,
    dependencies.sendToMeli,
    dependencies.syncToMadre,
    dependencies.madre,
  );
}

function createDependencies() {
  return {
    createInvoice: { execute: jest.fn().mockResolvedValue(invoiceAnswer()) },
    requestCae: {
      execute: jest.fn().mockResolvedValue(caeAnswer('authorized')),
    },
    sendToMeli: { execute: jest.fn().mockResolvedValue(meliAnswer('sent')) },
    syncToMadre: { execute: jest.fn().mockResolvedValue(undefined) },
    madre: {
      createSyncRun: jest.fn(),
      updateSyncRun: jest.fn(),
      upsertBatch: jest.fn(),
      findByTlqvCodes: jest.fn(),
      findByTlqvCode: jest.fn(),
      existsByTlqvCode: jest.fn(),
      findFullByTlqvCode: jest.fn().mockResolvedValue({ items: [] }),
    },
  };
}

function invoiceAnswer(
  options: { created?: boolean; transaccionId?: number | null } = {},
) {
  const created = options.created ?? true;

  return {
    status: 'completed' as const,
    canContinue: true as const,
    tlqvCode: TLQV,
    dryRun: !created,
    steps: [],
    invoiceBuild: { totalAmount: 386749.16 },
    createdInvoice: created
      ? {
          invoice: {
            transaccionId:
              options.transaccionId === undefined ? ID : options.transaccionId,
            numeroDocumento: NUMERO,
            importeTotal: 386749.16,
          },
        }
      : undefined,
  } as never;
}

function invoiceBlocked(code: string) {
  return {
    status: 'blocked' as const,
    canContinue: false as const,
    tlqvCode: TLQV,
    dryRun: false,
    steps: [],
    blockers: [{ code, message: 'motivo', step: 'client' as const }],
  };
}

function caeAnswer(status: 'authorized' | 'skipped' | 'ready' | 'blocked') {
  const hasCae = status === 'authorized' || status === 'skipped';

  return {
    status,
    transaccionId: ID,
    dryRun: false,
    comprobante: {
      transaccionId: ID,
      numeroDocumento: NUMERO,
      tipo: 1,
      fecha: '2026-11-27',
      importeTotal: 386749.16,
      cliente: 'Comprador',
      descripcion: `${TLQV} ML: 2000019813708728`,
      cae: hasCae ? CAE : null,
      caeFechaVto: hasCae ? '2026-12-07' : null,
    },
    blockers: [],
  };
}

function meliAnswer(status: 'sent' | 'skipped' | 'ready') {
  return {
    status,
    tlqvCode: TLQV,
    dryRun: false,
    meliOrderId: '2000019813708728',
    meliPackId: '2000019813708728',
    blockers: [],
  };
}

function madreFactura(
  xubioTransactionId: number,
  numeroDocumento: string,
  fechaEmision: string,
) {
  return {
    xubioTransactionId,
    numeroDocumento,
    fechaEmision,
    documentKind: 'INVOICE' as const,
    importeTotal: 386749.16,
  };
}
