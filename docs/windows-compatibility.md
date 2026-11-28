# Windows 安装与运行兼容目标

> 0.1.23 起统一局域网 HTTP，不再配置仅本机模式、域名或 HTTPS 证书。当前网络操作和回归以 [HTTP 部署说明](http-network.md) 为准；下文旧批次 HTTPS 记录保留历史含义，不作为新版验收结论。

从客户 0.1.6、供应方签发器 0.1.5 起，两种安装包采用以下统一目标。目标表示安装器允许的系统范围，不等于所有系统已经完成实机验收；本批结果见仓库中的 `docs/windows-compatibility-validation.md`。原有 M0/M1 验收不自动延伸至新增系统或新包。

| 系统                | 版本与架构                             | 安装类型             |
| ------------------- | -------------------------------------- | -------------------- |
| Windows 10          | 22H2，build 19045，原生 x64            | Client               |
| Windows 11          | 保留 build 22000 及以上的原生 x64 范围 | Client               |
| Windows Server 2022 | build 20348，原生 x64                  | 带桌面体验（Server） |
| Windows Server 2025 | build 26100，原生 x64                  | 带桌面体验（Server） |

累积补丁不改变上述基础 build 判定。Windows 10 更早版本、Server 2019/2016、其他服务器 build、Server Core（包括安装 App Compatibility FOD 的 Core）、ARM64 模拟运行、32 位和无法确认的系统均不支持。此范围仅用于安装与运行，不改变 Web 浏览器目标，也不声明所有 Windows SKU、域策略或未来版本均已验证。

## 安装检查

两个安装器共用 `installer/windows-compatibility.iss`，在 `InitializeSetup` 检查 Windows 版本、产品类型、原生架构及 64 位系统注册表 `InstallationType`。服务器必须为 `Server`；缺失、读取失败或未知值拒绝，不能靠检测某个 GUI 可执行文件判定桌面体验。系统产品类型使用系统 API，不解析本地化产品名称。

不支持时，在复制业务文件、运行 VC++ 安装器或修改服务之前退出；交互模式显示原因，`/VERYSILENT /SUPPRESSMSGBOXES /LOG=<日志路径>` 同样失败并在日志中记录固定错误分类。初始化检查拒绝的退出码为 1；Inno 原生系统／架构前置检查也会非零退出。生产安装器没有模拟系统或跳过检查的参数。卸载不增加此检查，以免妨碍已有安装的清理。

客户安装仍要求管理员，程序与数据分目录，服务使用既有虚拟账户；供应方仍按普通用户安装，不安装服务或客户 PostgreSQL。不自动启用桌面体验、修改安全策略或安装额外在线依赖。

## 锁定依赖与支持边界

保持 Node.js 24.22.3、PostgreSQL 18.7-1、Electron 45.5.0、WinSW 2.14.0（NET462）和 Inno Setup 6.7.4，不降级或升级技术栈。现有 Windows PowerShell/CIM、服务管理、ACL 与 .NET 运行条件需在实际系统确认。

- [Node.js 24 支持说明](https://github.com/nodejs/node/blob/v24.x/BUILDING.md)列出 Windows 10/Server 2016 及以上 x64，同时明确不支持已结束厂商支持的系统。Windows 10 22H2 是项目兼容目标，不等于获得全部依赖的上游支持；操作系统维护与安全更新由部署方管理。
- [PostgreSQL 官方 Windows 下载页](https://www.postgresql.org/download/windows/)列出 PostgreSQL 18 的 EDB 测试平台为 Server 2022/2025，并说明同类桌面系统通常可运行；桌面目标仍需本项目实测。
- [Electron 兼容变更说明](https://www.electronjs.org/docs/latest/breaking-changes)说明 Electron 23 起要求 Windows 10 或更高；这一最低条件不替代锁定 Electron 版本在目标系统上的实际验证。
- 版本／架构识别依据 [GetWindowsVersionEx](https://jrsoftware.org/inno-setup/documentation/topic_isxfunc_getwindowsversionex.htm) 和 [ProcessorArchitecture](https://jrsoftware.org/inno-setup/documentation/topic_isxfunc_processorarchitecture.htm)；服务器 GUI 边界见 [Microsoft 安装选项](https://learn.microsoft.com/en-us/windows-server/get-started/install-options-server-core-desktop-experience)。

## 回归与独立验收

`./tools/run.ps1 test:compatibility` 用锁定 Inno 编译独立测试安装器，执行产品共用 Pascal 判断，覆盖允许／拒绝边界、真实开发机只读识别、静默拒绝与拒绝后无文件复制。测试只在 artifacts 下写自己的探针文件，不安装产品、修改服务或写系统注册表。两条打包链都会执行此检查；它不能替代目标系统实机测试。

分别准备四类目标系统的可还原独立环境，禁止在开发机做服务安装测试。逐项记录操作系统版本/版本号/架构/安装类型、包版本、SHA256、时间、结果及失败原因：

1. 客户断网净机安装、UAC 与普通权限拒绝、程序/数据 ACL、三项服务启动及重启自启、VC++/.NET 运行条件。
2. 初始化、登录、真实设备指纹、授权导入及重启验签；LAN HTTPS、学生入场、保存、交卷和成绩流程。
3. 停止 API/Worker 后备份恢复，保留附件、授权与可信水位；诊断导出、卸载保留数据和重新安装。
4. 供应方普通用户安装、Electron 打开、临时密钥签发、重新导出字节一致、SQLite 台账跨重启/升级/卸载保留，以及客户侧导入；不得用正式私钥测试。
5. 对已有系统使用真实旧包做中断续升级，保留配置、公钥、数据与历史附件。旧客户包的 Windows 11 限制使其无法正常安装到部分新增系统，这些系统先做新安装，不伪造旧版本或绕过旧安装器。今后再用真实支持该系统的旧包回归升级。
6. 在独立的不支持系统上运行交互和静默安装，确认非零退出、日志原因以及没有业务文件、运行库或服务变更。

签名和证书信任按 `docs/code-signing.md` 验证，自签名通过不等于系统已信任。开发机只执行普通进程、隔离数据库和包内容回归；独立环境未提供时保留待验收状态。
