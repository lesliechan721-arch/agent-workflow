---
name: run-aw-skill-evals
description: >-
  当用户或其它公开 Skill 要准备、验证或执行 AW Agent Skill Eval 时使用。接受 plugin/Skill/suite/profile 选择或已有 EvalSpec，复用或取得独立 EvalAudit，披露模型调用、credential/network/process 与输出副作用后执行并验证 EvalResult；只在异常、混合、回归或结果将驱动 Skill 修改时做独立 triage。
compatibility: 需要 @lesliechan721/agent-skill-eval >=0.1.0，且 aw 与 aw-skill-eval 位于 PATH；依赖 agent-skill-toolkit。
metadata:
  short-description: 准备、审核、执行并验证 AW Skill Eval
---

# Run AW Skill Evals

涉及本运行器的用例格式、正式 Audit 合同或从通用 Author/Auditor 接入时，读取 `references/aw-eval-profile.md`。AW 格式辅助脚本为 `scripts/validate-eval-cases.mjs`；消费者模板为 `assets/eval-audit-template.json`。结构检查不代替官方 parser、语义审核或真实运行。

## 1. 选择并验证 EvalSpec

- 已有 Spec 直接验证。
- 只有 plugin/Skill/suite/profile/case/split/runs/baseline 选择时，先读 `aw skill eval prepare --help`，再调用公开 prepare 命令生成新的 Spec 目录。
- 运行 `aw-skill-eval spec validate <spec>`，要求零退出且 `valid=true`。
- 用户只要求准备或验证时返回路径和选择摘要后结束。

## 2. 复用或取得 EvalAudit

- 只检查用户显式 Audit，或 Spec 同目录的 `audit.json`。
- 用 `aw-skill-eval audit validate <audit> --spec <spec>` 验证 provider、workspace、current/previous target、case digest 和 selected cases。
- 精确绑定且 `status=pass` 时复用；缺失或陈旧时在独立上下文使用 `audit-agent-skill-evals` preflight，同时提供 validated Spec、selected cases、相关 fixture、本 Skill 的 `references/aw-eval-profile.md` 实际路径、当前模板/验证命令与本次允许的输出位置；只传本次需要的合同，不把整个运行流程交给 Auditor。
- fail/unknown/blocked/覆盖不完整时停止；不为通过而修改 Audit、case 或 Skill。

## 3. 披露成本与副作用

从 validated Spec/cases 计算 cases、runs、baseline variants 和预计真实模型调用数。显示 provider 进程类别、可能使用现有 credential 环境、模型网络、custom-process 未知影响和 validator 解析出的 outputDir；绝不读取 credential 值。

- 明确请求且预计内置模型调用 `<=10` 可直接执行；
- `>10`、调用数未知或 custom-process 需要覆盖本次成本与副作用的明确授权；已有明确覆盖当前输入的授权沿用，不重复请求；
- 确认只绑定当前 Spec、Audit 和已披露副作用。

执行前读取 `references/execution-and-safety.md`，由 Engine 检查会话权限、macOS Codex/keychain 与进程管理条件。

## 4. 执行

只调用 canonical runner：

```bash
aw-skill-eval run <spec.json> --audit <audit.json>
```

不自动 retry 或续跑。Engine 阻断时报告原始诊断和恢复选项，不手动绕过检查或用单次提权重试。只有用户明确接受本次非受管风险时，才向同一命令传 `--allow-unmanaged-processes`。命令失败时保留诊断和已有 result 路径；没有 result 即停止。

## 5. 验证与按需归因

运行 result validator，要求零退出且 `valid=true`。成功后返回 Spec、Audit、Result 路径、选择摘要、实际 summary 和副作用摘要。

clean success 直接结束。execution/grade 失败、current 混合、baseline 回归，或结果将驱动生产 Skill 修改时，在独立上下文使用 `audit-agent-skill-evals` result-triage。

普通回复不需要新结构化合同；机器事实已由 Spec/Audit/Result 拥有。
