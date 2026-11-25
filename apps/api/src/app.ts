import 'reflect-metadata';
import { Controller, Get, Post, Body, Param, Req, Res, Module, Injectable } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyRequest, FastifyReply } from 'fastify';
import fastifyStatic from '@fastify/static';
import { readFileSync, existsSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import {
  createDatabase,
  readiness,
  licenseStatus,
  enqueue,
  APP_VERSION,
  loadConfig,
  type RuntimeConfig,
  type Database,
} from '@metaexam/db';
import { jobRequestSchema, type SystemStatus } from '@metaexam/contracts';

@Injectable()
export class Runtime {
  db: Database = createDatabase();
  async onModuleDestroy() {
    await this.db.pool.end();
  }
}
function local(req: FastifyRequest) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.raw.socket.remoteAddress ?? '');
}
function management(req: FastifyRequest, token: string): boolean {
  const supplied = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
  const a = Buffer.from(supplied),
    b = Buffer.from(token);
  return local(req) && a.length === b.length && timingSafeEqual(a, b);
}
@Controller()
export class Routes {
  constructor(private readonly runtime: Runtime) {}
  @Get('/health/live') live() {
    return { status: 'alive', version: APP_VERSION };
  }
  @Get('/health/ready') async ready(@Res({ passthrough: true }) res: FastifyReply) {
    const ok = await readiness(this.runtime.db);
    res.status(ok ? 200 : 503);
    return { status: ok ? 'ready' : 'unavailable', schemaVersion: ok ? 1 : 0 };
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
      database: ok ? 'ready' : 'unavailable',
      schemaVersion: ok ? 1 : 0,
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
@Module({ controllers: [Routes], providers: [Runtime] })
class AppModule {}
export async function createApp(
  config: RuntimeConfig = loadConfig(),
): Promise<NestFastifyApplication> {
  const https =
    config.api.tlsCert && config.api.tlsKey
      ? { cert: readFileSync(config.api.tlsCert), key: readFileSync(config.api.tlsKey) }
      : undefined;
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      https,
      bodyLimit: 65536,
      trustProxy: false,
      logger: false,
    }),
    { logger: ['error', 'warn'] },
  );
  app.enableShutdownHooks();
  const server = app.getHttpAdapter().getInstance();
  server.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
    );
    reply.header('Cache-Control', 'no-store');
    return payload;
  });
  if (existsSync(config.api.webDir))
    await app.register(fastifyStatic, { root: config.api.webDir, prefix: '/' });
  return app;
}
