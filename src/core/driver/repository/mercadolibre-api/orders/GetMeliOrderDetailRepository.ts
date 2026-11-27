import axios, { type AxiosInstance } from 'axios';
import type { IGetMeliOrderDetailRepository } from '../../../../adapters/repositories/mercadolibre-api/orders/IGetMeliOrderDetailRepository';
import type {
  GetMeliOrderDetailCommand,
  GetMeliOrderDetailResponse,
  MeliOrderBilling,
  MeliOrderDetail,
  MeliOrderItem,
} from '../../../../entities/mercadolibre/orders/MeliOrderDetail';

const DEFAULT_BASE_URL = 'https://api.meli.loquieroaca.com';
// The service gathers one sale from up to five Mercado Libre calls.
const DEFAULT_TIMEOUT_IN_MILLISECONDS = 30_000;
const INTERNAL_API_KEY_HEADER = 'x-internal-api-key';
const MAX_ERROR_BODY_LENGTH = 500;

export interface GetMeliOrderDetailRepositoryOptions {
  baseUrl?: string;
  internalApiKey?: string;
  timeoutInMilliseconds?: number;
  httpClient?: AxiosInstance;
}

export class MeliOrderDetailRequestError extends Error {
  constructor(orderId: string, detail: string) {
    super(
      `mercadolibre-api request failed while getting order ${orderId}: ${detail}`,
    );
    this.name = MeliOrderDetailRequestError.name;
  }
}

export class MeliOrderDetailInvalidResponseError extends Error {
  constructor(detail: string) {
    super(`mercadolibre-api returned an invalid order detail: ${detail}`);
    this.name = MeliOrderDetailInvalidResponseError.name;
  }
}

export class MeliOrderDetailConfigurationError extends Error {
  constructor() {
    super('MELI_API_INTERNAL_API_KEY is required to call mercadolibre-api');
    this.name = MeliOrderDetailConfigurationError.name;
  }
}

export class GetMeliOrderDetailRepository implements IGetMeliOrderDetailRepository {
  private readonly httpClient: AxiosInstance;
  private readonly internalApiKey?: string;

  constructor(options: GetMeliOrderDetailRepositoryOptions = {}) {
    this.internalApiKey = options.internalApiKey;
    this.httpClient =
      options.httpClient ??
      axios.create({
        baseURL: options.baseUrl ?? DEFAULT_BASE_URL,
        timeout:
          options.timeoutInMilliseconds ?? DEFAULT_TIMEOUT_IN_MILLISECONDS,
      });
  }

  async getByOrderId(
    command: GetMeliOrderDetailCommand,
  ): Promise<GetMeliOrderDetailResponse> {
    const orderId = normalizeOrderId(command.orderId);
    const internalApiKey = this.internalApiKey?.trim();
    if (internalApiKey === undefined || internalApiKey === '') {
      throw new MeliOrderDetailConfigurationError();
    }

    try {
      const response = await this.httpClient.get<unknown>(
        `/meli/orders/${encodeURIComponent(orderId)}`,
        {
          headers: {
            Accept: 'application/json',
            [INTERNAL_API_KEY_HEADER]: internalApiKey,
          },
        },
      );

      return { found: true, order: parseOrderDetail(response.data, orderId) };
    } catch (error: unknown) {
      if (error instanceof MeliOrderDetailInvalidResponseError) {
        throw error;
      }

      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return { found: false, orderId, rawPayload: error.response.data };
      }

      throw buildRequestError(orderId, error);
    }
  }
}

function parseOrderDetail(
  value: unknown,
  expectedOrderId: string,
): MeliOrderDetail {
  if (!isRecord(value)) {
    throw new MeliOrderDetailInvalidResponseError('body must be an object');
  }

  const id = readId(value.id);
  if (id === null) {
    throw new MeliOrderDetailInvalidResponseError('id is required');
  }
  if (id !== expectedOrderId) {
    throw new MeliOrderDetailInvalidResponseError(
      `expected order ${expectedOrderId}, received ${id}`,
    );
  }

  const totalAmount = value.totalAmount;
  if (typeof totalAmount !== 'number' || !Number.isFinite(totalAmount)) {
    throw new MeliOrderDetailInvalidResponseError(
      'totalAmount must be a number',
    );
  }

  const status = readString(value.status);
  if (status === null) {
    throw new MeliOrderDetailInvalidResponseError('status is required');
  }

  const currencyId = readString(value.currencyId);
  if (currencyId === null) {
    throw new MeliOrderDetailInvalidResponseError('currencyId is required');
  }

  return {
    id,
    packId: readId(value.packId),
    status,
    currencyId,
    totalAmount,
    paidAmount: readNumber(value.paidAmount),
    items: Array.isArray(value.items) ? value.items.map(parseItem) : [],
    billing: parseBilling(value.buyer),
    rawPayload: value,
  };
}

function parseItem(value: unknown): MeliOrderItem {
  const item = isRecord(value) ? value : {};

  return {
    itemId: readString(item.itemId),
    title: readString(item.title),
    sellerSku: readString(item.sellerSku),
    quantity: readNumber(item.quantity),
    unitPrice: readNumber(item.unitPrice),
  };
}

function parseBilling(buyer: unknown): MeliOrderBilling | null {
  if (!isRecord(buyer) || !isRecord(buyer.billing)) {
    return null;
  }

  const billing = buyer.billing;
  const taxpayerType = isRecord(billing.taxpayerType)
    ? billing.taxpayerType
    : {};
  const address = isRecord(billing.address) ? billing.address : null;

  return {
    firstName: readString(billing.firstName),
    lastName: readString(billing.lastName),
    identificationType: readString(billing.identificationType),
    identificationNumber: readString(billing.identificationNumber),
    taxpayerTypeDescription: readString(taxpayerType.description),
    address:
      address === null
        ? null
        : {
            streetName: readString(address.streetName),
            streetNumber: readString(address.streetNumber),
            cityName: readString(address.cityName),
            stateName: readString(address.stateName),
            zipCode: readString(address.zipCode),
          },
  };
}

function buildRequestError(
  orderId: string,
  error: unknown,
): MeliOrderDetailRequestError {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const detail =
      status === undefined
        ? `${error.code ?? 'NETWORK_ERROR'} - ${error.message}`
        : `HTTP ${status} - ${serializeBody(error.response?.data)}`;

    return new MeliOrderDetailRequestError(orderId, detail);
  }

  return new MeliOrderDetailRequestError(
    orderId,
    error instanceof Error ? error.message : 'unknown error',
  );
}

function serializeBody(value: unknown): string {
  let serialized: string;
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

/** Mercado Libre ids are numbers that do not fit safely in every consumer. */
function readId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    return value.trim();
  }

  return null;
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
