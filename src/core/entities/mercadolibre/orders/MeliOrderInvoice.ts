/** Whether Mercado Libre already holds a factura for a sale. */
export interface MeliOrderInvoiceStatus {
  orderId: string;
  /** Where the factura lives: the cart, or the sale itself when it has none. */
  packId: string | null;
  hasInvoice: boolean;
  /** Mercado Libre's own answer, kept as it came. */
  documents: unknown;
}

export interface UploadMeliOrderInvoiceCommand {
  orderId: string;
  pdf: Buffer;
  fileName: string;
  /** Upload even if the sale already has a factura. */
  force?: boolean;
}

export type UploadMeliOrderInvoiceResponse =
  | {
      status: 'uploaded';
      orderId: string;
      packId: string | null;
      rawPayload: unknown;
    }
  | {
      /** The sale already had a factura and `force` was not set. */
      status: 'already_has_invoice';
      orderId: string;
      rawPayload: unknown;
    };
