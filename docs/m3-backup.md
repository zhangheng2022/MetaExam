# M3 第二批：同机备份与恢复

> 0.1.23 起统一局域网 HTTP，不再配置仅本机模式、域名或 HTTPS 证书。当前网络操作和回归以 [HTTP 部署说明](http-network.md) 为准；下文旧批次 HTTPS 记录保留历史含义，不作为新版验收结论。

## 范围

本地管理器新增“备份与恢复”：创建备份、选择并校验备份、确认恢复、回退中断维护。仅支持同一安装实例、同一设备、当前程序版本与 V10 数据库；不实现跨机器迁移、定时备份、在线备份、版本升级或自动清理旧数据。维护期间停止 API 和 Worker，PostgreSQL 保持运行。不自动强停考生、不注册或修改 Windows 服务。

继续使用原有本机维护 CLI，主进程原生文件夹选择器决定路径。渲染层只得到备份时间、大小、附件数量和一次性预览 ID；不能读取密钥、数据库凭据或任意执行命令。Windows 管理员权限在 Electron 和 CLI 两处校验，确认恢复重新检查权限。预览有效期 10 分钟，取消、重载、关闭窗口或确认后失效。

## 操作步骤

1. 安排无进行中考试的维护窗口。即使尚无人入场，已发布且处于考试时间的场次也会阻止维护。
2. 停止 API、Worker 和其他维护命令。开发模式先在原 `dev` 终端按 Ctrl+C，保留 PostgreSQL；在项目目录打开管理员 PowerShell，先执行 `$env:METAEXAM_CONFIG=(Resolve-Path .local/config.json).Path`，再用 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/run.ps1 --filter @metaexam/desktop start` 单独打开管理器。自定义配置时指定实际配置文件。
3. 安装版在管理员 PowerShell 停止 `MetaExam.Api`、`MetaExam.Worker`，不要停止 `MetaExam.Postgres`。确认服务已停止，再以管理员身份打开管理器。
4. 点击“创建备份”，选择数据目录之外的普通本地文件夹。成功后生成 `MetaExam-<备份编号>.mbackup` 文件夹，必须整体保存。失败的、不含有效 `manifest.json` 的目录不能用于恢复。
5. 恢复时选择该 `.mbackup` 文件夹，核对时间、大小和附件数量，再点击“确认恢复”。恢复会覆盖备份后业务修改的可见状态，清除登录会话；当前授权、本机连接配置、信任公钥、HTTPS 私钥和证书保留。
6. 成功后重新启动 API、Worker，验证就绪、管理员登录、题目图片和考试成绩。所有用户重新登录。
7. 如提示维护中断，保持 API、Worker 停止，点击“回退中断维护”。没有待回退记录时不会撤销已经完成的恢复。若回退仍失败，不手工删除 `maintenance.json`，保留数据和记录进行维护排查。

本机开发没有执行上述系统服务操作。安装环境可使用：

```powershell
Stop-Service MetaExam.Api, MetaExam.Worker
Get-Service MetaExam.Api, MetaExam.Worker, MetaExam.Postgres
# 完成维护并检查成功提示后：
Start-Service MetaExam.Api, MetaExam.Worker
```

## 备份内容与校验

- PostgreSQL 18 `pg_dump --format=custom` 导出整个业务库，包括版本快照、考试、账号密码摘要、审计和任务。
- 保存 `home/files/images`、`home/files/imports` 中的持久化文件，包括仅历史题目版本引用的图片。临时 `.tmp` 文件不导出；未知目录、链接和硬链接拒绝处理。
- 每个文件记录 SHA-256 和大小；核对数据库中所有图片、导入原文件的摘要。清单包含安装实例、设备指纹、程序／迁移版本、授权序号／时间水位和脱敏端口设置。
- 清单由本机随机 256 位密钥进行 HMAC-SHA256 认证。密钥只保存在 `home/backup-secret/key`，生产 CLI 将该目录 ACL 限制为 Administrators/SYSTEM；不进入备份或安装包。这不是软件授权签发密钥，软件授权仍采用原有 Ed25519 本地验签。
- 备份文件夹同样限制为 Administrators/SYSTEM 可访问。备份没有加密，含账号密码摘要和试题答案；复制到其他介质后应继续保护访问权限。摘要不是加密，HMAC 也不能替代保密存储。
- 不导出数据库密码、管理令牌、初始化令牌文件、TLS 私钥、DPAPI 凭据和本机备份密钥。它们由当前安装继续使用；本批不能依靠单个备份重建一台已丢失所有本机配置的新电脑。不要删除或重建 `backup-secret`，否则无法验证旧备份。

## 一致性与恢复

所有运行数据库连接在锁定版本 pg-pool 的 `onConnect` 中取得共享咨询锁，并保持到连接关闭；连接池不自动关闭空闲连接。维护命令先创建持久化标记，再取得独占咨询锁，确认没有其他数据库会话；不杀连接。API、Worker 和其他维护入口新建连接时检查标记并拒绝进入。连接关闭有短暂排空等待，仍有运行连接时返回明确错误。

控制连接在 `postgres` 库持有按目标数据库区分的维护锁，防止多个备份、恢复和回退并发。维护标记在数据库重命名期间持续阻止重连，数据库断开或进程崩溃不会自动解除标记。

恢复先校验来源、文件、版本、实例、设备和可用空间，将文件复制到本机工作目录并再次核对摘要，再以 `pg_restore --single-transaction --exit-on-error --no-owner --no-acl` 还原临时数据库。验证完整迁移序列、附件引用、初始化状态及考试时间，重新授予运行身份原有 DML 权限，不授予 DDL。不会通过恢复未初始化的旧备份重新开放管理员初始化。

临时库替换成当前授权状态和当前授权历史，序号／可信时间取当前库、备份库和水位文件的最大值；当前水位文件原样保留，不回滚信任公钥。所有业务会话、旧初始化令牌和 Worker 心跳失效。校验完成才重命名数据库并切换附件目录；完成后移除维护标记。自动回退只发生在维护尚未完成时。

原数据库保留为 `metaexam_old_<操作编号>`；原附件保留在 `home/restore-<操作编号>/previous-files`，切换记录为同目录 `receipt.json`。记录写入后才解除维护标记；仍有 `maintenance.json` 时按中断处理，不能仅凭 receipt 判定维护完成。失败的临时库、暂存文件也保留用于排查。本批不自动删除这些数据；后续清理须同时确认记录归属、恢复结果和保留策略，不能只根据数据库名或目录前缀批量删除。

PostgreSQL 服务监督进程在发现维护标记时保持数据库进程运行，暂不执行业务库就绪检查和授权操作，以便处理中断恢复；API/Worker 仍拒绝连接。真实断电、服务重启及磁盘损坏不等同于已完成的进程崩溃测试。

技术依据：[PostgreSQL 18 SQL Dump](https://www.postgresql.org/docs/18/backup-dump.html)、[pg_dump](https://www.postgresql.org/docs/18/app-pgdump.html)、[pg_restore](https://www.postgresql.org/docs/18/app-pgrestore.html)。组件 API 按项目 Ant Design 6.7.2 本地 CLI 查询，沿用官方视觉语言与默认蓝色。

## 验证与独立环境回归

`test:backup` 使用独立数据库、临时目录和临时密钥：数据库与历史图片恢复、校验失败不修改当前数据、版本／实例／设备不符、磁盘空间预检、当前授权与水位保留、旧会话撤销、运行角色权限、进行中考试拒绝、各切换点故障回退、真实子进程崩溃和显式恢复；真实 Electron 覆盖普通权限拒绝、非法来源 IPC 拒绝、服务运行时拒绝、备份、预览／取消／确认和窄窗口。

测试通过依赖注入替代提升权限及原生目录选择，数据库导出／恢复工具、PostgreSQL、文件、生产业务模块和界面均实际执行。未提升本机权限、未修改开发账号、未注册服务。

独立环境仍需验收：提升权限和备份目录 ACL、真实目录选择及移动介质权限、服务身份恢复后的图片读取／任务处理、实际磁盘空间耗尽、恢复各阶段断电与 PostgreSQL 重启、HTTPS／局域网访问。旧批次验收不代表这些新增路径已验收。

## 本批验证记录

2026-11-26：build、typecheck、lint、format:check、27 项单元测试、test:backup、test:desktop、test:ui、test:integration、test:license-manager、test:attempts、package:win、test:package 通过。最后的核心回归另验证并发维护互斥、恢复命令不能抢占正在运行的维护、链接目录拒绝及真实 PNG 历史附件；graphify 已更新。

内部包 `artifacts/MetaExam-Setup-0.1.0-win-x64-internal.exe` 为 258,902,762 字节，SHA-256：`d1bb413aa4cef6fa1db578bd2b14d4c3c9ab32d3929c4816d4f1c2408ce5c2f5`。同名内部包按摘要区分批次，未正式签名。

payload 扫描 7,765 个文件和 19 个 Electron ASAR 条目，私钥、签发工具均为 0；19 类包内回归通过，包含打包后的备份模块与 PostgreSQL 工具实际导出、预检和恢复隔离数据，以及普通权限维护拒绝。没有在开发机安装 EXE 或执行服务注册、系统重启。
