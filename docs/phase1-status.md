# 第一阶段交付状态

验证日期：2026-11-25。M0：**已完成**。独立环境整体验收依据用户当日“已验收”的确认；未附逐项日志，不补写实际执行证据。确认记录见 [M1 交付记录](m1-status.md)。

本机开发、普通进程运行、源码构建与内部离线包生成已实现；没有在开发机注册 MetaExam 服务、修改防火墙或执行系统重启。原始技术架构方案 DOCX 保留。

## 已完成清单

- [x] pnpm workspace：4 个应用、4 个共享包，TypeScript strict、ESLint、Prettier、锁文件与统一命令。
- [x] 项目独立 Node.js 24.22.3；系统 Node.js 16 保留，不修改全局 PATH。
- [x] NestJS + Fastify、React 同源生产资源/Vite 开发代理、沙箱 Electron 状态页面。
- [x] PostgreSQL 18.7 普通进程、Drizzle + pg、显式带校验和迁移。
- [x] API 写入 → Worker 租约领取 → 持久化完成；重复业务键幂等、过期租约重领。
- [x] 本地 Ed25519 请求导出、校验、导入、持久化与重启验签。
- [x] Windows 设备指纹：当前真实设备为 smbios；CIM 字段缺失/占位时回退 machine-guid 的实现已提供，缺失字段的真实硬件场景待独立环境覆盖。
- [x] 固定新开考授权/权益/容量判定和有效入场后续答的规则契约；实际名额分配、会话持久化与所有权检查尚未进入业务实现。
- [x] electron-builder 目录、后端生产依赖封装、Inno Setup 内部 EXE、SHA256、包内容排除扫描。
- [x] WinSW 服务安装/停止/卸载脚本、DPAPI + ACL 配置、HTTPS 证书导入、端口检查、已有数据库保护。
- [x] README、维护指引、独立环境验收清单、graphify 知识图更新。

## 本机已执行验证

| 检查                                           | 结果与边界                                                                                                                                                     |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 安装依赖、build、typecheck、lint、format:check | 通过                                                                                                                                                           |
| 授权与入场规则单元测试                         | 20 项通过，涵盖篡改、错误公钥/设备/实例、产品/版本、期限边界、序号、重复字段、时间回拨、名额与续答规则                                                         |
| 无网络验签                                     | 测试进程中禁止 TCP connect 和 fetch 后仍能完成有效/过期授权判定；未关闭整台开发机网络                                                                          |
| 真实 PostgreSQL 集成测试                       | 10 项通过：重复迁移、匿名修改拒绝、任务幂等、API 重启保留任务、模拟中断租约恢复、授权重复导入、失败保留、重启验签、数据库不可用 503、Electron 退出不停止后台   |
| PostgreSQL 进程重启                            | 通过，安装 ID、授权摘要/序号、任务行数保留，重启后授权 valid                                                                                                   |
| 页面                                           | 6 项通过：首次连接失败、桌面状态、390px 无横向溢出、断连旧数据提示、重试恢复、无页面 JS 错误                                                                   |
| UI 复核                                        | 独立 reviewer 指出的首次失败加载文案问题已修复，verdict ship 仅覆盖该项修复；检测器降级，未声称完整无障碍合规                                                  |
| 客户 payload 隔离运行                          | 6 项通过：包内 Node/API 与静态页、Worker 任务闭环、CLI 验签、打包 Electron 实际 IPC、关闭窗口后台存活、PostgreSQL 二进制版本                                   |
| 客户包内容检查                                 | 扫描普通文件和 Electron ASAR，无私钥、签发工具、开发配置、现成授权文件；只含内部测试公钥                                                                       |
| EXE 构建                                       | 已生成 Windows x64 内部包，未正式发布签名；没有运行此安装器                                                                                                    |
| 依赖审计                                       | 生产依赖 0 条已知漏洞；完整工具链审计有 2 条 moderate，均为 electron-builder 构建工具的 minimatch 依赖，不在客户运行代码中。未对构建器做未经验证的跨主版本覆盖 |

统一 dev 启动也已验证：Vite 5173 页面与代理、API 3000、Worker online 均通过；Ctrl+C 后退出开发进程。

原始结果文件位于 artifacts：dev-results.json、integration-results.json、database-restart-results.json、ui-results.json、package-smoke-results.json、payload-scan.json、audit-production.json、audit-toolchain.json；可通过仓库命令重跑。本机测试不是干净 Windows 安装验收的替代。

运行时核对：项目使用 .tools/node/node.exe 24.22.3；系统 NVM 的 v16.20.2 目录和可执行程序仍存在。结束时系统 nodejs 符号链接指向 NVM v24.18.0；本项目脚本没有执行 nvm use 或修改全局 PATH。

## Ant Design 接入验证（2026-11-25）

Web 与 Electron 已统一使用 Ant Design 6.7.2、@ant-design/icons 6.3.4 和中文 ConfigProvider。共享状态页的菜单、按钮、服务卡片、状态标签、授权描述及提示均已迁移；原有刷新、首次失败及旧结果提示保留。

随后按用户要求切换为 Ant Design 默认蓝色主题：移除主色和菜单选中色覆盖，主按钮与选中菜单使用 #1677ff，焦点、品牌图形与文本选区同步使用蓝色。Web 和打包 Electron 的运行检查验证实际主按钮为 rgb(22, 119, 255)。

新增 UI 检查后共 9 项通过，包括组件主题实际渲染、无 CSP 违规、无外部资源请求、授权标签对比度 5.50:1。独立复核提出的标签对比度修复已获 ship verdict；该结论仅覆盖该修复项。生产依赖审计仍为 0 条已知漏洞。

本次已重新构建内部 EXE，并验证包内 Electron 主题、真实 IPC 和独立后端运行。Ant Design 样式及图标随安装包提供，无 CDN 依赖；CSP 仅对动态 CSS 允许内联样式，脚本来源和 Electron 隔离策略保持原限制。此更新不替代以下独立环境验收。

## 工程整理与开发监听（2026-11-25）

保留四应用 workspace。tools 收敛为 bootstrap.ps1、run.ps1、dev.mjs 和 postgres.mjs；页面、数据库重启及包验证脚本归入 tests，打包入口归入 installer，测试签发工具归入 provider。环境准备合并为 bootstrap.ps1，通过 -Packaging 准备打包工具，移除自动改写工具链锁文件的脚本。

后台使用 TypeScript project references、tsc-watch 与 concurrently，编译成功后自动重启 API/Worker。Vite 开发模式直接使用共享 UI 源码，生产构建仍使用编译产物。新增 test:dev 的 7 项真实运行检查全部通过：统一启动、API 修改、Worker 修改、共享数据库代码、共享契约与任务闭环、共享 UI 无整页刷新、编译错误后自动恢复。结果保存在 artifacts/dev-watch-results.json。

整理后离线 frozen-lockfile 安装、工具链哈希校验、build、typecheck、lint、format:check、20 项单元测试、10 项集成测试、9 项页面检查和数据库重启持久化验证通过。实际终端启动并按 Ctrl+C 后，API、Worker 与 Vite 退出，3000/5173 端口释放，项目 PostgreSQL 普通进程继续运行。

打包入口改为复用已准备的本地 Electron 并核对锁定版本，避免重复联网下载。内部 EXE 已重新生成，客户 payload 的 6 项隔离运行检查通过；普通文件及 Electron ASAR 扫描结果为私钥 0、签发工具 0。未在开发机运行安装器。

## 独立环境验收与当前限制

开发启动补充验证：`dev` 已接入 Electron 自动启动，`dev:web` 保留仅后台与浏览器模式。独立端口运行的 `test:dev --startup-only` 已验证窗口启动、真实 IPC/default blue，以及窗口退出后 API、Worker、Vite 仍运行；结果见 artifacts/dev-startup-results.json。Electron 当前使用启动时构建的页面，桌面热更新未包含在此改动中。

用户已确认本批独立环境整体验收通过。以下范围保留为后续回归清单，不作为逐项执行报告：

- 独立 Windows 11 x64 净机断公网安装，包括包内 VC++ 运行库。
- 虚拟服务账户权限、数据库初始化、三项服务注册及自动恢复。
- 重启后自启、数据库就绪、原数据/授权保留。
- HTTPS CA 信任、局域网访问、证书错误和防火墙范围。
- 卸载停止服务、移除规则/程序、保留数据及失败安装处理。

完整步骤见 [独立环境验收清单](phase1-acceptance.md)。**第一阶段 M0 已按用户验收确认标记完成**。

本阶段不支持覆盖安装、原地升级或自动恢复保留数据；检测到已有数据库/安装记录时明确拒绝初始化。没有实现题库、考试、阅卷、实际并发作答名额分配；初始化、登录和角色权限已在 M1 第一批交付。测试私钥仅留在开发机受限的 .local/provider，独立环境用授权申请文件离线签发，不分发私钥。正式发布还需生产公钥治理和真实发布签名流程。

## M1 第一批后续交付（2026-11-25）

初始化、登录与 V1→V3 迁移的当前验证结果见 [M1 交付记录](m1-status.md)，操作步骤及回归清单见 [M1 验收说明](m1-acceptance.md)。本文件前面的本机验证结果为对应阶段的历史记录；用户随后确认本机及独立环境验收完成，M0 完成，M1 第一批验收完成。
