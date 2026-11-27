# 2026-11-27 自签名内部交付

客户 0.1.4、供应方签发器 0.1.3 使用同一自签名代码证书。软件授权继续采用现有 Ed25519 协议，客户包使用 `internal-test` 测试信任配置；数据库仍为 V10。

| 产物                                               | 大小（字节） | SHA256                                                             |
| -------------------------------------------------- | ------------ | ------------------------------------------------------------------ |
| `MetaExam-Setup-0.1.4-win-x64-internal.exe`        | 259250088    | `afcb3196790ae282473e85bdd5b09f45feeb0c0ad02666cb8cb3d97d75289898` |
| `MetaExam-Issuer-Setup-0.1.3-win-x64-internal.exe` | 172627056    | `fb7dc8538b5d8260fda04113ef083ab3bb4ed9889bd0db54414ebd289ce2b9e6` |

产物位于 `artifacts`；每个 EXE 附 `.sha256` 和 `.cer`。证书主体为 `CN=MetaExam Internal Code Signing`，指纹为 `D349A34B27BC213C9BDBE834E25F47604147B141`，到期时间为北京时间 2029-11-27 11:23:57。不使用时间戳；到期后的验证限制及独立测试机导入公开证书步骤见 [签名规范](code-signing.md)。开发机没有导入 Root/TrustedPublisher 信任。

签名范围包括两种安装器、Inno 生成的卸载程序与临时安装副本、客户管理器和供应方主程序。构建使用 PowerShell Authenticode；Inno 显式启用 SignTool 与 SignedUninstaller，签名失败中止构建。原始第三方 EXE 未重新签名或改写。

客户载荷扫描 7776 个文件、23 个 ASAR 条目；供应方扫描 82 个文件、10 个 ASAR 条目，未混入私钥、PFX、DPAPI 口令文件或台账。当前用户 My 证书库保留签名密钥；加密 PFX 备份放在用户指定 OneDrive 目录，不提交 Git。已验证 DPAPI 口令可解密 PFX，且备份证书指纹一致。

旧客户 0.1.3 和供应方 0.1.2 EXE 保持原摘要。真实旧客户载荷已验证并保留在 `artifacts/upgrade-baseline-0.1.3`，不通过伪造版本替代升级测试。

## 本机验证

- `build`、`typecheck`、`lint`、`format:check`、31 项单元测试通过。
- `test:signing --packages`：实际 PE 签名与固定证书匹配；原始未使用本证书的程序、正文篡改和缺失签名配置均拒绝。最终两种安装器和桌面主程序均复核。
- `package:win`、`package:issuer`：完整生成，校验签名后才发布最终文件和摘要。
- `test:issuer:package`：真实成品 Electron 签发、重新导出、备份恢复、非法 IPC、锁屏与空闲锁定、窄窗口通过。
- `test:package`：客户隔离载荷运行、授权维护、任务与后台存活、成品管理器诊断导出及 IPC 回归通过。
- `test:integration`：重复迁移、任务重启恢复、授权本地验签、数据库不可用就绪失败、关闭桌面后台继续运行通过。
- `test:upgrade`：真实 0.1.3 → 0.1.4 载荷、pg_dump 备份、启动失败同包继续、API/Worker 维护屏障、课程/授权/配置/公钥保留通过。

## 独立环境待验收

目标 Windows 用户/系统证书信任、SmartScreen/企业策略、实际安装与签名卸载程序、客户服务身份及重启回归仍待执行。本次没有安装 EXE、注册服务、修改受信任根或重启开发机。
