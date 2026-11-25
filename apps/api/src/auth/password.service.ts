import { Injectable, Module } from '@nestjs/common';
import { PasswordHasher } from '@nestjs/authentication';
import { IdentityError } from '@metaexam/db';
import { Runtime } from '../database/database.module';
@Injectable()
export class PasswordService {
  private active = 0;
  private readonly queue: (() => void)[] = [];
  constructor(
    private readonly hasher: PasswordHasher,
    private readonly runtime: Runtime,
  ) {}
  async run<T>(action: () => Promise<T>): Promise<T> {
    const max = this.runtime.db.config.auth?.hashConcurrency ?? 2;
    if (this.active >= max) {
      if (this.queue.length >= (this.runtime.db.config.auth?.hashQueue ?? 8))
        throw new IdentityError('RATE_LIMITED', 429);
      await new Promise<void>((resolve) => this.queue.push(resolve));
    } else this.active++;
    try {
      return await action();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.active--;
    }
  }
  hash(password: string) {
    return this.run(() => this.hasher.hash(password));
  }
  verify(password: string, hash?: string) {
    return this.run(() => this.hasher.verify(password, hash));
  }
}
@Module({ providers: [PasswordService], exports: [PasswordService] })
export class PasswordModule {}
