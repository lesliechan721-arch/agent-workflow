# Codex Explore 触发与 Gate Eval

这里的 20 个固定用例分成 train（12）和 validation（8），同时评测：

- `should_load_skill`：Codex 是否加载 `codex-explore`。
- `should_spawn_agent`：skill 加载后，Gate 是否实际调用 `spawn_agent`。

每组包含大型陌生材料、显式调用但 Gate 应拒绝、代码 review、写操作和少量已知来源等近似正反例。不要根据 validation 结果反向修改用例或 description；先在 train 上迭代，最后只用 validation 检查泛化。

## 运行

需要已登录且支持 `codex exec --json`、`spawn_agent.agent_type` 的 Codex：

```bash
node plugins/codex-explore/evals/run-trigger-evals.mjs \
  --split train \
  --runs 3 \
  --output /tmp/codex-explore-train.json

node plugins/codex-explore/evals/run-trigger-evals.mjs \
  --split validation \
  --runs 3 \
  --output /tmp/codex-explore-validation.json
```

runner 会在临时目录渲染当前 skill、专用 role 和合成材料，使用只读 sandbox 逐条执行。显式 `$codex-explore` 由宿主注入记为已加载；自动触发则通过 JSONL 中读取临时 `.agents/skills/codex-explore/SKILL.md` 的命令识别。`spawn_agent` 通过 `collab_tool_call` 事件识别。正向 spawn 用例在两个事件都出现后立即结束，避免等待完整探索结果。

默认每条运行 3 次，以 `0.5` 为分界：正例加载/调用率必须高于分界，反例必须低于分界。常规 `pnpm plugin:test codex-explore` 只验证用例、解析器和临时 staging，不会发起模型调用。
