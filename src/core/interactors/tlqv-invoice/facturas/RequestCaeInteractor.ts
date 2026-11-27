import type { IMadreXubioComprobantesRepository } from '../../../adapters/repositories/madre-api/xubio/comprobantes/IMadreXubioComprobantesRepository';
import type { IGetComprobanteDetailRepository } from '../../../adapters/repositories/xubio/comprobantes/IGetComprobanteDetailRepository';
import type { IRequestXubioCaeRepository } from '../../../adapters/repositories/xubio/facturas/IRequestXubioCaeRepository';
import type { XubioComprobanteDetail } from '../../../entities/xubio/comprobantes/XubioComprobante';
import { normalizeRequiredTlqvCode } from './CreateTlqvInvoiceFlowInteractor';

/**
 * `authorized`: the CAE was granted. `ready`: dry run, it would be requested.
 * `skipped`: nothing to do, it already had one. `blocked`: it could not be
 * obtained.
 */
export type RequestCaeStatus = 'authorized' | 'ready' | 'skipped' | 'blocked';

export type RequestCaeBlockerCode =
  | 'XUBIO_COMPROBANTE_LOOKUP_FAILED'
  | 'ALREADY_HAS_CAE'
  | 'CAE_REJECTED'
  | 'CAE_REQUEST_OUTCOME_UNKNOWN'
  | 'COMPROBANTES_LOOKUP_FAILED'
  | 'NO_COMPROBANTE';

export interface RequestCaeBlocker {
  code: RequestCaeBlockerCode;
  message: string;
}

export interface CaeComprobanteSummary {
  transaccionId: number;
  numeroDocumento: string | null;
  /** 1 factura, 3 nota de crédito, as Xubio numbers them. */
  tipo: number | null;
  fecha: string | null;
  importeTotal: number | null;
  cliente: string | null;
  descripcion: string | null;
  cae: string | null;
  /** YYYY-MM-DD. */
  caeFechaVto: string | null;
}

export interface RequestCaeResponse {
  status: RequestCaeStatus;
  transaccionId: number;
  dryRun: boolean;
  comprobante?: CaeComprobanteSummary;
  blockers: RequestCaeBlocker[];
}

export interface RequestCaeForTlqvResponse {
  /**
   * Worst case across the comprobantes: `blocked` if any was, then
   * `authorized`, then `ready`, and `skipped` only when none needed a CAE.
   */
  status: RequestCaeStatus;
  tlqvCode: string;
  dryRun: boolean;
  results: RequestCaeResponse[];
  blockers: RequestCaeBlocker[];
}

export interface CaeBulkPlanItem {
  transaccionId: number;
  /** Null when the comprobante was named by its ID instead of by a TLQV. */
  tlqvCode: string | null;
  numeroDocumento: string | null;
}

export interface CaeBulkPlan {
  /** Oldest first: the order the CAE has to be requested in. */
  items: CaeBulkPlanItem[];
  /** TLQVs asked for that have no comprobante in Madre yet. */
  tlqvCodesWithoutComprobante: string[];
}

/**
 * Asks AFIP, through Xubio, for the CAE of a comprobante — a factura or a
 * nota de crédito.
 *
 * A CAE cannot be taken back: once granted the comprobante is a fiscal
 * document and only a nota de crédito undoes it. So this never asks for one a
 * comprobante already has, and it never trusts the answer of the request by
 * itself: whatever Xubio said, or failed to say, the comprobante is read again
 * and that is what gets reported. A lost answer therefore ends as "it has a
 * CAE" or "it does not", never as a guess.
 */
export class RequestCaeInteractor {
  constructor(
    private readonly comprobanteDetailRepository: IGetComprobanteDetailRepository,
    private readonly requestCaeRepository: IRequestXubioCaeRepository,
    private readonly madreXubioComprobantesRepository: IMadreXubioComprobantesRepository,
  ) {}

  async execute(command: {
    transaccionId: number;
    dryRun?: boolean;
  }): Promise<RequestCaeResponse> {
    const transaccionId = command.transaccionId;
    const dryRun = command.dryRun ?? true;
    const base = { transaccionId, dryRun };

    let before: CaeComprobanteSummary;
    try {
      before = await this.readComprobante(transaccionId);
    } catch (error: unknown) {
      return {
        ...base,
        status: 'blocked',
        blockers: [
          {
            code: 'XUBIO_COMPROBANTE_LOOKUP_FAILED',
            message: `No se pudo consultar en Xubio el comprobante ${transaccionId}. ${readErrorMessage(error)}`,
          },
        ],
      };
    }

    if (before.cae !== null) {
      return {
        ...base,
        status: 'skipped',
        comprobante: before,
        blockers: [
          {
            code: 'ALREADY_HAS_CAE',
            message: `El comprobante ${describe(before)} ya tiene CAE (${before.cae}). No se pide otro.`,
          },
        ],
      };
    }

    if (dryRun) {
      return { ...base, status: 'ready', comprobante: before, blockers: [] };
    }

    let requestDetail: string | null = null;
    let outcomeUnknown = false;
    try {
      const response = await this.requestCaeRepository.requestCae({
        transaccionId,
      });
      requestDetail = response.detail;
    } catch (error: unknown) {
      requestDetail = readErrorMessage(error);
      outcomeUnknown = hasUnknownOutcome(error);
    }

    // The comprobante itself is the source of truth, not the answer above.
    let after: CaeComprobanteSummary;
    try {
      after = await this.readComprobante(transaccionId);
    } catch (error: unknown) {
      return {
        ...base,
        status: 'blocked',
        comprobante: before,
        blockers: [
          {
            code: 'CAE_REQUEST_OUTCOME_UNKNOWN',
            message: `Se pidió el CAE del comprobante ${describe(before)} pero no se pudo confirmar el resultado en Xubio. ${readErrorMessage(error)} Volvé a correrlo: si el CAE ya fue otorgado, lo detecta y no lo pide de nuevo.`,
          },
        ],
      };
    }

    if (after.cae !== null) {
      return {
        ...base,
        status: 'authorized',
        comprobante: after,
        blockers: [],
      };
    }

    return {
      ...base,
      status: 'blocked',
      comprobante: after,
      blockers: [
        outcomeUnknown
          ? {
              code: 'CAE_REQUEST_OUTCOME_UNKNOWN',
              message:
                `Xubio no respondió al pedir el CAE del comprobante ${describe(after)}, y al consultarlo sigue sin CAE. ${requestDetail ?? ''} Se puede reintentar: antes de pedirlo se verifica que no lo tenga.`.replace(
                  /\s+/g,
                  ' ',
                ),
            }
          : {
              code: 'CAE_REJECTED',
              message: `No se obtuvo el CAE del comprobante ${describe(after)}. ${requestDetail ?? 'Xubio no informó el motivo.'}`,
            },
      ],
    };
  }

  /**
   * Every comprobante of a TLQV that still lacks a CAE, oldest first: AFIP
   * authorizes each numbering in order, so the first one issued goes first.
   */
  async executeForTlqv(command: {
    tlqvCode: string;
    dryRun?: boolean;
  }): Promise<RequestCaeForTlqvResponse> {
    const tlqvCode = normalizeRequiredTlqvCode(command.tlqvCode);
    const dryRun = command.dryRun ?? true;
    const base = { tlqvCode, dryRun };

    let transaccionIds: number[];
    try {
      const response =
        await this.madreXubioComprobantesRepository.findByTlqvCode({
          tlqvCode,
        });
      transaccionIds = sortUniqueTransaccionIds(
        response.items.map((item) => item.xubioTransactionId),
      );
    } catch (error: unknown) {
      return {
        ...base,
        status: 'blocked',
        results: [],
        blockers: [
          {
            code: 'COMPROBANTES_LOOKUP_FAILED',
            message: `No se pudieron leer los comprobantes de ${tlqvCode} en Madre. ${readErrorMessage(error)}`,
          },
        ],
      };
    }

    if (transaccionIds.length === 0) {
      return {
        ...base,
        status: 'blocked',
        results: [],
        blockers: [
          {
            code: 'NO_COMPROBANTE',
            message: `${tlqvCode} no tiene comprobantes en Madre. Si se emitió hace poco, puede que todavía no se haya sincronizado: pedí el CAE con el ID del comprobante que devolvió la emisión.`,
          },
        ],
      };
    }

    const results: RequestCaeResponse[] = [];
    for (const transaccionId of transaccionIds) {
      results.push(await this.execute({ transaccionId, dryRun }));
    }

    return {
      ...base,
      status: summarizeStatus(results),
      results,
      blockers: results
        .filter((result) => result.status === 'blocked')
        .flatMap((result) => result.blockers),
    };
  }

  /**
   * Turns a list of TLQVs and/or comprobante IDs into the comprobantes a batch
   * has to go through, without asking Xubio anything. They come out oldest
   * first across the whole batch, not TLQV by TLQV: AFIP authorizes each
   * numbering in order, and a batch that skipped ahead would get the later
   * ones rejected.
   */
  async planBulk(command: {
    tlqvCodes?: string[];
    transaccionIds?: number[];
  }): Promise<CaeBulkPlan> {
    const tlqvCodes = [
      ...new Set((command.tlqvCodes ?? []).map(normalizeRequiredTlqvCode)),
    ];
    const byId = new Map<number, CaeBulkPlanItem>();

    for (const transaccionId of sortUniqueTransaccionIds(
      command.transaccionIds ?? [],
    )) {
      byId.set(transaccionId, {
        transaccionId,
        tlqvCode: null,
        numeroDocumento: null,
      });
    }

    const found = new Set<string>();
    if (tlqvCodes.length > 0) {
      const response =
        await this.madreXubioComprobantesRepository.findByTlqvCodes({
          tlqvCodes,
        });

      for (const item of response.items) {
        const [transaccionId] = sortUniqueTransaccionIds([
          item.xubioTransactionId,
        ]);
        if (transaccionId === undefined) {
          continue;
        }

        found.add(item.tlqvCode.trim().toUpperCase());
        // What Madre knows wins over a bare ID naming the same comprobante.
        byId.set(transaccionId, {
          transaccionId,
          tlqvCode: item.tlqvCode,
          numeroDocumento: normalizeOptionalString(item.numeroDocumento),
        });
      }
    }

    return {
      items: [...byId.values()].sort(
        (left, right) => left.transaccionId - right.transaccionId,
      ),
      tlqvCodesWithoutComprobante: tlqvCodes.filter(
        (tlqvCode) => !found.has(tlqvCode),
      ),
    };
  }

  private async readComprobante(
    transaccionId: number,
  ): Promise<CaeComprobanteSummary> {
    const { comprobante } = await this.comprobanteDetailRepository.getDetail({
      transaccionId,
    });

    return toSummary(transaccionId, comprobante);
  }
}

export function sortUniqueTransaccionIds(
  values: (number | null | undefined)[],
): number[] {
  const ids = values.filter(
    (value): value is number =>
      typeof value === 'number' && Number.isInteger(value) && value > 0,
  );

  return [...new Set(ids)].sort((left, right) => left - right);
}

function summarizeStatus(results: RequestCaeResponse[]): RequestCaeStatus {
  for (const status of ['blocked', 'authorized', 'ready'] as const) {
    if (results.some((result) => result.status === status)) {
      return status;
    }
  }

  return 'skipped';
}

function toSummary(
  transaccionId: number,
  comprobante: XubioComprobanteDetail,
): CaeComprobanteSummary {
  return {
    transaccionId,
    numeroDocumento: normalizeOptionalString(comprobante.numeroDocumento),
    tipo: typeof comprobante.tipo === 'number' ? comprobante.tipo : null,
    fecha: normalizeOptionalString(comprobante.fecha),
    importeTotal:
      typeof comprobante.importetotal === 'number'
        ? comprobante.importetotal
        : null,
    cliente: normalizeOptionalString(comprobante.cliente?.nombre),
    descripcion: normalizeOptionalString(comprobante.descripcion),
    cae: normalizeOptionalString(comprobante.cae ?? comprobante.CAE),
    caeFechaVto: formatCaeExpiration(comprobante.caefechaVto),
  };
}

function formatCaeExpiration(
  value: XubioComprobanteDetail['caefechaVto'],
): string | null {
  if (!Array.isArray(value) || value.length !== 3) {
    return null;
  }

  const [year, month, day] = value;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function describe(comprobante: CaeComprobanteSummary): string {
  return comprobante.numeroDocumento ?? String(comprobante.transaccionId);
}

function hasUnknownOutcome(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { outcomeUnknown?: unknown }).outcomeUnknown === true
  );
}

function normalizeOptionalString(
  value: string | null | undefined,
): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Error desconocido.';
}
