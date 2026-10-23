import { JobsService } from '../jobs.service';
import { JobHandler } from '../job.types';
import { PromoService } from '../../promo/promo.service';
import { AuthContext } from '../../common/interfaces/auth-context.interface';

export function registerPromoImageHandler(jobs: JobsService, promo: PromoService) {
  const handle: JobHandler = async (job, ctx) => {
    const productId = String(job.input.productId || '');
    if (!productId) throw new Error('缺少 productId');
    const user: AuthContext = {
      tenantId: job.tenantId,
      openid: job.userId || 'job-worker',
      role: 'owner',
      memberId: job.userId,
    };
    await ctx.updateProgress({ percent: 5, step: 'prepare', message: '准备生图' });
    return promo.executeGenerateJob(
      user,
      productId,
      { ...(job.input as any), _frameworkJobId: job.id },
      {
        onProgress: async (p) => ctx.updateProgress(p),
        appendEvent: async (event, message, data) => {
          if (ctx.appendEvent) await ctx.appendEvent(event, message, data);
        },
      },
    );
  };
  jobs.registerHandler('promo_image', handle);
}
