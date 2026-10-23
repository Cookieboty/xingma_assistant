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
 * 启动时回收全部孤儿 running；运行中按 JOB_STALE_MS（默认 45min）回收无进度更新的 running。
 */
@Injectable()
export class JobSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('JobScheduler');
  private timer: NodeJS.Timeout | null = null;
  private active = 0;
  private stopped = false;
  private tickCount = 0;
  private lastStaleReclaimAt = 0;

  constructor(private readonly jobs: JobsService) {}

  private get concurrency() {
    return Math.max(1, parseInt(process.env.JOB_CONCURRENCY || '2', 10));
  }
  private get pollMs() {
    return Math.max(500, parseInt(process.env.JOB_POLL_MS || '1500', 10));
  }
  private get staleMs() {
    return Math.max(
      60_000,
      parseInt(process.env.JOB_STALE_MS || '2700000', 10) || 2_700_000,
    );
  }

  async onModuleInit() {
    if (process.env.JOB_SCHEDULER === 'false') {
      this.logger.warn('JOB_SCHEDULER=false，跳过启动');
      return;
    }
    if (process.env.DB_ENABLED !== 'true') {
      this.logger.warn('DB 未启用，调度器不启动');
      return;
    }
    this.logger.log(
      `scheduler up poll=${this.pollMs}ms concurrency=${this.concurrency} staleMs=${this.staleMs} worker=${this.jobs.workerId}`,
    );
    // 单进程 worker：启动时所有 running 均为孤儿，一律重排队继续
    try {
      const n = await this.jobs.reclaimOrphanedRunning({ onlyStale: false });
      if (n) this.logger.warn(`startup reclaim orphaned running: ${n}`);
    } catch (e) {
      this.logger.warn(`startup reclaim failed: ${(e as Error).message}`);
    }
    this.timer = setInterval(() => void this.tick(), this.pollMs);
    this.timer.unref?.();
    void this.tick();
  }

  onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  private async tick() {
    if (this.stopped) return;
    this.tickCount += 1;
    const now = Date.now();
    // 约每 20 次 tick 或至少 60s 做一次陈旧 running 回收
    if (
      this.tickCount % 20 === 0 ||
      now - this.lastStaleReclaimAt >= 60_000
    ) {
      this.lastStaleReclaimAt = now;
      try {
        await this.jobs.reclaimOrphanedRunning({
          onlyStale: true,
          staleMs: this.staleMs,
        });
      } catch (e) {
        this.logger.warn(`stale reclaim failed: ${(e as Error).message}`);
      }
    }
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
      // 已被 reclaim/cancel 等改状态则勿覆盖
      if (!cur || cur.status !== 'running') return;
      await this.jobs.markSucceeded(cur, result as Record<string, unknown>);
      const pid = (result as any)?.productId || (job.payload as any)?.productId || '-';
      this.logger.log(
        `${job.type} jobId=${job.id} productId=${pid} succeeded`,
      );
    } catch (e: any) {
      const cur = await this.jobs.getEntity(job.tenantId, job.id);
      if (!cur || cur.status !== 'running') return;
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
