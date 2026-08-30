# Review AW Plugin 作者期评测

本目录由 `review-aw-plugin` 持有。`behavior-cases.json` 用 6 个只读 case 检查 source/evidence digest 边界、逐 Skill currentness、stage slot 冲突、materialized runtime closure 和分层 gate 聚合。

```bash
aw skill eval prepare aw-plugin-development review-aw-plugin \
  --suite behavior --profile project-default --output ./review-aw-plugin-spec --json
```

`aw skill eval prepare` 按 suite/profile/case 选择生成 `EvalSpec v1`，但不启动模型。执行前验证 Spec，并复用与 target 和 selected cases 精确绑定的单份 `EvalAudit v1`；没有可复用 Audit 时，由全新上下文生成一份。Runner 执行 `aw-skill-eval run <spec> --audit <audit>`，生成 `EvalResult v1`，再用 `aw-skill-eval result validate <result> --spec <spec> --audit <audit>` 验证。所有 case 要求 `workspace_unchanged=true`；当前没有真实执行记录。

clean success 不要求 triage。只有 execution/grade 失败、混合结果、baseline 回归，或结果将驱动生产 Skill 修改时，才做 result-triage；默认在聊天中返回，用户指定时可写 `triage.md`。triage 不是 Release Check 的机器输入。发布检查范围只从当前 `evals/manifest.json` 的 `requiredForRelease` 和 `releaseSplits` 派生。
