# 当前项目的插件契约

这份摘要只保留创建插件时反复会用到的约束。细节和推导过程来自：

- `docs/codex-plugins.md`
- `docs/codex-claude-code-extension-research.md`
- `docs/codex-claude-plugin-marketplace-research.md`
- `docs/dev/plans/project-init.md`
- `packages/cli/src/utils/manifest.ts`

## 仓库结构

新插件放在 `plugins/<name>/`，最小稳定结构如下：

```text
plugins/<name>/
├── .agents-plugin/
│   └── plugin.json
├── .claude-plugin/
│   └── plugin.json
├── .codex-plugin/
│   └── plugin.json
└── skills/
    └── <skill-name>/
        ├── SKILL.md
        └── agents/
            └── openai.yaml
```

根目录的 marketplace 入口也有两份：

- `.claude-plugin/marketplace.json`
- `.agents/plugins/marketplace.json`

这两份内容应保持同步。

## 唯一源 manifest

当前项目把 `plugins/<name>/.agents-plugin/plugin.json` 视为唯一源 manifest。

创建或修改插件时，先改这份文件，再同步：

- `.claude-plugin/plugin.json`
- `.codex-plugin/plugin.json`

如果平台产物和 source manifest 分叉，Claude Code 与 Codex 看到的能力面会漂移。

## 共享字段约束

共享字段遵循 Codex 可解析的最窄子集：

- `skills` 使用单个字符串路径，例如 `./skills`
- `mcpServers` 使用单个字符串路径，例如 `./.mcp.json`
- `apps` 如需共用，也按单个字符串路径处理
- 路径必须以 `./` 开头
- 路径必须留在插件根目录内
- `interface` 只放展示信息，不是 capability 开关

当前仓库的 source manifest 还支持：

- `extensions`
- `claude`

它们用于项目自己的生成和适配逻辑，不改变 Codex 对共享字段的窄类型要求。

## 共享能力面和平台差异

共享插件层最稳的交集只有：

- `skills`
- `MCP`
- 少量 manifest 元数据

需要单独看平台差异的部分：

- Claude Code 插件原生支持 `agents`、`hooks`、`commands`、`LSP`
- Codex 插件运行时只稳定承认 `skills`、`MCP`、`apps`
- Codex 的 `hooks`、`AGENTS.md`、agent roles、`execpolicy` 更接近配置层，不是插件原生能力

因此新插件应先把共享层做薄，再决定是否追加平台差异。

## marketplace 约束

共享 marketplace entry 的稳定写法：

- `source` 用相对路径字符串：`./plugins/<name>`
- 不在共享 manifest 里使用 Claude 专属 source 类型
- `policy` 可以保留给 Codex 使用，Claude 会忽略
- `owner` 是给 Claude 的，`interface` 是给 Codex 的；两边都不会因为对方字段报错

## 脚本语言约束

当前项目把“agent 会直接执行的脚手架和辅助脚本”默认收敛到 Node.js：

- 初始化插件骨架、同步 manifest、更新 marketplace 这类脚本优先使用 Node.js
- 默认假设 agent 环境会经过 Node.js 相关链路，不把 Python 当成必然存在的前置条件
- 如果需求只是文件系统、JSON、文本模板处理，优先使用 Node.js 标准库，不额外引入运行时
- 只有当任务明显依赖 Python 生态时，才考虑用 Python，并且要在技能和项目文档里说明原因

## 创建插件时最容易犯的错

- 把 slash command 当成双端共享入口。当前项目要求共享入口收敛到“手动触发 skill”。
- 直接手改 `.claude-plugin/plugin.json` 或 `.codex-plugin/plugin.json`，忘了回写 source manifest。
- 给 `skills`、`mcpServers` 写数组或对象，导致 Codex 解析失败。
- 假设 Claude 普通 skill 的 `hooks/context/agent` 语义也会原样出现在 Claude 插件 skill 或 Codex 插件 skill 上。
- 只更新 `.claude-plugin/marketplace.json`，忘了同步 `.agents/plugins/marketplace.json`。
- 新增脚本时顺手写成 Python，导致技能变成依赖 Python 环境才能正常使用。
