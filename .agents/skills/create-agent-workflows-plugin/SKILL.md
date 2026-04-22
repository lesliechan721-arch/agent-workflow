---
name: create-agent-workflows-plugin
description: 在当前 `agent-workflows` 仓库里创建或更新一个双端兼容插件，遵守项目的插件市场与 manifest 约定。用在新增 `plugins/插件名`、补齐 `.agents-plugin/plugin.json`、同步 `.claude-plugin/plugin.json` 与 `.codex-plugin/plugin.json`、注册两份 `marketplace.json`、初始化插件内 `skills/` 结构，或判断 Claude Code 和 Codex 的插件能力边界时。
---

# Create Agent Workflows Plugin

用这个技能为当前仓库创建或调整插件骨架。先把共享插件层做对，再处理 Claude Code 和 Codex 的差异。

## 快速开始

- 新建插件时，优先运行 `node .agents/skills/create-agent-workflows-plugin/scripts/init_plugin.js ...`。
- 只要任务涉及 `mcpServers`、`apps`、Claude `agents/hooks`、或 marketplace 兼容性，先读 `references/project-plugin-contract.md`。
- 如果只是补一个最小 `skill-only` 插件，可以直接用脚手架，再按任务把插件里的 `SKILL.md` 内容补完整。
- 这个仓库默认把插件脚手架和辅助脚本写成 Node.js。除非有明确理由，不要再把 Python 当成新脚本的默认实现。

## 工作流

1. 确认插件名使用小写短横线格式，并判断它属于哪一类：
   - 纯 `skills` 插件
   - `skills + extensions` 插件
   - 需要 `MCP` 或 `apps` 的插件
2. 把 `plugins/<name>/.agents-plugin/plugin.json` 当成唯一源 manifest。除非你在修复生成漂移，不要先改 `.claude-plugin/plugin.json` 或 `.codex-plugin/plugin.json`。
3. 让共享字段始终落在 Codex 可解析的最窄子集：
   - `skills`、`mcpServers`、`apps` 使用单个字符串路径
   - 路径必须以 `./` 开头，并且留在插件根目录内
   - `interface` 只放展示元数据，不把它当运行时 capability
4. 为共享入口优先设计“手动触发的 skill”，不要把 slash command 当成双端公共协议。
5. 更新两份 marketplace manifest：
   - `.claude-plugin/marketplace.json`
   - `.agents/plugins/marketplace.json`
   两边的插件 entry 应保持一致，`source` 指向 `./plugins/<name>`。
6. 如果插件需要 Claude 专属能力，把差异收敛在 Claude 能力面，不要假设 Codex 插件也能读取 `hooks`、`agent` 或 `context` 语义。
7. 如果需要新增或修改脚本，优先延续 Node.js 方案，避免为创建插件再引入额外运行时依赖。
8. 完成后检查 source manifest、两份 platform manifest、marketplace entry、插件 `skills/` 结构是否一致。

## 脚手架脚本

优先用脚手架创建第一版目录，再按需求细化：

```bash
node .agents/skills/create-agent-workflows-plugin/scripts/init_plugin.js my-plugin \
  --description "插件说明" \
  --display-name "My Plugin" \
  --short-description "插件短说明" \
  --skill-name my-skill \
  --skill-description "手动触发这个 skill，执行某个工作流"
```

脚本会：

- 创建 `plugins/<name>/` 基本目录
- 写入 `.agents-plugin/plugin.json`
- 同步 `.claude-plugin/plugin.json` 和 `.codex-plugin/plugin.json`
- 初始化 `skills/<skill-name>/SKILL.md` 与 `agents/openai.yaml`
- 默认把插件注册到两份 marketplace manifest

如果你只想先搭本地骨架，不想立即注册 marketplace，加 `--skip-marketplace`。

脚本实现约束：

- 优先保持零依赖 Node.js，可直接用 `node` 运行
- 如果未来需要扩展功能，先判断能否继续复用 Node.js 标准库
- 不要把 Python 作为默认实现，除非需求本身依赖 Python 生态

## 何时读参考资料

- 需要判断共享字段和平台差异时，读 `references/project-plugin-contract.md`
- 需要照着现有约定补文件树、manifest 示例和检查清单时，读 `references/plugin-scaffold-checklist.md`

## 验证

- 确认 `plugins/<name>/.agents-plugin/plugin.json` 是事实源头
- 确认 `.claude-plugin/plugin.json` 与 `.codex-plugin/plugin.json` 没有手工漂移
- 确认两份 marketplace manifest 都注册了同一个 `source`
- 如果改到了 `packages/cli/src/utils/manifest.ts`、marketplace 结构或安装逻辑，运行 `pnpm test`
