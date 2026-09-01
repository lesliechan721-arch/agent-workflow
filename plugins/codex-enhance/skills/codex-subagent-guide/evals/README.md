# Codex Subagent Guide Eval

该 manifest 覆盖 default/non-default、project/user 最终制品和 lifecycle 专用 timeout profile；普通模型用例位于 project-default：

## 准备与运行

`aw skill eval prepare` 每次按 manifest 注册的一个 suite/profile 和可选 case/split 选择生成 `EvalSpec v1`。`--output` 必须指向 Workspace 外尚不存在的新目录。只做 materialization 诊断时只执行 prepare，不启动 provider：

```bash
aw skill eval prepare codex-enhance \
  codex-subagent-guide --suite trigger --profile project-default \
  --output /tmp/aw-eval-specs/codex-subagent-guide-materialization --json
```

需要模型时，先验证 Spec。复用与 current、可选 previous-version target 和 selected cases 精确绑定的单份 `EvalAudit v1`；没有可复用 Audit 时，由全新上下文生成一份。取得本次成本与副作用授权后，Runner 执行：

```bash
aw-skill-eval run /tmp/aw-eval-specs/<spec-dir>/spec.json --audit /tmp/aw-eval-specs/<spec-dir>/audit.json
```

该命令生成 `EvalResult v1`。随后运行 `aw-skill-eval result validate <result> --spec <spec> --audit <audit>`。clean success 不要求 triage。只有 execution/grade 失败、混合结果、baseline 回归，或结果将驱动生产 Skill 修改时，才由全新上下文做 result-triage；默认在聊天中返回，用户指定时可写 `triage.md`。triage 不是 Release Check 的机器输入。发布检查范围只从当前 `evals/manifest.json` 的 `requiredForRelease` 和 `releaseSplits` 派生。

## 触发评估

strict 语料分成 train（12）、validation（7）和不参与 description 调优的 sanity（6）。它检查：

- 已经由用户或临时 workspace 中的真实 `AGENTS.md` 授权委派时，加载 skill 并启动子代理。
- 只询问是否应该委派、概念文档、安装配置、明确禁止子代理等 near miss，不加载也不启动。
- 显式调用 skill 或管理已有 agent 时加载 skill，但不额外 spawn。

standard 组合性诊断语料另有 5 条，并把 `codex-subagent-guide` 与 `codex-explore` 同时列为 participant。它使用精确 loaded-skill 集合检查：只授权、不提供代理管理时由 guide 接管；真实的大范围事实探索只由 explore 接管；专用 fixture skill 已完整拥有委派生命周期时，两者都不叠加加载。涉及已存在 agent 的 trigger 用例只验证 Skill 路由，并明确禁止调用不存在的 runtime actor；真实等待由 lifecycle suite 负责。该 suite 会写临时 `.agents/` fixture。

每条 query 默认在干净会话运行三次。普通 trigger 以 `0.5` 为分界；trigger-composition 的精确 loaded-skill 路由要求 `1.0`，并禁止同时加载两个 participant。strict suite 的 validation 和 sanity 禁止加载或禁止委派负例使用零容忍，任意一次误触发都失败。`$skill` 记录为宿主显式注入，隐式加载只接受成功读取 `SKILL.md` 的执行事件；spawn 还要求原始 rollout 参数证据。

```bash
aw skill eval prepare codex-enhance codex-subagent-guide --suite trigger --profile project-default --split train --runs 3 --output /tmp/aw-eval-specs/codex-subagent-guide-trigger-train --json
aw skill eval prepare codex-enhance codex-subagent-guide --suite trigger --profile project-default --split validation --runs 3 --output /tmp/aw-eval-specs/codex-subagent-guide-trigger-validation --json
aw skill eval prepare codex-enhance codex-subagent-guide --suite trigger --profile project-default --split sanity --runs 3 --output /tmp/aw-eval-specs/codex-subagent-guide-trigger-sanity --json
aw skill eval prepare codex-enhance codex-subagent-guide --suite trigger-composition --profile project-default --runs 3 --output /tmp/aw-eval-specs/codex-subagent-guide-trigger-composition --json
```

## Routing 参数评估

`provider-evals.json` 的 36 个独立 case 覆盖四档复杂度 preset、复杂只读任务不误入 simple、范围有限的 plan/review 使用 general、高难系统任务使用 advanced、`model` / `reasoning_effort` / `agent_type` 逐字段自定义、多子任务间 override 隔离、V1/V2 干净上下文、V2 部分历史与 override、全历史与 routing 字段的版本差异、来自 AGENTS.md 或其它 skill 的 context 要求、显式参数冲突和缺失 role。Engine 每次只把一个 case、variant 和 attempt 交给 adapter。prepare 只生成 `CodexWorkflowRequest v1`；grade 只使用 Engine normalized evidence。显式 `$skill` 从 case 机械重建；隐式加载只接受 `skillLoads` evidence。spawn 路由只用 normalized evidence 中保留的原始 `spawn_agent` arguments、output 和 status 评分，不根据 query、最终说明或调用摘要猜测证据。零 spawn 仍是阻断用例的硬门禁；解释只检查非空，并用单行 `ROUTING_BLOCK_REASON=<枚举>` 记录结构化原因。Engine 或 grade 失败会停止 batch，不重试。

```bash
aw skill eval prepare codex-enhance codex-subagent-guide --suite routing --profile project-default --runs 3 --output /tmp/aw-eval-specs/codex-subagent-guide-routing --json
```

调试时可限制 case；profile/variant 组合仍由领域 runner 完整覆盖：

```bash
aw skill eval prepare codex-enhance codex-subagent-guide --suite routing --profile project-default --runs 1 --case full_history_preset --output /tmp/aw-eval-specs/codex-subagent-guide-routing-full-history-preset --json
```

`provider-evals.json` 的 36 个展开 case 都是独立的 routing 输入；V1/V2 的期望值直接绑定各自 case，不依赖 provider 内部参数或额外组合。

如果 normalized evidence 缺少原始参数、skill load、thread lineage 或完成状态，grade 会 fail closed；它不读取 `workflow-trace.json` 来补证。最终说明不能替代参数证据。

## 等待与清理评估

两份 lifecycle case 文档各提供一条最小真实 timeline 用例。`lifecycle-evals.json` 的正常路径要求模型启动一个 simple 子代理，首次等待不少于 10 分钟，并且只有观察到真实终态结果才完成。`lifecycle-timeout-evals.json` 使用独立的 1 分钟 profile；子代理必须运行一个 75 秒只读 helper，使首次 wait 确定超时，然后再次等待到真实终态。如果当前 schema 提供清理工具，清理必须在结果已保留之后。grade 只从 `workflow-evidence.json` 读取 collaboration order、wait output/status、terminal result 和 Engine cleanup 确认，不用最终文案或 raw trace 代替工具证据。

```bash
aw skill eval prepare codex-enhance codex-subagent-guide --suite lifecycle --profile project-default --runs 1 --output /tmp/aw-eval-specs/codex-subagent-guide-lifecycle --json
aw skill eval prepare codex-enhance codex-subagent-guide --suite lifecycle-timeout --profile project-timeout --runs 1 --output /tmp/aw-eval-specs/codex-subagent-guide-lifecycle-timeout --json
```

渲染单测继续验证等待与清理规则进入最终 `SKILL.md`；lifecycle suite 分别验证正常终态路径和真实 timeout 后继续等待路径。确定性 timeline 测试还覆盖缺少 timeout、timeout 后没有再次等待和过早清理的失败情况。罕见乱序、强制取消和不存在的清理工具分支不扩展为复杂模型门禁。
