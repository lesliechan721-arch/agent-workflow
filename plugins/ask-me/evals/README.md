# Ask Me 作者期评测

这些用例分别检查 `requirements-clarifier` 和 `decision-grill` 的自动发现、相邻边界与加载后行为。确定性插件测试只验证语料结构、source contract、质量门禁和双平台 bundle，不调用模型，也不能替代 Codex 行为评测。

中央入口会先 materialize 最终 project/user 制品。以下命令只生成制品，不启动模型：

```bash
pnpm plugin:eval ask-me --materialize-only --output-dir /tmp/ask-me-eval
```

本地发布评估运行两个 Skill 的 validation trigger suite 和 conversation behavior suite：

```bash
pnpm plugin:eval ask-me --output-dir /tmp/ask-me-eval
```

## 触发语料

两个 trigger corpus 各有 20 条用例：10 条正例和 10 条近似负例，train 与 validation 各 10 条。中央 native trigger driver 负责干净会话、Skill 加载事件、重复运行、validation 零误触门槛和报告归档。

- `requirements-clarifier` 覆盖会影响成品或造成返工的关键歧义、多项小歧义的合并影响，以及可查事实、明确惯例、授权默认和协作规划等相邻负例。
- `decision-grill` 覆盖通过逐轮讨论形成或修订计划，以及一次性技术说明、方案比较、评审、估算、直接推荐、内部执行计划和实施歧义等近似负例。
- 所有 case 都声明 `use_project_rules: true`，使 `extensions.instructions` 中的质量门禁进入评测。
- 依赖现有代码、规范或测试的 near-miss 使用 `trigger-fixture.mjs` 准备小型脱敏仓库，避免空工作区改变触发判断。
- 隐式用例在干净 project session 中各运行至少三次。只根据 train 调整 description，再用 validation 检查泛化。

## 行为评测

`requirements-clarifier-evals.json` 包含 10 个会话用例，覆盖采用已知事实、事实／默认／提问三路处理、透明默认、多项小歧义的合并影响、依赖前沿、待验证项、冲突、问题形态、无缺口停止和交接。真实仓库事实查找由带 `trigger-fixture.mjs` 的 trigger suite 验证。

`decision-grill-evals.json` 包含 10 个会话用例，均置于明确的协作规划阶段，覆盖目标边界、先读后问、主要备选、假设验证、问题前沿、既有取舍、推荐校准、收敛、规划记录和风险延后。

行为 prompt 使用完整的自然任务描述，不显式写 `$skill-name`。这样 baseline 不会因为寻找不存在的 Skill 而产生额外成本或偏离任务。v1 每个用例分别在全新的 Codex app-server 会话中运行：

1. `with_skill` 使用中央 materializer 生成的当前 project Skill。
2. `without_skill` 只移除当前 suite 指定的 Skill，保留同插件的相邻 Skill，使用相同的自然 prompt、仓库、权限和模型配置作为 baseline。
3. app-server driver 将 `scripted_replies.answers_by_index` 映射到运行时 question id，并保存完整事件、问题、答复、最终消息、token usage 和 workspace diff。
4. repo-local `skill-review` 按 `review.checks` 复核真实 trace。`workspace_unchanged` 必须通过。

模型 eval v1 只覆盖 Codex。Claude 只通过 build、validator 和 `plugin:test` 验证确定性合同，不能把 Codex 或确定性测试结果报告成 Claude 模型行为证据。
