import { Module } from '@nestjs/common';
import { AccountsRepository } from '@metaexam/db';
import { Runtime } from '../database/database.module';
@Module({
  providers: [
    {
      provide: AccountsRepository,
      inject: [Runtime],
      useFactory: (r: Runtime) => new AccountsRepository(r.db),
    },
  ],
  exports: [AccountsRepository],
})
export class AccountsModule {}
