import type { MadreXubioComprobante } from '../../../entities/madre-api/xubio/comprobantes/MadreXubioComprobante';

export interface LiveInvoiceSelection {
  /** Every factura of the TLQV, cancelled or not. */
  facturas: MadreXubioComprobante[];
  /** The facturas no nota de crédito cancels, newest first. */
  live: MadreXubioComprobante[];
}

/**
 * Separates the facturas of a TLQV that still stand from the ones a nota de
 * crédito cancelled. A nota de crédito points at the factura it cancels
 * through `comprobante` in the payload Xubio returned.
 */
export function selectLiveInvoices(
  comprobantes: MadreXubioComprobante[],
): LiveInvoiceSelection {
  const facturas = comprobantes.filter((item) => !isCreditNote(item));
  const cancelledIds = readCancelledTransactionIds(comprobantes);
  const live = facturas
    .filter((factura) => !cancelledIds.has(factura.xubioTransactionId))
    .sort((left, right) =>
      String(right.fechaEmision).localeCompare(String(left.fechaEmision)),
    );

  return { facturas, live };
}

function isCreditNote(item: MadreXubioComprobante): boolean {
  return item.documentKind === 'CREDIT_NOTE';
}

function readCancelledTransactionIds(
  comprobantes: MadreXubioComprobante[],
): Set<number> {
  const ids = new Set<number>();
  for (const comprobante of comprobantes) {
    if (!isCreditNote(comprobante)) {
      continue;
    }

    const payload = comprobante.rawDetailPayload;
    if (typeof payload !== 'object' || payload === null) {
      continue;
    }

    const value = (payload as Record<string, unknown>).comprobante;
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
      ids.add(value);
    }
  }

  return ids;
}
