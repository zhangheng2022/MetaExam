import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { IdentityError } from '@metaexam/db';
const messages: Record<string, string> = {
  GRADING_NOT_READY: '尚未满足阅卷或发布条件：请等待考试结束、后台判分，并完成全部已交卷答卷的评分',
  GRADES_IMMUTABLE: '成绩已经发布，不能再修改或撤回',
  GRADE_INVALID: '只能人工评分简答题，分数须在本题范围内且以 0.5 分为单位',
  SERVICE_STOPPING: '服务正在停止，请等待后台重新启动后再入场',
  ATTEMPT_TIME_WINDOW: '尚未到开考时间或考试已结束，不能新入场',
  ATTEMPT_OTHER_ACTIVE: '你已有其他进行中的考试，请先完成该考试',
  ATTEMPT_CAPACITY: '同时答题名额已满，请稍后重试',
  ATTEMPT_CLOSED: '作答已提交或到达截止时间，请查看交卷回执',
  ATTEMPT_GRANT_INVALID: '入场记录校验失败，请联系管理员',
  INVALID_ANSWER: '答案类型或选项不属于当前试题，请重新读取',
  ANSWER_CONFLICT: '答案已在其他页面更新，请重新读取后检查，不能覆盖旧版本',
  ANSWER_MUTATION_REUSED: '保存请求标识冲突，请重新读取题目',
  ATTEMPTS_ACTIVE: '仍有进行中的考试作答，不能通过维护接口停止服务',
  EXAM_CLASSES_INVALID: '班级或授课关系已失效，请重新选择有效班级',
  EXAM_ROSTER_LIMIT: '每场考试最多 5000 名考生',
  EXAM_PAPER_INVALID: '请选择有权使用的同课程冻结试卷',
  EXAM_TIME_INVALID: '考试窗口须覆盖答题时长且不超过 7 天，答题时长为 1～480 分钟',
  EXAM_IMMUTABLE: '考试已发布或取消，不能修改试卷、时间或名单',
  EXAM_START_PASSED: '开考时间已到，请调整时间后再发布',
  EXAM_ROSTER_EMPTY: '考生名单为空，请维护班级学生后重新保存草稿',
  EXAM_ROSTER_STALE: '班级学生或姓名已变化，请重新保存草稿并确认最新名单',
  EXAM_LICENSE_INVALID: '本地授权无效、未激活或已到期，暂不能发布考试',
  EXAM_FEATURE_MISSING: '当前授权不包含考试功能，暂不能发布',
  EXAM_LICENSE_WINDOW: '授权在开考前已到期，请续期或调整开考时间',
  EXAM_CANCEL_DENIED: '只能取消尚未开考的已发布考试',
  PAPER_FROZEN: '试卷已冻结，请复制为新草稿后修改',
  PAPER_NOT_FROZEN: '请先冻结试卷再复制',
  INVALID_PAPER_QUESTIONS: '题目已归档、超出课程或权限范围，或重复引用同一道题；请移除后重新选题',
  INSUFFICIENT_QUESTIONS: '符合条件且未选入试卷的题目不足，请减少数量或调整条件',
  EMPTY_PAPER: '空试卷不能冻结，请先添加题目',
  PAPER_LIMIT: '每份试卷最多 200 道题',
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
