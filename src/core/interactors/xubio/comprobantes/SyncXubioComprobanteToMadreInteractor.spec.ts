import { SyncXubioComprobanteToMadreInteractor } from './SyncXubioComprobanteToMadreInteractor';

describe('SyncXubioComprobanteToMadreInteractor', () => {
  it('copies the comprobante to Madre as the backfill would', async () => {
    const dependencies = createDependencies();
    const interactor = createInteractor(dependencies);

    await interactor.execute({ transaccionId: 80000001 });

    expect(dependencies.detail.getDetail).toHaveBeenCalledWith({
      transaccionId: 80000001,
    });
    expect(dependencies.madre.upsertBatch).toHaveBeenCalledTimes(1);
    const [command] = dependencies.madre.upsertBatch.mock.calls[0] as [
      { items: Record<string, unknown>[] },
    ];
    expect(command.items).toHaveLength(1);
    expect(command.items[0]).toMatchObject({
      xubioTransactionId: 80000001,
      // No backfill run to attach it to.
      syncRunId: null,
      source: 'api',
      numeroDocumento: 'B-00008-00004100',
      documentKind: 'INVOICE',
      letraComprobante: 'B',
      // What the duplicate check looks for.
      tlqvCode: 'TLQV-23500',
      tlqvNumber: 23500,
      mlOrderId: '2000019813708728',
      importeTotal: 386749.16,
      cae: null,
      fiscalmenteEmitido: false,
    });
    expect(command.items[0].rawListPayload).toBeUndefined();
  });

  it('fails when Madre reports it did not store it', async () => {
    const dependencies = createDependencies();
    dependencies.madre.upsertBatch.mockResolvedValue({
      received: 1,
      failed: 1,
    });
    const interactor = createInteractor(dependencies);

    await expect(
      interactor.execute({ transaccionId: 80000001 }),
    ).rejects.toThrow('Madre no guardó el comprobante 80000001');
  });
});

function createInteractor(
  dependencies: ReturnType<typeof createDependencies>,
): SyncXubioComprobanteToMadreInteractor {
  return new SyncXubioComprobanteToMadreInteractor(
    dependencies.detail,
    dependencies.madre,
  );
}

function createDependencies() {
  const reference = { ID: 1, id: 1, nombre: 'x', codigo: 'x' };

  return {
    detail: {
      getDetail: jest.fn().mockResolvedValue({
        comprobante: {
          rawPayload: { transaccionid: 80000001 },
          transaccionid: 80000001,
          externalId: null,
          numeroDocumento: 'B-00008-00004100',
          tipo: 1,
          descripcion: 'TLQV-23500 ML: 2000019813708728',
          fecha: '2026-11-27',
          fechaVto: '2026-11-27',
          importeGravado: 319627.4,
          importeImpuestos: 67121.76,
          importetotal: 386749.16,
          importeMonPrincipal: 386749.16,
          moneda: reference,
          cotizacion: 1,
          cotizacionListaDePrecio: 1,
          circuitoContable: reference,
          deposito: reference,
          condicionDePago: 1,
          porcentajeComision: 0,
          puntoVenta: reference,
          cliente: reference,
          provincia: null,
          facturaNoExportacion: false,
          cbuinformada: false,
          mailEstado: null,
          cae: null,
          CAE: null,
          caefechaVto: null,
          transaccionProductoItems: [],
          transaccionCobranzaItems: [],
          transaccionPercepcionItems: [],
        },
      }),
    },
    madre: {
      createSyncRun: jest.fn(),
      updateSyncRun: jest.fn(),
      upsertBatch: jest.fn().mockResolvedValue({ received: 1, inserted: 1 }),
      findByTlqvCodes: jest.fn(),
      findByTlqvCode: jest.fn(),
      findFullByTlqvCode: jest.fn(),
      existsByTlqvCode: jest.fn(),
    },
  };
}
