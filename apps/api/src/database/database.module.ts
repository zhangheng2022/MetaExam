import { Module, Injectable, type DynamicModule } from '@nestjs/common';
import { createDatabase, type Database, type RuntimeConfig } from '@metaexam/db';
@Injectable()
export class Runtime {
  admissions = 0;
  draining = false;
  constructor(readonly db: Database) {}
  async onModuleDestroy() {
    await this.db.pool.end();
  }
}
@Module({})
export class DatabaseModule {
  static register(config: RuntimeConfig): DynamicModule {
    return {
      module: DatabaseModule,
      global: true,
      providers: [{ provide: Runtime, useFactory: () => new Runtime(createDatabase(config)) }],
      exports: [Runtime],
    };
  }
}
