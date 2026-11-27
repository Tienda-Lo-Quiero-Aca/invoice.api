import type { MadreXubioComprobante } from '../../../entities/madre-api/xubio/comprobantes/MadreXubioComprobante';
import { SendInvoiceToMeliInteractor } from './SendInvoiceToMeliInteractor';

const TLQV = 'TLQV-19989';
const ORDER_ID = '2000018498993478';
const PDF = Buffer.from('%PDF-1.4 factura de prueba');

describe('SendInvoiceToMeliInteractor', () => {
  it('checks everything and uploads nothing on dryRun', async () => {
    const dependencies = createDependencies();
    const interactor = createInteractor(dependencies);

    const result = await interactor.execute({ tlqvCode: 'tlqv-19989' });

    expect(result).toEqual({
      status: 'ready',
      tlqvCode: TLQV,
      dryRun: true,
      invoice: {
        xubioTransactionId: 77777299,
        numeroDocumento: 'B-00008-00003981',
        cae: '86395384692268',
        fechaEmision: '2026-09-30',
        importeTotal: 910628.23,
      },
      meliOrderId: ORDER_ID,
      meliPackId: ORDER_ID,
      pdf: { fileName: 'B-00008-00003981.pdf', sizeInBytes: PDF.length },
      blockers: [],
    });
    expect(dependencies.meliInvoices.upload).not.toHaveBeenCalled();
  });

  it('uploads the PDF of the factura to its Mercado Libre sale', async () => {
    const dependencies = createDependencies();
    const interactor = createInteractor(dependencies);

    const result = await interactor.execute({ tlqvCode: TLQV, dryRun: false });

    expect(result.status).toBe('sent');
    expect(dependencies.invoicePdf.getPdf).toHaveBeenCalledWith({
      transaccionId: 77777299,
    });
    expect(dependencies.meliInvoices.upload).toHaveBeenCalledTimes(1);
    expect(dependencies.meliInvoices.upload).toHaveBeenCalledWith({
      orderId: ORDER_ID,
      pdf: PDF,
      fileName: 'B-00008-00003981.pdf',
      force: false,
    });
    expect(result.meliResponse).toEqual({ id: 'doc-1' });
  });

  describe('the CAE', () => {
    it('is read from Xubio at that moment, not from the copy in Madre', async () => {
      const dependencies = createDependencies();
      const interactor = createInteractor(dependencies);

      const result = await interactor.execute({ tlqvCode: TLQV });

      expect(dependencies.comprobanteDetail.getDetail).toHaveBeenCalledWith({
        transaccionId: 77777299,
      });
      expect(result.invoice?.cae).toBe('86395384692268');
    });

    it.each([null, '', '   '])(
      'blocks a factura that has none yet (%p): it is not valid for the buyer',
      async (cae) => {
        const dependencies = createDependencies();
        dependencies.comprobanteDetail.getDetail.mockResolvedValue({
          comprobante: { cae, CAE: cae },
        });
        const interactor = createInteractor(dependencies);

        const result = await interactor.execute({
          tlqvCode: TLQV,
          dryRun: false,
        });

        expectBlocked(result, 'INVOICE_WITHOUT_CAE');
        // Nothing past this point may run for a factura without CAE.
        expect(dependencies.invoicePdf.getPdf).not.toHaveBeenCalled();
        expect(dependencies.meliInvoices.upload).not.toHaveBeenCalled();
      },
    );

    it('blocks when Xubio cannot be asked', async () => {
      const dependencies = createDependencies();
      dependencies.comprobanteDetail.getDetail.mockRejectedValue(
        new Error('timeout'),
      );
      const interactor = createInteractor(dependencies);

      const result = await interactor.execute({
        tlqvCode: TLQV,
        dryRun: false,
      });

      expectBlocked(result, 'XUBIO_COMPROBANTE_LOOKUP_FAILED');
      expect(dependencies.meliInvoices.upload).not.toHaveBeenCalled();
    });
  });

  describe('which factura', () => {
    it('sends the one that stands, not the one a nota de crédito cancelled', async () => {
      const dependencies = createDependencies();
      dependencies.madre.findFullByTlqvCode.mockResolvedValue({
        items: [
          factura(76985617, 'B-00008-00003355', '2026-08-31'),
          notaCredito(77112121, 76985617),
          factura(77267759, 'A-00008-00003083', '2026-09-14'),
        ],
      });
      const interactor = createInteractor(dependencies);

      const result = await interactor.execute({ tlqvCode: TLQV });

      expect(result.invoice?.numeroDocumento).toBe('A-00008-00003083');
      expect(dependencies.invoicePdf.getPdf).toHaveBeenCalledWith({
        transaccionId: 77267759,
      });
    });

    it('blocks when the only factura was cancelled', async () => {
      const dependencies = createDependencies();
      dependencies.madre.findFullByTlqvCode.mockResolvedValue({
        items: [
          factura(76985617, 'B-00008-00003355', '2026-08-31'),
          notaCredito(77112121, 76985617),
        ],
      });
      const interactor = createInteractor(dependencies);

      const result = await interactor.execute({
        tlqvCode: TLQV,
        dryRun: false,
      });

      expectBlocked(result, 'NO_LIVE_INVOICE');
      expect(result.blockers[0].message).toContain('anuladas');
      expect(dependencies.meliInvoices.upload).not.toHaveBeenCalled();
    });

    it('blocks when the TLQV has no factura', async () => {
      const dependencies = createDependencies();
      dependencies.madre.findFullByTlqvCode.mockResolvedValue({ items: [] });
      const interactor = createInteractor(dependencies);

      const result = await interactor.execute({ tlqvCode: TLQV });

      expectBlocked(result, 'NO_LIVE_INVOICE');
    });

    it('blocks when Madre cannot be read', async () => {
      const dependencies = createDependencies();
      dependencies.madre.findFullByTlqvCode.mockRejectedValue(
        new Error('timeout'),
      );
      const interactor = createInteractor(dependencies);

      const result = await interactor.execute({ tlqvCode: TLQV });

      expectBlocked(result, 'COMPROBANTES_LOOKUP_FAILED');
    });
  });

  describe('a sale that already has a factura in Mercado Libre', () => {
    it('is skipped: the buyer must not get it twice', async () => {
      const dependencies = createDependencies();
      dependencies.meliInvoices.getStatus.mockResolvedValue({
        orderId: ORDER_ID,
        packId: ORDER_ID,
        hasInvoice: true,
        documents: [{ id: 'doc-0' }],
      });
      const interactor = createInteractor(dependencies);

      const result = await interactor.execute({
        tlqvCode: TLQV,
        dryRun: false,
      });

      expect(result.status).toBe('skipped');
      expect(result.blockers[0].code).toBe('MELI_INVOICE_ALREADY_SENT');
      expect(result.meliResponse).toEqual([{ id: 'doc-0' }]);
      expect(dependencies.invoicePdf.getPdf).not.toHaveBeenCalled();
      expect(dependencies.meliInvoices.upload).not.toHaveBeenCalled();
    });

    it('is uploaded again only with force, for the new factura after a nota de crédito', async () => {
      const dependencies = createDependencies();
      dependencies.meliInvoices.getStatus.mockResolvedValue({
        orderId: ORDER_ID,
        packId: ORDER_ID,
        hasInvoice: true,
        documents: [{ id: 'doc-0' }],
      });
      const interactor = createInteractor(dependencies);

      const result = await interactor.execute({
        tlqvCode: TLQV,
        dryRun: false,
        force: true,
      });

      expect(result.status).toBe('sent');
      expect(dependencies.meliInvoices.upload).toHaveBeenCalledWith(
        expect.objectContaining({ force: true }),
      );
    });

    it('is reported as skipped when Mercado Libre says so at upload time', async () => {
      // Someone else uploaded it between the check and the upload.
      const dependencies = createDependencies();
      dependencies.meliInvoices.upload.mockResolvedValue({
        status: 'already_has_invoice',
        orderId: ORDER_ID,
        rawPayload: { message: 'already has an invoice' },
      });
      const interactor = createInteractor(dependencies);

      const result = await interactor.execute({
        tlqvCode: TLQV,
        dryRun: false,
      });

      expect(result.status).toBe('skipped');
      expect(result.blockers[0].code).toBe('MELI_INVOICE_ALREADY_SENT');
    });
  });

  describe('blocks instead of uploading', () => {
    it('when the sale has no Mercado Libre order', async () => {
      const dependencies = createDependencies({ meliOrderIds: [] });
      const interactor = createInteractor(dependencies);

      const result = await interactor.execute({
        tlqvCode: TLQV,
        dryRun: false,
      });

      expectBlocked(result, 'MELI_ORDER_NOT_LINKED');
      expect(dependencies.meliInvoices.upload).not.toHaveBeenCalled();
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

      expectBlocked(result, 'ORDER_DETAILS_NOT_FOUND');
    });

    it('when Mercado Libre cannot say whether there is already a factura', async () => {
      const dependencies = createDependencies();
      dependencies.meliInvoices.getStatus.mockRejectedValue(
        new Error('HTTP 502'),
      );
      const interactor = createInteractor(dependencies);

      const result = await interactor.execute({
        tlqvCode: TLQV,
        dryRun: false,
      });

      expectBlocked(result, 'MELI_INVOICE_STATUS_LOOKUP_FAILED');
      expect(dependencies.meliInvoices.upload).not.toHaveBeenCalled();
    });

    it('when the PDF cannot be downloaded from Xubio', async () => {
      const dependencies = createDependencies();
      dependencies.invoicePdf.getPdf.mockRejectedValue(
        new Error('the downloaded file is not a PDF'),
      );
      const interactor = createInteractor(dependencies);

      const result = await interactor.execute({
        tlqvCode: TLQV,
        dryRun: false,
      });

      expectBlocked(result, 'INVOICE_PDF_UNAVAILABLE');
      expect(dependencies.meliInvoices.upload).not.toHaveBeenCalled();
    });

    it('when the PDF is larger than Mercado Libre accepts', async () => {
      const dependencies = createDependencies();
      dependencies.invoicePdf.getPdf.mockResolvedValue({
        transaccionId: 77777299,
        content: PDF,
        sizeInBytes: 10 * 1024 * 1024 + 1,
      });
      const interactor = createInteractor(dependencies);

      const result = await interactor.execute({
        tlqvCode: TLQV,
        dryRun: false,
      });

      expectBlocked(result, 'INVOICE_PDF_TOO_LARGE');
      expect(dependencies.meliInvoices.upload).not.toHaveBeenCalled();
    });

    it('and says a retry is safe when the upload itself fails', async () => {
      const dependencies = createDependencies();
      dependencies.meliInvoices.upload.mockRejectedValue(
        new Error('HTTP 502 - Mercado Libre could not attach the invoice'),
      );
      const interactor = createInteractor(dependencies);

      const result = await interactor.execute({
        tlqvCode: TLQV,
        dryRun: false,
      });

      expectBlocked(result, 'MELI_INVOICE_UPLOAD_FAILED');
      expect(result.blockers[0].message).toContain('Se puede reintentar');
      expect(result.invoice?.numeroDocumento).toBe('B-00008-00003981');
    });
  });

  describe('a factura named by its Xubio ID', () => {
    const xubioFactura = (overrides: Record<string, unknown> = {}) => ({
      comprobante: {
        tipo: 1,
        numeroDocumento: 'B-00008-00004100',
        fecha: '2026-11-27',
        importetotal: 386749.16,
        descripcion: `${TLQV} ML: ${ORDER_ID}`,
        cae: '86484580124099',
        ...overrides,
      },
    });

    it('is sent without asking Madre, which does not know it yet', async () => {
      const dependencies = createDependencies();
      dependencies.comprobanteDetail.getDetail.mockResolvedValue(
        xubioFactura(),
      );
      const interactor = createInteractor(dependencies);

      const result = await interactor.execute({
        tlqvCode: TLQV,
        transaccionId: 80000001,
        dryRun: false,
      });

      expect(result.status).toBe('sent');
      expect(dependencies.madre.findFullByTlqvCode).not.toHaveBeenCalled();
      expect(result.invoice).toEqual({
        xubioTransactionId: 80000001,
        numeroDocumento: 'B-00008-00004100',
        cae: '86484580124099',
        fechaEmision: '2026-11-27',
        importeTotal: 386749.16,
      });
      expect(dependencies.invoicePdf.getPdf).toHaveBeenCalledWith({
        transaccionId: 80000001,
      });
      expect(dependencies.meliInvoices.upload).toHaveBeenCalledWith(
        expect.objectContaining({ fileName: 'B-00008-00004100.pdf' }),
      );
    });

    it('is not sent when it belongs to another sale', async () => {
      const dependencies = createDependencies();
      dependencies.comprobanteDetail.getDetail.mockResolvedValue(
        // TLQV-199890 is not TLQV-19989.
        xubioFactura({ descripcion: 'TLQV-199890 ML: 2000000000000001' }),
      );
      const interactor = createInteractor(dependencies);

      const result = await interactor.execute({
        tlqvCode: TLQV,
        transaccionId: 80000001,
        dryRun: false,
      });

      expectBlocked(result, 'COMPROBANTE_TLQV_MISMATCH');
      expect(dependencies.meliInvoices.upload).not.toHaveBeenCalled();
    });

    it('is not sent when it is a nota de crédito', async () => {
      const dependencies = createDependencies();
      dependencies.comprobanteDetail.getDetail.mockResolvedValue(
        xubioFactura({ tipo: 3 }),
      );
      const interactor = createInteractor(dependencies);

      const result = await interactor.execute({
        tlqvCode: TLQV,
        transaccionId: 80000001,
        dryRun: false,
      });

      expectBlocked(result, 'COMPROBANTE_NOT_AN_INVOICE');
      expect(dependencies.meliInvoices.upload).not.toHaveBeenCalled();
    });

    it('is not sent without CAE', async () => {
      const dependencies = createDependencies();
      dependencies.comprobanteDetail.getDetail.mockResolvedValue(
        xubioFactura({ cae: null }),
      );
      const interactor = createInteractor(dependencies);

      const result = await interactor.execute({
        tlqvCode: TLQV,
        transaccionId: 80000001,
        dryRun: false,
      });

      expectBlocked(result, 'INVOICE_WITHOUT_CAE');
    });
  });

  it('sends a pack once, through the first of its sales', async () => {
    const dependencies = createDependencies({
      meliOrderIds: [ORDER_ID, '2000018498993480'],
    });
    const interactor = createInteractor(dependencies);

    await interactor.execute({ tlqvCode: TLQV, dryRun: false });

    expect(dependencies.meliInvoices.upload).toHaveBeenCalledTimes(1);
    expect(dependencies.meliInvoices.upload).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: ORDER_ID }),
    );
  });
});

function expectBlocked(
  result: Awaited<ReturnType<SendInvoiceToMeliInteractor['execute']>>,
  code: string,
): void {
  expect(result.status).toBe('blocked');
  expect(result.blockers).toEqual([expect.objectContaining({ code })]);
}

function createInteractor(
  dependencies: ReturnType<typeof createDependencies>,
): SendInvoiceToMeliInteractor {
  return new SendInvoiceToMeliInteractor(
    dependencies.madre,
    dependencies.comprobanteDetail,
    dependencies.opsOrderDetails,
    dependencies.invoicePdf,
    dependencies.meliInvoices,
  );
}

function createDependencies(options: { meliOrderIds?: string[] } = {}) {
  return {
    madre: {
      createSyncRun: jest.fn(),
      updateSyncRun: jest.fn(),
      upsertBatch: jest.fn(),
      findByTlqvCodes: jest.fn(),
      findByTlqvCode: jest.fn(),
      existsByTlqvCode: jest.fn(),
      findFullByTlqvCode: jest.fn().mockResolvedValue({
        items: [factura(77777299, 'B-00008-00003981', '2026-09-30')],
      }),
    },
    comprobanteDetail: {
      getDetail: jest.fn().mockResolvedValue({
        comprobante: { cae: '86395384692268', CAE: '86395384692268' },
      }),
    },
    opsOrderDetails: {
      getByTlqvCode: jest.fn().mockResolvedValue({
        found: true,
        orderDetails: {
          tlqvCode: TLQV,
          source: 'ops_api',
          buyerData: {},
          meliOrderIds: options.meliOrderIds ?? [ORDER_ID],
          rawPayload: {},
        },
      }),
    },
    invoicePdf: {
      getPdf: jest.fn().mockResolvedValue({
        transaccionId: 77777299,
        content: PDF,
        sizeInBytes: PDF.length,
      }),
    },
    meliInvoices: {
      getStatus: jest.fn().mockResolvedValue({
        orderId: ORDER_ID,
        packId: ORDER_ID,
        hasInvoice: false,
        documents: null,
      }),
      upload: jest.fn().mockResolvedValue({
        status: 'uploaded',
        orderId: ORDER_ID,
        packId: ORDER_ID,
        rawPayload: { id: 'doc-1' },
      }),
    },
  };
}

function factura(
  xubioTransactionId: number,
  numeroDocumento: string,
  fechaEmision: string,
): MadreXubioComprobante {
  return {
    xubioTransactionId,
    numeroDocumento,
    documentKind: 'INVOICE',
    descripcion: `${TLQV} ML${ORDER_ID}`,
    tlqvCode: TLQV,
    fechaEmision,
    importeTotal: 910628.23,
    productItems: [],
    rawListPayload: {},
    rawDetailPayload: { transaccionid: xubioTransactionId },
  };
}

function notaCredito(
  xubioTransactionId: number,
  cancels: number,
): MadreXubioComprobante {
  return {
    ...factura(xubioTransactionId, 'B-00008-00000164', '2026-09-10'),
    documentKind: 'CREDIT_NOTE',
    rawDetailPayload: {
      transaccionid: xubioTransactionId,
      comprobante: cancels,
      comprobanteAsociado: 1,
    },
  };
}
