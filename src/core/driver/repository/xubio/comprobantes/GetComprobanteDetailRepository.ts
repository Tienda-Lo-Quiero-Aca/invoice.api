import axios, { type AxiosInstance } from 'axios';
import type { IGetComprobanteDetailRepository } from '../../../../adapters/repositories/xubio/comprobantes/IGetComprobanteDetailRepository';
import type {
  GetXubioComprobanteDetailCommand,
  GetXubioComprobanteDetailResponse,
} from '../../../../entities/xubio/comprobantes/XubioComprobante';
import {
  parseComprobanteDetail,
  XubioComprobanteInvalidResponseError,
} from './XubioComprobanteParsers';
import {
  executeXubioRequestWithRetry,
  type XubioRequestRetryOptions,
} from '../XubioRequestRetry';

const DEFAULT_BASE_URL = 'https://xubio.com';
const DEFAULT_TIMEOUT_IN_MILLISECONDS = 20_000;
const COMPROBANTE_VENTA_PATH = '/API/1.1/comprobanteVentaBean';

export interface GetComprobanteDetailRepositoryOptions {
  baseUrl?: string;
  authorizationToken?: string;
  accessTokenProvider?: () => Promise<string>;
  onAuthorizationFailure?: () => void | Promise<void>;
  timeoutInMilliseconds?: number;
  httpClient?: AxiosInstance;
  retryOptions?: XubioRequestRetryOptions;
}

export class XubioComprobanteDetailRequestError extends Error {
  constructor(transaccionId: number, detail?: string) {
    super(
      `Xubio request failed while getting comprobante detail ${transaccionId}${detail === undefined ? '' : `: ${detail}`}`,
    );
    this.name = XubioComprobanteDetailRequestError.name;
  }
}

/**
 * Xubio answered that the comprobante does not exist: it was deleted. Only a
 * comprobante without CAE can be deleted, so this is never a fiscal document
 * that went missing.
 */
export class XubioComprobanteNotFoundError extends XubioComprobanteDetailRequestError {
  readonly notFound = true;

  constructor(transaccionId: number) {
    super(transaccionId, 'no existe en Xubio (fue eliminado)');
    this.name = XubioComprobanteNotFoundError.name;
  }
}

export class GetComprobanteDetailRepository implements IGetComprobanteDetailRepository {
  private readonly httpClient: AxiosInstance;
  private readonly authorizationToken?: string;
  private readonly accessTokenProvider?: () => Promise<string>;
  private readonly onAuthorizationFailure?: () => void | Promise<void>;
  private readonly retryOptions: XubioRequestRetryOptions;

  constructor(options: GetComprobanteDetailRepositoryOptions = {}) {
    this.authorizationToken = options.authorizationToken;
    this.accessTokenProvider = options.accessTokenProvider;
    this.onAuthorizationFailure = options.onAuthorizationFailure;
    this.retryOptions = options.retryOptions ?? {};
    this.httpClient =
      options.httpClient ??
      axios.create({
        baseURL: options.baseUrl ?? DEFAULT_BASE_URL,
        timeout:
          options.timeoutInMilliseconds ?? DEFAULT_TIMEOUT_IN_MILLISECONDS,
        headers: buildHeaders(options.authorizationToken),
      });
  }

  async getDetail(
    command: GetXubioComprobanteDetailCommand,
  ): Promise<GetXubioComprobanteDetailResponse> {
    validateTransactionId(command.transaccionId);

    try {
      const response = await executeXubioRequestWithRetry(
        async () =>
          this.httpClient.get<unknown>(
            `${COMPROBANTE_VENTA_PATH}/${encodeURIComponent(command.transaccionId)}`,
            {
              headers: await this.buildAuthorizationHeaders(),
            },
          ),
        {
          ...this.retryOptions,
          onAuthorizationFailure: this.onAuthorizationFailure,
        },
      );

      return {
        comprobante: parseComprobanteDetail(response.data),
      };
    } catch (error: unknown) {
      if (error instanceof XubioComprobanteInvalidResponseError) {
        throw error;
      }
      throw buildRequestError(command.transaccionId, error);
    }
  }

  private async buildAuthorizationHeaders(): Promise<Record<string, string>> {
    if (this.accessTokenProvider !== undefined) {
      return {
        Authorization: `Bearer ${await this.accessTokenProvider()}`,
      };
    }

    if (
      this.authorizationToken !== undefined &&
      this.authorizationToken.trim() !== ''
    ) {
      return {
        Authorization: `Bearer ${this.authorizationToken}`,
      };
    }

    return {};
  }
}

function buildRequestError(
  transaccionId: number,
  error: unknown,
): XubioComprobanteDetailRequestError {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const body: unknown = error.response?.data;
    if (saysComprobanteDoesNotExist(body)) {
      return new XubioComprobanteNotFoundError(transaccionId);
    }

    const detail =
      status === undefined
        ? error.message
        : `HTTP ${status} - ${serializeResponseBody(body)}`;

    return new XubioComprobanteDetailRequestError(transaccionId, detail);
  }

  if (error instanceof Error) {
    return new XubioComprobanteDetailRequestError(transaccionId, error.message);
  }

  return new XubioComprobanteDetailRequestError(transaccionId, 'unknown error');
}

// Xubio reports it as a business error — HTTP 401, codeResponse 406 — whose
// text is the only thing that tells it apart: "La Factura de Venta no existe".
const DOES_NOT_EXIST_PATTERN =
  /^La (Factura de Venta|Nota de Cr[eé]dito( de Venta)?) no existe\.?$/i;

function saysComprobanteDoesNotExist(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) {
    return false;
  }

  const { description, message } = body as Record<string, unknown>;

  return [description, message].some(
    (text) =>
      typeof text === 'string' && DOES_NOT_EXIST_PATTERN.test(text.trim()),
  );
}

function serializeResponseBody(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  try {
    // Xubio sends its whole Java stack trace along. It says nothing to whoever
    // reads the error and buries the one line that does.
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const rest: Record<string, unknown> = {
        ...(value as Record<string, unknown>),
      };
      delete rest.stackTrace;
      delete rest.suppressed;
      delete rest.cause;

      return JSON.stringify(rest);
    }

    return JSON.stringify(value);
  } catch {
    return 'unserializable response body';
  }
}

function buildHeaders(
  authorizationToken: string | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };

  if (authorizationToken !== undefined && authorizationToken.trim() !== '') {
    headers.Authorization = `Bearer ${authorizationToken}`;
  }

  return headers;
}

function validateTransactionId(value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError('transaccionId must be a positive integer');
  }
}
