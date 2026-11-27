import axios, { type AxiosInstance } from 'axios';
import type {
  GetXubioInvoicePdfCommand,
  IGetXubioInvoicePdfRepository,
  XubioInvoicePdf,
} from '../../../../adapters/repositories/xubio/facturas/IGetXubioInvoicePdfRepository';
import {
  executeXubioRequestWithRetry,
  type XubioRequestRetryOptions,
} from '../XubioRequestRetry';

const DEFAULT_BASE_URL = 'https://xubio.com';
const DEFAULT_TIMEOUT_IN_MILLISECONDS = 60_000;
const PRINT_PDF_PATH = '/API/1.1/imprimirPDF';
// The standard layout. Xubio also has other print templates.
const PRINT_TYPE = 1;
const PDF_SIGNATURE = '%PDF';

export interface GetInvoicePdfRepositoryOptions {
  baseUrl?: string;
  accessTokenProvider?: () => Promise<string>;
  onAuthorizationFailure?: () => void | Promise<void>;
  timeoutInMilliseconds?: number;
  httpClient?: AxiosInstance;
  retryOptions?: XubioRequestRetryOptions;
}

export class XubioInvoicePdfRequestError extends Error {
  constructor(transaccionId: number, detail: string) {
    super(
      `Xubio request failed while getting the PDF of comprobante ${transaccionId}: ${detail}`,
    );
    this.name = XubioInvoicePdfRequestError.name;
  }
}

export class XubioInvoicePdfInvalidResponseError extends Error {
  constructor(transaccionId: number, detail: string) {
    super(
      `Xubio returned an invalid PDF for comprobante ${transaccionId}: ${detail}`,
    );
    this.name = XubioInvoicePdfInvalidResponseError.name;
  }
}

/**
 * Xubio hands out a comprobante's PDF in two steps: `imprimirPDF` answers with
 * a link, and the link serves the file. Both are plain reads, so they are
 * retried like any other Xubio read.
 */
export class GetInvoicePdfRepository implements IGetXubioInvoicePdfRepository {
  private readonly httpClient: AxiosInstance;
  private readonly baseUrl: string;
  private readonly accessTokenProvider?: () => Promise<string>;
  private readonly onAuthorizationFailure?: () => void | Promise<void>;
  private readonly retryOptions: XubioRequestRetryOptions;

  constructor(options: GetInvoicePdfRepositoryOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.accessTokenProvider = options.accessTokenProvider;
    this.onAuthorizationFailure = options.onAuthorizationFailure;
    this.retryOptions = options.retryOptions ?? {};
    this.httpClient =
      options.httpClient ??
      axios.create({
        baseURL: this.baseUrl,
        timeout:
          options.timeoutInMilliseconds ?? DEFAULT_TIMEOUT_IN_MILLISECONDS,
      });
  }

  async getPdf(command: GetXubioInvoicePdfCommand): Promise<XubioInvoicePdf> {
    const transaccionId = command.transaccionId;
    if (!Number.isInteger(transaccionId) || transaccionId < 1) {
      throw new RangeError('transaccionId must be a positive integer');
    }

    try {
      const pdfUrl = await this.getPdfUrl(transaccionId);
      const content = await this.download(pdfUrl);

      // Xubio answers an error page with HTTP 200 for some failures; a file
      // that is not a PDF must never reach a customer as their factura.
      if (
        content.subarray(0, PDF_SIGNATURE.length).toString('latin1') !==
        PDF_SIGNATURE
      ) {
        throw new XubioInvoicePdfInvalidResponseError(
          transaccionId,
          'the downloaded file is not a PDF',
        );
      }

      return { transaccionId, content, sizeInBytes: content.length };
    } catch (error: unknown) {
      if (error instanceof XubioInvoicePdfInvalidResponseError) {
        throw error;
      }

      throw buildRequestError(transaccionId, error);
    }
  }

  private async getPdfUrl(transaccionId: number): Promise<string> {
    const response = await executeXubioRequestWithRetry(
      async () =>
        this.httpClient.get<unknown>(PRINT_PDF_PATH, {
          params: { idtransaccion: transaccionId, tipoimpresion: PRINT_TYPE },
          headers: await this.buildAuthorizationHeaders(),
        }),
      {
        ...this.retryOptions,
        onAuthorizationFailure: this.onAuthorizationFailure,
      },
    );

    const body: unknown = response.data;
    const urlPdf =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>).urlPdf
        : undefined;
    if (typeof urlPdf !== 'string' || urlPdf.trim() === '') {
      throw new XubioInvoicePdfInvalidResponseError(
        transaccionId,
        'imprimirPDF did not return urlPdf',
      );
    }

    // The link comes from a response body: only follow it back to Xubio.
    if (new URL(urlPdf).hostname !== new URL(this.baseUrl).hostname) {
      throw new XubioInvoicePdfInvalidResponseError(
        transaccionId,
        `urlPdf points outside Xubio (${new URL(urlPdf).hostname})`,
      );
    }

    return urlPdf;
  }

  private async download(pdfUrl: string): Promise<Buffer> {
    const response = await executeXubioRequestWithRetry(
      () =>
        this.httpClient.get<ArrayBuffer>(pdfUrl, {
          responseType: 'arraybuffer',
        }),
      this.retryOptions,
    );

    return Buffer.from(response.data);
  }

  private async buildAuthorizationHeaders(): Promise<Record<string, string>> {
    if (this.accessTokenProvider === undefined) {
      return {};
    }

    return { Authorization: `Bearer ${await this.accessTokenProvider()}` };
  }
}

function buildRequestError(
  transaccionId: number,
  error: unknown,
): XubioInvoicePdfRequestError {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    return new XubioInvoicePdfRequestError(
      transaccionId,
      status === undefined ? error.message : `HTTP ${status}`,
    );
  }

  return new XubioInvoicePdfRequestError(
    transaccionId,
    error instanceof Error ? error.message : 'unknown error',
  );
}
