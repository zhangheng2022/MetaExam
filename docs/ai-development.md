# 官方 AI 开发工具与资料

检索日期：2026-11-25。仅安装官方发布或官方文档明确推荐、且适合当前工程的内容。此文档与根目录 AGENTS.md 是项目接入说明，不是上游官方技能。应用运行时版本保持不变。

## 官方安装项

| 工具                      | 锁定版本 | 用途与官方依据                                                                                                                               |
| ------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| @ant-design/cli           | 6.7.2    | 组件属性、示例、token、诊断及内置 skill；[Ant Design CLI](https://ant.design/docs/react/cli/)                                                |
| @nestjs/skills            | 0.1.1    | 六个 NestJS 官方技能；[官方仓库与安装说明](https://github.com/nestjs/agent-skills)                                                           |
| @nestjs/cli               | 12.0.15  | API 代码生成，先 dry-run；[官方 CLI 文档源](https://github.com/nestjs/docs.nestjs.com/blob/master/content/cli/usages.md)                     |
| @playwright/cli           | 0.1.25   | AI 浏览器检查 CLI 及官方技能；[安装入口](https://playwright.dev/docs/getting-started-cli)、[Skills](https://playwright.dev/agent-cli/skills) |
| eslint-plugin-react-hooks | 7.1.1    | React 官方 recommended 静态检查；[官方规则说明](https://react.dev/reference/eslint-plugin-react-hooks)                                       |

这些工具作为开发依赖锁在根 package.json/pnpm-lock.yaml，不全局安装，也不进入客户应用。Playwright CLI 的上游依赖包含它自己的 alpha 浏览器驱动；既有测试仍使用项目锁定的 playwright 1.65.1，两者用途独立。

技能安装在项目 `.agents/skills`，供 Codex/Cursor 等支持该目录的客户端发现。新安装的技能在下一轮对话可用；如果客户端尚未刷新，重新打开项目会话。官方技能内容保留原样，不拼入社区规则或自编技能。

已安装 8 个技能：antd、nestjs、nestjs-auth、nestjs-data、nestjs-feature、nestjs-production、nestjs-testing、playwright-cli。来源包版本、官方入口和每个文件的 SHA256 记录在 `.agents/skills-lock.json`；相应许可证在 `.agents/licenses`。已逐文件与锁定 npm 包中的原始技能比对。Playwright 官方初始化生成 `.playwright/cli.config.json`，使用本机 Edge；浏览器会话产物 `.playwright-cli` 忽略提交。

## 使用与恢复

以下命令均在项目根目录执行，使用已安装的 CLI，不下载 latest、不全局安装：

```powershell
# 本地文档查询，显式指定项目 antd 版本
$env:ANTD_NO_AUTO_REPORT = '1'
$env:NO_UPDATE_CHECK = '1'
./tools/run.ps1 exec antd info Button --version 6.7.2 --format json
./tools/run.ps1 exec antd doc Form --version 6.7.2 --lang zh

# API 代码生成预览（不会写文件）
./tools/run.ps1 exec nest generate service example --dry-run --no-spec

# AI 浏览器检查：命名会话，结束时只关闭自己的会话
./tools/run.ps1 exec playwright-cli --session=metaexam open http://127.0.0.1:5173
./tools/run.ps1 exec playwright-cli --session=metaexam snapshot
./tools/run.ps1 exec playwright-cli --session=metaexam close
```

Nest CLI 的 sourceRoot 已设为 apps/api/src。当前 AppModule 在 app.ts，CLI 的默认模块搜索不会识别它；生成 service/controller 后需要人工注册到该模块，不能把 CLI 成功当作路由已可用。nest-cli.json 不替代原有 dev/build。

仓库已包含技能文件，通常只需 `./tools/run.ps1 install --frozen-lockfile`。需要从锁定包恢复技能时：

```powershell
./tools/run.ps1 exec nestjs-skills add --agent agents
./tools/run.ps1 exec antd setup --client codex --mode skill
./tools/run.ps1 exec playwright-cli install --skills=agents
./tools/run.ps1 exec antd setup --client codex --mode skill --check
```

Ant Design 安装器还会维护 AGENTS.md 中自己的标记块，该块用 Prettier ignore 保持原样。项目约束优先使用本地锁定 CLI，不执行官方技能示例中的全局自动安装/升级。技能版本升级时应审阅上游变更并重新记录来源哈希；不手工修改上游技能内容。

## 验证范围

已验证三个官方 CLI 版本、Ant Design 组件 JSON 查询、Nest API 生成 dry-run、Playwright Edge 会话创建/读取/关闭。React 官方推荐规则发现并修复了初次 Effect 同步更新 loading 的问题；首次加载由初始状态表示，后续用户/定时刷新由事件触发 loading。构建、类型检查与现有 9 项页面检查通过。此任务不涉及 Windows 安装器验收。

## 官方资料索引

UI 开发必读：[Ant Design 官方视觉语言 design.md](https://ant.design/design.md)。所有 Web 与 Electron 界面生成和优化均以此为视觉依据，保持默认蓝色主题，并结合 DESIGN.md 的当前页面约定。组件 API 仍须按项目锁定版本查询；具体执行要求见 [项目 UI 设计规范](../AGENTS.md#ui-设计规范)。

| 技术栈 / 当前版本        | AI 开发时应参考的官方入口                                                                                                             | 当前接入策略                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Node.js 24.22.3          | [24.x API / crypto](https://nodejs.org/docs/latest-v24.x/api/crypto.html)                                                             | 现有项目 Node；Ed25519 验签采用其 crypto API                             |
| pnpm 10.24.0             | [10.x workspace](https://pnpm.io/10.x/workspaces)                                                                                     | 继续 workspace: 与 frozen-lockfile；不套用 pnpm 12 的技能自动链接配置    |
| TypeScript 5.9.3         | [Project references](https://www.typescriptlang.org/docs/handbook/project-references.html)                                            | 现有 tsc、strict、composite 与项目引用                                   |
| React 19.3.0             | [Hooks ESLint](https://react.dev/reference/eslint-plugin-react-hooks)、[编辑器配置](https://react.dev/learn/editor-setup)             | 启用官方推荐规则；未安装社区 React 技能                                  |
| Vite 8.3.8               | [指南](https://vite.dev/guide/)、[CLI](https://vite.dev/guide/cli.html)                                                               | 继续各前端应用已有 Vite CLI 与 HMR；不重复安装脚手架                     |
| Ant Design 6.7.2         | [CLI](https://ant.design/docs/react/cli/)、[LLMs.txt](https://ant.design/docs/react/llms/)、[MCP](https://ant.design/docs/react/mcp/) | 官方 CLI + bundled skill；按项目版本查询；MCP 是可选接入，本次不重复启用 |
| NestJS 12.6.0            | [First steps / coding agents](https://docs.nestjs.com/first-steps)、[HTTP adapters](https://docs.nestjs.com/techniques/performance)   | 官方 CLI 和六个技能，保留 Fastify 与项目现有构建方式                     |
| Fastify 5.12.8           | [Validation and serialization](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/)                               | 由 Nest adapter 托管；继续已有 Fastify 依赖，不另起独立 Fastify 服务     |
| Zod 4.6.7                | [官方文档](https://zod.dev/)                                                                                                          | contracts 作为共享协议与服务端校验来源                                   |
| Drizzle ORM 0.45.4       | [迁移工具概览](https://orm.drizzle.team/docs/kit-overview)、[AI setup](https://orm.drizzle.team/docs/agents)                          | AI setup 面向 RC，当前稳定版不直接安装 RC skill/MCP；保留项目迁移 CLI    |
| pg 8.16.3                | [事务](https://node-postgres.com/features/transactions)                                                                               | 同一连接内执行事务；使用现有 pg                                          |
| PostgreSQL 18.7          | [18 版本文档](https://www.postgresql.org/docs/18/ddl.html)                                                                            | 使用已有 psql/pg_ctl；不套用最新 19 的特性，不安装服务                   |
| Electron 45.5.0          | [安全指引](https://www.electronjs.org/docs/latest/tutorial/security)                                                                  | 现有 Electron CLI、隔离及 IPC 边界；未新增实验性调试桥                   |
| electron-builder 26.18.0 | [v26 文档](https://www.electron.build/v26/)                                                                                           | 继续已有构建器；官网首页当前是 v27 预发布文档，开发时选 v26              |
| Inno Setup 6.7.4         | [官方帮助](https://jrsoftware.org/inno-setup/documentation/)                                                                          | 使用 .tools/inno/ISCC.exe 与现有安装脚本                                 |
| WinSW 2.14.0             | [v2 XML 配置](https://raw.githubusercontent.com/winsw/winsw/v2/doc/xmlConfigFile.md)                                                  | 使用锁定 v2 二进制与配置，服务验收留在独立环境                           |
| ESLint 10 / Prettier 3   | [flat config](https://eslint.org/docs/latest/use/configure/configuration-files)、[本地安装与锁版本](https://prettier.io/docs/install) | 沿用现有配置，补充 Hooks recommended；上游技能排除自动格式化             |

没有为每个依赖机械安装一个 skill。未核实到适合本项目的官方推荐技能时，直接保留官方文档和已有 CLI；官方提到的实验性集成、跨主版本迁移和云服务不因本次接入自动启用。

## M1 身份开发依赖

本批按 [官方认证文档](https://docs.nestjs.com/security/authentication)、[官方权限文档](https://docs.nestjs.com/security/authorization)、[官方 CSRF 文档](https://docs.nestjs.com/security/csrf) 接入 @nestjs/authentication 0.1.6 与 @nestjs/authorization 0.1.4。React Router 8.5.3 使用 [官方声明式路由](https://reactrouter.com/start/declarative/routing)。认证只启用本机 Cookie 会话和密码，不启用在线账户、第三方登录或云服务。依赖仍以 pnpm-lock.yaml 为准。
