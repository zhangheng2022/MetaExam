# Windows 自签名交付

从客户 0.1.4、供应方签发器 0.1.3 起，两种安装包统一使用自签名 Authenticode。旧版 EXE 和摘要保持不变。签名覆盖安装器、Inno 生成的卸载程序和临时安装副本、MetaExam.Manager.exe 与 MetaExam.Issuer.exe。Node、Electron 附属组件、PostgreSQL、WinSW 等第三方文件保留上游内容与签名。

## 证书与私密文件

默认签名目录为 `C:\Users\96227\OneDrive\MetaExam\code-signing`；可通过 `METAEXAM_SIGNING_HOME` 指定其他受控位置。初始化必须显式执行 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File installer/signing.ps1 -Action Initialize`，不会在构建时自动创建或替换证书。

- 证书：RSA 3072 位、SHA-256、Code Signing EKU，保存在当前用户 Personal/My 证书库；有效期三年。
- `MetaExam-CodeSigning.pfx`：随机强口令保护的私钥备份。
- `pfx-password.dpapi`：仅原 Windows 用户能解密的 PFX 口令；不输出到终端、日志、命令行或环境变量。
- `certificate.json` 与 `MetaExam-CodeSigning.cer`：公开证书信息，不含私钥。
- 签名子目录关闭 ACL 继承，仅当前用户和 SYSTEM 访问。不自动变更 OneDrive 上级目录或云端共享权限。

OneDrive 同步不能代替跨机器恢复安排：DPAPI 文件通常只能在原 Windows 用户环境解密。迁移前应在原环境安全取出口令并另存密码管理器，目标机导入 PFX 到当前用户 My 库，再配置目录和公开信息。不得把 PFX、DPAPI 文件或口令放进 Git、客户包、供应方包。

程序签名证书与 Ed25519 软件授权密钥完全独立。本次不迁移或创建正式软件授权私钥，不将运行中的 SQLite 台账改放同步目录。

## 构建与验证

继续使用 `./tools/run.ps1 package:win`、`package:win:production` 和 `package:issuer`。两条构建链缺少有效签名证书时直接失败；SignTool 失败会中止 Inno 编译。先签桌面程序再生成客户载荷摘要，安装 EXE 验证通过后才写入最终文件和 SHA256。每个 EXE 附带同名 `.cer` 公钥证书。

`./tools/run.ps1 test:signing` 检查实际 PE 签名、错误签发者、正文篡改和配置缺失；加 `--packages` 验证当前两种安装器及桌面程序。验证固定证书指纹，并调用 Windows WinVerifyTrust 离线检查。只允许成功或固定自签名证书的 `CERT_E_UNTRUSTEDROOT`，其余错误均拒绝；未信任根的结果明确记录为 `PinnedSelfSignedUntrustedRoot`，不是 Windows 信任验证通过。

当前没有在线时间戳，证书过期后旧包的系统签名有效性会受影响。需要长期分发时另行安排证书轮换与可信时间戳，不伪造时间或关闭签名检查。

## 独立测试机验收

1. 通过独立渠道核对交付记录中的证书指纹与 EXE SHA256，不直接信任安装包旁任意证书。
2. 在测试机双击 `.cer` 查看用途、主体、有效期及指纹；确认来源后，由操作者将**公开证书**导入目标用户或本机的“受信任的根证书颁发机构”。按组织策略决定信任范围，不导入私钥。构建及安装脚本均不自动授予根信任。
3. 使用 `Get-AuthenticodeSignature -LiteralPath <EXE>`，信任配置完成后应为 `Valid`，签发者与记录一致。安装后对两个桌面主程序和 `unins000.exe` 再执行检查。
4. 按已有客户服务/升级验收、供应方普通用户安装流程测试；确认卸载保留数据。SmartScreen、企业应用控制与杀毒策略仍可能额外拦截，自签名不等于公开 CA 信誉。

本机仅构建与普通进程回归；本次证书信任、实际安装/卸载、服务与重启仍需独立环境验收。

官方依据：[PowerShell Authenticode](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/set-authenticodesignature)、[自签名证书](https://learn.microsoft.com/en-us/powershell/module/pki/new-selfsignedcertificate)、[Inno SignTool](https://jrsoftware.org/inno-setup/documentation/topic_setup_signtool.htm)、[Windows WinVerifyTrust](https://learn.microsoft.com/en-us/windows/win32/api/wintrust/nf-wintrust-winverifytrust)。
