# 插件脚手架清单

## 推荐顺序

1. 运行脚手架脚本创建最小源码骨架。
2. 检查 `.agents-plugin/plugin.json` 的 `marketplace`、`interface` 和 `extensions` 是否符合需求。
3. 补完插件内 `skills/<skill-name>/SKILL.md` 的真实流程。
4. 如果插件需要 `mcpServers`、`apps`、Claude `hooks/agents` 或模板化文件，再补对应源码目录与 `buildConfig`。
5. 运行 `pnpm build` 或相关测试，确认 build 生成的 runtime bundle 符合预期。

## 最小源码 manifest 示例

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

## 作者模型边界

- `plugins/marketplace-source.json` 是 marketplace root 级源码输入，不是运行时 marketplace manifest。
- `.agents-plugin/plugin.json.marketplace` 是插件 entry metadata 的唯一作者入口。
- 运行时 `.claude-plugin/plugin.json` 与 `.codex-plugin/plugin.json` 只会在 build 产物里出现。
- 共享 `hooks` / `agents` 继续写 `extensions.hooks`、`extensions.agents`，不要去写顶层 `claude` block 或 `manifestOverrides.claude.hooks` / `agents`。

## 验收清单

- `plugins/<name>/` 下只有源码结构，没有源码树 `.claude-plugin/plugin.json` 或 `.codex-plugin/plugin.json`
- `.agents-plugin/plugin.json` 已包含 `marketplace` block
- `skills/<skill-name>/SKILL.md` 已从占位文本替换成真实流程
- `agents/openai.yaml` 已明确表达 Codex 触发策略：
  脚手架默认写 `policy.allow_implicit_invocation: false`，这是保守基线，不是 Codex 平台默认值；需要自动触发时再显式改成 `true`
- 如果 skill 还要兼容 Claude Code 的手动 / 自动触发语义，已经按 `references/skill-trigger-rules.md` 检查过 `user-invocable` 和 `disable-model-invocation`
- `plugins/marketplace-source.json` 没被脚手架改写
- `pnpm build` 后，运行时 bundle 出现在 `packages/cli/plugins-dist/plugins/<name>/`
- 如果插件要带 `mcpServers`、`apps`、Claude `hooks/agents`，已经回到 `references/project-plugin-contract.md` 复核过能力边界

## 现有样例

仓库里现成的源码参考插件是 `plugins/git-commit/`。优先参考这些文件：

- `plugins/marketplace-source.json`
- `plugins/git-commit/.agents-plugin/plugin.json`
- `plugins/git-commit/skills/commit/SKILL.md`
