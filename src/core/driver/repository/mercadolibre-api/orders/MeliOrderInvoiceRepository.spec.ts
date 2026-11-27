import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AxiosInstance } from 'axios';
import {
  MeliOrderInvoiceConfigurationError,
  MeliOrderInvoiceRepository,
  MeliOrderInvoiceRequestError,
} from './MeliOrderInvoiceRepository';

const ORDER_ID = '2000019813708728';
const PDF = Buffer.from(
  '%PDF-1.4 factura de prueba \u0000\u0001\u0002 binario',
);

describe('MeliOrderInvoiceRepository', () => {
  describe('getStatus', () => {
    it('reads whether the sale already has a factura', async () => {
      const get = jest.fn().mockResolvedValue({
        data: {
          orderId: ORDER_ID,
          packId: 2000016292307607,
          hasInvoice: false,
          documents: null,
        },
      });

      const result = await createRepository({ get }).getStatus({
        orderId: ORDER_ID,
      });

      expect(get).toHaveBeenCalledWith(`/meli/orders/${ORDER_ID}/invoice`, {
        headers: {
          Accept: 'application/json',
          'x-internal-api-key': 'una-clave',
        },
      });
      expect(result).toEqual({
        orderId: ORDER_ID,
        packId: '2000016292307607',
        hasInvoice: false,
        documents: null,
      });
    });

    it('does not read a missing flag as "has no factura" by accident', async () => {
      const get = jest
        .fn()
        .mockResolvedValue({ data: { hasInvoice: true, documents: [{}] } });

      const result = await createRepository({ get }).getStatus({
        orderId: ORDER_ID,
      });

      expect(result.hasInvoice).toBe(true);
    });

    it('wraps a failure instead of answering that there is no factura', async () => {
      const get = jest.fn().mockRejectedValue({
        isAxiosError: true,
        message: 'Request failed',
        response: { status: 502, data: { message: 'bad gateway' } },
      });

      await expect(
        createRepository({ get }).getStatus({ orderId: ORDER_ID }),
      ).rejects.toBeInstanceOf(MeliOrderInvoiceRequestError);
    });
  });

  describe('upload', () => {
    it('reports the sale that already has a factura (HTTP 409) without failing', async () => {
      const post = jest.fn().mockRejectedValue({
        isAxiosError: true,
        message: 'Request failed',
        response: { status: 409, data: { message: 'already has an invoice' } },
      });

      const result = await createRepository({ post }).upload({
        orderId: ORDER_ID,
        pdf: PDF,
        fileName: 'B-00008-00003981.pdf',
      });

      expect(result).toEqual({
        status: 'already_has_invoice',
        orderId: ORDER_ID,
        rawPayload: { message: 'already has an invoice' },
      });
    });

    it('keeps what Mercado Libre answered when it rejects the file', async () => {
      const post = jest.fn().mockRejectedValue({
        isAxiosError: true,
        message: 'Request failed',
        response: {
          status: 502,
          data: { message: 'Mercado Libre could not attach the invoice' },
        },
      });

      await expect(
        createRepository({ post }).upload({
          orderId: ORDER_ID,
          pdf: PDF,
          fileName: 'f.pdf',
        }),
      ).rejects.toThrow(
        'HTTP 502 - {"message":"Mercado Libre could not attach the invoice"}',
      );
    });

    it('fails clearly when the internal API key is not configured', async () => {
      const post = jest.fn();
      const repository = new MeliOrderInvoiceRepository({
        httpClient: { post } as unknown as AxiosInstance,
      });

      await expect(
        repository.upload({ orderId: ORDER_ID, pdf: PDF, fileName: 'f.pdf' }),
      ).rejects.toBeInstanceOf(MeliOrderInvoiceConfigurationError);
      expect(post).not.toHaveBeenCalled();
    });

    it('rejects an order id that is not numeric', async () => {
      await expect(
        createRepository({}).upload({
          orderId: '../packs/1',
          pdf: PDF,
          fileName: 'f.pdf',
        }),
      ).rejects.toThrow('orderId must be numeric');
    });
  });

  describe('upload, over a real HTTP connection', () => {
    let server: Server;
    let baseUrl: string;
    let received: { url?: string; contentType?: string; body: Buffer };

    beforeEach(async () => {
      received = { body: Buffer.alloc(0) };
      server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
          received = {
            url: request.url,
            contentType: request.headers['content-type'],
            body: Buffer.concat(chunks),
          };
          response.writeHead(201, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ orderId: ORDER_ID, packId: '99' }));
        });
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('sends the PDF as the multipart field mercadolibre-api expects, byte for byte', async () => {
      const repository = new MeliOrderInvoiceRepository({
        baseUrl,
        internalApiKey: 'una-clave',
      });

      const result = await repository.upload({
        orderId: ORDER_ID,
        pdf: PDF,
        fileName: 'B-00008-00003981.pdf',
      });

      expect(result).toEqual({
        status: 'uploaded',
        orderId: ORDER_ID,
        packId: '99',
        rawPayload: { orderId: ORDER_ID, packId: '99' },
      });
      expect(received.url).toBe(`/meli/orders/${ORDER_ID}/invoice`);
      expect(received.contentType).toMatch(/^multipart\/form-data; boundary=/);
      const text = received.body.toString('latin1');
      expect(text).toContain('name="fiscal_document"');
      expect(text).toContain('filename="B-00008-00003981.pdf"');
      expect(text).toContain('Content-Type: application/pdf');
      expect(received.body.includes(PDF)).toBe(true);
    });

    it('asks to replace an existing factura only when force is set', async () => {
      const repository = new MeliOrderInvoiceRepository({
        baseUrl,
        internalApiKey: 'una-clave',
      });

      await repository.upload({
        orderId: ORDER_ID,
        pdf: PDF,
        fileName: 'f.pdf',
        force: true,
      });

      expect(received.url).toBe(`/meli/orders/${ORDER_ID}/invoice?force=true`);
    });
  });
});

function createRepository(client: {
  get?: jest.Mock;
  post?: jest.Mock;
}): MeliOrderInvoiceRepository {
  return new MeliOrderInvoiceRepository({
    internalApiKey: 'una-clave',
    httpClient: client as unknown as AxiosInstance,
  });
}
