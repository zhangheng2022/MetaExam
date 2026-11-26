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

## M2 第七批成绩统计与导出界面（2026-11-26）

已发布成绩的阅卷页显示“成绩统计与导出”入口，沿用考试导航、共享组件与 Ant Design 默认蓝色。顶部集中放刷新与导出，下面依次展示筛选表单、全场 Statistic、Progress 分布、分页成绩名单与逐题统计。合格比例只是分析参数；文字明确说明全场统计不随名单筛选变化。缺考显示“—”，实考零分显示 0；无人实考时不编造均分或合格率。

用户名／姓名、状态、排序和比例经“应用筛选”后写入 URL；有尚未应用的修改时提示并禁用导出。导出确认说明下载所有匹配记录及全场统计，包含当前人数和合格比例；进行中防重复，失败支持重试。读取失败收起旧统计并禁用导出，名单空态与错误独立处理；手机表单换行，表格仅在容器内横向滚动。学生不能进入该页。验收见 [成绩统计与导出](docs/m2-reports.md)。

## M2 第六批阅卷与成绩界面（2026-11-25）

遵循 Ant Design 官方 design.md，保持默认蓝色和共享组件。考试详情增加“阅卷与成绩”，顶部集中显示发布状态、满分、考试截止及真实人数；下方考生表按用户名／姓名搜索分页，区分未入场、作答中、待评分、已评完。发布前明确规则、缺考口径与不可撤回，发布按钮仅在服务器返回满足条件时启用，确认操作带整体版本校验。

阅卷采用适配视口的 880px Drawer，一次呈现一道冻结题目、参考答案、解析、受控图片与考生答案；简答使用 InputNumber 和 TextArea，分数步长 0.5、评语明确发布后学生可见。待评与零分分别显示。换题、刷新、关闭抽屉遇未保存评分需确认丢弃，保存中禁用切换。失败保留输入，冲突通过显式重新读取处理，不悄悄覆盖。发布后仅只读展示，学生端单独使用成绩页：未发布提示、缺考提示或本人总分／逐题得分／公开评语，不显示标准答案。读取失败收起旧成绩并提供重试，窄屏表格局部滚动、表单保持可读。人工验收见 [阅卷与成绩说明](docs/m2-grading.md)。

## M2 第五批考生答题界面（2026-11-25）

依据 Ant Design 官方 design.md，沿用默认蓝色与共享组件。“我的考试”在可入场时提供确认操作，有记录后显示继续答题或交卷回执。答题页使用考试标题、带文字倒计时、已保存填写数量与可换行题号导航；当前题以主色标记，填写状态附勾号。一次呈现一道题，单选／判断使用 Radio，多选使用 Checkbox，填空使用有明确标签的 Input，简答使用 TextArea。正文和“你的答案”标签继承统一字号，使用 4px 间距体系。

自动保存、保存中、失败待重试和已保存均有文字反馈；失败时保留当前输入，不能把未确认写入的数据显示成已保存。换题和交卷先保存；多页面冲突禁止静默覆盖，重新读取前确认丢弃本页修改。截止状态由服务器确认；交卷需确认已填写数量，回执只展示考试、收卷方式和时间，不提前展示答案、分数或解析。窄屏保留题号换行及全宽输入，题图同源鉴权。刷新只恢复服务器已保存内容，断线提示保持页面打开。范围和限制见 [答题会话说明](docs/m2-attempts.md)。

## M2 第四批考试安排界面（2026-11-25）

继续使用 Ant Design 默认蓝色和共享组件。管理员／教师增加“考试管理”，学生按权限显示“我的考试”。考试列表支持名称／状态筛选、分页和刷新；状态区分草稿、待开考、考试时间内、已结束和已取消，不将时间窗口状态当成实际答题进度。680px 编辑抽屉使用冻结试卷选择、可搜索分页多班选择、北京时间输入和答题分钟数；同名试卷用冻结版本短号辅助区分。

详情集中显示试卷、时间和名单数量，下方独立考生表；发布前强调核对与不可修改，发布需确认。发布成功显示只读状态、发布时授权容量与到期时间；开考前提供取消原因表单，不提供恢复按钮。未激活发布错误保留操作上下文，可维护授权后重试；详情重新读取失败时收起旧详情并提供重试。学生列表只含本人考试安排与取消原因，无预览答案或名单入口；第五批增加入场与答题入口。窄屏采用抽屉导航和表格内部横向滚动。完整范围见 [考试发布说明](docs/m2-exams.md)。

## M2 第三批组卷界面（2026-11-25）

沿用 Ant Design 默认蓝色和共享组件。管理员／教师增加“试卷管理”，列表提供名称搜索、状态筛选、分页与真实课程、创建人、题数和总分。新建时选定课程；详情上方放名称、说明、状态和题目表。手动选题采用 960px 抽屉、服务端搜索分页与跨页多选；条件抽题采用表单抽屉，明确匹配条件、数量不足整批失败及上限。分值使用 InputNumber，顺序通过上移／下移调整。

操作分组紧邻排列：空卷突出选题、有未保存修改突出保存、已保存非空草稿突出冻结。未保存状态给出警告并禁用选题、抽题、预览和冻结；返回列表确认丢弃，关闭／刷新浏览器提醒。教师预览为 880px 抽屉，每页 5 题，明确包含答案和解析；窄屏适应视口，表格局部滚动。冻结需二次确认，成功显示只读状态与冻结标识，保留预览和“复制为新草稿”，不提供解冻按钮。选入版本和题目当前版本分开显示，不自动替换。所有页面具备加载、错误、重试、空态及权限提示，不显示未实现的考试发布入口。范围与人工验收见 [组卷与冻结说明](docs/m2-papers.md)。

## M2 第一批题库界面（2026-11-25）

第二批扩展：题库详情增加“Excel 导入与记录”，1040px 抽屉提供模板下载、上传、历史、预检行预览和显式确认；上传不自动入库。重复策略默认跳过，有错误禁用确认。后台状态以文字显示，读取失败显示旧数据提示及重试，关闭抽屉不取消后台任务。窄屏抽屉适应视口，表格局部横向滚动。题目编辑最多 6 张图片，提供说明和移除；保存前上传完成，历史预览按版本显示图片；读取失败有说明和重试。所有附件请求同源鉴权，不加载外部图床。继续使用默认蓝色、共享 Upload／Alert／Table／Drawer。第二批范围及验收见 [导入与图片说明](docs/m2-imports.md)。

继续采用 Ant Design 默认蓝色与原生组件。管理员／教师按权限显示“题库管理”。题库和题目列表支持 URL 筛选、分页、加载、空态及重试；720px 编辑抽屉按题型呈现选项或空位，切换题型前确认清空答案；800px 历史抽屉展示版本列表和纯文本预览，窄屏适应视口。保存生成新版本，冲突要求重新加载。学生无题库入口，教师公共题库显示只读状态；不展示未实现的导入和考试按钮。官方视觉语言通过锁定 CLI 的 design.md 阅读，API 按 6.7.2 元数据核对。范围见 [M2 题库说明](docs/m2-questions.md)。

## M1 第二批管理界面（2026-11-25）

延续下方 Ant Design 默认浅色业务布局。侧栏按权限增加工作台、账号、班级、课程、授课安排和操作日志；强制改密时仅保留账号安全。管理列表使用原生 Table、URL 搜索/筛选/分页、Drawer 编辑；Form 实例设置不同 name，避免标签与同名字段冲突。关联选择使用服务端搜索和分页，保存前显示教师、课程、班级的实际名称。列表错误保留旧结果并标记可能过时；编辑冲突要求重新加载；移除关系使用明确确认。

教师与学生工作台只展示本人关系；新账号必须改密后才能进入。管理统计来自数据库，不加入考试图表或未实现入口。窄屏保持可打开的导航和表格内部滚动；所有时间展示使用北京时间。实现与验证记录见 [M1 第二批交付说明](docs/m1-management.md)。

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

考生作答页在考试卡片内、截止时间与题号导航前展示冻结试卷的“作答说明”。使用 Typography 五级标题与正文，保留换行并按纯文本显示；不解析 HTML。说明为空时不显示空标题，刷新及 API 重启后仍读取入场所引用的冻结版本。

- **Do** 通过 MetaExamProvider 复用中文配置与共享主题。
- **Do** 保留离线字体、键盘焦点与移动端可读的服务行结构。
- **Do** 用明确文字区分加载、成功、异常、未知和过期结果。
- **Don't** 用虚构数据或确定结论填补无法获取的状态。
- **Don't** 将当前技术验证界面描述为正式考试功能已开放。
- **Don't** 将缺失的视觉方向稿、FORM seed 或 QUALITY BAR 记录为已批准。
