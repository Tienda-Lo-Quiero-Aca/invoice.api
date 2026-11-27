import type { IMadreXubioComprobantesRepository } from '../../../../../adapters/repositories/madre-api/xubio/comprobantes/IMadreXubioComprobantesRepository';
import type { IGetComprobanteDetailRepository } from '../../../../../adapters/repositories/xubio/comprobantes/IGetComprobanteDetailRepository';
import type {
  CreateMadreXubioComprobanteSyncRunCommand,
  ExistsMadreXubioComprobanteByTlqvCodeCommand,
  ExistsMadreXubioComprobanteByTlqvCodeResponse,
  FindFullMadreXubioComprobanteByTlqvCodeCommand,
  FindFullMadreXubioComprobanteByTlqvCodeResponse,
  FindMadreXubioComprobanteByTlqvCodeCommand,
  FindMadreXubioComprobanteByTlqvCodeResponse,
  FindMadreXubioComprobantesByTlqvCodesCommand,
  FindMadreXubioComprobantesByTlqvCodesResponse,
  MadreXubioComprobante,
  MadreXubioComprobanteSyncRun,
  UpdateMadreXubioComprobanteSyncRunCommand,
  UpsertMadreXubioComprobantesBatchCommand,
  UpsertMadreXubioComprobantesBatchResponse,
} from '../../../../../entities/madre-api/xubio/comprobantes/MadreXubioComprobante';

/**
 * Madre's comprobantes of a TLQV, minus the ones that no longer exist in
 * Xubio.
 *
 * Madre is a copy, and nothing removes a row from it when the comprobante is
 * deleted in Xubio. A factura issued, copied to Madre and then deleted would
 * keep its sale marked as invoiced for good; a deleted nota de crédito would
 * keep a factura that still stands marked as cancelled, and let the sale be
 * invoiced twice. So whoever decides on these comprobantes gets them checked
 * against Xubio first.
 *
 * Only a comprobante without CAE can be deleted in Xubio, so only those are
 * asked about: in day-to-day use that is nearly none. And a comprobante is
 * dropped only when Xubio says, in so many words, that it does not exist. If
 * Xubio cannot be asked, it stays: counting a sale as invoiced by mistake
 * costs a review, the opposite costs a duplicate factura.
 */
export class XubioVerifiedMadreComprobantesRepository implements IMadreXubioComprobantesRepository {
  constructor(
    private readonly madreRepository: IMadreXubioComprobantesRepository,
    private readonly comprobanteDetailRepository: IGetComprobanteDetailRepository,
    private readonly onDeletedComprobanteFound: (
      comprobante: MadreXubioComprobante,
    ) => void = () => undefined,
  ) {}

  async findFullByTlqvCode(
    command: FindFullMadreXubioComprobanteByTlqvCodeCommand,
  ): Promise<FindFullMadreXubioComprobanteByTlqvCodeResponse> {
    const response = await this.madreRepository.findFullByTlqvCode(command);
    const items: MadreXubioComprobante[] = [];

    for (const item of response.items) {
      if (await this.wasDeletedInXubio(item)) {
        this.onDeletedComprobanteFound(item);
        continue;
      }
      items.push(item);
    }

    return { ...response, items };
  }

  private async wasDeletedInXubio(
    comprobante: MadreXubioComprobante,
  ): Promise<boolean> {
    if (hasCae(comprobante)) {
      return false;
    }

    try {
      await this.comprobanteDetailRepository.getDetail({
        transaccionId: comprobante.xubioTransactionId,
      });
      return false;
    } catch (error: unknown) {
      return isNotFound(error);
    }
  }

  createSyncRun(
    command: CreateMadreXubioComprobanteSyncRunCommand,
  ): Promise<MadreXubioComprobanteSyncRun> {
    return this.madreRepository.createSyncRun(command);
  }

  updateSyncRun(
    command: UpdateMadreXubioComprobanteSyncRunCommand,
  ): Promise<MadreXubioComprobanteSyncRun> {
    return this.madreRepository.updateSyncRun(command);
  }

  upsertBatch(
    command: UpsertMadreXubioComprobantesBatchCommand,
  ): Promise<UpsertMadreXubioComprobantesBatchResponse> {
    return this.madreRepository.upsertBatch(command);
  }

  findByTlqvCodes(
    command: FindMadreXubioComprobantesByTlqvCodesCommand,
  ): Promise<FindMadreXubioComprobantesByTlqvCodesResponse> {
    return this.madreRepository.findByTlqvCodes(command);
  }

  findByTlqvCode(
    command: FindMadreXubioComprobanteByTlqvCodeCommand,
  ): Promise<FindMadreXubioComprobanteByTlqvCodeResponse> {
    return this.madreRepository.findByTlqvCode(command);
  }

  existsByTlqvCode(
    command: ExistsMadreXubioComprobanteByTlqvCodeCommand,
  ): Promise<ExistsMadreXubioComprobanteByTlqvCodeResponse> {
    return this.madreRepository.existsByTlqvCode(command);
  }
}

function hasCae(comprobante: MadreXubioComprobante): boolean {
  return (
    comprobante.fiscalmenteEmitido === true ||
    (comprobante.cae ?? '').trim() !== ''
  );
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { notFound?: unknown }).notFound === true
  );
}
