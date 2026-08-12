# Codex Enhance

通过两个互相独立的 Skill 增强 Codex 多代理工作流。插件通过 AW 配置动态生成两个 Codex Skill 和八种专用 role。

## Skills

- `codex-explore`：在大型、陌生或边界不明的材料中执行只读证据探索，并保持最终判断和写操作在主代理中。
- `codex-subagent-guide`：在委派已获授权后管理通用子代理的任务分类、参数、上下文和生命周期。

两个 Skill 共享 `minimumInitialWaitMinutes` 配置，其它模型和推理强度配置各自作用于对应 role。renderer 只生成 ArtifactPlan。
