# aw-plugin-development

`agent-workflows` 项目插件开发适配层。

当前是并行迁移入口，不替换 `.agents/skills/create-aw-plugin` 或 `.agents/skills/skill-review`。两个适配器都只允许用户显式调用。

## 手工依赖

当前要求人工同时安装 `agent-content-toolkit >= 0.1.0`。运行时若找不到必需通用 Skill，适配器停止并报告缺失，不复制或内置通用标准。

## Skills

- `author-aw-plugin`：创建或维护 AW 插件；拥有源码写入、构建和确定性验证。
- `review-aw-plugin`：只读评审 AW 插件源码、materialized final artifacts 和 Eval evidence；发布报告或 README 登记需要独立授权。

这两个 Skill 不互相替代：Author 不给自己的结果出独立发布结论，Reviewer 不修改生产源码。

## 验证

```bash
node scripts/validate-contract-assets.mjs
pnpm plugin:test aw-plugin-development
```

真实模型证据的 v1 范围只包括 Codex。Claude 只做确定性验证和 materialization。
