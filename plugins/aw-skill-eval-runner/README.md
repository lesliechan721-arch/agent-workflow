# AW Skill Eval Runner

准备、验证或执行 AW Agent Skill Eval，复用独立审核并验证运行结果。依赖 `agent-skill-toolkit`。

```bash
aw install aw-skill-eval-runner -p codex
```

也支持 Claude，可将平台改为 `claude`。需要 PATH 中兼容的 `aw` 和 `aw-skill-eval`。包含公开能力 `run-aw-skill-evals`，其它 Skill 也可按当前任务使用它。

例如：“为这个 Skill 准备 Eval，但不要调用模型。”或“在已批准的预算内运行这个 Spec，使用其当前 Audit。”准备与格式检查可以独立完成，源 Oracle 审核由 Auditor 负责。

真实执行可能访问模型网络、使用现有凭据和运行外部进程。先说明成本与输出，未知成本或自定义进程需要明确授权。默认需要整个会话的 Full Access 语义和进程树检查；单次提权不足。用户明确接受的非受管模式不保证后代清理，也不能绕过 macOS Codex/keychain 拒绝。不会修改用户 keychain 来解除阻断。

失败不自动重试。结果先验证，只有异常、混合、回归或将驱动修改时才做进一步归因；本插件不作发布决定。
