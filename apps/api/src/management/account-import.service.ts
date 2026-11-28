import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import {
  idSchema,
  passwordSchema,
  type AccountImportInput,
  type AccountImportPreview,
  type AccountImportResult,
} from '@metaexam/contracts';
import {
  ManagementRepository,
  IdentityError,
  processFile,
  type PreparedAccount,
} from '@metaexam/db';
import { Runtime } from '../database/database.module';
import { PasswordService } from '../auth/password.service';

@Injectable()
export class AccountImportService implements OnModuleDestroy {
  private readonly previews = new Map<
    string,
    { actor: string; expires: number; inputs: PreparedAccount[]; snapshot: string }
  >();
  private busy = 0;
  private readonly confirmations = new Map<string, Promise<AccountImportResult>>();
  private readonly activeActors = new Set<string>();
  private readonly timer = setInterval(() => this.prune(), 30000).unref();
  private readonly repository: ManagementRepository;
  constructor(
    runtime: Runtime,
    private readonly passwords: PasswordService,
  ) {
    this.repository = new ManagementRepository(runtime.db);
  }
  onModuleDestroy() {
    clearInterval(this.timer);
    this.previews.clear();
  }
  private prune() {
    for (const [id, p] of this.previews) if (p.expires <= Date.now()) this.previews.delete(id);
  }
  async template(actor: string) {
    if (this.busy >= 2) throw new IdentityError('RATE_LIMITED', 429);
    this.busy++;
    try {
      await this.repository.inspectAccountImport(actor, []);
      return Buffer.from(await processFile<Uint8Array>('account-template'));
    } finally {
      this.busy--;
    }
  }
  async preview(actor: string, req: FastifyRequest): Promise<AccountImportPreview> {
    this.prune();
    if (this.busy >= 2 || this.activeActors.has(actor) || this.previews.size >= 8)
      throw new IdentityError('RATE_LIMITED', 429);
    this.busy++;
    this.activeActors.add(actor);
    try {
      await this.repository.inspectAccountImport(actor, []);
      if (!req.isMultipart()) throw new IdentityError('INVALID_UPLOAD', 400);
      let data: Buffer | undefined;
      try {
        for await (const part of req.parts({
          limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 0, parts: 1 },
        })) {
          if (
            part.type !== 'file' ||
            part.fieldname !== 'file' ||
            !part.filename.toLowerCase().endsWith('.xlsx')
          )
            throw new IdentityError('INVALID_UPLOAD', 400);
          data = await part.toBuffer();
          if (part.file.truncated) throw new IdentityError('INVALID_UPLOAD', 400);
        }
      } catch {
        throw new IdentityError('INVALID_UPLOAD', 400);
      }
      if (!data?.length) throw new IdentityError('INVALID_UPLOAD', 400);
      let source: AccountImportInput[];
      try {
        source = await processFile<AccountImportInput[]>('account-workbook', data);
      } finally {
        data.fill(0);
      }
      const inputs: PreparedAccount[] = source.map(({ password, ...r }) => ({
        ...r,
        passwordHash: password ? 'pending' : '',
      }));
      const inspected = await this.repository.inspectAccountImport(actor, inputs);
      for (const [i, row] of source.entries()) {
        if (row.password && !passwordSchema.safeParse(row.password).success)
          inspected.rows[i]!.errors.push('初始密码须为 6～128 字符');
      }
      const id = randomUUID(),
        expires = Date.now() + 10 * 60000;
      if (!inspected.rows.some((r) => r.errors.length)) {
        for (const [i, row] of source.entries()) {
          if (row.password) inputs[i]!.passwordHash = await this.passwords.hash(row.password);
          row.password = '';
        }
        // Recheck after hashing, and never hold the business lock during password work.
        await this.repository.inspectAccountImport(actor, []);
        for (const [key, p] of this.previews) if (p.actor === actor) this.previews.delete(key);
        this.previews.set(id, { actor, expires, inputs, snapshot: JSON.stringify(inspected) });
      }
      return { id, expiresAt: new Date(expires).toISOString(), rows: inspected.rows };
    } finally {
      this.busy--;
      this.activeActors.delete(actor);
    }
  }
  async confirm(actor: string, id: string, req: FastifyRequest) {
    if (!idSchema.safeParse(id).success) throw new IdentityError('INVALID_REQUEST', 400);
    const receipt = await this.repository.accountImportReceipt(actor, id);
    if (receipt) return receipt;
    this.prune();
    const p = this.previews.get(id);
    if (!p || p.actor !== actor) throw new IdentityError('ACCOUNT_IMPORT_EXPIRED', 409);
    const running = this.confirmations.get(id);
    if (running) return running;
    if (this.activeActors.has(actor)) throw new IdentityError('RATE_LIMITED', 429);
    this.activeActors.add(actor);
    const operation = this.repository.confirmAccountImport(
      actor,
      id,
      p.inputs,
      p.snapshot,
      {
        requestId: req.id,
        ip: req.ip,
      },
      p.expires,
    );
    this.confirmations.set(id, operation);
    try {
      const result = await operation;
      this.previews.delete(id);
      return result;
    } finally {
      this.confirmations.delete(id);
      this.activeActors.delete(actor);
    }
  }
  async cancel(actor: string, id: string) {
    await this.repository.inspectAccountImport(actor, []);
    if (this.confirmations.has(id)) throw new IdentityError('RATE_LIMITED', 429);
    if (this.previews.get(id)?.actor === actor) this.previews.delete(id);
  }
}
