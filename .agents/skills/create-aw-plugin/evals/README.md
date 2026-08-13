# Create Plugin Skill Evals

本目录评估 repo-local `create-aw-plugin` Skill 自身。

确定性合同检查：

```bash
node .agents/skills/skill-review/scripts/run_static_skill_evals.mjs \
  create-aw-plugin --validate-only
```

Eval Audit 结构检查使用共享 validator。当前 corpus 已补齐 Case Admission metadata，必须使用 `--strict`；其它历史文档仍可先使用兼容模式迁移：

```bash
node .agents/skills/skill-review/scripts/validate_eval_cases.mjs \
  .agents/skills/create-aw-plugin/evals/trigger-cases.json --strict --format json
node .agents/skills/skill-review/scripts/validate_eval_cases.mjs \
  .agents/skills/create-aw-plugin/evals/evals.json --strict --format json
```

只根据 train 结果调整 description：

```bash
node .agents/skills/skill-review/scripts/run_static_skill_evals.mjs \
  create-aw-plugin \
  --batch-name trigger-train \
  --suite trigger --split train --runs 3
```

验证触发泛化：

```bash
node .agents/skills/skill-review/scripts/run_static_skill_evals.mjs \
  create-aw-plugin \
  --batch-name trigger-validation \
  --suite trigger --split validation --runs 3
```

发布前再运行未参与调参的 sanity：

```bash
node .agents/skills/skill-review/scripts/run_static_skill_evals.mjs \
  create-aw-plugin \
  --batch-name trigger-sanity \
  --suite trigger --split sanity --runs 3
```

运行可写行为对照。每个 case 只在隔离临时副本中获得 `workspace-write`，并用
`allowed_workspace_changes` 和 `artifacts` 机械限制改动；报告保存
`with_skill` / `without_skill`、事件 trace、最终消息、workspace diff、最终文件摘要和 digest：

```bash
node .agents/skills/skill-review/scripts/run_static_skill_evals.mjs \
  create-aw-plugin \
  --batch-name behavior \
  --suite behavior --runs 1
```

本 Skill 不传 `--suite` 时运行 validation、sanity trigger 和 behavior。behavior 的机械门验证运行完整、改动路径和声明的最终文件；`review.checks` 由 `skill-review` 对照 trace 做定性判分。

触发结果分别解释 positive recall 和 negative specificity。混合低样本结果先增加运行并检查 trace。失败只有在 oracle、fixture、grader、runtime 和方差排除后归因为 `skill-defect`，才可以驱动 Skill 修改；修改后重跑同族 minimal pair、validation、sanity 和关键 regression。
