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

## UI 设计规范

- 所有 Web 与 Electron 界面开发、生成和优化，必须先阅读并遵循 [Ant Design 官方视觉语言](https://ant.design/design.md)，结合 DESIGN.md 中当前页面约定实现。
- 保持 Ant Design 默认蓝色主题，优先使用原生组件、默认算法和 Design Token；通过 ConfigProvider、组件 Token 或 theme.useToken 统一定制，不用零散硬编码样式覆盖组件视觉语言。
- 布局采用 4px 间距体系，正文以 14px 为基准；统一字体层级、表单密度、导航和反馈状态。补全加载、空数据、失败、无权限及移动端状态，不展示虚构数据或未实现的操作入口。
- design.md 用于视觉和交互指导；组件 API 必须通过锁定版本的本地 CLI 核对。用户明确的设计要求优先，不因官方文档更新自动升级依赖；界面约定发生变化时同步更新 DESIGN.md。

## 开发入口

在仓库根目录使用 `./tools/run.ps1 <命令>`，它使用项目 Node.js 24 和锁定 pnpm；不修改系统 PATH。常用命令：dev、build、typecheck、lint、format:check、test。

- `dev` 启动 TypeScript 项目引用监听、API/Worker 自动重启、Vite 热更新及 Electron 窗口；`dev:web` 只启动后台和 Web。关闭 Electron 不停止后台；不要另造启动器。
- Nest CLI 只辅助 API 代码生成；先 `nest generate ... --dry-run` 查看路径。不要在现有仓库执行 nest new，不把 Worker 改造成 Nest 应用，不覆盖统一构建链路。
- 共享类型/校验放 contracts；纯授权规则放 domain；持久化放 db；界面放 ui。浏览器代码不能导入数据库或 Node.js 私有实现。
- 使用项目 ESLint flat config、React Hooks recommended 规则与 Prettier。TypeScript 保持 strict 和既有项目引用。

## 业务与运行约束

- Nest 使用 Fastify adapter；不要直接套用 Express 请求类型、中间件或测试启动方式。外部输入须在服务端验证；当前协议使用 Zod。
- 数据库迁移由 packages/db/src/migrations.ts 中的 V1～V5 注册表及 index.ts 中的逐版事务/连接咨询锁管理。schema.ts 声明现有表；仍禁止用 push 代替显式迁移。已执行迁移不可原地改写；新迁移需单独设计升级路径。
- pg 事务必须使用同一 PoolClient 并释放连接；查询参数化。任务租约领取、幂等和重启恢复语义须保留。
- 授权使用 Node crypto Ed25519 完全本地验签；不加入授权服务器、公钥下载或在线时间依赖。签发工具与私钥不进入客户包。
- Electron 保持 sandbox、contextIsolation、受限 preload/IPC；窗口退出不停止 API/Worker。动态 CSS 的既有 CSP 例外不能扩展成任意脚本执行。
- 安装器按程序/数据分目录，已有数据库不能重新初始化。本批独立环境验收已由用户确认通过；后续改动按影响范围执行独立环境回归，内部包未正式签名。

## 验证

- 按改动选择已有检查；源码/配置修改运行 typecheck、lint、format:check 和相关测试。
- UI 改动运行 test:ui；数据库/API/Worker 改动运行 test:integration；打包链路改动运行 package:win 和 test:package。
- test:dev 临时改写源码验证热更新，需独占执行，不与编辑、构建或其他测试并行。
- `.local`、私钥、日志、浏览器会话和 artifacts 不提交；官方技能目录保留上游格式，不对其批量格式化。
- 代码问题先遵循上级 AGENTS.md 使用 graphify 查询；代码变更后运行 `graphify update .`。

## 身份与初始化

- 业务认证使用官方 @nestjs/authentication 和 @nestjs/authorization；Cookie 会话存 PostgreSQL，令牌原文不进数据库、日志或 localStorage。不要引入 JWT 或内存会话回退。
- 初始化只允许回环请求 + 一次性令牌；仅提升权限 Electron 主进程/维护 CLI 读取令牌，不开放浏览器初始化表单。完成后不得重开初始化作为密码恢复。
- 身份与软件授权分离；未激活不阻止初始化/登录/维护。改密更新凭据版本并撤销所有会话，创建会话必须复核版本。
- 管理创建/重置账号必须强制改密；仅允许查看本人身份、改密和退出，业务权限策略须检查 mustChangePassword。重置与停用撤销会话；不提供删除账号或默认通用密码。
- 管理写操作在数据库事务内重新校验管理员权限，并使用统一咨询锁保护最后管理员、角色与组织关系；新增管理写入口须复用此约束。教师/学生数据范围从认证身份计算，不信任客户端传入的账号 ID。编辑使用 revision 防止覆盖，审计不记录密码或令牌。
- M1 第二批实现与验收见 docs/m1-management.md；test:management 使用独立数据库验证接口与真实浏览器流程，新包独立环境回归单独记录。
- 身份数据库测试使用 tests/database-fixture.mts 的独立测试库；不能清空开发账号。test:m1 覆盖迁移、初始化、会话、权限、队列和浏览器；普通权限 Electron 测试不代表提升权限 ACL 验收。
- M1 安装维护与独立环境回归清单见 docs/m1-acceptance.md；2026-11-25 用户确认独立环境验收完成，M0 完成、M1 第一批验收完成，不代表后续 M1 批次完成。确认记录见 docs/m1-status.md。

## 题库与版本

- M2 第一批范围和权限矩阵见 docs/m2-questions.md；test:questions 使用独立数据库和真实浏览器验证。
- 公共题库仅管理员可写；教师按当前有效授课课程读取公共题库、维护个人题库；管理员可管理所有题库，学生不得访问题库答案。
- 历史 question_versions 不可修改或删除，运行身份仅 SELECT/INSERT；保存题目必须新增版本并原子更新当前版本。后续试卷引用固定版本 ID，不能跟随当前题目变化。
- 本批题干／答案／解析为纯文本，不解析 HTML；选项和填空使用稳定 UUID；审计不复制题目正文或答案。题库维护不受未激活限制，考试发布／入场另做授权判定。

## 代码提交

- 开发工作及相关验证完成后，直接创建本地 Git 提交，无需再次询问是否提交。
- 提交标题和正文使用中文，清楚说明本次修改的目的和内容。
- 提交前检查差异，只纳入本次任务的代码、配置、文档和必要锁文件，不混入无关改动、运行数据或私钥。
- 完成后告知提交号、验证结果及未完成的验收项。推送远程仓库按用户明确指令执行。

<!-- prettier-ignore-start -->

<!-- antd-cli setup start -->
## Ant Design CLI Skill

Use the shared Ant Design skill at `.agents/skills/antd/SKILL.md` before working on Ant Design code in this repository.

The skill teaches agents when and how to call `@ant-design/cli` commands such as `antd info`, `antd doc`, `antd demo`, `antd token`, `antd semantic`, and `antd changelog`.

<!-- antd-cli setup end -->

<!-- prettier-ignore-end -->
