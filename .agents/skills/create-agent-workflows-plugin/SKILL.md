---
name: create-agent-workflows-plugin
description: 在当前 `agent-workflows` 仓库里创建或更新插件源码，遵守 “source manifest + build bundle” 模型。用在新增 `plugins/<name>`、补齐 `.agents-plugin/plugin.json.marketplace`、初始化 `skills/` 结构、或梳理 `extensions.*` / `buildConfig` 的作者写法时。
---

# Create Agent Workflows Plugin

用这个技能创建或调整源码插件骨架。这个仓库里的运行时 bundle 统一由 build 产出，不再手写 repo root marketplace，也不再维护源码树平台 manifest。

## 快速开始

- 新建插件时，优先运行 `node .agents/skills/create-agent-workflows-plugin/scripts/init_plugin.js ...`。
- 只要任务涉及 `mcpServers`、`apps`、Claude `agents/hooks`、或 build 阶段的 bundle 生成，先读 `references/project-plugin-contract.md`。
- 如果任务涉及 skill 的自动触发、手动触发、或要判断 `allow_implicit_invocation`、`user-invocable`、`disable-model-invocation` 该怎么配，先读 `references/skill-trigger-rules.md`。
- 如果只是补一个最小 `skill-only` 插件，可以先用脚手架起目录，再按任务把 `SKILL.md` 里的占位说明补成真实工作流。
- 这个仓库默认把插件脚手架和辅助脚本写成 Node.js。除非有明确理由，不要再把 Python 当成新脚本的默认实现。

## 工作流

1. 确认插件名使用小写短横线格式，并判断它属于哪一类：
   - 纯 `skills` 插件
   - `skills + extensions` 插件
   - 需要 `MCP` 或 `apps` 的插件
2. 把 `plugins/<name>/.agents-plugin/plugin.json` 当成唯一源码 manifest。
   `plugins/marketplace-source.json` 只保存 marketplace root 级源码元数据；entry 级 metadata 写在插件自己的 `marketplace` block。
3. 共享字段始终收敛到 Codex 可解析的最窄子集：
   - `skills`、`mcpServers`、`apps` 使用单个字符串路径
   - 路径必须以 `./` 开头，并且留在插件根目录内
   - `interface` 只放展示元数据，不把它当运行时 capability
4. Claude 专属扩展继续写在 `extensions.hooks`、`extensions.agents`，不要引导用户写顶层 `claude` block，也不要把 `hooks` / `agents` 塞进 `buildConfig.manifestOverrides.claude`。
5. 如果需要 Claude-only 的额外 manifest 字段，只使用当前白名单：
   - `buildConfig.manifestOverrides.claude.commands`
   - `buildConfig.manifestOverrides.claude.outputStyles`
   - `buildConfig.manifestOverrides.claude.lspServers`
   - `buildConfig.manifestOverrides.claude.userConfig`
   - `buildConfig.manifestOverrides.claude.channels`
6. 源码改完后通过 `pnpm build` 或相关测试生成并校验 runtime bundle，不要手改 `packages/cli/plugins-dist`、`~/.aw`、repo root marketplace，或源码树 `.claude-plugin/plugin.json` / `.codex-plugin/plugin.json`。

## 脚手架脚本

优先用脚手架创建第一版目录，再按需求细化：

```bash
node .agents/skills/create-agent-workflows-plugin/scripts/init_plugin.js repo-check \
  --description "检查仓库状态并输出诊断结论。" \
  --display-name "Repo Check" \
  --short-description "检查仓库状态" \
  --skill-name repo-check \
  --skill-description "手动触发这个 skill，执行仓库检查工作流"
```

脚本会：

- 创建 `plugins/<name>/` 源码目录
- 写入带 `marketplace` block 的 `.agents-plugin/plugin.json`
- 初始化 `skills/<skill-name>/SKILL.md` 与 `agents/openai.yaml`
- 保持 `plugins/marketplace-source.json` 不变
- 不会生成源码树 `.claude-plugin/plugin.json` 或 `.codex-plugin/plugin.json`
- 不会改写 repo root marketplace manifest

脚本实现约束：

- 优先保持零依赖 Node.js，可直接用 `node` 运行
- 如果未来需要扩展功能，先判断能否继续复用 Node.js 标准库
- 不要把 Python 作为默认实现，除非需求本身依赖 Python 生态

## 何时读参考资料

- 需要判断源码结构、bundle 输出边界和平台差异时，读 `references/project-plugin-contract.md`
- 需要决定 skill 是自动触发、显式触发、用户可手动触发，还是只允许模型调用时，读 `references/skill-trigger-rules.md`
- 需要照着当前约定补文件树、manifest 示例和检查清单时，读 `references/plugin-scaffold-checklist.md`

## 验证

- 确认 `plugins/<name>/.agents-plugin/plugin.json` 是唯一源码真值
- 确认插件 entry metadata 写在 `.agents-plugin/plugin.json.marketplace`
- 确认源码树里没有 `.claude-plugin/plugin.json`、`.codex-plugin/plugin.json`
- 确认 `plugins/marketplace-source.json` 没被脚手架偷偷改写
- 如果改到了 `packages/cli/src/utils/manifest.ts`、bundle 结构或安装逻辑，运行 `pnpm test`
