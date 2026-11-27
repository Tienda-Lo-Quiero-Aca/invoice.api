import axios, { type AxiosInstance } from 'axios';
import type {
  IRequestXubioCaeRepository,
  RequestXubioCaeCommand,
  RequestXubioCaeResponse,
} from '../../../../adapters/repositories/xubio/facturas/IRequestXubioCaeRepository';
import {
  executeXubioRequestWithRetry,
  type XubioRequestRetryOptions,
} from '../XubioRequestRetry';

const DEFAULT_BASE_URL = 'https://xubio.com';
// Xubio asks AFIP while the request is open, so this one is slow by nature.
const DEFAULT_TIMEOUT_IN_MILLISECONDS = 60_000;
const REQUEST_CAE_PATH = '/API/1.1/solicitarCAE';
const MAX_ERROR_BODY_LENGTH = 800;

export interface RequestCaeRepositoryOptions {
  baseUrl?: string;
  accessTokenProvider?: () => Promise<string>;
  onAuthorizationFailure?: () => void | Promise<void>;
  timeoutInMilliseconds?: number;
  httpClient?: AxiosInstance;
  retryOptions?: XubioRequestRetryOptions;
}

export class XubioCaeRequestError extends Error {
  /**
   * True when Xubio never said what happened — a timeout, a dropped
   * connection, a 408 or a 5xx. AFIP may have granted the CAE anyway, so the
   * comprobante has to be read again before concluding anything.
   */
  readonly outcomeUnknown: boolean;

  constructor(transaccionId: number, detail: string, outcomeUnknown = false) {
    super(
      `Xubio request failed while requesting the CAE of comprobante ${transaccionId}: ${detail}`,
    );
    this.name = XubioCaeRequestError.name;
    this.outcomeUnknown = outcomeUnknown;
  }
}

export class RequestCaeRepository implements IRequestXubioCaeRepository {
  private readonly httpClient: AxiosInstance;
  private readonly accessTokenProvider?: () => Promise<string>;
  private readonly onAuthorizationFailure?: () => void | Promise<void>;
  private readonly retryOptions: XubioRequestRetryOptions;

  constructor(options: RequestCaeRepositoryOptions = {}) {
    this.accessTokenProvider = options.accessTokenProvider;
    this.onAuthorizationFailure = options.onAuthorizationFailure;
    this.retryOptions = options.retryOptions ?? {};
    this.httpClient =
      options.httpClient ??
      axios.create({
        baseURL: options.baseUrl ?? DEFAULT_BASE_URL,
        timeout:
          options.timeoutInMilliseconds ?? DEFAULT_TIMEOUT_IN_MILLISECONDS,
      });
  }

  async requestCae(
    command: RequestXubioCaeCommand,
  ): Promise<RequestXubioCaeResponse> {
    const transaccionId = command.transaccionId;
    if (!Number.isInteger(transaccionId) || transaccionId < 1) {
      throw new RangeError('transaccionId must be a positive integer');
    }

    try {
      const response = await executeXubioRequestWithRetry(
        async () =>
          this.httpClient.post<unknown>(
            REQUEST_CAE_PATH,
            { transaccionId },
            { headers: await this.buildAuthorizationHeaders() },
          ),
        {
          ...this.retryOptions,
          onAuthorizationFailure: this.onAuthorizationFailure,
          // A CAE turns the comprobante into a fiscal document in front of
          // AFIP and cannot be taken back. If the answer never arrives, the
          // request is not repeated blindly: the caller reads the comprobante
          // again to find out what happened. Not configurable on purpose.
          retryOnIndeterminateOutcome: false,
        },
      );

      const body = isRecord(response.data) ? response.data : {};

      return {
        transaccionId,
        cae: readString(body.CAE) ?? readString(body.cae),
        detail: readString(body.detalle),
        rawPayload: response.data,
      };
    } catch (error: unknown) {
      throw buildRequestError(transaccionId, error);
    }
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
): XubioCaeRequestError {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const detail =
      status === undefined
        ? error.message
        : `HTTP ${status} - ${serializeBody(error.response?.data)}`;

    return new XubioCaeRequestError(
      transaccionId,
      detail,
      status === undefined || status === 408 || status >= 500,
    );
  }

  return new XubioCaeRequestError(
    transaccionId,
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

function readString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
