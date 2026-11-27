import axios, { type AxiosInstance } from 'axios';
import type { IMeliOrderInvoiceRepository } from '../../../../adapters/repositories/mercadolibre-api/orders/IMeliOrderInvoiceRepository';
import type {
  MeliOrderInvoiceStatus,
  UploadMeliOrderInvoiceCommand,
  UploadMeliOrderInvoiceResponse,
} from '../../../../entities/mercadolibre/orders/MeliOrderInvoice';

const DEFAULT_BASE_URL = 'https://api.meli.loquieroaca.com';
const DEFAULT_TIMEOUT_IN_MILLISECONDS = 60_000;
const INTERNAL_API_KEY_HEADER = 'x-internal-api-key';
const FILE_FIELD = 'fiscal_document';
const MAX_ERROR_BODY_LENGTH = 800;

export interface MeliOrderInvoiceRepositoryOptions {
  baseUrl?: string;
  internalApiKey?: string;
  timeoutInMilliseconds?: number;
  httpClient?: AxiosInstance;
}

export class MeliOrderInvoiceRequestError extends Error {
  constructor(orderId: string, operation: string, detail: string) {
    super(
      `mercadolibre-api request failed while trying to ${operation} of order ${orderId}: ${detail}`,
    );
    this.name = MeliOrderInvoiceRequestError.name;
  }
}

export class MeliOrderInvoiceConfigurationError extends Error {
  constructor() {
    super('MELI_API_INTERNAL_API_KEY is required to call mercadolibre-api');
    this.name = MeliOrderInvoiceConfigurationError.name;
  }
}

/**
 * Attaches a factura to a Mercado Libre sale through the internal
 * mercadolibre-api, which takes the sale number and works out whether the
 * file belongs on the sale or on its cart.
 *
 * Neither call is retried here. The upload is what the buyer ends up seeing
 * and cannot be undone, so a failure is reported as it is and left for a
 * person — or for a second run, which Mercado Libre answers with "already has
 * an invoice" if the first one did go through.
 */
export class MeliOrderInvoiceRepository implements IMeliOrderInvoiceRepository {
  private readonly httpClient: AxiosInstance;
  private readonly internalApiKey?: string;

  constructor(options: MeliOrderInvoiceRepositoryOptions = {}) {
    this.internalApiKey = options.internalApiKey;
    this.httpClient =
      options.httpClient ??
      axios.create({
        baseURL: options.baseUrl ?? DEFAULT_BASE_URL,
        timeout:
          options.timeoutInMilliseconds ?? DEFAULT_TIMEOUT_IN_MILLISECONDS,
      });
  }

  async getStatus(command: {
    orderId: string;
  }): Promise<MeliOrderInvoiceStatus> {
    const orderId = normalizeOrderId(command.orderId);

    try {
      const response = await this.httpClient.get<unknown>(
        `/meli/orders/${orderId}/invoice`,
        { headers: this.buildHeaders() },
      );
      const body = isRecord(response.data) ? response.data : {};

      return {
        orderId,
        packId: readId(body.packId),
        hasInvoice: body.hasInvoice === true,
        documents: body.documents ?? null,
      };
    } catch (error: unknown) {
      throw buildRequestError(orderId, 'read the invoice status', error);
    }
  }

  async upload(
    command: UploadMeliOrderInvoiceCommand,
  ): Promise<UploadMeliOrderInvoiceResponse> {
    const orderId = normalizeOrderId(command.orderId);
    const headers = this.buildHeaders();

    const form = new FormData();
    form.append(
      FILE_FIELD,
      new Blob([new Uint8Array(command.pdf)], { type: 'application/pdf' }),
      command.fileName,
    );

    try {
      const response = await this.httpClient.post<unknown>(
        `/meli/orders/${orderId}/invoice`,
        form,
        {
          headers,
          params: command.force === true ? { force: 'true' } : undefined,
        },
      );
      const body = isRecord(response.data) ? response.data : {};

      return {
        status: 'uploaded',
        orderId,
        packId: readId(body.packId),
        rawPayload: response.data,
      };
    } catch (error: unknown) {
      if (axios.isAxiosError(error) && error.response?.status === 409) {
        return {
          status: 'already_has_invoice',
          orderId,
          rawPayload: error.response.data,
        };
      }

      throw buildRequestError(orderId, 'upload the invoice', error);
    }
  }

  private buildHeaders(): Record<string, string> {
    const internalApiKey = this.internalApiKey?.trim();
    if (internalApiKey === undefined || internalApiKey === '') {
      throw new MeliOrderInvoiceConfigurationError();
    }

    return {
      Accept: 'application/json',
      [INTERNAL_API_KEY_HEADER]: internalApiKey,
    };
  }
}

function buildRequestError(
  orderId: string,
  operation: string,
  error: unknown,
): Error {
  if (error instanceof MeliOrderInvoiceConfigurationError) {
    return error;
  }

  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const detail =
      status === undefined
        ? `${error.code ?? 'NETWORK_ERROR'} - ${error.message}`
        : `HTTP ${status} - ${serializeBody(error.response?.data)}`;

    return new MeliOrderInvoiceRequestError(orderId, operation, detail);
  }

  return new MeliOrderInvoiceRequestError(
    orderId,
    operation,
    error instanceof Error ? error.message : 'unknown error',
  );
}

function serializeBody(value: unknown): string {
  let serialized: string | undefined;
  try {
    serialized = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    serialized = 'unserializable response body';
  }

  return (serialized ?? '').slice(0, MAX_ERROR_BODY_LENGTH);
}

function normalizeOrderId(value: string): string {
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new RangeError('orderId must be numeric');
  }

  return normalized;
}

function readId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    return value.trim();
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
