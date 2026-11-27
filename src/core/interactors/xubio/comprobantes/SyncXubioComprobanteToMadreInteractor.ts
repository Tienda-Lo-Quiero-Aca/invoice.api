import type { IMadreXubioComprobantesRepository } from '../../../adapters/repositories/madre-api/xubio/comprobantes/IMadreXubioComprobantesRepository';
import type { IGetComprobanteDetailRepository } from '../../../adapters/repositories/xubio/comprobantes/IGetComprobanteDetailRepository';
import { mapToMadreComprobante } from './BackfillXubioComprobantesInteractor';

/**
 * Copies one comprobante from Xubio to Madre right away, the same record the
 * scheduled backfill would write hours later.
 *
 * Madre is what the duplicate check reads before invoicing. Until a new
 * factura is there, a second run for the same sale would not know it exists
 * and would issue another one.
 */
export class SyncXubioComprobanteToMadreInteractor {
  constructor(
    private readonly comprobanteDetailRepository: IGetComprobanteDetailRepository,
    private readonly madreXubioComprobantesRepository: IMadreXubioComprobantesRepository,
  ) {}

  async execute(command: { transaccionId: number }): Promise<void> {
    const { comprobante } = await this.comprobanteDetailRepository.getDetail({
      transaccionId: command.transaccionId,
    });

    const response = await this.madreXubioComprobantesRepository.upsertBatch({
      items: [mapToMadreComprobante(null, null, comprobante)],
    });

    if ((response.failed ?? 0) > 0) {
      throw new Error(
        `Madre no guardó el comprobante ${command.transaccionId}.`,
      );
    }
  }
}
