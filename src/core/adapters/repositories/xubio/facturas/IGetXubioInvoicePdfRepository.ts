export interface GetXubioInvoicePdfCommand {
  transaccionId: number;
}

export interface XubioInvoicePdf {
  transaccionId: number;
  content: Buffer;
  sizeInBytes: number;
}

export interface IGetXubioInvoicePdfRepository {
  getPdf(command: GetXubioInvoicePdfCommand): Promise<XubioInvoicePdf>;
}
