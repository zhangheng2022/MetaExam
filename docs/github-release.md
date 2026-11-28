# GitHub 云端构建与预发行

仓库为 `zhangheng2022/MetaExam`，客户包和供应方签发器都公开下载。首次云端版本为客户 0.1.5、签发器 0.1.4，统一标签 `v0.1.5`。旧本地安装包不覆盖。

首次交付结果、资产摘要、云端与本机验证分别记录于 [0.1.5 验收记录](github-release-0.1.5.md)。

## 使用方式

1. 按交付内容提升客户与签发器版本，同步客户 APP_VERSION、Inno 默认版本，提交并推送 master。
2. 打开 Actions 的“Windows 预发行”，选择 master，填写源码中的客户和签发器版本。
3. 工作流固定当前提交，顺序检查、构建两种包、执行真实普通权限回归，上传并核对 Release 资产，自动发布为 Pre-release，不设为 Latest。
4. 下载 EXE、SHA256、公开证书及说明。自签名信任和独立安装验收见 [签名规范](code-signing.md)。

普通 push/PR 运行“项目检查”和“CodeQL 质量与安全”，范围见 [质量检查](code-quality.md)，不持有签名密钥或 Release 写权限。发版失败检查日志后重跑；已发布版本不可覆盖。已有草稿只有提交 SHA、标签和已上传资产字节完全相符才可继续，重新构建签名产生不同字节时必须换版本，不能强制覆盖。

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

Release 只接收白名单：两种 EXE、各自 SHA256、公开 CER、签名说明、中文发布说明和交付清单。完整客户载荷另作为 customer-payload Actions artifact 保留 30 天，用于下载后的真实旧载荷升级回归；release-assets 仍保留 7 天用于续发布。新保留期不延长已有资产寿命；不会发布数据库、私钥、台账、口令、.local 或会话目录。

云端执行类型、Lint、格式、单元、CI 发布规则、构建、集成、供应方签发和两种成品回归。发版前验证文件摘要，上传后重新下载核对，再发布草稿。构建或测试失败不发布。

首次上线还需下载云端载荷，在本机用真实 0.1.4 基线验证升级；该结果与云端测试分开记录。云端成功不代表目标机器已完成证书信任、实际 Windows 服务安装、卸载和重启验收。

官方资料：[手动工作流](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)、[Actions Secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)、[GitHub Release CLI](https://cli.github.com/manual/gh_release_create)、[Windows 受限令牌](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-createrestrictedtoken)、[子进程安全上下文](https://learn.microsoft.com/en-us/windows/win32/secauthz/processes-in-the-client-security-context)、[对象默认 DACL](https://learn.microsoft.com/en-us/windows/win32/secauthz/dacl-for-a-new-object)。

## 0.1.16 发布回归补充

发布和续发布使用必填输入 `upgrade_baseline_run_id`，指定真实旧客户构建的 customer-payload 资产。下载前核对本仓库 master 手动发布工作流及成功 build job，下载后验证完整载荷清单、buildId 和旧版本。历史默认 45983115933 对应 0.1.13；现已取消固定默认值，操作者必须选择仍可下载的真实旧构建，不能跳过或伪造基线。

普通权限验证增加 test:install-repair、test:upgrade 和 test:attempts。创建 Release 草稿后允许短暂列表不可见，最多查询八次；发现错误提交、重复草稿或已发布版本仍立即拒绝，不覆盖资产。

构建及续发布验证检出完整 Git 历史，以便 test:attempts 读取真实历史迁移并核对不可变内容。默认浅克隆缺少历史提交会导致验证失败，不能删除该断言或改用当前迁移伪造旧基线。

## 流水线精简（2026-11-28）

开始即预检输入版本、已发布版本／草稿归属和基线资产有效期，基线版本从固定源码提交读取。下载后仍核对实际载荷，元数据预检不能替代内容校验。新构建遇到已有草稿要求显式续发布，不能重新构建后覆盖旧字节。

质量检查保留独立步骤，发布 ESLint 同样要求零警告。`tools/ci/build.mjs` 执行一次全量构建，并记录源码、Node 版本和编译输出摘要。两种打包在同一工作区使用 `--reuse-build`，任意源码／产物变化或摘要文件缺失均中止；不缓存摘要或编译产物。本地不传该参数仍自动构建。续发布继续重新编译原源码供测试，但复用原安装资产，不重签或重建交付包。

普通权限验证按原顺序执行，输出实时分组日志、每项耗时和 GitHub Step Summary。父进程逐段转发受限子进程日志，退出码及完整测试标记检查保留；失败仍停止后续测试并清理数据库进程。受限令牌、管理员文件拒绝、原始升级基线及签名保护均不放宽。

构建摘要入口通过 `./tools/run.ps1 exec node tools/ci/build.mjs` 执行，确保嵌套 workspace 构建也能找到锁定 Node/pnpm。云端运行 46096570329 在签名和打包前暴露了直接调用 Node 时未继承 pnpm PATH 的问题；不依赖开发机全局 pnpm，验证时使用只含系统工具和 Git 的初始 PATH 执行同一入口。

最近一次旧流水线成功运行 46031757389 约 10 分钟，其中打包 127 秒、成品验证 264 秒。缓存冷／热运行和 Ubuntu CodeQL 的实际收益须在新云端运行后记录，不以本机验证推算提速比例。

第一轮云端实测（46036917583／46037364340）发现工具下载与 pnpm 存储混合缓存约 550 MiB，准备步骤从未命中的 40 秒变成命中后的 57 秒。因此移除 pnpm 存储缓存，只保留经过 SHA256 复核的锁定工具下载包，普通项目检查不再准备 PostgreSQL；不将缓存命中本身当作性能提升。

本机已通过 build、typecheck、零警告 lint、format:check、32 项单元测试和 test:ci。独立工作区使用仅验证用的客户 0.1.21／供应方 0.1.8 构建两种签名包，确认两次 BUILD_REUSED，以及 test:package、test:issuer:package、test:signing --packages 通过；主工作区版本及已发布资产不变。实际云端缓存、Ubuntu 扫描和受限 runner 的结果以对应 Actions 运行为准，独立系统安装验收不在本轮范围内。
