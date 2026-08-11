# Codex Subagent Guide Eval

统一入口会先按 `evals/manifest.json` materialize default/non-default、project/user 最终制品；真实模型只运行 project-default：

```bash
pnpm plugin:eval codex-subagent-guide --materialize-only --output-dir /tmp/codex-subagent-guide-eval
pnpm plugin:eval codex-subagent-guide --suite trigger --split validation --runs 1 --output-dir /tmp/codex-subagent-guide-eval
pnpm plugin:eval codex-subagent-guide --output-dir /tmp/codex-subagent-guide-release
```

最后一条运行全部 release-required suite/split。`pnpm plugin:eval` 是唯一模型评测入口；routing runner 缺少中央提供的 final-artifact root 时会直接失败。

## 触发评估

固定语料分成 train（14）、validation（9）和不参与 description 调优的 sanity（7）。它同时检查：

- 已经由用户或临时 workspace 中的真实 `AGENTS.md` 授权委派时，加载 skill 并启动子代理。
- 临时安装的上游 skill 只授权、不提供代理管理时加载；专用 fixture skill 已完整拥有委派生命周期时不叠加加载。
- 只询问是否应该委派、概念文档、安装配置、明确禁止子代理等 near miss，不加载也不启动。
- 显式调用 skill 或管理已有 agent 时加载 skill，但不额外 spawn。

每条 query 默认在干净会话运行三次，以 `0.5` 为严格分界。`$skill` 记录为宿主显式注入，隐式加载只接受成功读取 `SKILL.md` 的执行事件；spawn 还要求原始 rollout 参数证据。中央 native trigger driver 使用只读临时 workspace 和隔离 `CODEX_HOME`，插件 fixture module 只准备授权场景；常规插件测试只检查语料、fixture 和领域 grader，不调用模型。

```bash
pnpm plugin:eval codex-subagent-guide --suite trigger --split train --runs 3 --output-dir /tmp/codex-subagent-guide-eval
pnpm plugin:eval codex-subagent-guide --suite trigger --split validation --runs 3 --output-dir /tmp/codex-subagent-guide-eval
pnpm plugin:eval codex-subagent-guide --suite trigger --split sanity --runs 3 --output-dir /tmp/codex-subagent-guide-eval
```

## Routing 参数评估

`evals.json` 覆盖四个预设 role、复杂只读任务不误入 simple、`model` / `reasoning_effort` / `agent_type` 逐字段自定义、多子任务间的 override 隔离、V1/V2 干净上下文、V2 部分历史与 override、全历史继承、来自 AGENTS.md 或其它 skill 的 context 要求、显式参数冲突和缺失 role。runner 对每个 case 运行 V1/V2，并用相同 prompt 对比 `with_skill` 与 `without_skill`；skill 加载只接受实际 `SKILL.md` 读取事件，spawn 路由只用隔离 rollout 中的原始 `spawn_agent` arguments 评分，不根据 query、最终说明或调用摘要猜测证据。

```bash
pnpm plugin:eval codex-subagent-guide --suite routing --runs 3 --output-dir /tmp/codex-subagent-guide-eval
```

调试时可限制 case；profile/variant 组合仍由领域 runner 完整覆盖：

```bash
pnpm plugin:eval codex-subagent-guide --suite routing --runs 1 --case partial_preset --output-dir /tmp/codex-subagent-guide-eval
```

runner 默认用 `gpt-5.6-luna` 运行 V1、`gpt-5.6-sol` 运行 V2，可用 `--v1-model` / `--v2-model` 调整。临时 home 只复制现有认证文件且权限设为 `0600`，模型 shell 环境不继承该路径，结束或中断后会删除。任何认证、网络、CLI 或 schema 环境错误都会令报告 `complete: false` 并返回非零，不会静默跳过。

如果 stdout 只给出简化的协作事件，却没有可读取的隔离 rollout 原始参数，runner 也会标记 `raw_evidence_missing` 和 `complete: false`；最终说明或调用事件不能替代参数证据。

渲染单测只验证响应式长等待、终态、条件清理和监控禁令等等待与清理不变量已进入最终 `SKILL.md`，不验证模型是否按这些规则行动。实时 routing eval 在 spawn 后停止，不启动长时间等待或清理工作流；这些行为仍需要 workflow eval 或人工轨迹检查。
