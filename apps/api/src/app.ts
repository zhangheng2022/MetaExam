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
import { ErrorsFilter } from './errors.filter';
@Module({})
class AppModule {}
export async function createApp(
  config: RuntimeConfig = loadConfig(),
): Promise<NestFastifyApplication> {
  const https =
    config.api.tlsCert && config.api.tlsKey
      ? { cert: readFileSync(config.api.tlsCert), key: readFileSync(config.api.tlsKey) }
      : undefined;
  const app = await NestFactory.create<NestFastifyApplication>(
    { module: AppModule, imports: [DatabaseModule.register(config), SystemModule, SetupModule] },
    new FastifyAdapter({
      https,
      bodyLimit: 65536,
      trustProxy: false,
      logger: false,
    }),
    { logger: ['error', 'warn'] },
  );
  app.enableCsrfProtection({
    trustedOrigins: config.production
      ? []
      : [
          'http://127.0.0.1:' + (config.api.webPort ?? 5173),
          'http://localhost:' + (config.api.webPort ?? 5173),
        ],
  });
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
