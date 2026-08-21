# AW Skill 集成

- 通用 Skill package 由 `author-agent-skill` 产生。
- 面向 Codex 的静态 Skill 提供 `agents/openai.yaml`，并显式声明 implicit invocation policy。
- Claude 扩展字段与 Codex metadata 保持平台独立，不把某客户端字段说成 portable core。
- 静态 Skill 直接进入插件 source；dynamic Skill 由 renderer 产生 ArtifactPlan，最终制品才是行为评审对象。
- Skill 根直接子目录 `evals/` 与 `reports/` 属于作者期材料，不进入 runtime 指令包；更深层同名业务目录按普通资源处理。
- 插件 description、Skill discovery description 和 UI summary 分离。
- 需要核对 Codex/Claude frontmatter 字段时读取 `skill-frontmatter-capabilities.generated.md`。该文件由项目 capability registry 生成，不手工修改。
