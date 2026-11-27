import { RequestCaeInteractor } from './RequestCaeInteractor';

const ID = 79915082;

describe('RequestCaeInteractor', () => {
  describe('one comprobante', () => {
    it('shows what it would authorize and asks AFIP for nothing on dryRun', async () => {
      const dependencies = createDependencies();
      const interactor = createInteractor(dependencies);

      const result = await interactor.execute({ transaccionId: ID });

      expect(result).toEqual({
        status: 'ready',
        transaccionId: ID,
        dryRun: true,
        comprobante: {
          transaccionId: ID,
          numeroDocumento: 'A-00008-00004095',
          tipo: 1,
          fecha: '2026-11-26',
          importeTotal: 622999,
          cliente: 'CASA MAINI SRL',
          descripcion: 'TLQV-22281 ML: 2000019102174568',
          cae: null,
          caeFechaVto: null,
        },
        blockers: [],
      });
      expect(dependencies.requestCae.requestCae).not.toHaveBeenCalled();
    });

    it('requests the CAE and reports the one the comprobante ends up with', async () => {
      const dependencies = createDependencies();
      dependencies.detail.getDetail
        .mockResolvedValueOnce({ comprobante: comprobante() })
        .mockResolvedValueOnce({
          comprobante: comprobante({
            cae: '86484580124007',
            caefechaVto: [2026, 12, 6],
          }),
        });
      const interactor = createInteractor(dependencies);

      const result = await interactor.execute({
        transaccionId: ID,
        dryRun: false,
      });

      expect(dependencies.requestCae.requestCae).toHaveBeenCalledTimes(1);
      expect(dependencies.requestCae.requestCae).toHaveBeenCalledWith({
        transaccionId: ID,
      });
      expect(result.status).toBe('authorized');
      expect(result.comprobante?.cae).toBe('86484580124007');
      expect(result.comprobante?.caeFechaVto).toBe('2026-12-06');
      expect(result.blockers).toEqual([]);
    });

    it('never asks for a second CAE for a comprobante that already has one', async () => {
      const dependencies = createDependencies();
      dependencies.detail.getDetail.mockResolvedValue({
        comprobante: comprobante({ cae: '86484580124007' }),
      });
      const interactor = createInteractor(dependencies);

      const result = await interactor.execute({
        transaccionId: ID,
        dryRun: false,
      });

      expect(result.status).toBe('skipped');
      expect(result.blockers[0].code).toBe('ALREADY_HAS_CAE');
      expect(dependencies.requestCae.requestCae).not.toHaveBeenCalled();
    });

    it('reads the CAE from the upper-case field too', async () => {
      const dependencies = createDependencies();
      dependencies.detail.getDetail.mockResolvedValue({
        comprobante: comprobante({ cae: null, CAE: '86484580124007' }),
      });
      const interactor = createInteractor(dependencies);

      const result = await interactor.execute({ transaccionId: ID });

      expect(result.status).toBe('skipped');
    });

    it('reports AFIP rejection with the reason Xubio gives', async () => {
      const dependencies = createDependencies();
      dependencies.requestCae.requestCae.mockResolvedValue({
        transaccionId: ID,
        cae: null,
        detail: 'El receptor del comprobante no coincide con el padrón.',
        rawPayload: {},
      });
      const interactor = createInteractor(dependencies);

      const result = await interactor.execute({
        transaccionId: ID,
        dryRun: false,
      });

      expect(result.status).toBe('blocked');
      expect(result.blockers).toEqual([
        {
          code: 'CAE_REJECTED',
          message:
            'No se obtuvo el CAE del comprobante A-00008-00004095. El receptor del comprobante no coincide con el padrón.',
        },
      ]);
    });

    it('reports a rejection that comes back as an HTTP error', async () => {
      const dependencies = createDependencies();
      dependencies.requestCae.requestCae.mockRejectedValue(
        new Error(
          'HTTP 400 - {"description":"El comprobante 4094 no tiene CAE"}',
        ),
      );
      const interactor = createInteractor(dependencies);

      const result = await interactor.execute({
        transaccionId: ID,
        dryRun: false,
      });

      expect(result.status).toBe('blocked');
      expect(result.blockers[0].code).toBe('CAE_REJECTED');
      expect(result.blockers[0].message).toContain('no tiene CAE');
    });

    it('finds out the truth when Xubio never answered: the CAE had been granted', async () => {
      const dependencies = createDependencies();
      dependencies.requestCae.requestCae.mockRejectedValue(
        Object.assign(new Error('timeout of 60000ms exceeded'), {
          outcomeUnknown: true,
        }),
      );
      dependencies.detail.getDetail
        .mockResolvedValueOnce({ comprobante: comprobante() })
        .mockResolvedValueOnce({
          comprobante: comprobante({ cae: '86484580124007' }),
        });
      const interactor = createInteractor(dependencies);

      const result = await interactor.execute({
        transaccionId: ID,
        dryRun: false,
      });

      // The answer was lost, the CAE was not: reading the comprobante settles it.
      expect(result.status).toBe('authorized');
      expect(result.comprobante?.cae).toBe('86484580124007');
    });

    it('says a retry is safe when Xubio never answered and there is still no CAE', async () => {
      const dependencies = createDependencies();
      dependencies.requestCae.requestCae.mockRejectedValue(
        Object.assign(new Error('timeout of 60000ms exceeded'), {
          outcomeUnknown: true,
        }),
      );
      const interactor = createInteractor(dependencies);

      const result = await interactor.execute({
        transaccionId: ID,
        dryRun: false,
      });

      expect(result.status).toBe('blocked');
      expect(result.blockers[0].code).toBe('CAE_REQUEST_OUTCOME_UNKNOWN');
      expect(result.blockers[0].message).toContain('Se puede reintentar');
    });

    it('does not claim a result it could not confirm', async () => {
      const dependencies = createDependencies();
      dependencies.detail.getDetail
        .mockResolvedValueOnce({ comprobante: comprobante() })
        .mockRejectedValueOnce(new Error('timeout'));
      const interactor = createInteractor(dependencies);

      const result = await interactor.execute({
        transaccionId: ID,
        dryRun: false,
      });

      expect(result.status).toBe('blocked');
      expect(result.blockers[0].code).toBe('CAE_REQUEST_OUTCOME_UNKNOWN');
    });

    it('skips a comprobante that was deleted in Xubio: there is nothing to authorize', async () => {
      const dependencies = createDependencies();
      dependencies.detail.getDetail.mockRejectedValue(
        Object.assign(new Error('no existe'), { notFound: true }),
      );
      const interactor = createInteractor(dependencies);

      const result = await interactor.execute({
        transaccionId: ID,
        dryRun: false,
      });

      expect(result.status).toBe('skipped');
      expect(result.blockers[0].code).toBe('COMPROBANTE_DELETED_IN_XUBIO');
      expect(dependencies.requestCae.requestCae).not.toHaveBeenCalled();
    });

    it('blocks without asking AFIP when the comprobante cannot be read', async () => {
      const dependencies = createDependencies();
      dependencies.detail.getDetail.mockRejectedValue(new Error('HTTP 404'));
      const interactor = createInteractor(dependencies);

      const result = await interactor.execute({
        transaccionId: ID,
        dryRun: false,
      });

      expect(result.status).toBe('blocked');
      expect(result.blockers[0].code).toBe('XUBIO_COMPROBANTE_LOOKUP_FAILED');
      expect(dependencies.requestCae.requestCae).not.toHaveBeenCalled();
    });
  });

  describe('every comprobante of a TLQV', () => {
    it('goes through them oldest first, the order AFIP authorizes a numbering in', async () => {
      const dependencies = createDependencies();
      dependencies.madre.findByTlqvCode.mockResolvedValue({
        items: [
          { tlqvCode: 'TLQV-22281', xubioTransactionId: 79915090 },
          { tlqvCode: 'TLQV-22281', xubioTransactionId: 79915082 },
          // Repeated and unusable rows must not become requests.
          { tlqvCode: 'TLQV-22281', xubioTransactionId: 79915082 },
          { tlqvCode: 'TLQV-22281', xubioTransactionId: null },
        ],
      });
      const interactor = createInteractor(dependencies);

      const result = await interactor.executeForTlqv({
        tlqvCode: 'tlqv-22281',
      });

      expect(result.tlqvCode).toBe('TLQV-22281');
      expect(result.results.map((item) => item.transaccionId)).toEqual([
        79915082, 79915090,
      ]);
      expect(result.status).toBe('ready');
    });

    it('is skipped as a whole when none of them needs a CAE', async () => {
      const dependencies = createDependencies();
      dependencies.detail.getDetail.mockResolvedValue({
        comprobante: comprobante({ cae: '86484580124007' }),
      });
      const interactor = createInteractor(dependencies);

      const result = await interactor.executeForTlqv({
        tlqvCode: 'TLQV-22281',
        dryRun: false,
      });

      expect(result.status).toBe('skipped');
      expect(dependencies.requestCae.requestCae).not.toHaveBeenCalled();
    });

    it('is blocked as a whole when any of them was, carrying its reason', async () => {
      const dependencies = createDependencies();
      dependencies.madre.findByTlqvCode.mockResolvedValue({
        items: [
          { tlqvCode: 'TLQV-22281', xubioTransactionId: 1 },
          { tlqvCode: 'TLQV-22281', xubioTransactionId: 2 },
        ],
      });
      dependencies.detail.getDetail
        .mockResolvedValueOnce({ comprobante: comprobante({ cae: 'X' }) })
        .mockRejectedValueOnce(new Error('HTTP 500'));
      const interactor = createInteractor(dependencies);

      const result = await interactor.executeForTlqv({
        tlqvCode: 'TLQV-22281',
      });

      expect(result.status).toBe('blocked');
      expect(result.blockers).toEqual([
        expect.objectContaining({ code: 'XUBIO_COMPROBANTE_LOOKUP_FAILED' }),
      ]);
    });

    it('blocks when the TLQV has no comprobante in Madre yet, and says how to go on', async () => {
      const dependencies = createDependencies();
      dependencies.madre.findByTlqvCode.mockResolvedValue({ items: [] });
      const interactor = createInteractor(dependencies);

      const result = await interactor.executeForTlqv({
        tlqvCode: 'TLQV-22281',
      });

      expect(result.status).toBe('blocked');
      expect(result.blockers[0].code).toBe('NO_COMPROBANTE');
      expect(result.blockers[0].message).toContain('ID del comprobante');
    });

    it('blocks when Madre cannot be read', async () => {
      const dependencies = createDependencies();
      dependencies.madre.findByTlqvCode.mockRejectedValue(new Error('timeout'));
      const interactor = createInteractor(dependencies);

      const result = await interactor.executeForTlqv({
        tlqvCode: 'TLQV-22281',
      });

      expect(result.status).toBe('blocked');
      expect(result.blockers[0].code).toBe('COMPROBANTES_LOOKUP_FAILED');
    });
  });

  describe('planning a batch', () => {
    it('orders every comprobante oldest first across the whole batch', async () => {
      const dependencies = createDependencies();
      dependencies.madre.findByTlqvCodes.mockResolvedValue({
        items: [
          {
            tlqvCode: 'TLQV-22323',
            xubioTransactionId: 300,
            numeroDocumento: 'B-00008-00004102',
          },
          {
            tlqvCode: 'TLQV-22281',
            xubioTransactionId: 100,
            numeroDocumento: 'A-00008-00004095',
          },
          { tlqvCode: 'TLQV-22281', xubioTransactionId: null },
        ],
      });
      const interactor = createInteractor(dependencies);

      const plan = await interactor.planBulk({
        tlqvCodes: ['tlqv-22323', 'TLQV-22281', 'TLQV-22281', 'TLQV-99999'],
        transaccionIds: [200, 100, 200],
      });

      expect(dependencies.madre.findByTlqvCodes).toHaveBeenCalledWith({
        tlqvCodes: ['TLQV-22323', 'TLQV-22281', 'TLQV-99999'],
      });
      expect(plan.items).toEqual([
        {
          transaccionId: 100,
          tlqvCode: 'TLQV-22281',
          numeroDocumento: 'A-00008-00004095',
        },
        { transaccionId: 200, tlqvCode: null, numeroDocumento: null },
        {
          transaccionId: 300,
          tlqvCode: 'TLQV-22323',
          numeroDocumento: 'B-00008-00004102',
        },
      ]);
      expect(plan.tlqvCodesWithoutComprobante).toEqual(['TLQV-99999']);
    });

    it('does not ask Madre when only comprobante IDs were given', async () => {
      const dependencies = createDependencies();
      const interactor = createInteractor(dependencies);

      const plan = await interactor.planBulk({ transaccionIds: [7, 3] });

      expect(plan.items.map((item) => item.transaccionId)).toEqual([3, 7]);
      expect(dependencies.madre.findByTlqvCodes).not.toHaveBeenCalled();
      expect(dependencies.detail.getDetail).not.toHaveBeenCalled();
    });
  });
});

function createInteractor(
  dependencies: ReturnType<typeof createDependencies>,
): RequestCaeInteractor {
  return new RequestCaeInteractor(
    dependencies.detail,
    dependencies.requestCae,
    dependencies.madre,
  );
}

function createDependencies() {
  return {
    detail: {
      getDetail: jest.fn().mockResolvedValue({ comprobante: comprobante() }),
    },
    requestCae: {
      requestCae: jest.fn().mockResolvedValue({
        transaccionId: ID,
        cae: '86484580124007',
        detail: null,
        rawPayload: {},
      }),
    },
    madre: {
      createSyncRun: jest.fn(),
      updateSyncRun: jest.fn(),
      upsertBatch: jest.fn(),
      findByTlqvCodes: jest.fn(),
      findFullByTlqvCode: jest.fn(),
      existsByTlqvCode: jest.fn(),
      findByTlqvCode: jest.fn().mockResolvedValue({
        items: [{ tlqvCode: 'TLQV-22281', xubioTransactionId: ID }],
      }),
    },
  };
}

function comprobante(overrides: Record<string, unknown> = {}) {
  return {
    transaccionid: ID,
    numeroDocumento: 'A-00008-00004095',
    tipo: 1,
    fecha: '2026-11-26',
    importetotal: 622999,
    cliente: { ID: 1, id: 1, nombre: 'CASA MAINI SRL', codigo: '' },
    descripcion: 'TLQV-22281 ML: 2000019102174568',
    cae: null,
    CAE: null,
    caefechaVto: null,
    ...overrides,
  };
}
