---
name: run-aw-skill-evals
description: >-
  当用户要准备、验证或执行 AW Agent Skill Eval 时使用。接受 plugin/Skill/suite/profile 选择或已有 EvalSpec，复用或取得独立 EvalAudit，披露真实调用与副作用后执行，并验证 EvalResult；只在异常或结果将驱动 Skill 修改时请求 triage。
compatibility: 需要 @lesliechan721/agent-skill-eval >= 0.1.0，且 aw 与 aw-skill-eval 位于 PATH；依赖 agent-skill-toolkit。
metadata:
  short-description: 准备、审核并执行 AW Skill Eval，按需归因异常结果
---

# Run AW Skill Evals

本 Skill 是默认 AW Eval 的 Agent-facing 编排入口。它不设计 case、不修改 Skill、不发布 Review，也不复制 schema、provider 或 digest 实现。

## 1. 选择并验证 EvalSpec

已有 `<spec.json>` 时直接使用。只有 plugin/Skill/suite/profile 或 case/split/runs/baseline 选择时，先读取 `aw skill eval prepare --help`，再调用：

```bash
aw skill eval prepare <plugin> <skill> --suite <suite> --profile <profile> --output <new-spec-directory> --json
```

只添加 `--help` 当前公开的选择参数。receipt 必须 `ok=true`，并使用其 `specPath`。然后运行：

```bash
aw-skill-eval spec validate <spec.json>
```

要求零退出且 `valid=true`。用户只要求准备或验证时，返回 spec 路径和选择摘要后结束，不进入执行。

`prepare` 失败时立即报告并停止。不要为了补齐输入而初始化 Catalog、添加或同步来源，也不要到外部缓存查找替代目标。

## 2. 复用或取得 EvalAudit

先检查用户显式提供的 Audit；没有显式路径时，只检查 spec 同目录的 `audit.json`。用以下命令验证：

```bash
aw-skill-eval audit validate <audit.json> --spec <spec.json>
```

验证通过且状态为 `pass` 时复用。Audit 缺失或验证失败时，在全新上下文调用 `audit-agent-skill-evals` 的 preflight，并只传 validated spec。Auditor 或 validator 阻断时停止；不得启动模型，也不得为通过而修改 Audit、case 或 Skill。Audit 的绑定和兼容规则由 validator 拥有，不在本 Skill 中重算。

## 3. 披露调用与副作用

从 validated spec/cases 计算并显示 cases 数、runs、baseline 和预计真实模型调用数。variant 数在无 baseline 时为 1，有 without-skill 或 previous-version baseline 时为 2：

- `codex-trigger`：`cases × runs × variants`。
- `codex-conversation`：上述 provider attempt 的 2 倍，因为每次包含 conversation 和独立 grader。
- `codex-workflow`：显示 `cases × runs × variants` 个 Engine attempt，并把内部模型调用数标为未知。
- `custom-process`：调用数标为未知。

只从 validated spec/cases 和 validator receipt 显示 provider 类别、可能使用 credential、模型网络和 `outputDir`；不读取或显示 credential 值。`custom-process` 的调用数和外部影响未知，必须明确说明。执行隔离、预检和清理由 Engine 拥有，本 Skill 不复刻这些规则。

用户已明确请求执行且预计调用数 `<=10` 时直接进入下一步。预计调用数 `>10` 或未知时先取得本次确认。`custom-process` 还因外部影响未知而总是确认。确认只绑定当前 spec、Audit 和已披露副作用。

执行模式由 Engine 的预检和本次用户授权决定。若 Engine 阻断，停止并报告其诊断和恢复选项；不要手工复现预检、猜测替代路径、使用单次提权绕过或自动重试。只有用户明确接受 Engine 提示的本次非受管风险后，才按 Engine 公开帮助向本次调用传递对应授权；该授权不写入 Spec 或 Audit。

## 4. 执行

只调用一次 canonical runner：

```bash
aw-skill-eval run <spec.json> --audit <audit.json>
```

不自动重试或续跑，也不在 managed 失败后静默降级。命令失败时保留其诊断和已产生的 result 路径；没有 result 时停止并报告执行失败。Engine 在启动前阻断不属于 provider 运行失败，不自动进入高级诊断。只有模型已启动后的运行失败需要检查 provider 环境时，才转到高级诊断分支。

## 5. 验证并按需归因

对 run 返回的 result 运行：

```bash
aw-skill-eval result validate <result.json> --spec <spec.json> --audit <audit.json>
```

验证失败时停止，并把 validator 错误作为机器合同结果。验证成功后，返回 spec、Audit、result 路径、选择摘要、实际 result summary、Engine 记录的执行模式和副作用摘要。

clean success 直接结束，不要求 triage。只有出现 execution/grade 失败、current 结果混合、current 相对 baseline 回归，或该结果将驱动生产 Skill 修改时，才在全新上下文调用 `audit-agent-skill-evals` 的 result-triage，并传 validated EvalResult、spec 和 Audit。triage 默认返回聊天结论；用户指定时可写 `triage.md`。

## 高级诊断

本分支不属于五步公共路径。只在安装或版本升级、用户显式请求 provider 环境诊断，或 run 已启动模型后失败且需要定位环境问题时运行：

```bash
aw skill eval doctor --json
```

把 receipt 当作机器诊断，只报告解决当前阻断所需的状态和恢复选项；不得读取或显示 credential 值。诊断结果不替代 Spec、Audit 或 Result validation，也不自动授权重试或其它执行模式。
