import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { IMadreXubioComprobantesRepository } from '../../../../core/adapters/repositories/madre-api/xubio/comprobantes/IMadreXubioComprobantesRepository';
import { MadreInvoiceClientIssuesRepository } from '../../../../core/driver/repository/madre-api/invoice/client-issues/MadreInvoiceClientIssuesRepository';
import { MadreXubioComprobantesRepository } from '../../../../core/driver/repository/madre-api/xubio/comprobantes/MadreXubioComprobantesRepository';
import { XubioVerifiedMadreComprobantesRepository } from '../../../../core/driver/repository/madre-api/xubio/comprobantes/XubioVerifiedMadreComprobantesRepository';
import { createXubioGetComprobanteDetailRepository } from '../../xubio/shared/xubio-factura-repository.factory';
import { readNumberConfig, readRequiredConfig } from '../config/read-config';

const logger = new Logger('MadreXubioComprobantes');

/**
 * Madre's copy of the comprobantes, with the ones deleted in Xubio left out
 * of what a TLQV is reported to have. See the wrapper for why.
 */
export function createMadreXubioComprobantesRepository(
  configService: ConfigService,
): IMadreXubioComprobantesRepository {
  return new XubioVerifiedMadreComprobantesRepository(
    new MadreXubioComprobantesRepository({
      baseUrl: readRequiredConfig(configService, 'MADRE_API_BASE_URL'),
      internalApiKey: readRequiredConfig(
        configService,
        'MADRE_INTERNAL_API_KEY',
      ),
      timeoutInMilliseconds: readNumberConfig(
        configService,
        'MADRE_API_TIMEOUT_MS',
        20_000,
      ),
    }),
    createXubioGetComprobanteDetailRepository(configService),
    (comprobante) =>
      logger.warn(
        `Comprobante in Madre no longer exists in Xubio, ignored ${JSON.stringify(
          {
            xubioTransactionId: comprobante.xubioTransactionId,
            numeroDocumento: comprobante.numeroDocumento,
            tlqvCode: comprobante.tlqvCode,
          },
        )}`,
      ),
  );
}

export function createMadreInvoiceClientIssuesRepository(
  configService: ConfigService,
): MadreInvoiceClientIssuesRepository {
  return new MadreInvoiceClientIssuesRepository({
    baseUrl: readRequiredConfig(configService, 'MADRE_API_BASE_URL'),
    internalApiKey: readRequiredConfig(configService, 'MADRE_INTERNAL_API_KEY'),
    timeoutInMilliseconds: readNumberConfig(
      configService,
      'MADRE_API_TIMEOUT_MS',
      20_000,
    ),
  });
}
