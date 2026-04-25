# 插件脚手架清单

## 推荐顺序

1. 用脚手架创建最小插件骨架。
2. 检查 `.agents-plugin/plugin.json`，确认 `marketplace`、`interface`、`skills` 和可选能力都声明正确。
3. 把 `skills/<skill-name>/SKILL.md` 的占位流程改成真实工作流。
4. 按需求补 `agents/openai.yaml`、MCP/apps 配置、`extensions`、`buildConfig` 和额外文件。
5. 运行 `pnpm build` 或对应测试，检查生成的 runtime bundle。

## 脚手架命令

```bash
node .agents/skills/create-agent-workflows-plugin/scripts/init_plugin.js repo-check \
  --description "检查仓库状态并输出诊断结论。" \
  --display-name "Repo Check" \
  --short-description "检查仓库状态" \
  --skill-name repo-check \
  --skill-description "手动触发这个 skill，执行仓库检查工作流"
```

脚手架只创建这些需要手动维护的文件：

- `plugins/<name>/.agents-plugin/plugin.json`
- `plugins/<name>/skills/<skill-name>/SKILL.md`
- `plugins/<name>/skills/<skill-name>/agents/openai.yaml`

它不会改 `plugins/marketplace-source.json`，也不会生成 `.claude-plugin/plugin.json` 或 `.codex-plugin/plugin.json`。

## 最小 manifest

```json
{
  "name": "repo-check",
  "version": "0.1.0",
  "description": "检查仓库状态并输出诊断结论。",
  "skills": "./skills",
  "marketplace": {
    "category": "workflow",
    "strict": true,
    "policy": {
      "installation": "AVAILABLE",
      "authentication": "NONE",
      "products": ["CODEX"]
    }
  },
  "interface": {
    "displayName": "Repo Check",
    "shortDescription": "检查仓库状态",
    "capabilities": ["Skills"]
  },
  "extensions": {
    "instructions": [],
    "permissions": [],
    "hooks": [],
    "agents": []
  }
}
```

## 常见补充

- 有 `skills/`：manifest 必须声明 `"skills": "./skills"`。
- 有 `.mcp.json`：manifest 必须声明 `"mcpServers": "./.mcp.json"`。
- 有 `.app.json`：manifest 必须声明 `"apps": "./.app.json"`。
- 要带 Claude commands/output styles/LSP：写 `buildConfig.manifestOverrides.claude`，并确认路径没有离开插件根目录。
- 要额外复制平台文件：写 `buildConfig.fileRules.claude` 或 `buildConfig.fileRules.codex`。
- 要按平台渲染文本：写 `buildConfig.templates.include` 和 `buildConfig.templates.vars`。
- 要声明安装期 instructions/permissions/hooks/agents：写 `extensions.*`，不要写顶层 `claude` block。

## 验收清单

- `plugins/<name>/.agents-plugin/plugin.json` 是唯一需要手动维护的 manifest。
- `.agents-plugin/plugin.json` 已包含 `marketplace` block。
- `plugins/marketplace-source.json` 是 marketplace 根级构建输入，不是运行时 marketplace manifest；创建单个插件时通常不要改它。
- 插件目录里没有 `.claude-plugin/plugin.json` 或 `.codex-plugin/plugin.json`。
- `skills/<skill-name>/SKILL.md` 已从占位文本替换成真实流程。
- `agents/openai.yaml` 已明确 Codex 触发策略；脚手架默认 `policy.allow_implicit_invocation: false`，这是保守基线。
- 如需配置 Claude Code 触发规则，`SKILL.md` frontmatter 已正确设置 `user-invocable` / `disable-model-invocation`。
- `pnpm build` 后，运行时 bundle 出现在 `packages/cli/plugins-dist/plugins/<name>/`。
- 如果插件带 `mcpServers`、`apps`、hooks、agents、commands、output styles 或 LSP，已检查生成后的 `.claude-plugin/plugin.json` 和 `.codex-plugin/plugin.json`。

## 现有样例

仓库里可参考的现有插件是 `plugins/git-commit/`。优先看：

- `plugins/marketplace-source.json`
- `plugins/git-commit/.agents-plugin/plugin.json`
- `plugins/git-commit/skills/commit/SKILL.md`
- `plugins/git-commit/skills/commit/agents/openai.yaml`
