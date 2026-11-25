---
name: MetaExam
description: 基于 Ant Design 默认视觉语言的账号中心与本地运行维护界面
colors:
  ink: 'rgba(0, 0, 0, 0.88)'
  muted: 'rgba(0, 0, 0, 0.65)'
  background: '#f5f5f5'
  surface: '#ffffff'
  line: '#dce3e6'
  accent: '#1677ff'
  accent-hover: '#4096ff'
  accent-active: '#0958d9'
  navigation: '#001529'
  navigation-current: '#1677ff'
  navigation-text: '#ecf3f5'
  brand-secondary: '#bed0d8'
  navigation-note: '#bfd0d8'
  logo: '#69b1ff'
  focus: '#1677ff'
  selection-background: '#bae0ff'
  selection-text: '#003eb3'
  good-text: '#176b5b'
  good-background: '#e4f2ed'
  good-border: '#b7d9ce'
  warning-background: '#faf0dc'
  warning-text: '#77500a'
  warning-border: '#e8d7b0'
  error: '#ff4d4f'
  error-background: '#fff2f0'
  error-border: '#ffccc7'
  info: '#1677ff'
  info-background: '#e6f4ff'
  info-border: '#91caff'
typography:
  page-title:
    fontSize: '24px'
    fontWeight: 600
  brand:
    fontSize: '20px'
    fontWeight: 600
  section-title:
    fontSize: '16px'
    fontWeight: 600
  headline:
    fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif'
    fontSize: '28px'
    fontWeight: 600
    letterSpacing: '-0.02em'
  title:
    fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif'
    fontSize: '18px'
    fontWeight: 600
  item-title:
    fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif'
    fontSize: '15px'
    fontWeight: 600
  body:
    fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif'
    fontSize: '14px'
    lineHeight: 1.5714285714285714
  detail:
    fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif'
    fontSize: '13px'
  label:
    fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif'
    fontSize: '12px'
rounded:
  tag: '4px'
  control: '6px'
  panel: '8px'
spacing:
  compact: '12px'
  regular: '20px'
  roomy: '24px'
  section: '32px'
components:
  button-primary:
    backgroundColor: '{colors.accent}'
    textColor: '{colors.surface}'
    rounded: '{rounded.control}'
    height: '44px'
  button-primary-hover:
    backgroundColor: '{colors.accent-hover}'
  button-primary-active:
    backgroundColor: '{colors.accent-active}'
  navigation-current:
    backgroundColor: '{colors.navigation-current}'
    textColor: '{colors.surface}'
    rounded: '{rounded.panel}'
  status-good:
    backgroundColor: '{colors.good-background}'
    textColor: '{colors.good-text}'
    typography: '{typography.label}'
    rounded: '{rounded.tag}'
  status-warning:
    backgroundColor: '{colors.warning-background}'
    textColor: '{colors.warning-text}'
    typography: '{typography.label}'
    rounded: '{rounded.tag}'
  service-panel:
    backgroundColor: '{colors.surface}'
    rounded: '{rounded.panel}'
    padding: '24px'
  error-notice:
    backgroundColor: '{colors.error-background}'
    textColor: '{colors.ink}'
    rounded: '{rounded.panel}'
  info-notice:
    backgroundColor: '{colors.info-background}'
    textColor: '{colors.ink}'
    rounded: '{rounded.panel}'
  license-description:
    textColor: '{colors.muted}'
    typography: '{typography.body}'
---

# Design System: MetaExam

## 账号中心视觉更新（2026-11-25）

视觉依据：[Ant Design design.md](https://ant.design/design.md)，本次通过终端 HTTPS 读取原文；组件 API 通过项目锁定的 Ant Design CLI 6.7.2 查询。以下当前规则优先于后面的运行状态页历史说明。

- 使用 Ant Design 默认浅色算法和蓝色主色，恢复默认功能色、文本色、背景和 32px 控件高度。登录及密码表单使用原生 large 尺寸（40px）；保留中文、离线系统字体与既有关闭动画配置。
- 业务区采用白色侧栏、浅蓝选中态、白色顶部栏及浅灰内容背景；运行诊断页保留原有深色侧栏。账号中心只展示已实现的个人信息和账号安全导航。
- 共享 ThemeSurface 通过 theme.useToken 将容器、页面、文字、分隔线和主色映射为 CSS 变量。自定义业务布局使用这些变量；不通过单独色值改写组件背景。Descriptions 标签使用次要文字色以保证可读性。
- 正文 14px，品牌 20px，页面标题 24px；字重 400/600。主要布局间距采用 8/16/24/32px，卡片与控件圆角沿用原生 Token。
- 登录采用独立品牌区、432px 表单容器和页脚。账号中心侧栏 224px、顶部栏 64px，内容最大 1440px；资料与安全分区展示，下方管理概览按需读取真实统计。
- 窄屏使用可打开的 Drawer 导航；资料区域转为单列。用户名截断可查看完整 title，资料长文本换行；支持跳转主要内容和明确焦点。
- 保留真实登录、退出、改密后撤销会话、503 重试及会话过期反馈。概览请求失败有错误说明，已有结果明确标为上次读取，不用零值代替未知统计。

验证与实现范围见 [UI 交付记录](docs/ui-ant-design.md)。未增加账号、班级、课程管理页或虚构统计，不代表 M1 第二批业务功能已完成。

## Overview

以下记录原有运行诊断页面的布局与实现，主题变更以文首当前规则为准。Web 与 Electron 通过 `packages/ui` 共享 Ant Design（6.7.2）；`MetaExamProvider` 使用 `ConfigProvider` 统一 `zhCN` 中文配置与主题。离线系统字体、内联 SVG 品牌与打包图标不依赖外部素材。

本文依据当前组件源码、样式和桌面、移动端截图更新。按用户选择采用 Ant Design 默认蓝色主题；没有新增或补造 Creative North Star、FORM seed、QUALITY BAR 或批准的视觉稿。

**Key Characteristics:**

- Ant Design 组件与统一中文主题。
- 默认深色导航与蓝色主操作，绿色独立表达成功状态。
- 状态文字明确，色彩辅助判断。
- 平面分层、细线与适度圆角，适配窄屏。

## Colors

默认蓝色 accent 用于主按钮；good-text 独立用于成功语义。navigation 系列用于默认深色侧栏及蓝色选中项，选中项文字为白色。surface、background 与 line 区分页面和服务面板；ink 用于正文，muted 同时用于次要文字、说明和授权标签。

成功、警告底色和边框由共享主题设置；错误与信息提示采用当前 Ant Design 默认语义色。蓝色同时承担主操作、导航选中与信息提示。logo 使用浅蓝品牌线条色；selection 系列用于文字选中，focus 用于键盘轮廓。悬停、按下色来自当前主题算法。

**The 文字伴随状态 Rule.** 状态必须同时给出可读文字；成功、待检查和连接中断不能只靠颜色区分。

## Typography

使用 frontmatter 的系统字体栈及 Ant Design `Typography`。页面标题、区块标题、服务名称分别采用 headline、title、item-title；服务说明为 detail，标签与页脚为 label。标题字重来自 Ant Design，品牌单独使用（650）。窄屏页面标题降为（24px），按钮为（13px）。页脚使用等宽数字。

## Layout

宽屏侧栏（234px），内容区最大宽度（1120px）、内边距（50px 58px 30px）。标题与检查按钮分列；Card 内服务行左侧为名称和说明，右侧 Tag 不换行。授权区两列，间距（32px）。

宽度不超过（850px）：侧栏（200px），内容内边距（34px 26px），授权区改为单列。宽度不超过（600px）：品牌改为顶部横栏，隐藏导航与侧栏附注；内容内边距（28px 20px），Card 头部及正文内边距（20px），页脚纵向排列。说明允许换行，保留服务与状态并列关系。

## Elevation & Depth

当前服务 Card 未启用悬浮效果，主按钮恢复 Ant Design 默认轻投影（`0 2px 0 rgba(5,145,255,0.1)`）；以浅灰页面、白色面板、语义浅底和细边框建立层次。共享主题设置 `motion: false`。授权说明直接位于页面底色，技术阶段说明使用信息 Alert。

## Shapes

control 用于按钮，panel 用于 Card 与 Alert，tag 用于状态标签。边框细而克制。品牌为线性内联 SVG，Ant Design 图标随应用打包；当前无栅格素材。

## Components

- **Button：** 检查操作使用 `type="primary"` 与 `ReloadOutlined`，默认蓝底白字，高度（44px）；悬停、按下采用主题派生色。请求中同时设置 `loading` 和 `disabled`，文案为“检查中…”。链接与按钮键盘焦点为（3px）focus 轮廓，偏移（4px）。
- **Menu：** 采用默认深色 `inline` 菜单，选中背景为 navigation-current、文字为白色；当前项含 `DashboardOutlined` 和指向服务标题的锚点，保留 `aria-current="page"`。窄屏隐藏该菜单。
- **Card：** 系统服务集中在单张白底卡片；标题区与正文分隔，标题右侧为总状态 Tag，正文默认内边距（24px）。服务行间细线分隔，不新增嵌套卡片。
- **Tag：** 使用 success、warning、error、default 语义状态，沿用 Ant Design 填充样式、字号和内边距；用于只读状态，无交互伪装。成功色使用 good-text，警告色使用 warning-text。
- **Alert：** 连接失败使用 error、`showIcon` 与 `role="alert"`；历史数据存在时补充过时说明。技术验证说明使用 info、`showIcon` 与 `role="note"`。
- **Descriptions：** 授权信息为 `size="small"`、单列描述列表；标签显式采用 muted。仅有效授权展示真实有效期与并发人数。当前没有授权导入表单。
- **Typography：** Title、Paragraph、Text 统一标题与说明层级；检查时间通过 `aria-live="polite"` 更新，刷新失败保留上次成功时间。

**The 未知状态 Rule.** 首次请求结束但失败时，考试服务显示“连接失败”，数据库、后台任务与授权显示“无法获取”，页脚显示“尚未获取检查结果”；不能把未知状态写成“未激活”或持续检查中。

**The 旧结果标识 Rule.** 已有成功结果后刷新失败，保留上次数据及其时间，同时显示连接中断与“以下为上次检查结果，可能已过时。”；不能把缓存结果呈现为新鲜结果。

每（15秒）自动刷新。数据库 ready、后台任务 online 且无请求错误时，总状态才显示“运行正常”；这不代表正式考试或净机部署已验收。

## Do's and Don'ts

- **Do** 通过 MetaExamProvider 复用中文配置与共享主题。
- **Do** 保留离线字体、键盘焦点与移动端可读的服务行结构。
- **Do** 用明确文字区分加载、成功、异常、未知和过期结果。
- **Don't** 用虚构数据或确定结论填补无法获取的状态。
- **Don't** 将当前技术验证界面描述为正式考试功能已开放。
- **Don't** 将缺失的视觉方向稿、FORM seed 或 QUALITY BAR 记录为已批准。
