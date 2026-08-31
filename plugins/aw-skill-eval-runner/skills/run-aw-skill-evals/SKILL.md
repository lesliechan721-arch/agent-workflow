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

## 2. 复用或取得 EvalAudit

先检查用户显式提供的 Audit；没有显式路径时，只检查 spec 同目录的 `audit.json`。用以下命令验证 provider、workspace digest、current target、可选 previous-version target、case digest 和 selected case 覆盖：

```bash
aw-skill-eval audit validate <audit.json> --spec <spec.json>
```

精确绑定且 `status=pass` 时复用；`runs` 或 `timeoutMs` 改变不影响复用。Audit 缺失或绑定陈旧时，在全新上下文调用 `audit-agent-skill-evals` 的 preflight，并只传 validated spec。旧版使用字符串 `workspace` 的 v1 Spec 必须重新 prepare 并重新 Audit。`status=fail` 或 `unknown`、blocked case、格式错误或重新验证失败时停止；不得启动模型，也不得为通过而修改 Audit、case 或 Skill。

## 3. 披露调用与副作用

从 validated spec/cases 计算并显示 cases 数、runs、baseline 和预计真实模型调用数。variant 数在无 baseline 时为 1，有 without-skill 或 previous-version baseline 时为 2：

- `codex-trigger`：`cases × runs × variants`。
- `codex-conversation`：上述 provider attempt 的 2 倍，因为每次包含 conversation 和独立 grader。
- `codex-workflow`：`cases × runs × variants` 个 Engine attempt；每个 attempt 只有一个 Engine-owned app-server root，后代模型 turn 取决于该 workflow 的真实委派行为。
- `custom-process`：调用数标为未知。

只从 validated spec/cases 显示 provider 进程类别、可能使用现有 credential 环境、模型网络和 validator 解析出的 `outputDir`。`codex-trigger` 和 `codex-conversation` 属于内置 Codex provider 进程，会访问模型网络，并可能使用当前 credential 环境；不读取或显示 credential 值。`codex-workflow` 只在 macOS/Linux 运行，真实模型网络、credential 使用和 app-server 生命周期由 Engine 拥有；adapter 的 prepare/grade 不接收 credential 或 proxy。Engine 每个 attempt 建立一个 app-server root，采集脱敏 trace、normalized evidence 和 model output；attempt 失败会停止 batch，不 retry。`custom-process` 属于自定义外部进程，其实际调用数、credential、网络行为和副作用未知。它是可信、协作式 provider，不是任意外部程序 sandbox。Engine 只在 macOS/Linux 启动它，并在运行期观察；违反或检查失效会 fail closed、丢弃 grade 并停止 batch。Runner 只披露并调用 Engine，不重复该运行期检查。

用户已明确请求执行且预计调用数 `<=10` 时直接进入下一步。预计调用数 `>10` 时先取得本次确认。`custom-process` 因调用数和外部影响未知，任何执行都先确认。确认只绑定当前 spec、Audit 和已披露副作用。

## 4. 执行

只调用一次 canonical runner：

```bash
aw-skill-eval run <spec.json> --audit <audit.json>
```

不自动重试或续跑。命令失败时保留其诊断和已产生的 result 路径；没有 result 时停止并报告执行失败。run 失败且需要检查 provider 环境时，转到高级诊断分支。

## 5. 验证并按需归因

对 run 返回的 result 运行：

```bash
aw-skill-eval result validate <result.json> --spec <spec.json> --audit <audit.json>
```

验证失败时停止，并把 validator 错误作为机器合同结果。验证成功后，返回 spec、Audit、result 路径，选择摘要、实际 result summary 和副作用摘要。

clean success 直接结束，不要求 triage。只有出现 execution/grade 失败、current 结果混合、current 相对 baseline 回归，或该结果将驱动生产 Skill 修改时，才在全新上下文调用 `audit-agent-skill-evals` 的 result-triage，并传 validated EvalResult、spec 和 Audit。triage 默认返回聊天结论；用户指定时可写 `triage.md`。

## 高级诊断

本分支不属于五步公共路径。只在安装或版本升级、用户显式请求 provider 环境诊断，或 run 失败后需要定位环境问题时运行：

```bash
aw skill eval doctor --json
```

只报告可执行文件、credential 名称及存在状态和进程清理支持；不得读取 credential 值。诊断结果不替代 Spec、Audit 或 Result validation，也不自动授权重试。
