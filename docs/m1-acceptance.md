# M1 第一批：初始化与登录验收

实现范围：V1→V3 迁移、账号和组织关系基础、Electron 首次管理员初始化、本地 Cookie 登录/个人信息/改密/退出。无默认账号或密码。账号/组织管理页面、忘记密码、题库和考试不在本批。

当前状态：2026-11-25 用户已确认本机功能验收完成，截图显示管理员已登录个人信息页。确认记录见 [M1 交付记录](m1-status.md)。下方独立环境清单仍待验收。

## 开发启动与初始化

```powershell
./tools/run.ps1 build
./tools/run.ps1 db:start
./tools/run.ps1 db:migrate
./tools/run.ps1 dev
```

`dev` 自动启动 API、Worker、Vite 和普通权限 Electron。浏览器开发地址为 `http://127.0.0.1:5173/login`，API 静态页面为 `http://127.0.0.1:3000/login`，本机诊断页为 `/status`。后台端口仍为 API 3000、PostgreSQL 55432。

首次初始化时，保持后台运行，关闭普通权限 Electron，在**以管理员身份打开的 PowerShell**中进入项目目录执行：

```powershell
$env:METAEXAM_CONFIG = (Resolve-Path .local/config.json).Path
$env:METAEXAM_WEB_PORT = '5173'
./tools/run.ps1 --filter @metaexam/desktop start
```

若 PowerShell 的执行策略禁止运行 `.ps1`，保留上面的环境变量，直接调用项目 Node.js 启动客户端，无需修改执行策略：

```powershell
& .\.tools\node\node.exe .\.tools\pnpm\node_modules\pnpm\bin\pnpm.cjs --filter @metaexam/desktop start
```

填写用户名、姓名、密码和确认密码。客户端主进程自动生成/读取受限令牌；完成后关闭提升权限的客户端，后续普通权限启动即可。管理员创建一次后不能再次初始化；未激活授权不阻止此流程。

手动换发尚未消费的初始化令牌（管理员终端）：`./tools/run.ps1 setup:token`。原令牌失效；命令不输出原文。开发令牌在 `.local/bootstrap/token.json`，安装版在数据根目录的 `runtime/bootstrap/token.json`。不应手工放宽 ACL 或把文件内容粘贴到浏览器。

## 配置与行为

配置在 `METAEXAM_CONFIG` 指定的 JSON，开发默认 `.local/config.json`。新增可选配置：

```json
{
  "api": { "webPort": 5173 },
  "auth": { "hashConcurrency": 2, "hashQueue": 8, "accountLimit": 10, "ipLimit": 60 }
}
```

以上是增量示例，合并到原配置，不替换数据库、端口、管理令牌等原字段。`METAEXAM_WEB_PORT` 优先于 `api.webPort`，同时用于 Vite 启动和开发 CSRF 来源。生产不允许跨源 Cookie 写操作。

- 用户名去空白并转小写，3～64 位 ASCII 字母、数字、点、下划线、连字符；密码 12～128 字符，不去空白。
- 官方 scrypt 默认成本，随机盐；最多 2 个计算同时运行，队列上限 8，超限 429。
- IP 每分钟 60 次、IP+账号每 15 分钟 10 次，登录和改密共用计数；成功请求也计数。计数保存 PostgreSQL。
- 会话最长 8 小时、空闲 30 分钟；每次有效认证记录活动。仅 Cookie 原文，数据库存 SHA-256 摘要，按官方包使用 base64url 编码。
- 生产 HTTPS 的 Cookie 为 `__Host-sid`、Secure、HttpOnly、SameSite=Lax；仅明确回环 HTTP 开发模式使用非 Secure `sid`。
- 改密在同一事务内更新凭据版本并删除所有会话；创建会话锁定凭据并复核版本，避免旧密码并发登录穿过撤销。
- 浏览器不保存 Cookie/令牌到 localStorage；401 清除身份缓存，503 展示重试且保留身份。角色/停用状态每次从数据库读取。
- 健康检查只检查数据库迁移就绪，不要求管理员已创建；`initialized` 仍表示数据库就绪，新增 `adminInitialized` 表示管理员初始化。
- `setup/status` 公开最小状态；初始化写操作同时要求回环地址和一次性令牌。业务会话不能代替独立的本机管理令牌。

## 已有安装版升级路径

**此流程尚需独立环境验证。** 不支持直接覆盖安装。保留原安装器对已有数据库的保护；升级前备份完整数据及程序、停止 API/Worker，只让数据库普通进程或数据库服务运行。维护身份执行迁移，不能让运行账号执行 DDL。

在独立环境的管理员终端、已部署匹配版本程序后，设置安装版配置路径并运行：

```powershell
$env:METAEXAM_CONFIG = 'C:\ProgramData\MetaExam\config.json'
& 'C:\Program Files\MetaExam\runtime\node.exe' 'C:\Program Files\MetaExam\server\cli.cjs' migrate-installed
```

实际安装目录按安装记录替换。命令仅在安装版 `metaexam_app` 配置下读取受限 `owner.dpapi`，以维护账号执行 V1→V3 并显式授权新表；不会重新 initdb。成功后启动 API/Worker 并检查 `/health/ready` 的 schemaVersion=3。失败停止升级，按已验证的备份恢复流程恢复；不得改迁移校验和或删除迁移记录。

V1 SQL 保持原字节与 SHA-256。每个版本独立事务，同一连接持有迁移咨询锁。已成功版本不会重跑；缺版本、校验和错误或更高版本会拒绝启动就绪。API/Worker 启动不迁移。PostgreSQL 服务仅新数据库自动执行迁移，已有数据库不自动升级。

## 本机自动验证

运行 `./tools/run.ps1 test:m1`（先 build 和 db:start），为每个测试创建随机名称 `metaexam_test_*` 数据库，结束仅清理自建库；不会创建开发管理员或清空开发账号。测试需要开发数据库维护权限。桌面普通权限测试应在非提升权限终端运行。

| 测试              | 覆盖                                                                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| migrations.mts    | V1 字节和数据保留、并发/重复迁移、部分失败回滚、缺版本/校验和/高版本拒绝                                                                 |
| identity.mts      | 令牌过期/错误/并发/重放、事务失败保留令牌、权限种子、凭据版本、限流与脱敏审计                                                            |
| setup.mts         | 真实 HTTP 初始化、远程调用与跨站拒绝、真实默认 scrypt、规范化用户名                                                                      |
| auth.mts          | 真实登录、Cookie 摘要、API 重建持久化、角色变更、停用、会话替换、退出、可控时钟的绝对/空闲超时、改密撤销、多端、重启限流、数据库异常 503 |
| storage.mts       | 会话并发删除/单调活动时间/不复活、旧凭据拒绝、计算队列上限、隔离运行角色 DML 成功及 DDL/迁移表修改拒绝                                   |
| desktop-setup.mts | 真实 Electron 表单、受限 IPC 方法、普通权限拒绝、窗口退出后 API 存活                                                                     |
| auth-ui.mts       | 真实浏览器登录/刷新/管理概览/改密/退出、模拟 503 界面恢复、会话失效、移动端、默认蓝色                                                    |

原有 `test`、`test:integration`、`test:ui`、`test:dev`、`test:package` 继续运行。`test:dev` 临时修改源文件，需独占执行。旧状态页 UI 回归已改为 `/status`；完整开发监听测试的 API 探针改为拆分后的 system 模块。

## 独立环境待验收（不计为本机已通过）

- [ ] 净机断网安装内部 EXE，三项服务注册、自动启动及卸载保留数据。
- [ ] 提升权限 Electron 自动生成/读取令牌、创建首个管理员、清理令牌并打开浏览器登录；两个提升权限窗口只能成功一次。
- [ ] 标准用户与管理员未提升令牌均不能读取 bootstrap 文件；Admins 提升权限和 SYSTEM 可读取。检查新建文件和父目录 DACL、继承、失败重试及文件残留。
- [ ] 有效期超过 30 分钟自动换发，旧文件重放失败；初始化完成后换发也失败。
- [ ] 生产 HTTPS 证书信任、127.0.0.1 SAN、局域网浏览器访问和 Secure Cookie；跨站登录/写操作拒绝。
- [ ] Windows 重启后 PostgreSQL/API/Worker 自动启动，会话和管理员持久化；关闭桌面仍可浏览器登录。
- [ ] V1 已安装数据备份升级到 V3，授权历史和任务保留；恢复失败升级的备份演练。

M0 保持待独立验收；本批不能据本机普通进程测试宣称正式发布或净机安装完成。内部包未正式签名，不含生产签名证书、签发工具、测试账号、私钥或初始化令牌。
