# Codex Explore

在大型、陌生或边界不明的材料中隔离搜索、筛选和核验证据。插件通过 AW 配置动态生成 Codex Skill 和四种探索 role。

## Skill

- `codex-explore`：执行只读证据探索，并保持最终判断和写操作在主代理中。

动态 Skill 源码位于 `skills/codex-explore/`，renderer 只生成 ArtifactPlan。
