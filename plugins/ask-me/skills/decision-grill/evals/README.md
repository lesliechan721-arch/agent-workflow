# Decision Grill 作者期评测

本目录由 `decision-grill` 持有。确定性 `plugin:test` 不调用模型，不能替代 Codex 行为证据。

```bash
pnpm plugin:eval ask-me --skill decision-grill --batch-name materialization --materialize-only
pnpm plugin:eval ask-me --skill decision-grill --batch-name release
```

单 Skill trigger corpus 有 20 条用例：10 条正例和 10 条近似负例，train 与 validation 各 10 条。它覆盖计划、决策或想法访谈，以及一次性技术说明、直接推荐、内部执行计划和实施歧义等近似负例。`n09_implementation_ambiguity` 不加载项目规则，用于独立验证 description 边界；validation 负例零容忍。

`ask-me-routing-cases.json` 是双 Skill 路由矩阵。它用 `expected_loaded_skills` 精确区分 `decision-grill`、`requirements-clarifier`、不加载和同时加载。8 条核心 validation 用例是发布门禁，每条运行 10 次；6 条事实、显式调用和委托补充用例属于 sanity。正确路由至少为 90%，任何同时加载都失败。报告还记录首个和全部已加载 Skill、问题工具等待、最终响应和终止原因。

`decision-grill-evals.json` 包含 15 个会话用例。原 10 条继续作为协议回归；新增用例降低提示度，并检查依赖顺序、静默遗漏、用户决定不被代答、共享理解确认和纠错后重开分支。conversation baseline 只移除 owner Skill，并保留 `requirements-clarifier`。

真实模型默认要求 Full Access。无 Full Access 时会在模型启动前阻断；用户确认风险后可传 `--allow-unmanaged-processes`。中间产物固定在项目 `.tmp/agent-workflows/evals/`，持久报告写入 `plugins/ask-me/reports/decision-grill/<batch-id>/`。
