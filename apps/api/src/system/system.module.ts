import { Public } from '@nestjs/authentication';
import 'reflect-metadata';
import { Controller, Get, Post, Body, Param, Req, Res, Module } from '@nestjs/common';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { readFileSync } from 'node:fs';
import path from 'node:path';
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
  @Get([
    '/login',
    '/change-password',
    '/status',
    '/workspace',
    '/users',
    '/classes',
    '/classes/:id',
    '/courses',
    '/assignments',
    '/audit',
    '/question-banks',
    '/question-banks/:bankId',
    '/papers',
    '/papers/:paperId',
    '/exams',
    '/exams/:examId',
    '/my-exams',
    '/attempts/:attemptId',
    '/exams/:examId/grading',
    '/exams/:examId/report',
    '/my-exams/:examId/result',
  ])
  page(@Res() res: FastifyReply) {
    return res
      .type('text/html')
      .send(readFileSync(path.join(this.runtime.db.config.api.webDir, 'index.html')));
  }
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
      return { code: 'LOCAL_ONLY', message: '只允许本机访问', requestId: req.id };
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
      return { code: 'MANAGEMENT_REQUIRED', message: '需要本机管理凭据', requestId: req.id };
    }
    const parsed = jobRequestSchema.safeParse(body);
    if (!parsed.success) {
      res.status(400);
      return { code: 'INVALID_REQUEST', message: '请检查请求内容', requestId: req.id };
    }
    try {
      const job = await enqueue(this.runtime.db, parsed.data.businessKey, parsed.data.message);
      res.status(202);
      return job;
    } catch {
      res.status(503);
      return { code: 'DATABASE_UNAVAILABLE', message: '数据库暂时不可用', requestId: req.id };
    }
  }
  @Get('/api/v1/diagnostics/jobs/:id') async getJob(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    if (!management(req, this.runtime.db.config.api.managementToken)) {
      res.status(403);
      return { code: 'MANAGEMENT_REQUIRED', message: '需要本机管理凭据', requestId: req.id };
    }
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      res.status(400);
      return { code: 'INVALID_ID', message: '无效的任务编号', requestId: req.id };
    }
    const result = await this.runtime.db.pool.query(
      'SELECT id,status,attempts,result,error_code FROM jobs WHERE id=$1',
      [id],
    );
    if (!result.rows[0]) {
      res.status(404);
      return { code: 'NOT_FOUND', message: '任务不存在', requestId: req.id };
    }
    return result.rows[0] as Record<string, unknown>;
  }
  @Post('/api/v1/maintenance/stop') async stop(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    if (!management(req, this.runtime.db.config.api.managementToken)) {
      res.status(403);
      return { code: 'MANAGEMENT_REQUIRED', message: '需要本机管理凭据', requestId: req.id };
    }
    if (this.runtime.admissions > 0) {
      res.status(409);
      return {
        code: 'ATTEMPTS_ACTIVE',
        message: '正在处理考生入场，请稍后再试',
        requestId: req.id,
      };
    }
    this.runtime.draining = true;
    let active;
    try {
      active = await this.runtime.db.pool.query(
        "SELECT 1 FROM exam_attempts WHERE status='active' AND deadline_at>clock_timestamp() LIMIT 1",
      );
    } catch (error) {
      this.runtime.draining = false;
      throw error;
    }
    if (active.rowCount) {
      this.runtime.draining = false;
      res.status(409);
      return {
        code: 'ATTEMPTS_ACTIVE',
        message: '仍有进行中的考试作答，不能通过维护接口停止服务',
        requestId: req.id,
      };
    }
    setTimeout(() => process.emit('SIGTERM'), 200);
    return { status: 'stopping' };
  }
}

@Module({ controllers: [Routes] })
export class SystemModule {}
