---
name: run-aw-skill-evals
description: >-
  准备、验证或执行 AW Agent Skill Eval 时使用。根据 plugin、Skill、suite、profile 等选择生成 EvalSpec，或使用已有 Spec；执行前复用或取得独立 EvalAudit、确认成本与副作用，执行后验证 EvalResult，并在异常或结果将驱动修改时安排独立归因。
compatibility: 需要 @lesliechan721/agent-skill-eval >=0.1.0，且 aw 与 aw-skill-eval 位于 PATH；依赖 agent-skill-toolkit。
metadata:
  short-description: 准备 AW Skill Eval、核验独立准入、执行并验证实际结果
---

# Run AW Skill Evals

把本次选择落实为有效 Spec，在独立审核与执行授权成立后运行，并交付可核验的结果。用例设计采用 `author-agent-skill`，Oracle 与结果的语义判断采用 `audit-agent-skill-evals`；本技能负责 AW 格式、输入绑定、执行条件和工具操作。

## 确定本次结果

| 用户请求 | 完成点 |
| --- | --- |
| 准备 Eval | 生成并验证 Spec，交付实际选择与路径 |
| 验证已有 Spec、Audit 或 Result | 执行相应公开 validator，报告诊断与绑定；不启动模型 |
| 执行 Eval | 继续完成独立 Audit、成本与环境检查、运行和结果验证 |

设计或审核 AW 用例、接入通用 Author/Auditor、处理正式 Audit 合同时，读取 [AW 格式与准入](references/aw-eval-profile.md)。已有有效输入直接采用，不重建无关资产。

## 准备或验证输入

已有 Spec 使用 `aw-skill-eval spec validate <spec.json>`。只有 plugin/Skill/suite/profile/case/split/runs/baseline 选择时，先查询 `aw skill eval prepare --help`，再向新目录准备 Spec。验证须零退出且 `valid=true`；仅准备或验证的请求在交付相应结果后结束。

验证 Audit 使用 `aw-skill-eval audit validate <audit.json> --spec <spec.json>`；验证 Result 使用下方完整命令及其对应输入。格式通过只证明机器合同，不证明 Oracle 或 Skill 质量。

## 核验执行条件

**独立 Audit。** 只检查用户指定的 Audit 或 Spec 同目录的 `audit.json`。通过公开 validator 核验 provider、workspace、current/previous target、case digest 和全部 selected cases；精确绑定且 `status=pass` 才复用。

缺失或陈旧时，在独立上下文使用 `audit-agent-skill-evals` 的 preflight，提供 validated Spec、所选用例、相关 fixture、本技能 profile 和 [Audit 模板](assets/eval-audit-template.json) 的实际路径、验证命令及允许的输出位置。只交接本次所需合同。无法取得独立审核，或结果为 fail/unknown/blocked、覆盖不完整时停止；不代签 passing Audit，也不为通过而改用例或目标。

**成本与授权。** 从 validated Spec/cases 计算 cases、runs、baseline variants 与真实模型调用估算，披露 provider 进程类别、现有凭据环境的使用、模型网络、custom-process 的未知影响及 validator 解析出的 outputDir；不读取凭据值。明确请求执行且预计内置调用不超过 10 次时可继续；超过 10 次、调用数未知或 custom-process，须有覆盖当前 Spec、Audit、成本与副作用的明确授权。已有授权仍适用时沿用。

**执行环境。** 执行前读取 [执行与安全](references/execution-and-safety.md)，采用其中的调用估算和 Engine 权限、macOS Codex/keychain、进程管理条件。Audit、成本授权和环境检查分别成立，彼此不能替代。

## 执行与验证结果

只使用 canonical runner：

```bash
aw-skill-eval run <spec.json> --audit <audit.json>
aw-skill-eval result validate <result.json> --spec <spec.json> --audit <audit.json>
```

第二条使用实际运行返回的 Result 路径，要求零退出且 `valid=true`。不自动重试或续跑。Engine 阻断时保留原始诊断及恢复选项，不绕过检查或用单次提权重试；只有用户明确接受本次非受管风险时才可使用 `--allow-unmanaged-processes`。失败时保留已有 Result 并验证；没有 Result 即报告诊断后停止。

交付实际 Spec/Audit/Result 路径、选择、summary 与副作用。执行或评分失败、current 混合、baseline 回归，或结果将驱动生产 Skill 修改时，在独立上下文采用 `audit-agent-skill-evals` 的 result-triage；缺少条件时明确尚未归因。其余 clean success 在交付结果后结束。普通回复无须另建结构化协议，机器事实由 Spec/Audit/Result 记录。
