# MetaExam AI 开发指引

## 项目上下文

这是 pnpm workspace：React/Vite Web、NestJS/Fastify API、独立 Worker、Electron 管理端；共享 contracts、domain、db、ui。界面使用 Ant Design 默认蓝色主题。开发机只运行普通进程；Windows 服务安装及重启验收在独立环境进行。M0 状态见 docs/phase1-status.md。

## 官方资料和技能

- 先按 package.json、pnpm-lock.yaml、toolchain.lock.json 确认版本，再查 [官方文档索引](docs/ai-development.md)。官方文档中的最新版本示例不等于本项目已安装的 API。
- `.agents/skills` 只放官方包提供的原版技能；按任务读取相关 SKILL.md，不一次加载全部。来源及恢复命令见文档索引。
- NestJS 任务使用 nestjs 系列官方技能。它们介绍的认证、ORM 集成、Observe 等可选包，并非本项目已安装组件；添加依赖要服务于用户当前需求。
- Ant Design 任务先用本地 CLI 查目标版本的属性、示例和 token。组件与主题复用 packages/ui。
- 技能示例中的全局安装、自动升级或云服务连接不是本项目默认操作；这里通过 tools/run.ps1 exec 使用锁定的本地 CLI。Ant Design 查询指定 --version 6.7.2；升级依赖仍按当前任务范围处理。
- 浏览器检查可用 Playwright 官方技能及项目现有测试。新增测试应验证用户可见行为，不能通过跳过失败测试来宣称功能通过。
- 用户要求只安装官方发布或官方文档明确推荐的技能和工具；不要用同名社区技能替代，不自动升级整个技术栈。

## 开发入口

在仓库根目录使用 `./tools/run.ps1 <命令>`，它使用项目 Node.js 24 和锁定 pnpm；不修改系统 PATH。常用命令：dev、build、typecheck、lint、format:check、test。

- `dev` 启动 TypeScript 项目引用监听、API/Worker 自动重启和 Vite 热更新；不要另造启动器。
- Nest CLI 只辅助 API 代码生成；先 `nest generate ... --dry-run` 查看路径。不要在现有仓库执行 nest new，不把 Worker 改造成 Nest 应用，不覆盖统一构建链路。
- 共享类型/校验放 contracts；纯授权规则放 domain；持久化放 db；界面放 ui。浏览器代码不能导入数据库或 Node.js 私有实现。
- 使用项目 ESLint flat config、React Hooks recommended 规则与 Prettier。TypeScript 保持 strict 和既有项目引用。

## 业务与运行约束

- Nest 使用 Fastify adapter；不要直接套用 Express 请求类型、中间件或测试启动方式。外部输入须在服务端验证；当前协议使用 Zod。
- 当前数据库迁移由 packages/db/src/index.ts 中的版本、事务锁和校验和管理。schema.ts 仅覆盖部分表，不能把它当作完整数据库声明直接 push。已执行迁移不可原地改写；新迁移需单独设计升级路径。
- pg 事务必须使用同一 PoolClient 并释放连接；查询参数化。任务租约领取、幂等和重启恢复语义须保留。
- 授权使用 Node crypto Ed25519 完全本地验签；不加入授权服务器、公钥下载或在线时间依赖。签发工具与私钥不进入客户包。
- Electron 保持 sandbox、contextIsolation、受限 preload/IPC；窗口退出不停止 API/Worker。动态 CSS 的既有 CSP 例外不能扩展成任意脚本执行。
- 安装器按程序/数据分目录，已有数据库不能重新初始化。发布前仍须完成独立环境验收，内部包未正式签名。

## 验证

- 按改动选择已有检查；源码/配置修改运行 typecheck、lint、format:check 和相关测试。
- UI 改动运行 test:ui；数据库/API/Worker 改动运行 test:integration；打包链路改动运行 package:win 和 test:package。
- test:dev 临时改写源码验证热更新，需独占执行，不与编辑、构建或其他测试并行。
- `.local`、私钥、日志、浏览器会话和 artifacts 不提交；官方技能目录保留上游格式，不对其批量格式化。
- 代码问题先遵循上级 AGENTS.md 使用 graphify 查询；代码变更后运行 `graphify update .`。

<!-- prettier-ignore-start -->

<!-- antd-cli setup start -->
## Ant Design CLI Skill

Use the shared Ant Design skill at `.agents/skills/antd/SKILL.md` before working on Ant Design code in this repository.

The skill teaches agents when and how to call `@ant-design/cli` commands such as `antd info`, `antd doc`, `antd demo`, `antd token`, `antd semantic`, and `antd changelog`.

<!-- antd-cli setup end -->

<!-- prettier-ignore-end -->
