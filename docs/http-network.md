# 0.1.23：局域网 HTTP 部署

客户服务统一通过 `http://服务器IP:端口` 访问，默认应用端口 3000。安装器不再提供仅本机模式、域名输入或 HTTPS 证书页面。API 监听 `0.0.0.0`；管理器固定使用 `http://127.0.0.1:端口`，PostgreSQL 继续仅监听回环地址，默认数据库端口 55432。

## 安装与访问

1. 在支持的独立 Windows 环境运行客户安装器，填写应用端口、允许访问网段和数据库端口。两个端口须不同；网段默认 `LocalSubnet`，可指定 IP、CIDR 或逗号分隔的地址范围。
2. 安装器为本安装的 Node 程序及应用端口创建 `MetaExam HTTP` 入站 TCP 规则，仅适用专用／域网络配置文件；不开放公共网络或数据库端口。这里的“域网络”是 Windows 防火墙分类，不是域名配置。
3. 本机管理器完成初始化后，其他电脑使用服务器实际 IPv4 地址及应用端口登录。修改网卡或 IP 后使用新的实际地址，无须签发证书。
4. HTTP 不加密密码、会话或答题流量，按可信内网部署。浏览器提示连接不安全是 HTTP 的预期行为；产品没有关闭浏览器安全校验或代理转发信任。

正式安装保持 `production=true`，不会信任 Vite 开发来源。登录会话继续存 PostgreSQL，只保存令牌摘要；Cookie 名为 `metaexam_http_session`，保持 HttpOnly、SameSite=Lax、Path=/，不带 Secure 或 Domain。初始化仍只允许回环请求及一次性令牌；CSRF、强制改密和角色／数据权限继续有效。

题目选项、填空及答题 mutationId 使用 `crypto.getRandomValues` 生成 UUID v4，不依赖局域网 HTTP 中不可用的 `crypto.randomUUID`。不引入线上服务或新依赖。

## 原安装升级、修复与重装

- 原仅本机 HTTP 安装也转换为局域网监听，保留端口，允许网段默认 LocalSubnet；原 HTTPS 安装保留原端口和配置网段。已有卸载记录中的网段及旧防火墙范围可作为恢复来源，非法网段拒绝执行。
- 正常升级在停服、备份、替换程序及数据库迁移后，新服务启动前转换配置；首次安装修复／保留数据重装在数据冷副本及程序替换后转换。禁止进行中考试时强停升级。
- 转换移除 `api.tlsCert`、`api.tlsKey`，统一 `api.host=0.0.0.0`、`production=true`；同时更新仅含端口的公开配置，替换匹配程序路径、端口、方向和协议的本产品防火墙规则。凭据、信任公钥、安装实例和业务数据不变。
- upgrades／repairs 的受保护工作目录保存原始配置及转换日志；写入配置时保留 ACL。中断后只接受原始或预期转换后的文件摘要，其他修改会拒绝续跑；旧版备份校验使用原始配置快照。失败保留 pending／维护状态，仅同一 buildId 可以继续，健康检查通过才放行业务。
- 升级后重新登录，并更新原 HTTPS 收藏地址为 HTTP。历史 TLS 证书文件不再引用但不主动删除。软件授权 Ed25519 公钥、离线验签、安装包 Authenticode 签名证书均继续保留。
- 新业务进程遇到旧 TLS 字段报 `HTTP_CONFIGURATION_UPGRADE_REQUIRED`；请通过安装器完成转换，不直接删除字段或维护标记。配置摘要异常报 `HTTP_CONFIGURATION_CHANGED`，保留现场排查；网段错误报 `HTTP_SUBNET_INVALID`。

## 验证范围

自动化入口：`test:http-network`、`test:m1`、`test:integration`、`test:questions`、`test:attempts`、`test:ui`、`test:desktop`、`test:diagnostics`、`test:backup`、`test:install-repair`、`test:upgrade` 和 `test:package`。

题库与答题浏览器检查使用测试专用来源 `http://metaexam-http.test` 映射回环服务器，并断言 `isSecureContext=false`，覆盖实际非安全来源行为；该域名仅供自动化测试，不进入产品配置。`test:http-network` 在普通权限进程中验证转换中断、配置篡改和实际 PowerShell 脚本的防火墙筛选逻辑，防火墙命令使用进程内替身，不修改开发机防火墙。

真实载荷升级默认用 `METAEXAM_UPGRADE_BASELINE` 指定保留的旧包；设置 `METAEXAM_UPGRADE_HTTPS=1` 额外启动旧版 HTTPS API，临时证书仅保存在测试目录，不进入系统证书库或客户包。校验旧证书使用显式 CA，不关闭 TLS 校验。

本机普通进程测试不代表以下独立环境项目已验收：

- [ ] 净机断网安装，界面没有模式／域名／证书配置；另一台电脑通过 IP + HTTP 登录、编辑题目、答题交卷及查询成绩。
- [ ] 原本机安装、原 HTTPS 安装升级；真实服务身份和 DPAPI／文件 ACL 正常，应用端口和网段保持预期。
- [ ] 允许网段能访问，其他网段及公共网络被阻止；数据库端口不对外开放；只移除本安装的旧规则。
- [ ] 配置／公开配置／防火墙转换及启动检查期间中断，重启后同包续跑；失败状态不放行业务。
- [ ] 未完成安装修复、卸载保留数据重装、系统重启自启及管理器普通／提升权限行为。

数据库保持 V10，Node／PostgreSQL／WinSW 版本不变。旧包与旧载荷保留；不能覆盖同版本 EXE 或用新程序伪造旧版本测试。
