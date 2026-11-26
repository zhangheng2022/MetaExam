# M3 第五批：0.1.2 内部测试交付

日期：2026-11-26。将本地诊断功能纳入离线安装包，保留本地授权、备份恢复和升级功能。数据库仍为 V10，依赖与独立 Node.js／PostgreSQL／WinSW 运行时版本不变。未正式签名，不自动推送或部署。

## 产物

- 文件：`artifacts/MetaExam-Setup-0.1.2-win-x64-internal.exe`。
- 大小：259220188 字节。
- SHA-256：`cf8699e6d15172563f17711d30b5ca49f0d391d99fa40d70b6f713137bafdb1c`。
- buildId：`49a679c8fe5a44e8ee2d158efed72daeff1bdb8f1439c99db49b3a45f2836dc8`。
- 载荷扫描：7772 个文件、23 个 Electron 归档条目，私钥 0、签发工具 0。

原 0.1.1 EXE 实际 SHA-256 复核为 `351570579bdadab109e7d6fe211463ebc405dbdfce6baa9880ac68f54b309bee`，未覆盖。旧载荷在新构建前完成逐文件清单校验并保存到 `artifacts/upgrade-baseline-0.1.1`，buildId 为 `9b4fb3c7a512292add0af94cc736f0f38ca7155bd34b904956d8e5ff627480a2`。原 0.1.0 基线仍在 `artifacts/upgrade-baseline`。这些产物和运行数据不进 Git。

## 构建约束

同版本 EXE 或 SHA256 已存在时，`package:win` 在修改载荷前失败。编译先输出 `artifacts/package-staging`，成功后以排他创建方式复制最终 EXE，再创建摘要文件，不覆盖已有交付。共享载荷构建使用排他锁，正常退出清理；异常终止残留锁时，先核对锁内 PID 对应进程已结束再处理，不自动抢占。版本号必须同时更新根目录、workspace 包、数据库 APP_VERSION 与安装器默认版本；依赖版本不随应用补丁版本升级。

升级只接受比当前安装更新的版本。未完成升级必须继续使用原 buildId 对应的 EXE，不能用 0.1.2 替代未完成的 0.1.1 升级。先用原包完成或维护修复后，再开始新版本升级。详见 [离线升级说明](m3-upgrade.md)。

## 本机验证

- build／package:win、typecheck、lint、format:check、31 项单元测试通过。
- 构建并发锁拒绝测试通过，原载荷清单不变。
- test:integration 与开发版 test:diagnostics 通过。
- test:package 通过：最终载荷完整业务冒烟、已交付版本防覆盖、打包管理器诊断检查／导出／取消／断连／503／IPC／窄窗口全部通过；已查看真实打包版截图。
- 原 0.1.0 → 0.1.2：通过真实旧程序、pg_dump 备份、启动失败同包继续、API／Worker 检查期间业务暂停、任务恢复及课程／授权／配置／公钥保留；重复同版本升级被拒绝。
- 原 0.1.1 → 0.1.2：上述路径全部通过；使用原 0.1.1 包降级亦被拒绝。测试未改变开发数据或服务。
- 已执行 graphify update，未修改开发账号数据。

`test:package` 现在包括已有 EXE 防覆盖检查及实际打包管理器的诊断检查／导出／断连／IPC／窄窗口测试。`test:upgrade` 默认使用原 0.1.0；另一条路径在当前 PowerShell 设置 `$env:METAEXAM_UPGRADE_BASELINE=(Resolve-Path artifacts/upgrade-baseline-0.1.1).Path`，再执行 `./tools/run.ps1 exec node tests/upgrade-package.mjs`。完成后删除该终端的环境变量，避免后续误选基线。旧包存在 release.json 时校验全量摘要；不接受缺失或不比目标更旧的基线。

## 独立环境验收

本机验证只使用普通进程、独立数据库及测试文件选择器。没有执行安装 EXE，没有注册／操作系统服务、修改真实服务 ACL 或防火墙，没有模拟真实断电或重启。已有 M0／M1 验收确认不代替本次回归。

- [ ] 独立 Windows 11 x64 断网净机安装 0.1.2，初始化、登录和本地授权正常。
- [ ] 分别从原 M3 第二批 0.1.0、原 0.1.1 安装版升级；已有题目图片、账号、成绩和授权保留。
- [ ] 普通／提升权限管理器的原生诊断保存对话框、报告字段、维护记录权限及 Windows 125%／150% DPI 正常。
- [ ] HTTPS 证书、CA 信任与局域网访问保留；错误证书不能被静默绕过。
- [ ] Windows 服务身份、目录 ACL、迁移 DML 权限、重启自启和升级中断续升级正确。
- [ ] 卸载保留业务数据、备份和升级记录；程序与服务移除正确。

参考：[Inno 编译器参数](https://jrsoftware.org/inno-setup/documentation/topic_compilercmdline.htm)。本批保留未签名内部交付属性，不使用虚构发布证书。
