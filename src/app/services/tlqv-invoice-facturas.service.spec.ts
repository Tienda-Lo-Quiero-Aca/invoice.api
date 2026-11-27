import { TlqvInvoiceFacturasService } from './tlqv-invoice-facturas.service';

const ID = 80000001;

describe('TlqvInvoiceFacturasService — copy to Madre', () => {
  describe('a new factura', () => {
    it.each([
      ['from the sheet', 'createFromTlqv', 'createTlqvFlow'],
      ['from the Mercado Libre order', 'createFromMeliOrder', 'createMeliFlow'],
    ] as const)('%s is copied at once', async (_label, method, dependency) => {
      const dependencies = createDependencies();
      dependencies[dependency].execute.mockResolvedValue(created());
      const service = createService(dependencies);

      const result = await service[method]({
        tlqvCode: 'TLQV-23500',
        dryRun: false,
      });

      expect(dependencies.syncToMadre.execute).toHaveBeenCalledWith({
        transaccionId: ID,
      });
      expect(result.madreSync).toEqual({ status: 'synced' });
    });

    it('is not copied on a dry run, where nothing was issued', async () => {
      const dependencies = createDependencies();
      dependencies.createTlqvFlow.execute.mockResolvedValue({
        status: 'completed',
        steps: [],
      });
      const service = createService(dependencies);

      const result = await service.createFromTlqv({ tlqvCode: 'TLQV-23500' });

      expect(dependencies.syncToMadre.execute).not.toHaveBeenCalled();
      expect(result.madreSync).toBeUndefined();
    });

    it('is not copied when the run was blocked', async () => {
      const dependencies = createDependencies();
      dependencies.createMeliFlow.execute.mockResolvedValue({
        status: 'blocked',
        blockers: [{ code: 'ALREADY_BILLED', message: 'x', step: 'client' }],
      });
      const service = createService(dependencies);

      await service.createFromMeliOrder({ tlqvCode: 'TLQV-23500' });

      expect(dependencies.syncToMadre.execute).not.toHaveBeenCalled();
    });

    it('stays issued when the copy fails, and the answer warns about it', async () => {
      const dependencies = createDependencies();
      dependencies.createTlqvFlow.execute.mockResolvedValue(created());
      dependencies.syncToMadre.execute.mockRejectedValue(new Error('HTTP 503'));
      const service = createService(dependencies);

      const result = await service.createFromTlqv({
        tlqvCode: 'TLQV-23500',
        dryRun: false,
      });

      // The factura exists in Xubio: that must reach the caller no matter what.
      expect(result.createdInvoice?.invoice.transaccionId).toBe(ID);
      expect(result.madreSync?.status).toBe('failed');
      expect(result.madreSync?.message).toContain('HTTP 503');
      expect(result.madreSync?.message).toContain('no vuelvas a facturar');
    });
  });

  it('copies a new nota de crédito at once', async () => {
    const dependencies = createDependencies();
    dependencies.createNotaCredito.execute.mockResolvedValue({
      status: 'created',
      blockers: [],
      createdNotaCredito: { invoice: { transaccionId: 80000002 } },
    });
    const service = createService(dependencies);

    const result = await service.createNotaCreditoFromTlqv({
      tlqvCode: 'TLQV-23500',
      dryRun: false,
    });

    expect(dependencies.syncToMadre.execute).toHaveBeenCalledWith({
      transaccionId: 80000002,
    });
    expect(result.madreSync).toEqual({ status: 'synced' });
  });

  describe('a CAE', () => {
    it('is copied when it was just granted', async () => {
      const dependencies = createDependencies();
      dependencies.requestCae.execute.mockResolvedValue(cae('authorized', ID));
      const service = createService(dependencies);

      const result = await service.requestCae({
        transaccionId: ID,
        dryRun: false,
      });

      expect(dependencies.syncToMadre.execute).toHaveBeenCalledWith({
        transaccionId: ID,
      });
      expect(result.madreSync).toEqual({ status: 'synced' });
    });

    it.each(['ready', 'skipped', 'blocked'] as const)(
      'is not copied when the answer is %s: nothing changed in Xubio',
      async (status) => {
        const dependencies = createDependencies();
        dependencies.requestCae.execute.mockResolvedValue(cae(status, ID));
        const service = createService(dependencies);

        const result = await service.requestCae({ transaccionId: ID });

        expect(dependencies.syncToMadre.execute).not.toHaveBeenCalled();
        expect(result.madreSync).toBeUndefined();
      },
    );

    it('by TLQV copies only the comprobantes that got one', async () => {
      const dependencies = createDependencies();
      dependencies.requestCae.executeForTlqv.mockResolvedValue({
        status: 'authorized',
        tlqvCode: 'TLQV-23500',
        dryRun: false,
        results: [cae('skipped', 1), cae('authorized', 2)],
        blockers: [],
      });
      const service = createService(dependencies);

      const result = await service.requestCaeForTlqv({
        tlqvCode: 'TLQV-23500',
        dryRun: false,
      });

      expect(dependencies.syncToMadre.execute).toHaveBeenCalledTimes(1);
      expect(dependencies.syncToMadre.execute).toHaveBeenCalledWith({
        transaccionId: 2,
      });
      expect(result.results.map((item) => item.madreSync?.status)).toEqual([
        undefined,
        'synced',
      ]);
    });
  });
});

function created() {
  return {
    status: 'completed',
    steps: [],
    createdInvoice: { invoice: { transaccionId: ID } },
  };
}

function cae(status: string, transaccionId: number) {
  return { status, transaccionId, dryRun: false, blockers: [] };
}

function createDependencies() {
  return {
    createTlqvFlow: { execute: jest.fn() },
    deleteInvoice: { execute: jest.fn() },
    createNotaCredito: { execute: jest.fn() },
    createMeliFlow: { execute: jest.fn() },
    sendToMeli: { execute: jest.fn() },
    requestCae: {
      execute: jest.fn(),
      executeForTlqv: jest.fn(),
      planBulk: jest.fn(),
    },
    completeSale: { execute: jest.fn() },
    syncToMadre: { execute: jest.fn().mockResolvedValue(undefined) },
    issueRecorder: {
      recordBlocked: jest.fn().mockResolvedValue(undefined),
      recordUnhandledFailure: jest.fn().mockResolvedValue(undefined),
    },
  };
}

function createService(
  dependencies: ReturnType<typeof createDependencies>,
): TlqvInvoiceFacturasService {
  return new TlqvInvoiceFacturasService(
    dependencies.createTlqvFlow as never,
    dependencies.deleteInvoice as never,
    dependencies.createNotaCredito as never,
    dependencies.createMeliFlow as never,
    dependencies.sendToMeli as never,
    dependencies.requestCae as never,
    dependencies.completeSale as never,
    dependencies.syncToMadre as never,
    dependencies.issueRecorder as never,
  );
}
