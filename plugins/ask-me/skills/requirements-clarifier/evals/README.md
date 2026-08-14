# Ask Me 作者期评测

本目录由 `requirements-clarifier` 持有。相邻 `decision-grill` 在自己的 Skill 根维护独立 manifest。

Materialization：

```bash
pnpm plugin:eval ask-me --skill requirements-clarifier --batch-name materialization --materialize-only
```

完整评估：

```bash
pnpm plugin:eval ask-me --skill requirements-clarifier --batch-name release
```

`decision-grill` 的命令和语料说明位于其自身 `evals/README.md`。

## 触发语料

trigger corpus 有 20 条用例：10 条正例和 10 条近似负例，train 与 validation 各 10 条；validation 负例使用零误触门槛。

- `requirements-clarifier` 覆盖会影响成品或造成返工的关键歧义、多项小歧义的合并影响，以及可查事实、明确惯例、授权默认和协作规划等相邻负例。
- 大部分 case 声明 `use_project_rules: true`，使 `extensions.instructions` 中的质量门禁进入评测。相邻访谈负例 `n05_decision_planning` 关闭项目规则，用于独立验证 description 边界。
- 依赖现有代码、规范或测试的 near-miss 使用 `trigger-fixture.mjs` 准备小型脱敏仓库，避免空工作区改变触发判断。
- 隐式用例在干净 project session 中各运行至少三次。只根据 train 调整 description，再用 validation 检查泛化。

## 行为评测

`requirements-clarifier-release-evals.json` 包含 3 个低提示代表性会话用例，覆盖事实／默认／用户决定三路处理、多项小歧义的组合影响和工程待验证事项。它是发布必需的 behavior suite。

`requirements-clarifier-evals.json` 保留 10 个非发布诊断用例，覆盖透明默认、依赖前沿、冲突、问题形态、停止和交接。`known-fact-before-question`、`dependent-frontier` 和 `handoff-on-stop` 使用低提示自然任务，其余用例继续隔离检查单条正文规则。它属于 `behavior-diagnostic` suite，不进入默认发布结果。真实仓库事实查找由带 `trigger-fixture.mjs` 的 trigger suite 验证。

行为 prompt 使用完整的自然任务描述，不显式写 `$skill-name`。这样 baseline 不会因为寻找不存在的 Skill 而产生额外成本或偏离任务。每个用例分别在全新的 Codex app-server 会话中运行：

1. `with_skill` 使用 materialized 当前 project Skill。
2. `without_skill` 只移除当前 suite 指定的 Skill，保留同插件的相邻 Skill，使用相同的自然 prompt、仓库、权限和模型配置作为 baseline。
3. app-server driver 将 `scripted_replies.answers_by_index` 映射到运行时 question id，并保存完整事件、问题、答复、最终消息、token usage 和 workspace diff。
4. repo-local `skill-review` 按 `review.checks` 复核真实 trace。`workspace_unchanged` 必须通过。
