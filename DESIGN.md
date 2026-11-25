---
name: MetaExam
description: 本地考试系统的运行状态与离线授权界面
colors:
  ink: '#202f39'
  muted: '#566570'
  background: '#f3f5f6'
  surface: '#ffffff'
  line: '#dce3e6'
  accent: '#176b5b'
  navigation: '#182e3c'
  navigation-current: '#294653'
  navigation-text: '#ecf3f5'
  good-background: '#e4f2ed'
  good-text: '#125d49'
  warning-background: '#faf0dc'
  warning-text: '#77500a'
  error-background: '#fff8f5'
  error-text: '#783c2a'
typography:
  headline:
    fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif'
    fontSize: '28px'
    fontWeight: 650
    letterSpacing: '-0.02em'
  title:
    fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif'
    fontSize: '18px'
    fontWeight: 650
  item-title:
    fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif'
    fontSize: '15px'
    fontWeight: 600
  body:
    fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif'
    fontSize: '14px'
    lineHeight: 1.7
  detail:
    fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif'
    fontSize: '13px'
    lineHeight: 1.7
  label:
    fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif'
    fontSize: '12px'
    fontWeight: 600
rounded:
  badge: '4px'
  control: '6px'
  panel: '10px'
spacing:
  compact: '12px'
  regular: '20px'
  roomy: '24px'
  section: '32px'
components:
  button:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.ink}'
    rounded: '{rounded.control}'
    padding: '10px 18px'
  navigation-current:
    backgroundColor: '{colors.navigation-current}'
    textColor: '{colors.navigation-text}'
    rounded: '{rounded.control}'
    padding: '12px 14px'
  status-good:
    backgroundColor: '{colors.good-background}'
    textColor: '{colors.good-text}'
    typography: '{typography.label}'
    rounded: '{rounded.badge}'
    padding: '6px 10px'
  status-warning:
    backgroundColor: '{colors.warning-background}'
    textColor: '{colors.warning-text}'
    typography: '{typography.label}'
    rounded: '{rounded.badge}'
    padding: '6px 10px'
  service-panel:
    backgroundColor: '{colors.surface}'
    rounded: '{rounded.panel}'
    padding: '26px 30px'
  error-notice:
    backgroundColor: '{colors.error-background}'
    textColor: '{colors.error-text}'
    rounded: '{rounded.control}'
    padding: '16px 20px'
---

# Design System: MetaExam

## Overview

延续现有运维界面基线：墨蓝导航、浅灰底、白色服务面板与克制的状态色，优先帮助本机维护人员读懂真实状态。网页与 Electron 复用同一组件和数据契约；字体与内联 SVG 标识无需联网加载。

本文从 `packages/ui/src/styles.css`、`packages/ui/src/index.tsx` 及本轮桌面、移动端、首次连接失败截图提取。未保存用户选定的 Creative North Star、FORM seed 或 QUALITY BAR，亦无批准的视觉稿；不补造这些承诺。

**Key Characteristics:**

- 状态文字明确，色彩辅助判断。
- 服务列表集中呈现，授权说明保持独立。
- 平面分层、细分隔线与适度圆角。
- 采用离线系统字体，不依赖栅格素材。

## Colors

主强调色为克制的青绿，用于交互边界；成功与警告各有浅底和深色文字。墨蓝承担导航识别，白色和浅灰区分内容面板与页面背景。正文使用 ink，说明和检查时间使用 muted，分隔使用 line。

**The 文字伴随状态 Rule.** 状态必须同时给出可读文字；成功、待检查和连接中断不能只靠颜色区分。

## Typography

全界面使用 frontmatter 中的离线字体栈。页面标题、区块标题、行标题、正文、说明和标签逐级缩小；不为此技术验证界面新增展示字体。窄屏页面标题降为（24px），按钮降为（13px）。正文最大行宽（72ch），服务说明使用较小字号；页脚时间采用等宽数字。

## Layout

宽屏采用（234px）侧栏与左对齐主内容，主内容最大宽度（1120px），内边距（50px 58px 30px）。顶部标题与检查按钮分列；服务行左侧为名称和说明，右侧为不换行的状态。授权区默认两列。

宽度不超过（850px）时侧栏缩至（200px）、内容内边距改为（34px 26px），授权区转为单列。宽度不超过（600px）时品牌成为顶部横栏，侧栏导航与附注隐藏；内容内边距为（28px 20px），页脚纵向排列，说明文字允许折行。保留服务名称与状态的并列关系。

## Elevation & Depth

当前实现无投影、渐变、模糊层或动画。层次由背景明度、白色服务面板和（1px）细线建立。授权区和技术阶段说明直接置于页面底色上，不套入额外面板。

## Shapes

服务面板使用 panel 圆角，按钮、当前导航项和错误提示使用 control 圆角，状态标签使用 badge 圆角。品牌使用内联线性 SVG；当前页面没有照片、插画或外部图标字体。

## Components

- **检查按钮：** 白底描边，最小高度（44px）。悬停时浅青灰填充并使用 accent 边框；键盘焦点为外置（3px）青绿轮廓，偏移（4px）。请求进行中禁用并显示“检查中…”，完成后恢复“重新检查”。
- **导航：** 墨蓝侧栏承载品牌链接；当前项为较亮墨蓝底，标记 `aria-current="page"`。当前导航项是静态文本，不伪装为可点击入口。
- **服务面板：** 白底细边框；标题右侧状态标签；服务行以横线分隔，避免嵌套卡片。
- **错误提示：** 置于面板上方，浅暖底配深暖文字和细边框，使用 `role="alert"`；检查按钮提供重试入口。
- **授权说明：** 展示真实授权状态、有效期及已返回的人数限制；不使用虚构考试指标。当前尚无授权导入表单。
- **检查时间：** 页脚使用 `aria-live="polite"` 更新最近成功检查时间；刷新失败不生成新的成功时间。

**The 未知状态 Rule.** 首次请求结束但失败时，考试服务显示“连接失败”，数据库、后台任务与授权显示“无法获取”，页脚显示“尚未获取检查结果”；不能把未知状态写成“未激活”或持续检查中。

**The 旧结果标识 Rule.** 已有成功结果后刷新失败，保留上次数据及其时间，同时显示连接中断与“以下为上次检查结果，可能已过时。”；不能把缓存结果呈现为新鲜结果。

首次加载显示等待检查与读取中；每（15秒）自动刷新。只有数据库 ready 且后台任务 online、并且当前没有请求错误，系统标签才显示“运行正常”。这些状态约定由实现决定，不代表净机部署或正式考试能力已经验收。

## Do's and Don'ts

- **Do** 用明确的文字区分加载、成功、异常、未知和过期结果。
- **Do** 保留离线字体、键盘焦点与移动端可读的服务行结构。
- **Do** 从真实返回值生成授权信息与检查时间。
- **Don't** 把首次连接失败表示为确定的授权或数据库结论。
- **Don't** 将当前技术验证界面写成正式考试功能已经开放。
- **Don't** 将缺失的视觉方向稿、FORM seed 或 QUALITY BAR 记录为已批准。
