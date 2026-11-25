import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyStatic from '@fastify/static';
import { readFileSync, existsSync } from 'node:fs';
import { loadConfig, type RuntimeConfig } from '@metaexam/db';
import { DatabaseModule } from './database/database.module';
import { SystemModule } from './system/system.module';
import { SetupModule } from './setup/setup.module';
import { AuthenticationModule } from '@nestjs/authentication';
import { AuthorizationModule } from '@nestjs/authorization';
import { AuthModule } from './auth/auth.module';
import { ErrorsFilter } from './errors.filter';
import { ManagementModule } from './management/management.module';
@Module({})
class AppModule {}
export async function createApp(
  config: RuntimeConfig = loadConfig(),
  clock: () => number = Date.now,
): Promise<NestFastifyApplication> {
  if (
    !config.api.tlsCert &&
    (config.production || !['127.0.0.1', 'localhost', '::1'].includes(config.api.host))
  )
    throw new Error('HTTPS_REQUIRED');
  for (const [key, value] of Object.entries(config.auth ?? {}))
    if (!Number.isInteger(value) || value < 1 || value > 10000)
      throw new Error('INVALID_AUTH_CONFIG: ' + key);
  const trustedOrigins = config.production
    ? []
    : [
        'http://127.0.0.1:' + (process.env.METAEXAM_WEB_PORT ?? config.api.webPort ?? 5173),
        'http://localhost:' + (process.env.METAEXAM_WEB_PORT ?? config.api.webPort ?? 5173),
      ];
  const https =
    config.api.tlsCert && config.api.tlsKey
      ? { cert: readFileSync(config.api.tlsCert), key: readFileSync(config.api.tlsKey) }
      : undefined;
  const app = await NestFactory.create<NestFastifyApplication>(
    {
      module: AppModule,
      imports: [
        AuthenticationModule.forRoot({
          session: {
            absoluteTtl: '8h',
            idleTtl: '30m',
            touchInterval: 0,
            cookie: { secure: !!config.api.tlsCert, sameSite: 'lax', path: '/' },
            trustedOrigins,
            now: clock,
          },
        }),
        AuthorizationModule.forRoot(),
        DatabaseModule.register(config),
        SystemModule,
        SetupModule,
        AuthModule,
        ManagementModule,
      ],
    },
    new FastifyAdapter({
      https,
      bodyLimit: 65536,
      trustProxy: false,
      logger: false,
    }),
    { logger: ['error', 'warn'] },
  );
  app.enableCsrfProtection({ trustedOrigins });
  app.useGlobalFilters(new ErrorsFilter());
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
