import { Public } from '@nestjs/authentication';
import 'reflect-metadata';
import { Controller, Get, Post, Body, Param, Req, Res, Module } from '@nestjs/common';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import {
  readiness,
  licenseStatus,
  enqueue,
  APP_VERSION,
  SCHEMA_VERSION,
  BootstrapRepository,
} from '@metaexam/db';
import { jobRequestSchema, type SystemStatus } from '@metaexam/contracts';
import { Runtime } from '../database/database.module';
export function local(req: FastifyRequest) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.raw.socket.remoteAddress ?? '');
}
function management(req: FastifyRequest, token: string): boolean {
  const supplied = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
  const a = Buffer.from(supplied),
    b = Buffer.from(token);
  return local(req) && a.length === b.length && timingSafeEqual(a, b);
}
@Public()
@Controller()
export class Routes {
  constructor(private readonly runtime: Runtime) {}
  @Get('/health/live') live() {
    return { status: 'alive', version: APP_VERSION };
  }
  @Get('/health/ready') async ready(@Res({ passthrough: true }) res: FastifyReply) {
    const ok = await readiness(this.runtime.db);
    res.status(ok ? 200 : 503);
    return { status: ok ? 'ready' : 'unavailable', schemaVersion: ok ? SCHEMA_VERSION : 0 };
  }
  @Get('/api/v1/system/status') async status(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    if (!local(req)) {
      res.status(403);
      return { code: 'LOCAL_ONLY' };
    }
    const db = this.runtime.db,
      ok = await readiness(db);
    const heartbeat = ok
      ? await db.pool.query<{ online: boolean }>(
          "SELECT seen_at>now()-interval '15 seconds' AS online FROM worker_heartbeat WHERE id=1",
        )
      : null;
    const status: SystemStatus = {
      product: 'MetaExam',
      version: APP_VERSION,
      initialized: ok,
      adminInitialized: ok ? await new BootstrapRepository(db).initialized() : false,
      database: ok ? 'ready' : 'unavailable',
      schemaVersion: ok ? SCHEMA_VERSION : 0,
      worker: heartbeat?.rows[0]?.online ? 'online' : 'offline',
      checkedAt: new Date().toISOString(),
      stage: 'phase1',
      license: ok
        ? await licenseStatus(db)
        : {
            state: 'invalid',
            expiresAt: null,
            maxConcurrentAttempts: null,
            features: [],
            errorCode: 'DATABASE_UNAVAILABLE',
          },
    };
    return status;
  }
  @Post('/api/v1/diagnostics/jobs') async createJob(
    @Req() req: FastifyRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    if (!management(req, this.runtime.db.config.api.managementToken)) {
      res.status(403);
      return { code: 'MANAGEMENT_REQUIRED' };
    }
    const parsed = jobRequestSchema.safeParse(body);
    if (!parsed.success) {
      res.status(400);
      return { code: 'INVALID_REQUEST' };
    }
    try {
      const job = await enqueue(this.runtime.db, parsed.data.businessKey, parsed.data.message);
      res.status(202);
      return job;
    } catch {
      res.status(503);
      return { code: 'DATABASE_UNAVAILABLE' };
    }
  }
  @Get('/api/v1/diagnostics/jobs/:id') async getJob(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    if (!management(req, this.runtime.db.config.api.managementToken)) {
      res.status(403);
      return { code: 'MANAGEMENT_REQUIRED' };
    }
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      res.status(400);
      return { code: 'INVALID_ID' };
    }
    const result = await this.runtime.db.pool.query(
      'SELECT id,status,attempts,result,error_code FROM jobs WHERE id=$1',
      [id],
    );
    if (!result.rows[0]) {
      res.status(404);
      return { code: 'NOT_FOUND' };
    }
    return result.rows[0] as Record<string, unknown>;
  }
  @Post('/api/v1/maintenance/stop') stop(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    if (!management(req, this.runtime.db.config.api.managementToken)) {
      res.status(403);
      return { code: 'MANAGEMENT_REQUIRED' };
    }
    // Phase 1 has no examination sessions. The exam phase must add the maintenance lock.
    setTimeout(() => process.emit('SIGTERM'), 200);
    return { status: 'stopping' };
  }
}

@Module({ controllers: [Routes] })
export class SystemModule {}
