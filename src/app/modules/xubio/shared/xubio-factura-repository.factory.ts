import { ConfigService } from '@nestjs/config';
import { CachedXubioAccessTokenProvider } from '../../../../core/driver/repository/xubio/auth/CachedXubioAccessTokenProvider';
import { GetAccessTokenRepository } from '../../../../core/driver/repository/xubio/auth/GetAccessTokenRepository';
import { GetComprobanteDetailRepository } from '../../../../core/driver/repository/xubio/comprobantes/GetComprobanteDetailRepository';
import { CreateInvoiceRepository } from '../../../../core/driver/repository/xubio/facturas/CreateInvoiceRepository';
import { GetInvoicePdfRepository } from '../../../../core/driver/repository/xubio/facturas/GetInvoicePdfRepository';
import { DeleteInvoiceRepository } from '../../../../core/driver/repository/xubio/facturas/DeleteInvoiceRepository';
import { RequestCaeRepository } from '../../../../core/driver/repository/xubio/facturas/RequestCaeRepository';
import {
  readNumberConfig,
  readOptionalConfig,
  readRequiredConfig,
} from '../../shared/config/read-config';
import { readXubioRetryOptions } from './xubio-cliente-repository.factory';

export function createXubioCreateInvoiceRepository(
  configService: ConfigService,
): CreateInvoiceRepository {
  const xubioBaseUrl = readOptionalConfig(configService, 'XUBIO_BASE_URL');
  const retryOptions = readXubioRetryOptions(configService);
  const tokenProvider = createXubioAccessTokenProvider(configService);

  return new CreateInvoiceRepository({
    baseUrl: xubioBaseUrl,
    accessTokenProvider: () => tokenProvider.getAccessToken(),
    onAuthorizationFailure: () => tokenProvider.invalidateAccessToken(),
    timeoutInMilliseconds: readNumberConfig(
      configService,
      'XUBIO_INVOICE_TIMEOUT_MS',
      30_000,
    ),
    retryOptions,
  });
}

export function createXubioDeleteInvoiceRepository(
  configService: ConfigService,
): DeleteInvoiceRepository {
  const xubioBaseUrl = readOptionalConfig(configService, 'XUBIO_BASE_URL');
  const retryOptions = readXubioRetryOptions(configService);
  const tokenProvider = createXubioAccessTokenProvider(configService);

  return new DeleteInvoiceRepository({
    baseUrl: xubioBaseUrl,
    accessTokenProvider: () => tokenProvider.getAccessToken(),
    onAuthorizationFailure: () => tokenProvider.invalidateAccessToken(),
    timeoutInMilliseconds: readNumberConfig(
      configService,
      'XUBIO_INVOICE_TIMEOUT_MS',
      30_000,
    ),
    retryOptions,
  });
}

/** The PDF of a comprobante, as Xubio prints it. */
export function createXubioGetInvoicePdfRepository(
  configService: ConfigService,
): GetInvoicePdfRepository {
  const tokenProvider = createXubioAccessTokenProvider(configService);

  return new GetInvoicePdfRepository({
    baseUrl: readOptionalConfig(configService, 'XUBIO_BASE_URL'),
    accessTokenProvider: () => tokenProvider.getAccessToken(),
    onAuthorizationFailure: () => tokenProvider.invalidateAccessToken(),
    retryOptions: readXubioRetryOptions(configService),
  });
}

/** One comprobante read straight from Xubio — the current CAE included. */
export function createXubioGetComprobanteDetailRepository(
  configService: ConfigService,
): GetComprobanteDetailRepository {
  const tokenProvider = createXubioAccessTokenProvider(configService);

  return new GetComprobanteDetailRepository({
    baseUrl: readOptionalConfig(configService, 'XUBIO_BASE_URL'),
    accessTokenProvider: () => tokenProvider.getAccessToken(),
    onAuthorizationFailure: () => tokenProvider.invalidateAccessToken(),
    retryOptions: readXubioRetryOptions(configService),
  });
}

/** Asks AFIP for the CAE of a comprobante, through Xubio. */
export function createXubioRequestCaeRepository(
  configService: ConfigService,
): RequestCaeRepository {
  const tokenProvider = createXubioAccessTokenProvider(configService);

  return new RequestCaeRepository({
    baseUrl: readOptionalConfig(configService, 'XUBIO_BASE_URL'),
    accessTokenProvider: () => tokenProvider.getAccessToken(),
    onAuthorizationFailure: () => tokenProvider.invalidateAccessToken(),
    // Xubio keeps the request open while AFIP answers.
    timeoutInMilliseconds: readNumberConfig(
      configService,
      'XUBIO_CAE_TIMEOUT_MS',
      60_000,
    ),
    retryOptions: readXubioRetryOptions(configService),
  });
}

function createXubioAccessTokenProvider(
  configService: ConfigService,
): CachedXubioAccessTokenProvider {
  return new CachedXubioAccessTokenProvider(
    new GetAccessTokenRepository({
      baseUrl: readOptionalConfig(configService, 'XUBIO_BASE_URL'),
      basicAuthorizationToken: readRequiredConfig(
        configService,
        'XUBIO_BASIC_AUTHORIZATION',
      ),
      retryOptions: readXubioRetryOptions(configService),
    }),
  );
}
