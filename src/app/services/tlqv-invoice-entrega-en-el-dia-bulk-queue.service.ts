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
  CompleteMeliOrderSaleResponse,
  CompleteMeliOrderSaleStage,
  CompleteMeliOrderSaleStatus,
} from '../../core/interactors/tlqv-invoice/facturas/CompleteMeliOrderSaleInteractor';
import {
  readErrorMessage,
  waitUntilQueueReady,
} from '../drivers/queue/wait-until-queue-ready';
import { RedisConnectionOptionsFactory } from '../drivers/redis/redis-connection-options.factory';
import { InvoiceClientIssueRecorderService } from './invoice-client-issue-recorder.service';
import { TlqvInvoiceFacturasService } from './tlqv-invoice-facturas.service';
import { normalizeUniqueTlqvCodes } from './tlqv-invoice-nota-credito-bulk-queue.service';

export const TLQV_INVOICE_ENTREGA_EN_EL_DIA_BULK_QUEUE_NAME =
  'tlqv-invoice-entrega-en-el-dia-bulk';
const JOB_NAME = 'facturar-cae-enviar';
const ISSUE_SOURCE = 'tlqv_invoice_entrega_en_el_dia_bulk_queue';
const QUEUE_READY_TIMEOUT_MS = 10_000;
const ADD_CHUNK_SIZE = 500;
const KEPT_JOBS = 5_000;

export interface TlqvInvoiceEntregaEnElDiaBulkJobData {
  batchId: string;
  tlqvCode: string;
  dryRun: boolean;
  issueDate?: string;
  requestedAt: string;
}

export interface TlqvInvoiceEntregaEnElDiaBulkJobResult {
  batchId: string;
  tlqvCode: string;
  status: CompleteMeliOrderSaleStatus;
  stoppedAt: CompleteMeliOrderSaleStage | null;
  invoiceStatus: CompleteMeliOrderSaleResponse['invoice']['status'];
  transaccionId: number | null;
  numeroDocumento: string | null;
  totalAmount: number | null;
  caeStatus: CompleteMeliOrderSaleResponse['cae']['status'];
  cae: string | null;
  meliStatus: CompleteMeliOrderSaleResponse['meli']['status'];
  meliOrderId: string | null;
  blockerCodes: string[];
  message: string | null;
  /** Set when the new factura could not be copied to Madre at once. */
  warning: string | null;
}

export interface EnqueueTlqvInvoiceEntregaEnElDiaBulkCommand {
  tlqvCodes: string[];
  dryRun?: boolean;
  issueDate?: string;
}

type JobState =
  'completed' | 'failed' | 'active' | 'waiting' | 'delayed' | 'paused';

const JOB_STATES: JobState[] = [
  'completed',
  'failed',
  'active',
  'waiting',
  'delayed',
  'paused',
];

@Injectable()
export class TlqvInvoiceEntregaEnElDiaBulkQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(
    TlqvInvoiceEntregaEnElDiaBulkQueueService.name,
  );
  private readonly queue: Queue<TlqvInvoiceEntregaEnElDiaBulkJobData>;
  private readonly worker: Worker<
    TlqvInvoiceEntregaEnElDiaBulkJobData,
    TlqvInvoiceEntregaEnElDiaBulkJobResult
  >;

  constructor(
    private readonly configService: ConfigService,
    private readonly tlqvInvoiceFacturasService: TlqvInvoiceFacturasService,
    private readonly redisConnectionOptionsFactory: RedisConnectionOptionsFactory,
    private readonly invoiceClientIssueRecorder: InvoiceClientIssueRecorderService,
  ) {
    const connection = this.redisConnectionOptionsFactory.build();

    this.queue = new Queue<TlqvInvoiceEntregaEnElDiaBulkJobData>(
      TLQV_INVOICE_ENTREGA_EN_EL_DIA_BULK_QUEUE_NAME,
      { connection, defaultJobOptions: buildDefaultJobOptions() },
    );
    this.worker = new Worker<
      TlqvInvoiceEntregaEnElDiaBulkJobData,
      TlqvInvoiceEntregaEnElDiaBulkJobResult
    >(
      TLQV_INVOICE_ENTREGA_EN_EL_DIA_BULK_QUEUE_NAME,
      (job) => this.processJob(job),
      {
        connection,
        // One sale at a time, and not configurable. Each job issues a factura
        // and asks for its CAE before the next one starts, which is what keeps
        // the numbering and the CAEs in the order AFIP wants them.
        concurrency: 1,
      },
    );

    this.worker.on('failed', (job, error) => {
      this.logger.error(
        `Entrega en el dia job failed ${JSON.stringify({
          jobId: job?.id,
          tlqvCode: job?.data.tlqvCode,
          message: readErrorMessage(error),
        })}`,
      );
    });
  }

  getQueue(): Queue<TlqvInvoiceEntregaEnElDiaBulkJobData> {
    return this.queue;
  }

  async enqueueBulk(command: EnqueueTlqvInvoiceEntregaEnElDiaBulkCommand) {
    try {
      await waitUntilQueueReady(this.queue, QUEUE_READY_TIMEOUT_MS);
    } catch (error: unknown) {
      throw new ServiceUnavailableException(
        `La cola de entrega en el día no está disponible. ${readErrorMessage(error)}`,
      );
    }

    const normalized = normalizeUniqueTlqvCodes(command.tlqvCodes);
    const batchId = buildBatchId();
    const dryRun = command.dryRun ?? true;
    const requestedAt = new Date().toISOString();

    const jobs = normalized.unique.map((tlqvCode) => ({
      name: JOB_NAME,
      data: {
        batchId,
        tlqvCode,
        dryRun,
        issueDate: command.issueDate,
        requestedAt,
      },
      // Deterministic per batch: a sale cannot enter the same batch twice.
      opts: { jobId: `tlqv-entrega-en-el-dia:${batchId}:${tlqvCode}` },
    }));

    let totalQueued = 0;
    for (let index = 0; index < jobs.length; index += ADD_CHUNK_SIZE) {
      const created = await this.queue.addBulk(
        jobs.slice(index, index + ADD_CHUNK_SIZE),
      );
      totalQueued += created.length;
    }

    this.logger.log(
      `Entrega en el dia bulk queued ${JSON.stringify({
        batchId,
        totalQueued,
        dryRun,
      })}`,
    );

    return {
      status: 'queued' as const,
      queueName: TLQV_INVOICE_ENTREGA_EN_EL_DIA_BULK_QUEUE_NAME,
      batchId,
      dryRun,
      issueDate: command.issueDate,
      totalRequested: normalized.totalRequested,
      totalDuplicated: normalized.totalDuplicated,
      totalQueued,
      bullBoardPath:
        this.configService.get<string>('BULL_BOARD_BASE_PATH')?.trim() ||
        '/admin/queues',
      tlqvCodes: normalized.unique,
    };
  }

  async getBatchStatus(batchId: string) {
    const counts: Record<string, number> = {};
    const jobs: Array<
      Partial<TlqvInvoiceEntregaEnElDiaBulkJobResult> & {
        jobId: string;
        tlqvCode: string;
        state: JobState;
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
          TlqvInvoiceEntregaEnElDiaBulkJobResult | undefined;
        jobs.push({
          ...result,
          jobId: String(job.id),
          tlqvCode: job.data.tlqvCode,
          state,
          failedReason: job.failedReason,
        });
      }
    }

    const stoppedAt = (stage: CompleteMeliOrderSaleStage) =>
      jobs.filter((job) => job.status === 'blocked' && job.stoppedAt === stage)
        .length;

    return {
      batchId,
      queueName: TLQV_INVOICE_ENTREGA_EN_EL_DIA_BULK_QUEUE_NAME,
      found: jobs.length > 0,
      totalJobs: jobs.length,
      counts,
      results: {
        completed: jobs.filter((job) => job.status === 'completed').length,
        ready: jobs.filter((job) => job.status === 'ready').length,
        blocked: jobs.filter((job) => job.status === 'blocked').length,
        // Where the blocked ones stopped: what is left to do differs.
        blockedAtInvoice: stoppedAt('invoice'),
        blockedAtCae: stoppedAt('cae'),
        blockedAtMeli: stoppedAt('meli'),
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
    job: Job<TlqvInvoiceEntregaEnElDiaBulkJobData>,
  ): Promise<TlqvInvoiceEntregaEnElDiaBulkJobResult> {
    const { batchId, tlqvCode, dryRun, issueDate } = job.data;
    const metadata = { batchId, jobId: String(job.id), dryRun, issueDate };

    let response: CompleteMeliOrderSaleResponse;
    try {
      response = await this.tlqvInvoiceFacturasService.completeMeliOrderSale({
        tlqvCode,
        dryRun,
        issueDate,
      });
    } catch (error: unknown) {
      if (!dryRun) {
        await this.invoiceClientIssueRecorder.recordUnhandledFailure({
          tlqvCode,
          error,
          source: ISSUE_SOURCE,
          metadata,
        });
      }
      throw error;
    }

    this.logger.log(
      `Entrega en el dia job finished ${JSON.stringify({
        ...metadata,
        tlqvCode,
        status: response.status,
        stoppedAt: response.stoppedAt,
        invoice: response.invoice.status,
        transaccionId: response.invoice.transaccionId,
        cae: response.cae.status,
        meli: response.meli.status,
        madreSync: response.madreSync?.status,
        blockerCodes: response.blockers.map((blocker) => blocker.code),
      })}`,
    );

    // Only real runs are recorded: a dry run did not happen. The job holding
    // the answer is eventually removed from the queue, and a sale that stopped
    // halfway is exactly what someone has to come back to.
    if (!dryRun && response.status === 'blocked') {
      await this.invoiceClientIssueRecorder.recordBlocked({
        tlqvCode,
        response: {
          status: 'blocked',
          blockers: response.blockers.map((blocker) => ({
            code: blocker.code,
            message: blocker.message,
            step: blocker.stage,
          })),
          clienteFlow: response.invoiceFlow?.clienteFlow,
        },
        source: ISSUE_SOURCE,
        metadata: {
          ...metadata,
          stoppedAt: response.stoppedAt,
          invoice: response.invoice,
          cae: response.cae,
          meli: response.meli,
        },
      });
    }

    return buildJobResult(batchId, response);
  }
}

function buildDefaultJobOptions(): JobsOptions {
  return {
    // A single attempt, on purpose: the job issues a factura and asks for a
    // CAE. Whatever stops it comes back as a blocker, and sending the sale
    // again is the retry — it goes on from where it stopped.
    attempts: 1,
    removeOnComplete: { count: KEPT_JOBS },
    removeOnFail: { count: KEPT_JOBS },
  };
}

function buildJobResult(
  batchId: string,
  response: CompleteMeliOrderSaleResponse,
): TlqvInvoiceEntregaEnElDiaBulkJobResult {
  return {
    batchId,
    tlqvCode: response.tlqvCode,
    status: response.status,
    stoppedAt: response.stoppedAt ?? null,
    invoiceStatus: response.invoice.status,
    transaccionId: response.invoice.transaccionId ?? null,
    numeroDocumento: response.invoice.numeroDocumento ?? null,
    totalAmount: response.invoice.totalAmount ?? null,
    caeStatus: response.cae.status,
    cae: response.cae.cae ?? null,
    meliStatus: response.meli.status,
    meliOrderId: response.meli.meliOrderId ?? null,
    blockerCodes: response.blockers.map((blocker) => blocker.code),
    message:
      response.blockers.map((blocker) => blocker.message).join(' | ') || null,
    warning:
      response.madreSync?.status === 'failed'
        ? (response.madreSync.message ?? null)
        : null,
  };
}

function buildBatchId(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `tlqv-entrega-en-el-dia-${timestamp}-${randomUUID().slice(0, 8)}`;
}
