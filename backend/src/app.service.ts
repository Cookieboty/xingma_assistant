import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getHealth() {
    return {
      ok: true,
      name: 'wool-stall-miniapp-api',
      ts: new Date().toISOString(),
    };
  }
}
