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

- `requirements-clarifier` 覆盖实施前重大用户决策、冲突约束、委托默认，以及计划评审等相邻负例。
- `decision-grill` 覆盖计划、方案和重大决策压力测试，以及实施阻塞、事实核验和机械执行等相邻负例。
- 所有 case 都声明 `use_project_rules: true`，使 `extensions.instructions` 中的质量门禁进入评测。
- 隐式用例在干净 project session 中各运行至少三次。只根据 train 调整 description，再用 validation 检查泛化。

## 行为评测

`requirements-clarifier-evals.json` 包含 9 个会话用例，覆盖先查后问、用户决策所有权、依赖前沿、待验证项、冲突、部分回答、无副作用和交接。

`decision-grill-evals.json` 包含 10 个会话用例，覆盖事实底座、主要替代方案、假设验证、决策前沿、推荐校准、收敛、停止、决策简报、上游决定复用和无副作用。

v1 每个用例分别在全新的 Codex app-server 会话中运行：

1. `with_skill` 使用中央 materializer 生成的当前 project Skill。
2. `without_skill` 只移除当前 suite 指定的 Skill，保留同插件的相邻 Skill，使用相同 prompt、仓库、权限和模型配置作为 baseline。
3. app-server driver 将 `scripted_replies.answers_by_index` 映射到运行时 question id，并保存完整事件、问题、答复、最终消息、token usage 和 workspace diff。
4. repo-local `skill-review` 按 `review.checks` 复核真实 trace。`workspace_unchanged` 必须通过。

模型 eval v1 只覆盖 Codex。Claude 只通过 build、validator 和 `plugin:test` 验证确定性合同，不能把 Codex 或确定性测试结果报告成 Claude 模型行为证据。
