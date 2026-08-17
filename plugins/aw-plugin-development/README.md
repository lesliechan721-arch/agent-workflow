# aw-plugin-development

为 `agent-workflows` 仓库提供插件作者和插件评审工作流。

## 什么时候使用

- 你要在本仓库创建或维护 `plugins/<name>/` 下的 AW 插件。
- 你要只读评审 AW 插件源码、最终制品、Eval 证据或发布就绪性。

不适用于仓库外的通用 Agent Skill 创建或评审，也不用于安装和使用现有插件。

## 包含的 Skills

| Skill | 用途 | 调用方式 |
| --- | --- | --- |
| `author-aw-plugin` | 创建或维护 AW 插件，并执行作者验证 | 仅 `$author-aw-plugin` |
| `review-aw-plugin` | 只读评审 AW 插件和发布证据 | 仅 `$review-aw-plugin` |

## 快速开始

先安装通用工具包，再安装本插件：

```bash
aw install agent-content-toolkit -p both -s user
aw install aw-plugin-development -p both -s user
```

示例请求：

- “使用 `$author-aw-plugin` 为这个仓库新增一个手动调用的发布检查 Skill。”
- “使用 `$review-aw-plugin` 评审 `plugins/git` 的源码、最终制品和现有证据，不修改文件。”

## 平台与安装范围

支持 Codex 和 Claude Code 的 user scope 与 project scope。当前需要同时安装 `agent-content-toolkit >= 0.1.0`；缺少所需通用 Skill 时工作流会停止并报告。

## 权限和边界

- `author-aw-plugin` 可以修改插件源码、提高插件版本、构建并运行确定性验证。
- `review-aw-plugin` 保持生产源码只读；正式报告发布和批次封存需要用户明确授权。
- Author 不给自己的结果出独立发布结论，Reviewer 不修改生产源码或 README。
- 真实模型证据目前只覆盖 Codex；Claude Code 只做确定性验证和 materialization。
