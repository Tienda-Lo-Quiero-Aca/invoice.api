import type { MadreXubioComprobante } from '../../../../../entities/madre-api/xubio/comprobantes/MadreXubioComprobante';
import { PrepareTlqvInvoiceInteractor } from '../../../../../interactors/tlqv-invoice/preparacion/PrepareTlqvInvoiceInteractor';
import { XubioVerifiedMadreComprobantesRepository } from './XubioVerifiedMadreComprobantesRepository';

const TLQV = 'TLQV-24016';
const notFound = () =>
  Object.assign(new Error('no existe'), { notFound: true });

describe('XubioVerifiedMadreComprobantesRepository', () => {
  it('leaves out a factura that was deleted in Xubio', async () => {
    const dependencies = createDependencies([factura(79961340, { cae: null })]);
    dependencies.detail.getDetail.mockRejectedValue(notFound());
    const onDeleted = jest.fn();
    const repository = createRepository(dependencies, onDeleted);

    const result = await repository.findFullByTlqvCode({ tlqvCode: TLQV });

    expect(result.items).toEqual([]);
    expect(dependencies.detail.getDetail).toHaveBeenCalledWith({
      transaccionId: 79961340,
    });
    expect(onDeleted).toHaveBeenCalledWith(
      expect.objectContaining({ xubioTransactionId: 79961340 }),
    );
  });

  it('keeps a comprobante that exists in Xubio', async () => {
    const dependencies = createDependencies([factura(1, { cae: null })]);
    const repository = createRepository(dependencies);

    const result = await repository.findFullByTlqvCode({ tlqvCode: TLQV });

    expect(result.items).toHaveLength(1);
  });

  it('keeps it when Xubio cannot be asked: in doubt, the sale stays invoiced', async () => {
    const dependencies = createDependencies([factura(1, { cae: null })]);
    dependencies.detail.getDetail.mockRejectedValue(new Error('timeout'));
    const repository = createRepository(dependencies);

    const result = await repository.findFullByTlqvCode({ tlqvCode: TLQV });

    expect(result.items).toHaveLength(1);
  });

  it('does not ask about a comprobante with CAE, which cannot be deleted', async () => {
    const dependencies = createDependencies([
      factura(1, { cae: '86484580124007' }),
      factura(2, { cae: null, fiscalmenteEmitido: true }),
    ]);
    const repository = createRepository(dependencies);

    const result = await repository.findFullByTlqvCode({ tlqvCode: TLQV });

    expect(result.items).toHaveLength(2);
    expect(dependencies.detail.getDetail).not.toHaveBeenCalled();
  });

  describe('seen from the duplicate check', () => {
    it('a sale whose only factura was deleted can be invoiced again', async () => {
      const dependencies = createDependencies([
        factura(79961340, { cae: null }),
      ]);
      dependencies.detail.getDetail.mockRejectedValue(notFound());
      const prepare = new PrepareTlqvInvoiceInteractor(
        createRepository(dependencies),
      );

      const result = await prepare.execute({ tlqvCode: TLQV });

      expect(result.isBilled).toBe(false);
      expect(result.canContinue).toBe(true);
    });

    it('a sale whose factura exists stays blocked', async () => {
      const dependencies = createDependencies([factura(1, { cae: null })]);
      const prepare = new PrepareTlqvInvoiceInteractor(
        createRepository(dependencies),
      );

      const result = await prepare.execute({ tlqvCode: TLQV });

      expect(result.isBilled).toBe(true);
      expect(result.blockers[0].code).toBe('ALREADY_BILLED');
    });

    it('a deleted nota de crédito does not leave its factura looking cancelled', async () => {
      const dependencies = createDependencies([
        factura(1, { cae: '86484580124007' }),
        {
          xubioTransactionId: 2,
          documentKind: 'CREDIT_NOTE',
          fechaEmision: '2026-11-27',
          cae: null,
          rawDetailPayload: { comprobante: 1 },
        },
      ]);
      // The nota de crédito is the only one asked about: it has no CAE.
      dependencies.detail.getDetail.mockRejectedValue(notFound());
      const prepare = new PrepareTlqvInvoiceInteractor(
        createRepository(dependencies),
      );

      const result = await prepare.execute({ tlqvCode: TLQV });

      // Without the check this sale would be invoiced a second time.
      expect(result.isBilled).toBe(true);
    });
  });

  it('passes everything else straight to Madre', async () => {
    const dependencies = createDependencies([]);
    const repository = createRepository(dependencies);

    await repository.existsByTlqvCode({ tlqvCode: TLQV });
    await repository.findByTlqvCode({ tlqvCode: TLQV });
    await repository.findByTlqvCodes({ tlqvCodes: [TLQV] });
    await repository.upsertBatch({ items: [factura(1, {})] });

    expect(dependencies.madre.existsByTlqvCode).toHaveBeenCalledTimes(1);
    expect(dependencies.madre.findByTlqvCode).toHaveBeenCalledTimes(1);
    expect(dependencies.madre.findByTlqvCodes).toHaveBeenCalledTimes(1);
    expect(dependencies.madre.upsertBatch).toHaveBeenCalledTimes(1);
    expect(dependencies.detail.getDetail).not.toHaveBeenCalled();
  });
});

function createRepository(
  dependencies: ReturnType<typeof createDependencies>,
  onDeleted?: (comprobante: MadreXubioComprobante) => void,
): XubioVerifiedMadreComprobantesRepository {
  return new XubioVerifiedMadreComprobantesRepository(
    dependencies.madre,
    dependencies.detail,
    onDeleted,
  );
}

function createDependencies(items: MadreXubioComprobante[]) {
  return {
    madre: {
      createSyncRun: jest.fn(),
      updateSyncRun: jest.fn(),
      upsertBatch: jest.fn().mockResolvedValue({}),
      findByTlqvCodes: jest.fn().mockResolvedValue({ items: [] }),
      findByTlqvCode: jest.fn().mockResolvedValue({ items: [] }),
      existsByTlqvCode: jest
        .fn()
        .mockResolvedValue({ tlqvCode: TLQV, exists: items.length > 0 }),
      findFullByTlqvCode: jest.fn().mockResolvedValue({ items }),
    },
    detail: { getDetail: jest.fn().mockResolvedValue({ comprobante: {} }) },
  };
}

function factura(
  xubioTransactionId: number,
  overrides: Partial<MadreXubioComprobante>,
): MadreXubioComprobante {
  return {
    xubioTransactionId,
    documentKind: 'INVOICE',
    numeroDocumento: 'A-00008-00004151',
    fechaEmision: '2026-11-27',
    rawDetailPayload: {},
    tlqvCode: TLQV,
    ...overrides,
  };
}
