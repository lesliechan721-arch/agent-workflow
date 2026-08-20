# Codex Clarifier 作者期评测

本目录由 `codex-clarifier` 持有。`ask-me` 只作为路由和组合评测中的 repo-local
companion，不形成生产依赖。

Materialization：

```bash
pnpm plugin:eval codex-enhance --skill codex-clarifier --batch-name materialization --materialize-only
```

完整评估：

```bash
pnpm plugin:eval codex-enhance --skill codex-clarifier --batch-name release
```

## 触发语料

trigger
corpus 有 25 条用例：train 与 validation 各 10 条，另有 5 条 sanity。train/validation 各含 5 条隐式正例和 5 条近似负例；sanity 含显式调用、口语正例、协作访谈和两类已完整实施任务。validation 和 sanity 负例使用零误触门槛。

- `codex-clarifier`
  覆盖会影响成品或造成返工的关键歧义、多项小歧义的合并影响，以及可查事实、明确惯例、授权默认和协作规划等相邻负例。
- trigger case 的 `use_project_rules` 只控制 materialized project
  rule，不代表生产质量门禁。质量门禁的增量只在 behavior 2×2 矩阵中评估。
- 依赖现有代码、规范或测试的 near-miss 使用 `trigger-fixture.mjs`
  准备小型脱敏仓库，避免空工作区改变触发判断。
- 隐式用例在干净 project
  session 中各运行至少三次。只根据 train 调整 description，再用 validation 检查泛化。

`codex-clarifier-routing-cases.json` 是本 owner 与两个 Ask Me companion
Skill 的精确路由门禁。6 条 validation 用例覆盖局部实施歧义、实施语境中的协作访谈、纯决策访谈、一次性评审、已完整定义的内部修改和已批准计划的局部缺口；4 条 sanity 用例覆盖显式入口、完整可调用惯例和只有策略对象的相反 minimal
pair。两个 split 都是发布门禁；每条运行 10 次，正确路由至少为 90%，任何同时加载都失败。

## 行为评测

`codex-clarifier-release-evals.json` 包含 3 个低提示代表性场景的 gate/no-gate minimal
pair。每个 case 由中央 runner 自动执行 with-Skill 与 without-Skill 两个 variant，并重复 3 次，因此形成 Skill 有无 ×
eval-only 门禁有无的 2×2 行为矩阵。门禁只通过隔离项目的 `AGENTS.md` 提供，不属于生产插件能力。

`codex-clarifier-evals.json`
保留 10 个非发布诊断用例，覆盖透明默认、依赖前沿、冲突、问题形态、停止和交接。`known-fact-before-question`、`dependent-frontier`
和 `handoff-on-stop` 使用低提示自然任务，其余用例继续隔离检查单条正文规则。它属于
`behavior-diagnostic` suite，不进入默认发布结果。

行为 prompt 使用完整的自然任务描述，不显式写 `$skill-name`。每个用例分别在全新的 Codex
app-server 会话中运行：

1. `with_skill` 使用 materialized 当前 project `codex-clarifier`。
2. `without_skill` 只移除 owner Skill，保留 Ask Me companion
   Skills，使用相同的自然 prompt、仓库、权限和模型配置作为 baseline。
3. app-server driver 将 `scripted_replies.answers_by_index` 映射到运行时 question
   id，并保存完整事件、问题、答复、最终消息、token usage 和 workspace diff。
4. repo-local `skill-review` 按 `review.checks` 复核真实 trace。`workspace_unchanged` 必须通过。
