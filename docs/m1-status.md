# M1 第一批交付记录

日期：2026-11-25。代码与本机普通进程验证完成；提升权限的首次管理员完整流程、安装版 ACL、HTTPS、净机服务及重启仍待独立环境验收，M0 不标记完成。

## 已交付

- V1→V3 有序迁移，V1 SQL/校验和与已有数据兼容；Drizzle 声明补全，维护角色迁移、运行角色 DML 分离。
- 账号、角色权限、会话、初始化状态、持久限流、审计、班级课程和授课关系的数据基础。
- Electron 初始化向导及受限 IPC；管理员/SYSTEM 文件 ACL 的生成流程、一次性令牌消费和换发。
- 官方 `@nestjs/authentication` 0.1.6、`@nestjs/authorization` 0.1.4；PostgreSQL Cookie 会话、默认 scrypt、CSRF、权限与限流。
- React Router 8.5.3 的登录、个人信息、改密和退出页面，Ant Design 默认蓝色；原诊断状态页保留在 `/status`。
- 安装版维护迁移命令、新内部 EXE、payload 内容扫描和隔离运行检查。

## 本机验证结果

| 项目                                    | 结果                                                                        |
| --------------------------------------- | --------------------------------------------------------------------------- |
| build / typecheck / lint / format:check | 通过                                                                        |
| test                                    | 20 项通过，含禁止 TCP/fetch 后本地授权验证                                  |
| test:m1                                 | 7 个测试文件全部通过；使用独立数据库和临时数据目录                          |
| test:integration                        | 10 项通过；已改为独立库，保留任务重启恢复、本地验签和 Electron 退出存活验证 |
| test:ui                                 | 原状态页 9 项回归通过                                                       |
| test:dev                                | 9 项完整启动/监听/共享包/Vite 热更新/错误恢复通过，探针源码已恢复           |
| Ant Design CLI 检查                     | 新共享身份表单 0 条问题                                                     |
| package:win                             | 内部 Windows x64 EXE 生成成功，未执行安装器                                 |
| test:package                            | 7 项通过；新增包内初始化、登录、管理员接口及改密撤销，使用独立库            |
| payload 扫描                            | 1875 个文件、11 个 Electron ASAR 条目；私钥 0、签发工具 0                   |

包：`artifacts/MetaExam-Setup-0.1.0-win-x64-internal.exe`，243588895 字节，附同名 `.sha256`。内部包未正式签名，客户 payload 不含测试账号、数据库配置或初始化令牌。版本仍为内部 0.1.0；按本次生成时间和 SHA-256 区分早期包。

结果文件：`artifacts/m1/browser-results.json`、`artifacts/m1/login-mobile.png`、`artifacts/integration-results.json`、`artifacts/ui-results.json`、`artifacts/dev-watch-results.json`、`artifacts/package-smoke-results.json`、`artifacts/payload-scan.json`。生成物不纳入 Git，测试步骤在仓库中可重复执行。

构建保留两类非阻断提示：前端 chunk 超过 500 KB，以及桌面 Vite 配置未来 native loader 的 CommonJS 兼容提示。没有通过关闭检查来规避错误。

开发机未注册 Windows 服务、未修改防火墙、未进行系统重启，也未执行提升权限的令牌发放。普通权限 Electron 拒绝初始化已验证；这不等于已验证真实文件 ACL 的标准用户/管理员隔离。

启动、初始化和完整待验收清单见 [M1 验收与维护步骤](m1-acceptance.md)。本批没有管理员忘记密码恢复、账号/组织管理页面、题库或考试功能。
