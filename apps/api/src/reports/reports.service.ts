import { Injectable } from '@nestjs/common';
import { ReportRepository, IdentityError, processFile, type AuditContext } from '@metaexam/db';
import {
  idSchema,
  reportSettingsSchema,
  reportQuerySchema,
  reportFiltersSchema,
} from '@metaexam/contracts';
import { Runtime } from '../database/database.module';
function parse<T>(schema: { parse: (v: unknown) => T }, v: unknown) {
  try {
    return schema.parse(v);
  } catch {
    throw new IdentityError('INVALID_REQUEST', 400);
  }
}
@Injectable()
export class ReportsService {
  private readonly repository: ReportRepository;
  private readonly exporting = new Set<string>();
  constructor(runtime: Runtime) {
    this.repository = new ReportRepository(runtime.db);
  }
  summary(actor: string, id: string, q: unknown) {
    return this.repository.summary(
      actor,
      parse(idSchema, id),
      parse(reportSettingsSchema, q).passPercent,
    );
  }
  list(actor: string, id: string, q: unknown) {
    return this.repository.list(actor, parse(idSchema, id), parse(reportQuerySchema, q));
  }
  async export(actor: string, id: string, body: unknown, ctx: AuditContext) {
    const exam = parse(idSchema, id),
      filters = parse(reportFiltersSchema, body ?? {});
    if (this.exporting.size >= 2 || this.exporting.has(actor))
      throw new IdentityError('RESULT_EXPORT_BUSY', 429);
    this.exporting.add(actor);
    try {
      const data = await this.repository.prepare(actor, exam, filters);
      const bytes = Buffer.from(
        await processFile<Uint8Array>('results', Buffer.from(JSON.stringify(data))),
      );
      // Recheck ownership/roles after CPU work, before disclosing the generated workbook.
      await this.repository.authorizeDownload(actor, exam, data, ctx);
      return { bytes, filename: `MetaExam-results-${exam}.xlsx` };
    } finally {
      this.exporting.delete(actor);
    }
  }
}
