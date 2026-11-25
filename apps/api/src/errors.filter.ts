import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { IdentityError } from '@metaexam/db';
const messages: Record<string, string> = {
  INVALID_UPLOAD: '请上传一个不超过 2 MiB 的文件',
  INVALID_WORKBOOK: 'Excel 文件不符合要求：请使用模板，最多 500 行，不含公式、链接或嵌入对象',
  INVALID_TEMPLATE: '请使用下载的模板并保留“题目”工作表及标题',
  EMPTY_WORKBOOK: '工作表中没有可导入的题目',
  INVALID_IMAGE: '仅支持完整的 PNG/JPEG 静态图片，不超过 2 MiB、800 万像素',
  INVALID_ATTACHMENT: '图片不存在或不属于当前题库',
  FILE_UNAVAILABLE: '文件暂时不可用，请联系管理员检查本地文件',
  FILE_PROCESSING_TIMEOUT: '文件处理超时，请缩小文件后重试',
  FILE_PROCESSING_FAILED: '文件处理失败，请检查文件内容',
  UPLOAD_QUOTA: '已达到今天的上传上限，请稍后再试',
  IMPORT_NOT_READY: '预检未完成或存在错误，请修正后重新上传',
  IMPORT_EXPIRED: '导入预检已超过 24 小时，请重新上传',
  IMPORT_ALREADY_CONFIRMED: '该导入已确认，不能更改重复题处理方式',
  SOURCE_CHANGED: '导入源文件已发生变化，请重新上传',
  BANK_READ_ONLY: '题库已归档或课程已停用，暂不能修改',
  INVALID_COURSE: '请选择启用且有权使用的课程',
  QUESTION_ARCHIVED: '题目已归档，请恢复后再编辑',
  INVALID_REQUEST: '请检查填写内容',
  INVALID_CREDENTIALS: '账号或密码错误',
  DATABASE_UNAVAILABLE: '数据库暂时不可用，请稍后重试',
  RATE_LIMITED: '操作过于频繁，请稍后重试',
  ALREADY_INITIALIZED: '管理员已经创建',
  SETUP_TOKEN_INVALID: '初始化令牌无效或已过期',
  LOCAL_ONLY: '只能在本机初始化',
  CREDENTIALS_CHANGED: '凭据已变更，请重新登录',
  EDIT_CONFLICT: '数据已被修改，请刷新后重新编辑',
  DUPLICATE_RECORD: '用户名或编码已存在，请使用其他值',
  SELF_DISABLE: '不能停用自己的账号',
  LAST_ADMIN: '必须保留至少一名启用的管理员',
  ROLE_IN_USE: '请先解除班级或授课关系，再移除对应角色',
  INVALID_ASSIGNMENT: '请选择启用的班级、课程及具备对应角色的账号',
  USE_CHANGE_PASSWORD: '请通过修改密码页面修改自己的密码',
  NOT_FOUND: '记录不存在',
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
