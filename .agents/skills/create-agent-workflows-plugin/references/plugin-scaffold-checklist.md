# 插件脚手架清单

## 推荐顺序

1. 运行脚手架脚本创建最小骨架。
2. 检查 `.agents-plugin/plugin.json` 的描述、`interface` 和 `extensions` 是否符合需求。
3. 检查 `.claude-plugin/plugin.json` 与 `.codex-plugin/plugin.json` 是否和 source manifest 一致。
4. 补完插件内 `skills/<skill-name>/SKILL.md` 的真实流程。
5. 同步两份 marketplace manifest。
6. 如果需求涉及 CLI 的 manifest 生成或安装逻辑，再跑 `pnpm test`。

## 最小示例

```json
{
  "name": "repo-check",
  "version": "0.1.0",
  "description": "检查仓库状态并输出诊断结论。",
  "skills": "./skills",
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

## 最小 marketplace entry

```json
{
  "name": "repo-check",
  "source": "./plugins/repo-check",
  "description": "检查仓库状态并输出诊断结论。",
  "category": "workflow",
  "strict": true,
  "policy": {
    "installation": "AVAILABLE",
    "authentication": "NONE",
    "products": ["CODEX"]
  }
}
```

## 验收清单

- `plugins/<name>/` 下存在三份 manifest
- `.agents-plugin/plugin.json` 是唯一事实源
- `skills/<skill-name>/SKILL.md` 已从占位文本替换成真实流程
- `agents/openai.yaml` 至少保留 `policy.allow_implicit_invocation: false`
- `.claude-plugin/marketplace.json` 和 `.agents/plugins/marketplace.json` 都已注册插件
- 如果插件要带 `mcpServers`、`apps`、Claude `hooks/agents`，已经回到 `references/project-plugin-contract.md` 复核过能力边界

## 现有样例

仓库里现成的参考插件是 `plugins/git-commit/`。优先参考这些文件：

- `plugins/git-commit/.agents-plugin/plugin.json`
- `plugins/git-commit/.claude-plugin/plugin.json`
- `plugins/git-commit/.codex-plugin/plugin.json`
- `plugins/git-commit/skills/commit/SKILL.md`
