import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LevelsController } from './levels.controller';
import { LevelsService } from './levels.service';
import { LEVELS_REPO } from './repositories/levels.repository';
import { MemoryLevelsRepository } from './repositories/memory-levels.repository';
import { TypeOrmLevelsRepository } from './repositories/typeorm-levels.repository';
import { DataSource } from 'typeorm';

const dbEnabled = process.env.DB_ENABLED === 'true';

@Module({
  imports: [AuthModule],
  controllers: [LevelsController],
  providers: [
    LevelsService,
    MemoryLevelsRepository,
    {
      provide: LEVELS_REPO,
      useFactory: (memory: MemoryLevelsRepository, ds?: DataSource) => {
        if (dbEnabled && ds) return new TypeOrmLevelsRepository(ds);
        return memory;
      },
      inject: [MemoryLevelsRepository, ...(dbEnabled ? [DataSource] : [])],
    },
  ],
  exports: [LevelsService, LEVELS_REPO],
})
export class LevelsModule {}
