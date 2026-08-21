# aw-plugin-development

在兼容工作区中创建、维护和只读评审 AW 插件。目标插件由 `.agents-plugin/plugin.json` 标识，不要求固定目录。

必需：`agent-content-toolkit >= 0.5.0`、`agent-skill-toolkit >= 0.8.0`。真实模型 Eval 可选使用 `agent-skill-eval-runner >= 0.3.0`。

| Skill              | 用途                                                         |
| ------------------ | ------------------------------------------------------------ |
| `author-aw-plugin` | 创建或维护 AW 插件源码、README、manifest、构建和确定性验证。 |
| `review-aw-plugin` | 轻量只读评审 AW 插件，并在明确请求时执行发布检查。           |

`author-aw-plugin` 继续使用 `AWAuthoringContext` 描述复合插件变更；它不负责独立 Review。

## Review 路径

普通 Review 不再生成多阶段 bundle、target plan 或 AW summary：

1. AW inspector 计算项目机器事实；
2. 通用 `review-agent-skill` 按唯一 Skill digest 输出简洁设计结论；
3. 只有明确发布检查时，`check-aw-plugin-release.mjs` 从当前 manifest 和 materialized roots 实时重算 profile coverage、runtime closure 和 review binding。

```bash
node scripts/check-aw-plugin-release.mjs <plugin-root> \
  --review <review-result-lite.json> \
  --final codex-project=<materialized-root>
```

旧 `ReviewInputBundle`、`AWReviewTargetPlan` 和 `AWReviewSummary` 保留为历史报告兼容接口，但不再由新 Skill 主流程生成，也不应继续扩展。
