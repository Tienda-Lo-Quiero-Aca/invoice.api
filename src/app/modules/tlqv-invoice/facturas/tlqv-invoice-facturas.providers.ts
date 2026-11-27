import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GetCostosOperacionesByTlqvCodeRepository } from '../../../../core/driver/repository/spreadsheet-api/costos-operaciones/GetCostosOperacionesByTlqvCodeRepository';
import { GetMeliOrderDetailRepository } from '../../../../core/driver/repository/mercadolibre-api/orders/GetMeliOrderDetailRepository';
import { MeliOrderInvoiceRepository } from '../../../../core/driver/repository/mercadolibre-api/orders/MeliOrderInvoiceRepository';
import { GetMadreItemByTlqvCodeRepository } from '../../../../core/driver/repository/spreadsheet-api/madre/GetMadreItemByTlqvCodeRepository';
import { GetStockBueItemByTlqvCodeRepository } from '../../../../core/driver/repository/spreadsheet-api/stock-bue/GetStockBueItemByTlqvCodeRepository';
import { GetTlqvItemByCodeRepository } from '../../../../core/driver/repository/spreadsheet-api/tlqv/GetTlqvItemByCodeRepository';
import {
  CreateTlqvInvoiceFlowInteractor,
  type ICreateXubioClienteFromTlqvUseCase,
} from '../../../../core/interactors/tlqv-invoice/facturas/CreateTlqvInvoiceFlowInteractor';
import { CreateXubioClienteFromTlqvInteractor } from '../../../../core/interactors/tlqv-invoice/clientes/CreateXubioClienteFromTlqvInteractor';
import { CompleteMeliOrderSaleInteractor } from '../../../../core/interactors/tlqv-invoice/facturas/CompleteMeliOrderSaleInteractor';
import { CreateMeliOrderInvoiceFlowInteractor } from '../../../../core/interactors/tlqv-invoice/facturas/CreateMeliOrderInvoiceFlowInteractor';
import { CreateNotaCreditoFromTlqvInteractor } from '../../../../core/interactors/tlqv-invoice/facturas/CreateNotaCreditoFromTlqvInteractor';
import { RequestCaeInteractor } from '../../../../core/interactors/tlqv-invoice/facturas/RequestCaeInteractor';
import { SendInvoiceToMeliInteractor } from '../../../../core/interactors/tlqv-invoice/facturas/SendInvoiceToMeliInteractor';
import { SyncXubioComprobanteToMadreInteractor } from '../../../../core/interactors/xubio/comprobantes/SyncXubioComprobanteToMadreInteractor';
import { DeleteXubioInvoiceInteractor } from '../../../../core/interactors/xubio/facturas/DeleteXubioInvoiceInteractor';
import {
  createMadreInvoiceClientIssuesRepository,
  createMadreXubioComprobantesRepository,
} from '../../shared/madre/madre-repositories.factory';
import {
  readNumberConfig,
  readOptionalConfig,
} from '../../shared/config/read-config';
import {
  createXubioCreateInvoiceRepository,
  createXubioDeleteInvoiceRepository,
  createXubioGetComprobanteDetailRepository,
  createXubioGetInvoicePdfRepository,
  createXubioRequestCaeRepository,
} from '../../xubio/shared/xubio-factura-repository.factory';
import {
  createXubioCreateClienteRepository,
  createXubioFindClienteRepository,
} from '../../xubio/shared/xubio-cliente-repository.factory';
import {
  CREATE_XUBIO_CLIENTE_FROM_TLQV_INTERACTOR,
  createOpsApiOrderDetailsRepository,
  createTusFacturasAfipInfoRepository,
} from '../clientes/tlqv-invoice-clientes.providers';

export const CREATE_TLQV_INVOICE_FLOW_INTERACTOR = Symbol(
  'CREATE_TLQV_INVOICE_FLOW_INTERACTOR',
);
export const DELETE_XUBIO_INVOICE_INTERACTOR = Symbol(
  'DELETE_XUBIO_INVOICE_INTERACTOR',
);
export const CREATE_NOTA_CREDITO_FROM_TLQV_INTERACTOR = Symbol(
  'CREATE_NOTA_CREDITO_FROM_TLQV_INTERACTOR',
);
export const CREATE_MELI_ORDER_INVOICE_FLOW_INTERACTOR = Symbol(
  'CREATE_MELI_ORDER_INVOICE_FLOW_INTERACTOR',
);
export const SEND_INVOICE_TO_MELI_INTERACTOR = Symbol(
  'SEND_INVOICE_TO_MELI_INTERACTOR',
);
export const REQUEST_CAE_INTERACTOR = Symbol('REQUEST_CAE_INTERACTOR');
export const SYNC_XUBIO_COMPROBANTE_TO_MADRE_INTERACTOR = Symbol(
  'SYNC_XUBIO_COMPROBANTE_TO_MADRE_INTERACTOR',
);
export const COMPLETE_MELI_ORDER_SALE_INTERACTOR = Symbol(
  'COMPLETE_MELI_ORDER_SALE_INTERACTOR',
);

export const tlqvInvoiceFacturasInteractorProviders: Provider[] = [
  {
    provide: CREATE_TLQV_INVOICE_FLOW_INTERACTOR,
    inject: [CREATE_XUBIO_CLIENTE_FROM_TLQV_INTERACTOR, ConfigService],
    useFactory: (
      createXubioClienteFromTlqvUseCase: ICreateXubioClienteFromTlqvUseCase,
      configService: ConfigService,
    ) => {
      // The Spreadsheet API reads a live Google Sheet and times out every so
      // often. Each call is a plain read of one row, so retrying costs nothing
      // and it is what lets a single TLQV be invoiced from the panel: before
      // this, only the bulk queue recovered, by retrying the whole job.
      const spreadsheetRetryOptions = {
        maxAttempts: readNumberConfig(
          configService,
          'SPREADSHEET_API_RETRY_ATTEMPTS',
          3,
        ),
        initialDelayInMilliseconds: readNumberConfig(
          configService,
          'SPREADSHEET_API_RETRY_INITIAL_DELAY_MS',
          500,
        ),
      };
      const spreadsheetOptions = {
        baseUrl: readOptionalConfig(configService, 'SPREADSHEET_API_BASE_URL'),
        spreadsheetName: readOptionalConfig(
          configService,
          'SPREADSHEET_API_INVOICE_SPREADSHEET_NAME',
        ),
        timeoutInMilliseconds: readNumberConfig(
          configService,
          'SPREADSHEET_API_TIMEOUT_MS',
          10_000,
        ),
        retryOptions: spreadsheetRetryOptions,
      };

      return new CreateTlqvInvoiceFlowInteractor(
        createXubioClienteFromTlqvUseCase,
        new GetTlqvItemByCodeRepository(spreadsheetOptions),
        new GetMadreItemByTlqvCodeRepository(spreadsheetOptions),
        createXubioCreateInvoiceRepository(configService),
        undefined,
        undefined,
        new GetTlqvItemByCodeRepository({
          ...spreadsheetOptions,
          spreadsheetName: 'prueba-lectura',
        }),
        new GetStockBueItemByTlqvCodeRepository({
          baseUrl: readOptionalConfig(
            configService,
            'SPREADSHEET_API_BASE_URL',
          ),
          timeoutInMilliseconds: readNumberConfig(
            configService,
            'SPREADSHEET_API_TIMEOUT_MS',
            10_000,
          ),
          retryOptions: spreadsheetRetryOptions,
        }),
      );
    },
  },
  {
    provide: CREATE_MELI_ORDER_INVOICE_FLOW_INTERACTOR,
    inject: [ConfigService],
    useFactory: (configService: ConfigService) => {
      const madre = createMadreXubioComprobantesRepository(configService);
      const tusFacturas = createTusFacturasAfipInfoRepository(configService);
      const createCliente = createXubioCreateClienteRepository(configService);
      const findCliente = createXubioFindClienteRepository(configService);
      const issues = createMadreInvoiceClientIssuesRepository(configService);

      return new CreateMeliOrderInvoiceFlowInteractor(
        createOpsApiOrderDetailsRepository(configService),
        new GetMeliOrderDetailRepository({
          baseUrl: readOptionalConfig(configService, 'MELI_API_BASE_URL'),
          internalApiKey: readOptionalConfig(
            configService,
            'MELI_API_INTERNAL_API_KEY',
          ),
          timeoutInMilliseconds: readNumberConfig(
            configService,
            'MELI_API_TIMEOUT_MS',
            30_000,
          ),
        }),
        // The amount Mercado Libre reports is cross-checked against this
        // sheet. A plain read of one row, so it is retried like the others.
        new GetCostosOperacionesByTlqvCodeRepository({
          baseUrl: readOptionalConfig(
            configService,
            'SPREADSHEET_API_BASE_URL',
          ),
          timeoutInMilliseconds: readNumberConfig(
            configService,
            'SPREADSHEET_API_TIMEOUT_MS',
            10_000,
          ),
          retryOptions: {
            maxAttempts: readNumberConfig(
              configService,
              'SPREADSHEET_API_RETRY_ATTEMPTS',
              3,
            ),
            initialDelayInMilliseconds: readNumberConfig(
              configService,
              'SPREADSHEET_API_RETRY_INITIAL_DELAY_MS',
              500,
            ),
          },
        }),
        // The same cliente step as the sheet-based flow, reading the buyer
        // from the Mercado Libre order instead of asking Ops API.
        (orderDetailsRepository) =>
          new CreateXubioClienteFromTlqvInteractor(
            madre,
            [orderDetailsRepository],
            tusFacturas,
            createCliente,
            issues,
            () => new Date(),
            findCliente,
          ),
        createXubioCreateInvoiceRepository(configService),
      );
    },
  },
  {
    provide: SEND_INVOICE_TO_MELI_INTERACTOR,
    inject: [ConfigService],
    useFactory: (configService: ConfigService) =>
      new SendInvoiceToMeliInteractor(
        createMadreXubioComprobantesRepository(configService),
        createXubioGetComprobanteDetailRepository(configService),
        createOpsApiOrderDetailsRepository(configService),
        createXubioGetInvoicePdfRepository(configService),
        new MeliOrderInvoiceRepository({
          baseUrl: readOptionalConfig(configService, 'MELI_API_BASE_URL'),
          internalApiKey: readOptionalConfig(
            configService,
            'MELI_API_INTERNAL_API_KEY',
          ),
          timeoutInMilliseconds: readNumberConfig(
            configService,
            'MELI_API_UPLOAD_TIMEOUT_MS',
            60_000,
          ),
        }),
      ),
  },
  {
    provide: REQUEST_CAE_INTERACTOR,
    inject: [ConfigService],
    useFactory: (configService: ConfigService) =>
      new RequestCaeInteractor(
        createXubioGetComprobanteDetailRepository(configService),
        createXubioRequestCaeRepository(configService),
        createMadreXubioComprobantesRepository(configService),
      ),
  },
  {
    // The three stages are the very use cases their own endpoints run.
    provide: COMPLETE_MELI_ORDER_SALE_INTERACTOR,
    inject: [
      CREATE_MELI_ORDER_INVOICE_FLOW_INTERACTOR,
      REQUEST_CAE_INTERACTOR,
      SEND_INVOICE_TO_MELI_INTERACTOR,
      SYNC_XUBIO_COMPROBANTE_TO_MADRE_INTERACTOR,
      ConfigService,
    ],
    useFactory: (
      createInvoice: CreateMeliOrderInvoiceFlowInteractor,
      requestCae: RequestCaeInteractor,
      sendInvoiceToMeli: SendInvoiceToMeliInteractor,
      syncComprobanteToMadre: SyncXubioComprobanteToMadreInteractor,
      configService: ConfigService,
    ) =>
      new CompleteMeliOrderSaleInteractor(
        createInvoice,
        requestCae,
        sendInvoiceToMeli,
        syncComprobanteToMadre,
        createMadreXubioComprobantesRepository(configService),
      ),
  },
  {
    provide: SYNC_XUBIO_COMPROBANTE_TO_MADRE_INTERACTOR,
    inject: [ConfigService],
    useFactory: (configService: ConfigService) =>
      new SyncXubioComprobanteToMadreInteractor(
        createXubioGetComprobanteDetailRepository(configService),
        createMadreXubioComprobantesRepository(configService),
      ),
  },
  {
    provide: CREATE_NOTA_CREDITO_FROM_TLQV_INTERACTOR,
    inject: [ConfigService],
    useFactory: (configService: ConfigService) =>
      new CreateNotaCreditoFromTlqvInteractor(
        createMadreXubioComprobantesRepository(configService),
        createXubioCreateInvoiceRepository(configService),
      ),
  },
  {
    provide: DELETE_XUBIO_INVOICE_INTERACTOR,
    inject: [ConfigService],
    useFactory: (configService: ConfigService) =>
      new DeleteXubioInvoiceInteractor(
        createXubioDeleteInvoiceRepository(configService),
      ),
  },
];
