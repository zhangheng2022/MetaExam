import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { IdentityError } from '@metaexam/db';
const messages: Record<string, string> = {
  INVALID_REQUEST: '请检查填写内容',
  INVALID_CREDENTIALS: '账号或密码错误',
  DATABASE_UNAVAILABLE: '数据库暂时不可用，请稍后重试',
  RATE_LIMITED: '操作过于频繁，请稍后重试',
  ALREADY_INITIALIZED: '管理员已经创建',
  SETUP_TOKEN_INVALID: '初始化令牌无效或已过期',
  LOCAL_ONLY: '只能在本机初始化',
  CREDENTIALS_CHANGED: '凭据已变更，请重新登录',
};
@Catch()
export class ErrorsFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const request = host.switchToHttp().getRequest<FastifyRequest>(),
      reply = host.switchToHttp().getResponse<FastifyReply>();
    let status = 500,
      code = 'INTERNAL_ERROR';
    if (error instanceof IdentityError) {
      status = error.status;
      code = error.code;
    } else if (error instanceof HttpException) {
      status = error.getStatus();
      code =
        (
          {
            400: 'INVALID_REQUEST',
            401: 'UNAUTHENTICATED',
            403: 'FORBIDDEN',
            404: 'NOT_FOUND',
            429: 'RATE_LIMITED',
          } as Record<number, string>
        )[status] ?? 'REQUEST_FAILED';
    } else if (
      error &&
      typeof error === 'object' &&
      ('code' in error ||
        (error instanceof Error && /connection|timeout|terminated|pool/i.test(error.message)))
    ) {
      status = 503;
      code = 'DATABASE_UNAVAILABLE';
    }
    // Never serialize driver errors, submitted bodies, credentials or headers.
    reply.status(status).send({
      code,
      message:
        messages[code] ??
        ({ 401: '请先登录', 403: '无权执行此操作', 404: '页面不存在' } as Record<number, string>)[
          status
        ] ??
        '请求失败，请重试',
      requestId: request.id,
    });
  }
}
