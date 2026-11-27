import type { AxiosInstance } from 'axios';
import {
  GetInvoicePdfRepository,
  XubioInvoicePdfInvalidResponseError,
  XubioInvoicePdfRequestError,
} from './GetInvoicePdfRepository';

const PDF_URL =
  'https://xubio.com:443/NXV/ImprimirPdf?transaccionid=77777299&tenant=tnt_1&tipoimpresion=1';
const PDF = Buffer.from('%PDF-1.4 contenido');
const NO_RETRY = {
  maxAttempts: 1,
  initialDelayInMilliseconds: 0,
  maxDelayInMilliseconds: 0,
};

describe('GetInvoicePdfRepository', () => {
  it('asks Xubio for the link and downloads the PDF from it', async () => {
    const get = jest
      .fn()
      .mockResolvedValueOnce({ data: { urlPdf: PDF_URL } })
      .mockResolvedValueOnce({ data: toArrayBuffer(PDF) });
    const repository = createRepository(get);

    const result = await repository.getPdf({ transaccionId: 77777299 });

    expect(get).toHaveBeenNthCalledWith(1, '/API/1.1/imprimirPDF', {
      params: { idtransaccion: 77777299, tipoimpresion: 1 },
      headers: { Authorization: 'Bearer un-token' },
    });
    expect(get).toHaveBeenNthCalledWith(2, PDF_URL, {
      responseType: 'arraybuffer',
    });
    expect(result.transaccionId).toBe(77777299);
    expect(result.sizeInBytes).toBe(PDF.length);
    expect(result.content.equals(PDF)).toBe(true);
  });

  it('rejects a download that is not a PDF, so an error page never reaches a buyer', async () => {
    const get = jest
      .fn()
      .mockResolvedValueOnce({ data: { urlPdf: PDF_URL } })
      .mockResolvedValueOnce({
        data: toArrayBuffer(Buffer.from('<!doctype html><html>Error</html>')),
      });

    await expect(
      createRepository(get).getPdf({ transaccionId: 77777299 }),
    ).rejects.toEqual(
      new XubioInvoicePdfInvalidResponseError(
        77777299,
        'the downloaded file is not a PDF',
      ),
    );
  });

  it('does not follow a link that points outside Xubio', async () => {
    const get = jest.fn().mockResolvedValueOnce({
      data: { urlPdf: 'https://otro-sitio.example/factura.pdf' },
    });

    await expect(
      createRepository(get).getPdf({ transaccionId: 77777299 }),
    ).rejects.toBeInstanceOf(XubioInvoicePdfInvalidResponseError);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('rejects an answer without a link', async () => {
    const get = jest.fn().mockResolvedValueOnce({ data: {} });

    await expect(
      createRepository(get).getPdf({ transaccionId: 77777299 }),
    ).rejects.toThrow('imprimirPDF did not return urlPdf');
  });

  it('wraps request failures with context', async () => {
    const get = jest.fn().mockRejectedValue({
      isAxiosError: true,
      message: 'Request failed',
      response: { status: 404, data: {} },
    });

    await expect(
      createRepository(get).getPdf({ transaccionId: 77777299 }),
    ).rejects.toEqual(new XubioInvoicePdfRequestError(77777299, 'HTTP 404'));
  });

  it('rejects an id that is not a positive integer', async () => {
    await expect(
      createRepository(jest.fn()).getPdf({ transaccionId: 0 }),
    ).rejects.toThrow('transaccionId must be a positive integer');
  });
});

function createRepository(get: jest.Mock): GetInvoicePdfRepository {
  return new GetInvoicePdfRepository({
    accessTokenProvider: () => Promise.resolve('un-token'),
    httpClient: { get } as unknown as AxiosInstance,
    retryOptions: NO_RETRY,
  });
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}
