# 元考 / MetaExam 品牌接入

2026-11-27：中文品牌名为“元考”，英文品牌名为 MetaExam。图形采用蓝色书页、M 与勾选组合。共享组件见 `packages/ui/src/brand.tsx`；字标使用真实文本与 Ant Design Token，图形不重复参与屏幕阅读器朗读。

## 接入位置

登录页、业务导航、运行概览、Electron 本地管理器、供应方签发器复用共享品牌组件。浏览器标签页、Electron 窗口、EXE 和安装程序使用 `packages/ui/public/brand/icon.ico`，含 16、24、32、48、64、128、256 像素图层；界面使用同目录 256px 透明 PNG。三端 Vite 使用同一资源目录，无外部资源请求。

构建器通过 `win.icon` 写入 EXE 资源，`signExecutable: false` 仅关闭构建器自带签名；已有构建脚本随后执行强制 Authenticode 签名与核验。未关闭或降级产品签名要求。原协议名称、数据路径、AppId 和程序文件名保持兼容。

## 本地验证

客户 0.1.7、供应方 0.1.6；旧版 EXE 和 SHA256 保留。

- build、typecheck、lint、format:check 通过。
- test:ui 通过，检查图形解码、中文品牌、favicon、1440px 与 390px 登录布局；测试改用独立数据库，不依赖开发库初始化状态。
- test:desktop、test:integration、test:web-dev、test:compatibility 通过。
- 签发器真实 Electron 界面测试通过。
- package:win、package:issuer、test:package、test:issuer:package 通过。
- `tests/signing.mjs --packages` 通过，覆盖两种安装器、程序签名与篡改拒绝；从客户 EXE 提取图标并确认新图形。
- graphify update 已执行。

本次未执行目标 Windows 系统真实安装／升级、快捷方式缓存刷新、真实 DPI、提升权限 ACL、服务与重启回归；这些仍在独立环境验收。生产信任配置交付及远程发布不在本次范围。
