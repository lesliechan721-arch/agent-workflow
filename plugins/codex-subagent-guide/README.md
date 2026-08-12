# Codex Subagent Guide

在子代理委派已获授权后，选择 task role、上下文策略、等待方式和清理规则。插件通过 AW 配置动态生成 Codex Skill 和专用 role。

## Skill

- `codex-subagent-guide`：管理通用子代理委派的参数和生命周期。

动态 Skill 源码位于 `skills/codex-subagent-guide/`，renderer 只生成 ArtifactPlan。
