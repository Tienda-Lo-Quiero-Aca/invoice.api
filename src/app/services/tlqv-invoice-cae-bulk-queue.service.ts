import {
  Injectable,
  Logger,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { Job, Queue, Worker, type JobsOptions } from 'bullmq';
import type {
  RequestCaeResponse,
  RequestCaeStatus,
} from '../../core/interactors/tlqv-invoice/facturas/RequestCaeInteractor';
import {
  readErrorMessage,
  waitUntilQueueReady,
} from '../drivers/queue/wait-until-queue-ready';
import { RedisConnectionOptionsFactory } from '../drivers/redis/redis-connection-options.factory';
import { TlqvInvoiceFacturasService } from './tlqv-invoice-facturas.service';

export const TLQV_INVOICE_CAE_BULK_QUEUE_NAME = 'tlqv-invoice-cae-bulk';
const TLQV_INVOICE_CAE_BULK_JOB_NAME = 'request-cae';
const QUEUE_READY_TIMEOUT_MS = 10_000;
const ADD_CHUNK_SIZE = 500;
const KEPT_JOBS = 5_000;

export interface TlqvInvoiceCaeBulkJobData {
  batchId: string;
  transaccionId: number;
  /** Null when the comprobante was sent by its ID instead of by a TLQV. */
  tlqvCode: string | null;
  dryRun: boolean;
  requestedAt: string;
}

export interface TlqvInvoiceCaeBulkJobResult {
  batchId: string;
  transaccionId: number;
  tlqvCode: string | null;
  status: RequestCaeStatus;
  numeroDocumento: string | null;
  cae: string | null;
  caeFechaVto: string | null;
  blockerCodes: string[];
  message: string | null;
}

export interface EnqueueTlqvInvoiceCaeBulkCommand {
  tlqvCodes?: string[];
  transaccionIds?: number[];
  dryRun?: boolean;
}

type CaeBulkJobState =
  'completed' | 'failed' | 'active' | 'waiting' | 'delayed' | 'paused';

const JOB_STATES: CaeBulkJobState[] = [
  'completed',
  'failed',
  'active',
  'waiting',
  'delayed',
  'paused',
];

@Injectable()
export class TlqvInvoiceCaeBulkQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(TlqvInvoiceCaeBulkQueueService.name);
  private readonly queue: Queue<TlqvInvoiceCaeBulkJobData>;
  private readonly worker: Worker<
    TlqvInvoiceCaeBulkJobData,
    TlqvInvoiceCaeBulkJobResult
  >;

  constructor(
    private readonly configService: ConfigService,
    private readonly tlqvInvoiceFacturasService: TlqvInvoiceFacturasService,
    private readonly redisConnectionOptionsFactory: RedisConnectionOptionsFactory,
  ) {
    const connection = this.redisConnectionOptionsFactory.build();

    this.queue = new Queue<TlqvInvoiceCaeBulkJobData>(
      TLQV_INVOICE_CAE_BULK_QUEUE_NAME,
      { connection, defaultJobOptions: buildDefaultJobOptions() },
    );
    this.worker = new Worker<
      TlqvInvoiceCaeBulkJobData,
      TlqvInvoiceCaeBulkJobResult
    >(TLQV_INVOICE_CAE_BULK_QUEUE_NAME, (job) => this.processJob(job), {
      connection,
      // One at a time, and not configurable: AFIP authorizes each numbering in
      // order, so the batch is enqueued oldest first and has to be worked in
      // that same order. Two at once would get the later ones rejected.
      concurrency: 1,
    });

    this.worker.on('failed', (job, error) => {
      this.logger.error(
        `TLQV invoice CAE job failed ${JSON.stringify({
          jobId: job?.id,
          transaccionId: job?.data.transaccionId,
          message: readErrorMessage(error),
        })}`,
      );
    });
  }

  getQueue(): Queue<TlqvInvoiceCaeBulkJobData> {
    return this.queue;
  }

  async enqueueBulk(command: EnqueueTlqvInvoiceCaeBulkCommand) {
    await this.ensureQueueReady();

    let plan: Awaited<ReturnType<TlqvInvoiceFacturasService['planCaeBulk']>>;
    try {
      plan = await this.tlqvInvoiceFacturasService.planCaeBulk(command);
    } catch (error: unknown) {
      // Nothing was enqueued: without Madre the TLQVs cannot be turned into
      // comprobantes, and a half-resolved batch would be worse than none.
      throw new ServiceUnavailableException(
        `No se pudieron leer en Madre los comprobantes de los TLQV pedidos. No se encoló nada. ${readErrorMessage(error)}`,
      );
    }

    const batchId = buildBatchId();
    const dryRun = command.dryRun ?? true;
    const requestedAt = new Date().toISOString();

    const jobs = plan.items.map((item) => ({
      name: TLQV_INVOICE_CAE_BULK_JOB_NAME,
      data: {
        batchId,
        transaccionId: item.transaccionId,
        tlqvCode: item.tlqvCode,
        dryRun,
        requestedAt,
      },
      // Deterministic per batch: the same comprobante cannot enter twice.
      opts: { jobId: `tlqv-cae:${batchId}:${item.transaccionId}` },
    }));

    // addBulk keeps the order it is given, and that order is the whole point.
    let totalQueued = 0;
    for (let index = 0; index < jobs.length; index += ADD_CHUNK_SIZE) {
      const created = await this.queue.addBulk(
        jobs.slice(index, index + ADD_CHUNK_SIZE),
      );
      totalQueued += created.length;
    }

    this.logger.log(
      `TLQV invoice CAE bulk queued ${JSON.stringify({
        batchId,
        totalQueued,
        dryRun,
        tlqvCodesWithoutComprobante: plan.tlqvCodesWithoutComprobante.length,
      })}`,
    );

    return {
      status: 'queued' as const,
      queueName: TLQV_INVOICE_CAE_BULK_QUEUE_NAME,
      batchId,
      dryRun,
      totalQueued,
      // TLQVs that were asked for and have no comprobante in Madre: they are
      // not in the batch, and whoever sent it has to know.
      tlqvCodesWithoutComprobante: plan.tlqvCodesWithoutComprobante,
      bullBoardPath:
        this.configService.get<string>('BULL_BOARD_BASE_PATH')?.trim() ||
        '/admin/queues',
      comprobantes: plan.items,
    };
  }

  async getBatchStatus(batchId: string) {
    const counts: Record<string, number> = {};
    const jobs: Array<
      Partial<TlqvInvoiceCaeBulkJobResult> & {
        jobId: string;
        transaccionId: number;
        tlqvCode: string | null;
        state: CaeBulkJobState;
        failedReason?: string;
      }
    > = [];

    for (const state of JOB_STATES) {
      const found = await this.queue.getJobs([state], 0, KEPT_JOBS);
      const mine = found.filter((job) => job.data?.batchId === batchId);
      counts[state] = mine.length;
      for (const job of mine) {
        // BullMQ types returnvalue as any; narrow it before reading.
        const result = job.returnvalue as
          TlqvInvoiceCaeBulkJobResult | undefined;
        jobs.push({
          jobId: String(job.id),
          transaccionId: job.data.transaccionId,
          tlqvCode: job.data.tlqvCode,
          state,
          status: result?.status,
          numeroDocumento: result?.numeroDocumento,
          cae: result?.cae,
          caeFechaVto: result?.caeFechaVto,
          blockerCodes: result?.blockerCodes,
          message: result?.message,
          failedReason: job.failedReason,
        });
      }
    }

    jobs.sort((left, right) => left.transaccionId - right.transaccionId);

    return {
      batchId,
      queueName: TLQV_INVOICE_CAE_BULK_QUEUE_NAME,
      found: jobs.length > 0,
      totalJobs: jobs.length,
      counts,
      results: {
        authorized: jobs.filter((job) => job.status === 'authorized').length,
        ready: jobs.filter((job) => job.status === 'ready').length,
        skipped: jobs.filter((job) => job.status === 'skipped').length,
        blocked: jobs.filter((job) => job.status === 'blocked').length,
        failed: jobs.filter((job) => job.state === 'failed').length,
        pending: jobs.filter((job) =>
          ['waiting', 'active', 'delayed', 'paused'].includes(job.state),
        ).length,
      },
      jobs,
    };
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker.close();
    await this.queue.close();
  }

  private async processJob(
    job: Job<TlqvInvoiceCaeBulkJobData>,
  ): Promise<TlqvInvoiceCaeBulkJobResult> {
    const response = await this.tlqvInvoiceFacturasService.requestCae({
      transaccionId: job.data.transaccionId,
      dryRun: job.data.dryRun,
    });

    this.logger.log(
      `TLQV invoice CAE job finished ${JSON.stringify({
        jobId: job.id,
        batchId: job.data.batchId,
        transaccionId: job.data.transaccionId,
        dryRun: job.data.dryRun,
        status: response.status,
        blockerCodes: response.blockers.map((blocker) => blocker.code),
      })}`,
    );

    return buildJobResult(job.data, response);
  }

  private async ensureQueueReady(): Promise<void> {
    try {
      await waitUntilQueueReady(this.queue, QUEUE_READY_TIMEOUT_MS);
    } catch (error: unknown) {
      throw new ServiceUnavailableException(
        `La cola de pedido de CAE no está disponible. ${readErrorMessage(error)}`,
      );
    }
  }
}

function buildDefaultJobOptions(): JobsOptions {
  return {
    // A single attempt, on purpose. Whatever goes wrong comes back as a
    // blocker, not as a thrown error, and a delayed retry would run after the
    // comprobantes that follow it, out of order.
    attempts: 1,
    removeOnComplete: { count: KEPT_JOBS },
    removeOnFail: { count: KEPT_JOBS },
  };
}

function buildJobResult(
  data: TlqvInvoiceCaeBulkJobData,
  response: RequestCaeResponse,
): TlqvInvoiceCaeBulkJobResult {
  return {
    batchId: data.batchId,
    transaccionId: data.transaccionId,
    tlqvCode: data.tlqvCode,
    status: response.status,
    numeroDocumento: response.comprobante?.numeroDocumento ?? null,
    cae: response.comprobante?.cae ?? null,
    caeFechaVto: response.comprobante?.caeFechaVto ?? null,
    blockerCodes: response.blockers.map((blocker) => blocker.code),
    message:
      response.blockers.map((blocker) => blocker.message).join(' | ') || null,
  };
}

function buildBatchId(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `tlqv-cae-${timestamp}-${randomUUID().slice(0, 8)}`;
}
