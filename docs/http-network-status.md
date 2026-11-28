# 0.1.23 HTTP 改造交付记录

日期：2026-11-28。功能与独立环境操作见 [HTTP 部署说明](http-network.md)。本次仅本地构建、验证与提交，不推送或云端发版。

## 交付内容

移除仅本机选项、HTTPS 证书页及 TLS 启动配置，统一局域网 HTTP；保留应用端口、网段、数据库回环监听和本地管理器回环探针。生产会话使用独立 HTTP Cookie 名称，保留 CSRF 和权限校验。题库及答题 UUID 改用 `getRandomValues`，实际非安全浏览器来源下五题型编辑和自动保存已验证。

升级、首次安装修复及保留数据重装共用可恢复配置转换；原始配置快照用于旧版备份校验，转换过程保留配置 ACL 和维护门禁。旧证书文件保留但不再引用。数据库 V10、Node／PostgreSQL／WinSW、软件授权与安装包签名机制保持不变；供应方版本仍为 0.1.8。

## 本机验证结果

| 检查                                                                    | 结果                                                                                                      |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| build、typecheck、lint --max-warnings 0、format:check、git diff --check | 通过                                                                                                      |
| test                                                                    | 33 项通过，包括生产 HTTP 配置与旧 TLS 配置拒绝                                                            |
| test:http-network                                                       | 13 项通过；本机／HTTPS 转换中断续跑、配置篡改拒绝、网段恢复，以及实际 PowerShell 脚本的隔离防火墙筛选测试 |
| test:install-repair                                                     | 51 项通过，另通过 WinSW 配置与隔离 PostgreSQL 初始化／关闭回归                                            |
| test:m1、test:integration                                               | 通过；生产 HTTP Cookie、旧 Cookie 拒绝、CSRF、权限、初始化、会话与任务重启恢复                            |
| test:questions、test:attempts                                           | 通过；真实浏览器明确断言非安全来源，题库五题型、入场、自动保存、断网重试、冲突及交卷正常                  |
| test:ui、test:desktop、test:diagnostics、test:backup                    | 通过；普通权限拒绝、受限 IPC、诊断导出及备份恢复                                                          |
| package:win                                                             | 通过；包含 24 项兼容性检查及实际共用 Inno 安装结果测试                                                    |
| test:upgrade，原始 0.1.22 本机 HTTP 载荷                                | 通过；完整 pg_dump 备份、启动失败续跑、API／Worker 门禁及课程／授权／配置保留                             |
| upgrade-package，原始 0.1.22 HTTPS 载荷                                 | 通过；旧 API 使用临时证书真实提供 HTTPS，随后转为 HTTP，并验证启动失败续跑。临时证书不导入系统信任        |
| test:package                                                            | 通过；最终载荷隔离冒烟、普通权限断言和打包后的 Electron 诊断流程                                          |
| graphify update .                                                       | 已执行                                                                                                    |

构建仍有既有的大 chunk 与 Vite 原生配置加载器未来兼容提示；ESLint 零警告。未跳过失败断言，测试不清空开发账号或修改开发机产品服务、防火墙与系统根证书。

## 安装包与基线

- 安装包：`artifacts/MetaExam-Setup-0.1.23-win-x64-internal.exe`，259,525,264 字节，内部自签名测试包。
- SHA256：`2c5efa62e6864dbbbe7f52cde136ec8cc3cfcc03bf3798c8dd31085d837c6052`。
- buildId：`86259e8b4f8bea49c72171861f137bfb816996fb3ef420910b2e9b5843a446b6`。
- 载荷扫描：7,929 个文件、28 个管理器归档项，私钥 0、供应方工具 0。
- 原始旧载荷：`artifacts/upgrade-baseline-0.1.22`，复制前后核验完整清单，buildId 为 `bd4de3e60994acfe843e2f7788e6cd3a75fec369456a70cafbc21d08332130d9`。原安装包及更早基线未覆盖。

## 未完成的独立环境验收

真实净机安装、服务虚拟身份和 ACL、实际防火墙网段限制、另一台电脑通过服务器 IP 访问、系统重启／断电续升级、卸载重装仍待独立环境回归。本机非安全来源浏览器、普通进程真实旧载荷和命令替身测试不替代这些验收；此前批次结论不扩大到本次新路径。
