# M3 第三批：离线应用升级

当前客户 0.1.6／供应方 0.1.5 的系统范围与新增系统验收要求见 [Windows 兼容目标](windows-compatibility.md)。下文历史批次的版本与验收记录保持原意，不代表新增系统已验收。

## 0.1.23 网络转换

新包统一局域网 HTTP，无仅本机选项或证书页。原本机安装也转换为 `0.0.0.0`，原端口保留，网段默认 LocalSubnet；原 HTTPS 安装保留端口与配置网段。仅管理员维护读取器可以读取旧 TLS 配置，新业务进程遇到 TLS 字段报 `HTTP_CONFIGURATION_UPGRADE_REQUIRED`，须通过安装器转换。

转换在停服、备份、程序切换及迁移后，新服务启动前完成。受保护的 upgrades/repairs 工作目录保存 `http-network.json` 与 `http-config-before.json`，只允许原始或预期转换后的配置摘要，分别原子更新 config/public-config 并重建本安装防火墙规则；配置写入保留 ACL。旧版备份 CLI 通过原始配置快照校验备份，避免新 HTTP 配置导致续升级失败。失败保留 pending，继续使用同一 buildId；不要手动删除记录。证书文件不再引用，保留在数据目录。完整操作及验收见 [HTTP 部署说明](http-network.md)。

以下 0.1.2 等批次说明为历史协议与验收背景；0.1.23 不再要求保留 HTTPS 服务或重新导入 TLS 证书。安装器和管理器继续使用独立的 Authenticode 签名。

## 支持范围

当前 0.1.2 内部测试 EXE 支持从 M3 第二批、已具备 `BackupService` 的 0.1.0，以及原 0.1.1 安装版升级。更早的 0.1.0 包不支持直接升级。程序和 ProgramData 数据必须位于同一卷；本批不迁移目录，不升级 Node.js、PostgreSQL 或 WinSW，不提供自动降级。V1～V10 SQL 及校验和保持不变，本次没有新增迁移。原 0.1.1 交付验证记录保留在 m3-upgrade-status.md。

升级由 Inno Setup 提取临时完整载荷，再调用固定维护入口完成。已有安装不走首次安装、initdb、凭据生成或证书导入。仅替换 server、web、manager、maintenance、licenses；原 Node.js／PostgreSQL 文件逐项核对 SHA-256，服务路径、虚拟身份及 WinSW 二进制必须匹配本安装。保留配置、端口、HTTPS、DPAPI 凭据、授权公钥、安装实例、业务库和附件。

`release.json` 包含程序版本、迁移序列、文件 SHA-256 和 buildId；它用于检测缺失、改变和错包续升级。内部 EXE 尚未进行 Authenticode 签名，清单不提供发布者身份认证，应只使用交付的可信离线介质和对应 EXE 摘要。客户包不含授权私钥或签发工具。

## 安装环境操作

1. 安排没有进行中考试的维护窗口，记录当前版本、管理员登录、授权、题目图片、课程和成绩。完整保存现有安装和数据；保证程序与数据磁盘都有足够空间。
2. 从系统托盘选择“退出管理器”（仅关闭窗口会后台运行）。保持 PostgreSQL 服务运行；升级器检查服务归属，通过原 API 维护入口排空入场请求，再停止 API 和 Worker。存在进行中考试或有效答题时拒绝升级。
3. 在独立 Windows 11 x64 测试机以管理员身份运行 `MetaExam-Setup-0.1.2-win-x64-internal.exe`，选择原程序目录。安装器检测安装记录并跳过网络／证书配置页，不重新初始化数据库。
4. 升级器先调用旧版工具创建并校验完整数据库及历史附件备份，再保存旧程序，替换应用，使用维护身份执行有序迁移并恢复运行角色 DML 权限。
5. API、Worker 重启后先进入升级检查状态。健康接口可访问，业务接口返回 `503 UPGRADE_IN_PROGRESS`，Worker 只更新心跳。版本、迁移与心跳全部通过且成功记录已写入，才恢复业务。
6. 检查 `ProgramData\MetaExam\installation.json` 版本为 0.1.2；无 `upgrade-pending.json` 或 runtime 下的 `maintenance.json`；登录、授权、历史图片和成绩可用，再重启测试机验证自启。

正常开发继续使用 `tools/run.ps1 dev`；不能拿安装版升级器覆盖源码工作区。

## 中断与保留记录

升级工作目录为 `ProgramData\MetaExam\upgrades\<编号>`，包含完整 candidate、previous 旧程序、backups 完整备份和成功后的 result.json。目录限定 Administrators／SYSTEM 访问，备份包含密码摘要与试题答案，不自动删除。预检磁盘空间按程序体积估算，真实数据库与附件空间由备份工具另行检查；空间不足不能跳过备份。

`upgrade-pending.json` 记录 buildId、阶段和备份编号；`runtime/maintenance.json` 阻止普通连接进入文件切换及迁移窗口。程序复制、迁移或启动检查失败时保留标记、旧程序和备份，不自动恢复旧数据库、不自动启动旧业务。原有数据不因回退程序而被悄悄回滚。

升级记录原子替换前给 API／Worker 服务身份只读权限；文件权限或文件系统检查错误按“升级未完成”处理。完整工作目录仍只允许 Administrators／SYSTEM 访问。

失败后保留记录，查 `ProgramData\MetaExam\upgrade.log` 的错误码，修复磁盘／服务／权限等原因后**重新运行相同 buildId 的原 EXE**。升级器验证保留包和备份，并继续未完成阶段。不能用另一次构建的同版本包替代；不能删除标记、用管理器“回退中断维护”处理升级，或覆盖安装更旧版本。备份阶段失败时尚未替换程序，重试会重新创建备份。

旧版本备份继续由 previous/server 中的旧工具验证；新版管理器的同版本恢复不能直接导入旧版备份。本批没有通用跨版本回滚入口。迁移 SQL 失败或数据库损坏须保留现场排查；同包续升级不能修复所有数据库错误。

常见错误：`UPGRADE_CLOSE_MANAGER` 从系统托盘退出管理器；`EXAMS_ACTIVE` 等考试结束；`UPGRADE_SERVICE_OWNERSHIP` 核对服务归属；`UPGRADE_RUNTIME_INCOMPATIBLE` 核对原运行时，不能强行覆盖；`UPGRADE_RESUME_PACKAGE_REQUIRED` 使用原始 EXE；`UPGRADE_SAME_VOLUME_REQUIRED` 当前跨卷安装不在支持范围；`UPGRADE_START_FAILED` 排查服务日志与证书，修复后同包重试。

## 验证与独立环境回归

`test:upgrade` 使用独立数据库，不清空开发账号。流程测试对程序切换、迁移前、启动前、收尾阶段注入中断，验证保持维护状态及同包继续；覆盖包篡改、运行时不匹配、备份失败、启动失败和错误续包。程序包测试使用真实 0.1.0／0.1.1 后端、pg_dump 和普通进程验证升级及启动失败续升级，验证 API／Worker 门禁、任务恢复和业务／授权／配置保留。服务操作、提升权限和 ACL 使用测试适配器，不能代表安装环境验收。

默认 `test:upgrade` 使用 `artifacts/upgrade-baseline` 中原 M3 第二批 0.1.0 payload；设置 `METAEXAM_UPGRADE_BASELINE` 可选择另一个完整旧包。0.1.1 的原载荷保存在 `artifacts/upgrade-baseline-0.1.1`，须在构建新包前核验 release.json 全部摘要并完整复制。缺少、篡改或不比新包更旧的基线会明确失败。需要重建 0.1.0 基线时使用提交 4219053 的独立 checkout 和锁定工具链；不要用新版程序修改版本号伪造旧包。测试直接调用协调器和普通进程，未实际运行 Inno 安装向导。

以下项目全部留待独立环境，不能因普通进程测试通过而勾选：

- [ ] 断公网首次安装 0.1.2，三项服务、初始化和本地授权正常。
- [ ] 原 M3 第二批 0.1.0／原 0.1.1 安装分别原地升级；服务身份、DML 权限及维护目录 ACL 正确。
- [ ] 非管理员不能读取备份／所有者凭据或执行升级；API／Worker 可读新程序。
- [ ] 开着管理器、进行中考试、端口冲突、错误目录／运行时、空间不足均安全拒绝。
- [ ] 文件切换、迁移、启动检查期间中止升级进程后，同一 EXE 能继续；保留 Inno 和升级日志。
- [ ] 实际断电／系统重启中断后保持维护状态，不错误恢复业务；确认同包续升级。
- [ ] LAN HTTPS 原证书和 CA 信任保持有效，局域网登录、图片与成绩正常。
- [ ] 升级后重启自启；卸载移除服务与程序，保留数据库、备份及升级记录。
- [ ] Inno 安装失败／取消、卸载日志合并与快捷方式无异常；不得将测试适配器结果视为通过。

参考：[Inno Setup 事件](https://jrsoftware.org/inno-setup/documentation/topic_scriptevents.htm)、[脚本常量](https://jrsoftware.org/inno-setup/documentation/topic_scriptconstants.htm)、[PostgreSQL 18 升级说明](https://www.postgresql.org/docs/18/upgrading.html)。本批固定 PostgreSQL 二进制，未实施大版本数据库升级。

# 未完成的首次安装

客户 0.1.13 起，安装记录为 `phase=configuring` 时，安装器自动进入首次安装修复，正常 `installed` 记录仍走上述升级协议。从系统托盘退出管理器，选择原安装目录，直接运行新修复包即可。程序替换前先停止本产品服务，保存旧程序及数据冷副本到 `ProgramData\MetaExam\repairs\<ID>`；保留配置、DPAPI 凭据、公钥和已有 PostgreSQL 数据。配置或凭据缺失、归属不明、运行库或迁移清单不匹配时拒绝，不猜测密码或删除数据库。

修复中断保留 `upgrade-pending.json`（`kind=install-repair`），只能用相同 buildId 的包续跑。完成服务、API 版本、schema 和 Worker 心跳检查后才标记 installed、解除业务阻断。已有业务管理员不会被覆盖，不提供默认密码；Windows Administrator 密码也不属于安装器修改范围。详见 [修复与验收记录](install-repair.md)。
