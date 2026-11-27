# MetaExam

M2 第七批已实现已发布成绩的全场统计、逐题分析、名单筛选与 Excel 导出，验收见 [成绩统计与导出](docs/m2-reports.md)。数据库保持 V10，无新增迁移。沿用 [阅卷与成绩发布](docs/m2-grading.md)、[答题会话](docs/m2-attempts.md)、[考试发布与名单](docs/m2-exams.md)、[组卷与冻结](docs/m2-papers.md)、[Excel 导入与图片](docs/m2-imports.md) 和 [题库基础](docs/m2-questions.md)；跨考试分析、复核改分和补考尚未交付。

M1 第二批已实现账号、班级、课程、授课安排、角色工作台及操作日志，沿用 Ant Design 默认蓝色。开发与验收步骤见 [M1 第二批交付说明](docs/m1-management.md)。首次登录或管理员重置密码后，用户须先修改密码。

M1 基础平台工程：Node.js 24、NestJS + Fastify、React + Ant Design 6、Electron、PostgreSQL 18。Windows x64 开发与内部离线安装验证。2026-11-25 用户已确认本机及独立环境验收完成：M0 完成，M1 第一批验收完成，详见 [交付记录](docs/m1-status.md)。

Web 与 Electron 共用 packages/ui 的 Ant Design 组件；MetaExamProvider 统一中文 locale，采用 Ant Design 默认蓝色主题与语义色。账号中心使用浅色导航及移动端抽屉，运行诊断页保留深色菜单。布局依据 [Ant Design 视觉语言](https://ant.design/design.md)，实现范围见 [UI 交付记录](docs/ui-ant-design.md)。组件样式、图标均由 Vite 本地打包，无 CDN 依赖。CSP 仅为组件动态样式允许内联 CSS，脚本仍仅允许本地来源；Electron 保持 sandbox、contextIsolation 和受限 IPC。

## 开发启动

`./tools/run.ps1 test:web-dev` 使用隔离数据库及独立 Vite 服务，验证冷缓存登录、题库路由刷新、题目保存和试卷／考试懒加载。共享 contracts 为浏览器导出 TypeScript 源码，为 Node 保留 CommonJS 编译入口；修改包导出后需重启 Vite 以更新模块解析。背景见 [Vite 共享包规则](https://vite.dev/guide/dep-pre-bundling.html#monorepos-and-linked-dependencies) 与 [条件导出](https://vite.dev/config/shared-options.html#resolve-conditions)。

在 PowerShell 中进入本目录。项目运行时位于 `.tools`，不会替换系统 Node.js 16，也不修改全局 PATH。

```powershell
# 首次联网准备；已有工具时可跳过
./tools/bootstrap.ps1 -Proxy http://127.0.0.1:7897
./tools/run.ps1 build
./tools/run.ps1 db:start
./tools/run.ps1 db:migrate
./tools/run.ps1 dev
```

访问 http://127.0.0.1:5173/login 。首次管理员在 Electron 中创建，首次需以 Windows 管理员身份运行客户端；步骤见 [M1 初始化与登录](docs/m1-acceptance.md)。运行状态页迁至 `/status`。API 默认 3000，PostgreSQL 默认 55432，仅回环监听。端口被占用时启动失败，不自动杀进程或换端口。配置在首次 db:start 生成的 `.local/config.json`；复制到其他位置可用进程环境变量 `METAEXAM_CONFIG` 指定。设置示例见 [.env.example](.env.example)。

日常开发运行 `./tools/run.ps1 dev`（也可在 IDE 的 package.json 中运行 dev），会编译桌面端、启动 API/Worker/Vite，并在 API 启动后自动打开 Electron 管理窗口。只开发浏览器页面时运行 `dev:web`，不打开桌面窗口。TypeScript project references 按依赖顺序监听后端及共享包，编译成功后由 tsc-watch 自动重启 API 和 Worker；编译出错时暂停后台进程，修复后自动恢复。浏览器 React 和共享 UI 源码通过 Vite 热更新；Electron 当前加载启动时构建的本地页面，修改桌面代码后需要重新运行 dev。concurrently 统一管理开发进程；Ctrl+C 关闭本次启动的 API、Worker、Vite 和 Electron，数据库单独停止：

```powershell
./tools/run.ps1 db:stop
# 窗口关闭后需要重新打开时，另开终端执行（API/Worker 需已启动）
$env:METAEXAM_CONFIG = (Resolve-Path .local/config.json).Path
./tools/run.ps1 --filter @metaexam/desktop start
```

关闭 Electron 不停止独立 API/Worker。开发环境无 Windows 服务注册。

本地管理器首次进入管理员设置，完成后默认显示服务与授权概览；点击“打开考试系统”进入浏览器。运行详情中可复制本机登录地址。修改管理器后运行 `./tools/run.ps1 test:desktop`，实现与验收范围见 [本地管理器改版记录](docs/local-manager.md)。

## 工程与命令

AI 开发先读取 [AGENTS.md](AGENTS.md) 和 [官方工具与资料](docs/ai-development.md)。项目只接入官方发布或官方明确推荐的技能与 CLI，版本随依赖锁文件固定。

| 目录               | 职责                                                    |
| ------------------ | ------------------------------------------------------- |
| apps/api           | NestJS 模块、Fastify HTTP/HTTPS、健康检查、生产静态资源 |
| apps/web           | React + Vite 登录、个人信息和状态页面                   |
| apps/worker        | 独立数据库任务消费者、维护 CLI                          |
| apps/desktop       | 沙箱 Electron、初始化向导与受限 IPC、运行状态           |
| packages/contracts | 严格授权文件 schema、接口类型                           |
| packages/domain    | 完全本地 Ed25519 验签与授权规则                         |
| packages/db        | Drizzle + pg、显式迁移、设备绑定、授权持久化、任务租约  |
| packages/ui        | Web 与 Electron 共用界面                                |
| installer          | Windows 打包入口、Inno Setup、WinSW、安装维护脚本       |
| tools              | 环境准备、命令入口、开发启动、普通进程数据库管理        |
| tests              | 单元、集成、开发监听、页面、数据库重启及客户包验证      |
| provider           | 供应方测试签发工具，不进入客户安装包                    |

统一命令均通过 `./tools/run.ps1 <command>` 使用：dev、build、typecheck、lint、format:check、test、test:integration、test:ui、test:dev、test:db-restart、test:package、test:m1、test:management、test:questions、test:imports、test:papers、test:exams、test:attempts、test:grading、test:reports、setup:token、db:migrate、package:win。

`tools` 只保留四个入口：bootstrap.ps1 准备锁定工具链与依赖，run.ps1 使用项目 Node/pnpm 执行命令，dev.mjs 将配置交给标准监听工具，postgres.mjs 管理项目数据库普通进程。业务逻辑放在应用与共享包，不在这些脚本中实现。

`test:dev` 使用端口 3310/5180 验证 API、Worker、共享契约、数据库包、UI 热更新与编译错误恢复。它会临时修改源码并在结束时恢复、重新构建；请独占运行，期间不要编辑源码或同时执行其他构建/测试。UI 检查使用本机 Microsoft Edge。测试结果保存在忽略提交的 artifacts 目录。

`./tools/run.ps1 test:dev --startup-only` 仅验证四个进程启动、Electron 实际 IPC 与主题、关闭窗口后后台继续运行，不执行源码改写探针。

`GET /health/live` 仅判断进程；`GET /health/ready` 校验数据库连接及迁移校验和，失败 503；`GET /api/v1/system/status` 仅回环来源可访问，返回脱敏状态。诊断任务写入/读取与停机接口还需要配置中的管理令牌；本阶段没有匿名授权导入接口。开发 Vite 也仅回环监听，生产静态页面由 API 同源托管。

## 数据与任务

项目数据库普通进程数据在 `.local/postgres`；安装版在 `%ProgramData%\MetaExam\postgres\data`，程序在 Program Files。授权、序号、任务均落 PostgreSQL。版本迁移用事务、咨询锁及校验和，重复执行安全，不在 API 启动时自动迁移。任务领取用 `FOR UPDATE SKIP LOCKED`、租约 token 和重试上限；过期租约可重领。任务包括 diagnostic.echo、题目预检和确认导入；确认导入采用整批事务及业务幂等。原始 Excel 和图片保存在配置 `home/files`，备份必须同时包含数据库与文件。

安装版数据库使用独立低权限 Windows 虚拟服务账户，应用数据库角色只有所需表的 DML 权限，初始化角色与应用角色分离。数据库口令用 Windows DPAPI LocalMachine 加密并通过文件 ACL 限制读取。管理员始终可控制本机数据；本地验签不承诺抵御管理员整体回滚磁盘或修改程序。

## 本地授权

本地管理器已支持授权文件操作：以 Windows 管理员身份启动 → 在“软件授权”卡片导出 `.mreq` 申请 → 将供应方签发的 `.mlic` 文件导入 → 核对期限、同时作答人数和功能变更 → 确认导入。整个验签过程不需要联网，取消或无效文件不会覆盖原授权。文件预览有效期 10 分钟，确认时再次校验。操作及验收详见 [本地授权维护](docs/m3-license-manager.md)，回归命令为 `./tools/run.ps1 test:license-manager`。

授权格式为 JSON：`{protected, payload, signature}`，三部分均为无填充规范 base64url。签名原文固定为 ASCII `MetaExam-License-v1.<protected>.<payload>`。protected 中固定 typ、alg=Ed25519 和可信 kid；payload 字段见 [协议实现](packages/contracts/src/index.ts)。

校验签名、产品、schema、安装 UUID、Windows 设备指纹、应用版本范围、序号、时间区间和权益。到期边界为排他，最大时间回拨容忍 5 分钟。高水位保存在数据库和独立数据文件；相同序号仅同一文件可重复导入。失败导入不覆盖已有授权；重启后重新验签。验签路径无网络访问、远程公钥或在线时间依赖。

Windows 指纹优先 SMBIOS UUID + 主板序列，缺失或占位字段时回退 MachineGuid；请求会包含 fingerprintMode。原始硬件标识不导出。安装实例 ID 参与哈希，同机重新初始化是新的授权实例。

```powershell
./tools/run.ps1 license:request .local/request.mreq
./tools/run.ps1 license:verify .local/issued.mlic
./tools/run.ps1 license:import .local/issued.mlic
./tools/run.ps1 license:status
```

供应方测试签发工具单独运行，客户包不含它：

```powershell
# 只生成一次；临时测试私钥仅在开发机 .local/provider，切勿分发
./.tools/node/node.exe provider/test-license.mjs keygen .local/provider
# 测试客户的申请文件经离线介质送到供应方；每次更新递增序号
$env:LICENSE_SEQUENCE = '1'
./.tools/node/node.exe provider/test-license.mjs sign .local/provider request.mreq issued.mlic
```

测试公钥在打包时固化进客户文件；更换测试密钥后必须重新打包。集成测试和包验证另用进程内临时密钥与独立测试库，不更新开发账号或授权，也不作为正式授权。

新开考的有效授权/权益/容量判断，以及有效入场后中途到期可继续作答的纯规则已定义在 domain/attempt-policy。本阶段只固定规则契约并测试，实际名额分配、可信入场记录、用户所有权和考试会话在后续阶段开发。

开发数据库经过集成测试后使用另一组进程内临时测试公钥，并已有更高授权序号。若在开发数据库演练供应方签发，需先将配置的 trustFile 指向 .local/provider/public-keys.json，并使用高于数据库历史最高值的 LICENSE_SEQUENCE；不要降低或清空高水位。全新安装的首份测试授权可从 1 开始。

## 离线打包与维护

```powershell
# 首次打包时额外准备 Inno Setup、WinSW 和 VC++ 运行库
./tools/bootstrap.ps1 -Packaging -Proxy http://127.0.0.1:7897
./tools/run.ps1 package:win
```

环境准备统一校验 toolchain.lock.json 中的下载哈希，失败时中止，不自动改写锁文件。`-SkipDependencies` 可用于只检查和准备工具链。打包实现位于 installer/build.mjs，日常仍通过 package:win 调用；electron-builder 复用 bootstrap 准备的本地 Electron，并核对其版本，不在打包时重复下载运行时。

产物为 `artifacts/MetaExam-Setup-0.1.4-win-x64-internal.exe` 及 SHA256。打包前核验工具链锁文件；Electron 由 electron-builder 输出目录，后端生产代码与生产依赖由 esbuild 封装，Inno Setup 统一生成 EXE。包内含独立 Node、React、Electron、PostgreSQL、WinSW、VC++ 运行库；安装后不运行 npm、不下载依赖。安装器、卸载程序和桌面主程序使用自签名 Authenticode，详见 [证书管理与测试机信任](docs/code-signing.md)。

`package:win` 拒绝覆盖已有同版本 EXE 或 SHA256；修改交付内容需递增应用版本，保留旧包用于同 buildId 续升级。构建互斥锁位于 `artifacts/.package-build.lock`，正常退出自动清理；异常退出后须确认记录中的构建进程已结束再人工处理锁，不能在构建期间删除。编译先输出暂存目录，再排他创建最终 EXE；编译失败不覆盖已交付文件。

仅在独立 Windows 11 x64 测试机运行安装器。可选本机 HTTP 或局域网 HTTPS；生产 LAN 必须导入真实可用证书，客户端信任其 CA。HTTPS 证书需覆盖 127.0.0.1 及访问用 LAN IP/域名；程序不跳过 TLS 验证。详细步骤见 [独立环境验收清单](docs/phase1-acceptance.md)。

安装版维护命令：管理员终端设置 `METAEXAM_CONFIG=C:\ProgramData\MetaExam\config.json`，然后使用 `C:\Program Files\MetaExam\runtime\node.exe --use-system-ca C:\Program Files\MetaExam\server\cli.cjs license-request <输出路径>` 等同名命令。含空格路径需 PowerShell 的 `&` 与引号。

已有数据库禁止重新 initdb；安装器对受支持的旧版进入独立升级流程，见 [M3 离线升级](docs/m3-upgrade.md)。当前迁移为 V10，维护命令见 [M2 阅卷与成绩说明](docs/m2-grading.md)。卸载删除应用服务和应用文件、保留 ProgramData 数据。同机业务数据恢复见下文；保留数据的重新安装仍需人工维护，不提供净机或跨机恢复入口。当前仍为内部测试包，正式发布尚未交付；后续变更按影响范围回归。

## 本地备份与恢复

本地管理器支持同机离线备份与恢复。先停止 API／Worker，保留 PostgreSQL；以管理员身份运行管理器，在“备份与恢复”中操作。范围、恢复后果、异常回退和独立环境清单见 [M3 第二批](docs/m3-backup.md)。回归命令：`./tools/run.ps1 test:backup`。

0.1.1 离线升级及内部包验证结果见 [M3 第三批验证记录](docs/m3-upgrade-status.md)；安装环境回归尚待完成。

本地管理器的“故障诊断”已纳入 0.1.2，支持服务断连时导出脱敏 JSON 报告。操作与范围见 [M3 第四批](docs/m3-diagnostics.md)，验证命令 `./tools/run.ps1 test:diagnostics`；`test:package` 还会验证打包后的管理器。上一批 0.1.1 原包保持不变。

0.1.2 历史安装包摘要及验收清单见 [0.1.2 交付记录](docs/m3-release-012.md)；历史 0.1.3 客户包与独立签发器交付见 [供应方签发器](docs/provider-issuer.md)。

当前客户 0.1.4、供应方签发器 0.1.3 安装包、证书指纹及验证结果见 [自签名交付记录](docs/release-self-signed.md)。

## 供应方授权签发器

独立 Windows 签发器已接入工程，运行 `./tools/run.ps1 dev:issuer`。支持客户申请、口令保护密钥、限期／永久授权、序号台账、续期扩容和加密备份恢复。使用与信任配置见 [供应方操作手册](docs/provider-issuer.md)。供应方包通过 `package:issuer` 生成；客户 `package:win` 明确使用测试公钥，正式信任构建使用 `package:win:production` 并设置 `METAEXAM_TRUST_MANIFEST`，不回退测试配置。客户包不包含签发器或私钥。
