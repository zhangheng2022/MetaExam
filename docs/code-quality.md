# GitHub 代码质量检查

## 自动执行

master 推送和 PR 运行两类工作流，也可在 Actions 中手动执行：

| 工作流            | 检查内容                                                         | 结果入口                            |
| ----------------- | ---------------------------------------------------------------- | ----------------------------------- |
| 项目检查          | CI 保护规则、构建、TypeScript、ESLint 零警告、Prettier、单元测试 | Actions 各独立步骤及 PR Checks      |
| CodeQL 质量与安全 | JavaScript/TypeScript 质量与安全、GitHub Actions 工作流安全      | Security → Code scanning 及 PR 检查 |

CodeQL 另在每周一北京时间 10:23（UTC 02:23）计划执行，实际开始时间可能受 GitHub 调度影响。同一分支或 PR 的新运行取消旧运行，不影响发版工作流。扫描采用官方 `security-and-quality` 查询套件，覆盖 Web、API、Worker、Electron、共享包及构建维护脚本中的 JavaScript/TypeScript；Actions 单独分析。不设置源码目录排除来隐藏现有问题。本次没有接入 C# 或 PowerShell 专用分析器。

沿用锁定 Node、pnpm、TypeScript、ESLint 和 Prettier。CodeQL 为静态扫描，不安装项目依赖、不执行产品构建；真实编译和单元测试由 Windows 项目检查完成。官方 Actions 固定完整提交 SHA，升级需审查上游版本和提交。检查任务不访问签名 Environment、私钥或业务数据；仅 CodeQL 分析 job 获得上传扫描结果所需的 `security-events: write`，不具有 Release 写权限。不使用 `pull_request_target` 执行 PR 代码。

## 处理检查结果

- 类型、Lint、格式、测试或构建失败，修复后重新提交；不能使用 `continue-on-error` 或跳过测试将失败改为通过。
- ESLint 在 CI 中要求零警告，沿用本地规则；本地复现使用 `./tools/run.ps1 exec eslint . --max-warnings 0`。
- CodeQL 分析成功表示扫描和结果上传完成，不表示没有告警。现有及新增问题在 Code scanning 中查看，结合实际数据流判断并修复，不批量忽略告警。
- 当前未修改分支保护、强制 PR 流程或配置强制合并检查；有检查结果不等于 GitHub 已禁止直接推送或合并。
- 使用公开仓库可用的 CodeQL Actions；没有开通单独计费的 GitHub Code Quality/AI 修复产品。

官方依据：[CodeQL 高级配置](https://docs.github.com/en/code-security/how-tos/find-and-fix-code-vulnerabilities/configure-code-scanning/configuring-advanced-setup-for-code-scanning)、[工作流配置](https://docs.github.com/en/code-security/reference/code-scanning/workflow-configuration-options)、[官方 Action](https://github.com/github/codeql-action)、[GitHub Code Quality 产品适用范围](https://docs.github.com/en/code-security/how-tos/maintain-quality-code/enable-code-quality)。
