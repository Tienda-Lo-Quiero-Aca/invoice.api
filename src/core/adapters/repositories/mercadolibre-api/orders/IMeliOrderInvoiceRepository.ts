import type {
  MeliOrderInvoiceStatus,
  UploadMeliOrderInvoiceCommand,
  UploadMeliOrderInvoiceResponse,
} from '../../../../entities/mercadolibre/orders/MeliOrderInvoice';

export interface IMeliOrderInvoiceRepository {
  getStatus(command: { orderId: string }): Promise<MeliOrderInvoiceStatus>;
  upload(
    command: UploadMeliOrderInvoiceCommand,
  ): Promise<UploadMeliOrderInvoiceResponse>;
}
