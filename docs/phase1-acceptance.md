# 第一阶段独立环境验收

当前客户 0.1.6／供应方 0.1.5 的系统范围与新增系统验收要求见 [Windows 兼容目标](windows-compatibility.md)。下文历史批次的版本与验收记录保持原意，不代表新增系统已验收。

状态：**独立环境整体验收通过，M0 完成**。2026-11-25 用户在收到验收步骤后反馈“已验收”，据此记录验收完成。本次未附逐项结果、环境版本、安装包哈希或日志；下方保留操作及预期供后续回归，不作为开发代理实际执行的逐项报告。确认记录见 [M1 交付记录](m1-status.md)。开发机仍只用于普通进程与构建验证。

## 测试准备

- 一台可还原快照的 Windows 11 x64 干净虚拟机或独立电脑，管理员账户；不要使用开发机。
- 复制内部 EXE 与 .sha256，Get-FileHash 核对；安装前断开互联网，保留所需 LAN。
- 快照记录：系统版本、安装包哈希、测试时间；内置软件运行库应从包内安装。
- HTTPS 场景准备测试 CA 签发的 PEM 证书和私钥，SAN 包含 127.0.0.1、实际 LAN IP/域名。这只是 HTTPS 证书，**不是发布签名证书**。将 CA 明确导入服务机 LocalMachine Root 和客户端受信任根；不要关闭证书校验。

## 安装与启动

| 用例         | 操作及预期                                                                                |
| ------------ | ----------------------------------------------------------------------------------------- |
| 断网净机安装 | 运行 EXE，离线完成 Node/Electron/PostgreSQL/WinSW/运行库安装，不需 npm、互联网或系统 Node |
| 权限/冲突    | 非管理员触发 UAC；占用 API 或 55432 时明确报错，已有无归属数据库拒绝初始化                |
| 三项服务     | Get-Service MetaExam.\* 显示 Postgres/Api/Worker；虚拟账户、自动启动、失败恢复配置正确    |
| 数据库隔离   | 只监听 127.0.0.1:55432，外机不可连接；应用角色不能 CREATE/DROP 表                         |
| 健康检查     | /health/live 200，/health/ready 200；停止数据库后 ready 503                               |
| 桌面退出     | 打开管理窗口查看状态，退出窗口后 API 和 Worker 仍工作                                     |
| 重启自启     | 重启机器，不先打开 Electron；三项服务自启、ready 200、原任务和授权保留                    |
| LAN HTTPS    | 同 LAN 客户端用受信任证书访问 / 与 /health/ready；无证书错误，其他网络范围被防火墙阻止    |
| 本机管理边界 | LAN 访问 /api/v1/system/status 和诊断写入返回 403；普通管理状态仅部署机可读               |

安装日志在 Inno 的临时安装日志与 ProgramData/MetaExam/logs，服务日志滚动保留。VC++ 返回 3010 时记录“需要重启”，在重启用例中确认正常。服务启动失败保留配置和日志，先定位再处理，不删除数据库重试。

## 离线授权与任务

管理员 PowerShell：

```powershell
$env:METAEXAM_CONFIG = 'C:\ProgramData\MetaExam\config.json'
$node = 'C:\Program Files\MetaExam\runtime\node.exe'
$cli = 'C:\Program Files\MetaExam\server\cli.cjs'
& $node --use-system-ca $cli license-request 'C:\test\request.mreq'
# 将申请移交开发/供应方电脑，使用 provider-test 签发；仅返回 issued.mlic
& $node --use-system-ca $cli license-verify 'C:\test\issued.mlic'
& $node --use-system-ca $cli license-import 'C:\test\issued.mlic'
& $node --use-system-ca $cli license-status
```

- 断公网导入有效授权，状态 valid；重启 API/电脑后仍 valid。记录实际 fingerprintMode，缺失字段后备模式需在相应硬件/虚拟机验证。
- 篡改签名、错误设备、错误实例、过期、未知 kid、旧序号均被拒绝，原授权不受影响。
- 重复导入同一文件幂等；同序号不同文件拒绝；更高序号有效文件可替换。
- 调低系统时间超过 5 分钟，报告 clock_anomaly；恢复时间后验证。此机制不能阻止管理员整体磁盘快照回滚。
- 通过本机带管理令牌的诊断 POST /api/v1/diagnostics/jobs 提交 businessKey、message；GET /api/v1/diagnostics/jobs/:id 记录 completed。令牌只从受限配置读取，不写入报告。
- Worker 中止后重启，未完成租约到期后被重领，最终只保留一份任务结果；正式业务副作用不属于该测试。

## 卸载与恢复保护

- 卸载前记录安装 UUID、授权序号、任务行数；备份 ProgramData 与公钥文件。
- 卸载：服务移除、MetaExam 防火墙规则移除、程序文件移除，ProgramData 数据与日志仍存在，数据库无强制断电损坏。
- 原数据存在时重新安装应拒绝自动初始化。**本阶段不支持原地升级/自动恢复安装**；不要为绕过保护删除 PG_VERSION 或 installation.json。
- 测试停止服务超时的失败提示，确认不会继续删除服务文件。后续安装链路变更需回归失败安装清理与部分安装恢复。

## 交付检查

- 包内不含私钥、签发工具、开发配置、现成授权文件；仅内置内部测试公钥。
- Windows 可提示“未知发布者”：本包没有正式发布签名，不使用虚构生产证书。
- 后续回归记录：安装包哈希、Windows build、时间、每项通过/失败、脱敏日志、待修问题。本次整体验收确认见文首，不补填缺失记录。
