# GitHub 云端构建与预发行

仓库为 `zhangheng2022/MetaExam`，客户包和供应方签发器都公开下载。首次云端版本为客户 0.1.5、签发器 0.1.4，统一标签 `v0.1.5`。旧本地安装包不覆盖。

## 使用方式

1. 按交付内容提升客户与签发器版本，同步客户 APP_VERSION、Inno 默认版本，提交并推送 master。
2. 打开 Actions 的“Windows 预发行”，选择 master，填写源码中的客户和签发器版本。
3. 工作流固定当前提交，顺序检查、构建两种包、执行真实普通权限回归，上传并核对 Release 资产，自动发布为 Pre-release，不设为 Latest。
4. 下载 EXE、SHA256、公开证书及说明。自签名信任和独立安装验收见 [签名规范](code-signing.md)。

普通 push/PR 仅运行“项目检查”，不持有签名密钥或 Release 写权限。发版失败检查日志后重跑；已发布版本不可覆盖。已有草稿只有提交 SHA、标签和已上传资产字节完全相符才可继续，重新构建签名产生不同字节时必须换版本，不能强制覆盖。

若 build 已成功而 publish 失败，在手动发版时填写原始 `resume_run_id`。工作流核验该运行来自本仓库 master 的手动发版、build 已成功，再下载原 artifact。恢复验证使用原源码与当前验证器，解压原客户载荷，在临时 runner 安装原供应方 EXE，然后重新执行成品测试；只为签名回归临时导入证书，不重签或重建交付包，不改变原始源码 SHA。通过后才继续发布。通过认证的 Release 列表查找草稿，不使用只返回已发布版本的按标签接口。artifact 超过 7 天失效后不可假装原字节重跑。

## 工具链、证书与权限

- 固定 windows-2025；Node、pnpm、Electron、PostgreSQL 和 Inno 使用项目锁定版本，下载 SHA256 变化即失败。上游可变下载地址发生变化时需人工核实，禁止自动改写锁文件。
- 官方 checkout/upload-artifact/download-artifact 固定完整提交 SHA。checkout 不保留 Git 凭据；只有 publish job 使用 contents:write。
- Environment `windows-signing` 仅允许 master；Secrets 为 `METAEXAM_SIGNING_PFX_BASE64` 和 `METAEXAM_SIGNING_PFX_PASSWORD`。公开证书指纹固定在 `installer/signing-certificate.json`。不使用软件授权 Ed25519 私钥。
- 导入步骤临时读取 Secrets，把 PFX 导入当前用户 My 库；临时文件位于 RUNNER_TEMP，流程结束无论成功失败都清理本次导入证书和私钥。不会写入 Root/TrustedPublisher。开发机仍使用 OneDrive 加密备份，不把 DPAPI 文件上传到 GitHub。
- 客户测试授权公钥、指纹位于 installer/test-trust.json，构建自动关联目标版本；正式信任仍必须显式提供，不能回退测试配置。
- Windows runner 默认管理员且关闭 UAC。测试父进程创建当前用户的受限令牌，禁用管理员组并移除提升权限；保留宿主完整性等级，为受限令牌设置当前用户的对象默认 DACL，并创建仅当前用户和 SYSTEM 可访问的独立非交互桌面。子进程断言身份未变、不是管理员，并实际验证无法读取仅 Administrators/SYSTEM 可读的探针文件。PostgreSQL、Electron 和原有权限拒绝断言实际运行，不跳过测试，不增加产品权限绕过开关。该令牌测试不替代目标机器的普通登录/UAC 与真实安装 ACL 验收。
- 受限子进程使用显式文件/NUL 标准句柄和隐藏启动，直接调用锁定 Node/pnpm；父进程同时核对退出码、完成标记与真实测试输出。退出码为零但缺少实际测试输出同样失败，不能把空执行当作通过。原生 stderr 保留为日志，不能把正常诊断文本误当作失败或丢弃真正非零退出。

## 资产与验收

Release 只接收白名单：两种 EXE、各自 SHA256、公开 CER、签名说明、中文发布说明和交付清单。完整客户载荷另作为 customer-payload Actions artifact 保留 7 天，用于下载后的真实旧载荷升级回归；不会发布数据库、私钥、台账、口令、.local 或会话目录。

云端执行类型、Lint、格式、单元、CI 发布规则、构建、集成、供应方签发和两种成品回归。发版前验证文件摘要，上传后重新下载核对，再发布草稿。构建或测试失败不发布。

首次上线还需下载云端载荷，在本机用真实 0.1.4 基线验证升级；该结果与云端测试分开记录。云端成功不代表目标机器已完成证书信任、实际 Windows 服务安装、卸载和重启验收。

官方资料：[手动工作流](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)、[Actions Secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)、[GitHub Release CLI](https://cli.github.com/manual/gh_release_create)、[Windows 受限令牌](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-createrestrictedtoken)、[子进程安全上下文](https://learn.microsoft.com/en-us/windows/win32/secauthz/processes-in-the-client-security-context)、[对象默认 DACL](https://learn.microsoft.com/en-us/windows/win32/secauthz/dacl-for-a-new-object)。
