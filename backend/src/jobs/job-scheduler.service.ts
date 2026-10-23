import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { JobsService } from './jobs.service';
import { JobEntity } from '../common/entities/job.entity';

/**
 * 进程内调度器：轮询 jobs 表领取 queued，交给已注册 handler 执行。
 * 并发上限 JOB_CONCURRENCY（默认 2），轮询间隔 JOB_POLL_MS（默认 1500）。
 */
@Injectable()
export class JobSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('JobScheduler');
  private timer: NodeJS.Timeout | null = null;
  private active = 0;
  private stopped = false;

  constructor(private readonly jobs: JobsService) {}

  private get concurrency() {
    return Math.max(1, parseInt(process.env.JOB_CONCURRENCY || '2', 10));
  }
  private get pollMs() {
    return Math.max(500, parseInt(process.env.JOB_POLL_MS || '1500', 10));
  }

  onModuleInit() {
    if (process.env.JOB_SCHEDULER === 'false') {
      this.logger.warn('JOB_SCHEDULER=false，跳过启动');
      return;
    }
    if (process.env.DB_ENABLED !== 'true') {
      this.logger.warn('DB 未启用，调度器不启动');
      return;
    }
    this.timer = setInterval(() => void this.tick(), this.pollMs);
    // 不阻止进程退出
    this.timer.unref?.();
    this.logger.log(
      `scheduler up poll=${this.pollMs}ms concurrency=${this.concurrency} worker=${this.jobs.workerId}`,
    );
    void this.tick();
  }

  onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  private async tick() {
    if (this.stopped) return;
    while (this.active < this.concurrency) {
      const job = await this.jobs.claimNext();
      if (!job) break;
      this.active++;
      void this.execute(job).finally(() => {
        this.active--;
      });
    }
  }

  private async execute(job: JobEntity) {
    const handler = this.jobs.getHandler(job.type);
    if (!handler) {
      await this.jobs.markFailed(job, `未注册任务类型: ${job.type}`);
      return;
    }
    const record = this.jobs.toRecord(job);
    try {
      const result =
        (await handler(record, {
          updateProgress: async (p) => {
            await this.jobs.updateProgress(job.id, job.tenantId, p);
          },
          isCancelled: async () => {
            const cur = await this.jobs.getEntity(job.tenantId, job.id);
            return cur?.status === 'cancelled';
          },
          appendEvent: async (event, message, data) => {
            await this.jobs.appendEvent(job, event, message, data || null);
          },
        })) || {};
      const cur = await this.jobs.getEntity(job.tenantId, job.id);
      if (!cur || cur.status === 'cancelled') return;
      await this.jobs.markSucceeded(cur, result as Record<string, unknown>);
      const pid = (result as any)?.productId || (job.payload as any)?.productId || '-';
      this.logger.log(
        `${job.type} jobId=${job.id} productId=${pid} succeeded`,
      );
    } catch (e: any) {
      const cur = await this.jobs.getEntity(job.tenantId, job.id);
      if (!cur || cur.status === 'cancelled') return;
      const auto = process.env.JOB_AUTO_RETRY !== 'false';
      const errFull = e?.stack || e?.message || String(e);
      await this.jobs.markFailed(cur, e?.message || String(e), {
        requeue: auto && cur.attempts < cur.maxAttempts,
      });
      const pid = (job.payload as any)?.productId || '-';
      this.logger.error(
        `${job.type} jobId=${job.id} productId=${pid} failed: ${errFull}`,
      );
    }
  }
}
