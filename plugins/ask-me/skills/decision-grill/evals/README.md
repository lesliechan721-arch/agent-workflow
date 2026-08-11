# Decision Grill 作者期评测

本目录由 `decision-grill` 持有。确定性 `plugin:test` 不调用模型，不能替代 Codex 行为证据。

```bash
pnpm plugin:eval ask-me --skill decision-grill --materialize-only
pnpm plugin:eval ask-me --skill decision-grill
```

trigger corpus 有 20 条用例：10 条正例和 10 条近似负例，train 与 validation 各 10 条。它覆盖通过逐轮讨论形成或修订计划，以及一次性技术说明、直接推荐、内部执行计划和实施歧义等近似负例。validation 负例零容忍。

`decision-grill-evals.json` 包含 10 个会话用例，覆盖目标边界、先读后问、主要备选、假设验证、问题前沿、既有取舍、推荐校准、收敛、规划记录和风险延后。conversation baseline 只移除 owner Skill，并保留同一 subject 中的 companion Skills。

真实模型默认要求 Full Access。无 Full Access 时会在模型启动前阻断；用户确认风险后可传 `--allow-unmanaged-processes`。中间产物固定在项目 `.tmp/agent-workflows/evals/`，持久报告写入本 Skill 的 `reports/evals/<run-id>/`。
