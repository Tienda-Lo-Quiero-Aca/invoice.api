/**
 * One Mercado Libre sale as the internal mercadolibre-api returns it
 * (`GET /meli/orders/:orderId`). Only what invoicing reads is typed; the full
 * answer travels in `rawPayload`.
 */
export interface MeliOrderDetail {
  id: string;
  /** Cart the sale belongs to. Null when the buyer bought a single product. */
  packId: string | null;
  status: string;
  currencyId: string;
  /**
   * Sum of the products at the price charged, after seller discounts and
   * without shipping. This is the amount the invoice is issued for.
   */
  totalAmount: number;
  /** What the buyer paid, shipping and financing included. */
  paidAmount: number | null;
  items: MeliOrderItem[];
  /** Null when Mercado Libre did not return billing data. */
  billing: MeliOrderBilling | null;
  rawPayload: unknown;
}

export interface MeliOrderItem {
  itemId: string | null;
  title: string | null;
  sellerSku: string | null;
  quantity: number | null;
  unitPrice: number | null;
}

export interface MeliOrderBilling {
  firstName: string | null;
  lastName: string | null;
  /** `DNI`, `CUIT`, … */
  identificationType: string | null;
  identificationNumber: string | null;
  /** AFIP condition as Mercado Libre reports it, e.g. "Consumidor Final". */
  taxpayerTypeDescription: string | null;
  address: {
    streetName: string | null;
    streetNumber: string | null;
    cityName: string | null;
    stateName: string | null;
    zipCode: string | null;
  } | null;
}

export interface GetMeliOrderDetailCommand {
  orderId: string;
}

export type GetMeliOrderDetailResponse =
  | { found: true; order: MeliOrderDetail }
  | { found: false; orderId: string; rawPayload?: unknown };
