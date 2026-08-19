# Codex Subagent Guide Eval

该 manifest 覆盖 default/non-default、project/user 最终制品和 lifecycle 专用 timeout profile；普通模型用例位于 project-default：

```bash
pnpm plugin:eval codex-enhance --skill codex-subagent-guide --batch-name materialization --materialize-only
pnpm plugin:eval codex-enhance --skill codex-subagent-guide --batch-name trigger-validation-debug --suite trigger --split validation --runs 1
pnpm plugin:eval codex-enhance --skill codex-subagent-guide --batch-name release
```

## 触发评估

strict 发布语料分成 train（12）、validation（7）和不参与 description 调优的 sanity（6）。它检查：

- 已经由用户或临时 workspace 中的真实 `AGENTS.md` 授权委派时，加载 skill 并启动子代理。
- 只询问是否应该委派、概念文档、安装配置、明确禁止子代理等 near miss，不加载也不启动。
- 显式调用 skill 或管理已有 agent 时加载 skill，但不额外 spawn。

standard 组合性诊断语料另有 5 条，并把 `codex-subagent-guide` 与 `codex-explore` 同时列为 participant。它使用精确 loaded-skill 集合检查：只授权、不提供代理管理时由 guide 接管；真实的大范围事实探索只由 explore 接管；专用 fixture skill 已完整拥有委派生命周期时，两者都不叠加加载。涉及已存在 agent 的 trigger 用例只验证 Skill 路由，并明确禁止调用不存在的 runtime actor；真实等待由 lifecycle suite 负责。该 suite 会写临时 `.agents/` fixture，因此不作为发布证据。

每条 query 默认在干净会话运行三次。普通 trigger 以 `0.5` 为分界；trigger-composition 的精确 loaded-skill 路由要求 `1.0`，并禁止同时加载两个 participant。strict 发布 suite 的 validation 和 sanity 禁止加载或禁止委派负例使用零容忍，任意一次误触发都失败。`$skill` 记录为宿主显式注入，隐式加载只接受成功读取 `SKILL.md` 的执行事件；spawn 还要求原始 rollout 参数证据。

```bash
pnpm plugin:eval codex-enhance --skill codex-subagent-guide --batch-name trigger-train --suite trigger --split train --runs 3
pnpm plugin:eval codex-enhance --skill codex-subagent-guide --batch-name trigger-validation --suite trigger --split validation --runs 3
pnpm plugin:eval codex-enhance --skill codex-subagent-guide --batch-name trigger-sanity --suite trigger --split sanity --runs 3
pnpm plugin:eval codex-enhance --skill codex-subagent-guide --batch-name trigger-composition --suite trigger-composition --runs 3
```

## Routing 参数评估

`evals.json` 覆盖四档复杂度 preset、复杂只读任务不误入 simple、范围有限的 plan/review 使用 general、高难系统任务使用 advanced、`model` / `reasoning_effort` / `agent_type` 逐字段自定义、多子任务间 override 隔离、V1/V2 干净上下文、V2 部分历史与 override、全历史与 routing 字段的版本差异、来自 AGENTS.md 或其它 skill 的 context 要求、显式参数冲突和缺失 role。runner 对每个 case 运行 V1/V2，并用相同 prompt 对比 `with_skill` 与 `without_skill`；显式 `$skill` 作为宿主注入证据，隐式加载只接受实际 `SKILL.md` 读取事件。spawn 路由只用隔离 rollout 中的原始 `spawn_agent` arguments 评分，不根据 query、最终说明或调用摘要猜测证据。零 spawn 仍是阻断用例的硬门禁；解释只检查非空，并用单行 `ROUTING_BLOCK_REASON=<枚举>` 记录结构化原因，不维护自然语言同义词表。V1 通过 rollout 中的 `exec` 工具调用源码读取同一原始参数，并只接受内联的 JSON-like 字面量参数；spawn 事件先到但原始参数尚不可用时，runner 等待 rollout 输出元数据，仍无法机械取证才保持 incomplete。明确的模型传输瞬断最多重试两次，普通 timeout 或行为错误不重试。

```bash
pnpm plugin:eval codex-enhance --skill codex-subagent-guide --batch-name routing --suite routing --runs 3
```

调试时可限制 case；profile/variant 组合仍由领域 runner 完整覆盖：

```bash
pnpm plugin:eval codex-enhance --skill codex-subagent-guide --batch-name routing-debug --suite routing --runs 1 --case full_history_preset
```

`evals.json` 声明的 20 个 case 都有完整证据后，routing suite 才组合出 `/all` target。

runner 默认用 `gpt-5.6-luna` 运行 V1 和 V2；`plugin:eval --model` 同时覆盖两者，runner 内部仍可用 `--v1-model` / `--v2-model` 分别调整。lifecycle 使用同一个模型覆盖。

如果 stdout 只给出简化的协作事件，却没有可读取的隔离 rollout 原始参数，runner 也会标记 `raw_evidence_missing` 和 `complete: false`；最终说明或调用事件不能替代参数证据。

## 等待与清理评估

两份 lifecycle case 文档各提供一条最小真实 timeline 用例。`lifecycle-evals.json` 的正常路径要求模型启动一个 simple 子代理，首次等待不少于 10 分钟，并且只有观察到真实终态结果才完成。`lifecycle-timeout-evals.json` 使用独立的 1 分钟 profile；子代理必须运行一个 75 秒只读 helper，使首次 wait 确定超时，然后再次等待到真实终态。如果当前 schema 提供清理工具，清理必须在结果已保留之后。runner 从隔离 rollout 读取真实 collaboration timeline，不用最终文案代替工具证据。

```bash
pnpm plugin:eval codex-enhance --skill codex-subagent-guide --batch-name lifecycle --suite lifecycle --runs 1
pnpm plugin:eval codex-enhance --skill codex-subagent-guide --batch-name lifecycle-timeout --suite lifecycle-timeout --runs 1
```

渲染单测继续验证等待与清理规则进入最终 `SKILL.md`；lifecycle suite 分别验证正常终态路径和真实 timeout 后继续等待路径。确定性 timeline 测试还覆盖缺少 timeout、timeout 后没有再次等待和过早清理的失败情况。罕见乱序、强制取消和不存在的清理工具分支不扩展为复杂模型门禁。
