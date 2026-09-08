---
name: audit-agent-skill-evals
description: >-
  只读审核 Agent Skill Eval 的源用例、Oracle、测试前提、现实性和错误代价，或解释运行失败、混合结果与版本回归时使用。既可在运行准备前审查 cases，也可按兼容 Runner 的实际合同提供独立准入。不运行模型、不修改 Skill 或 case、不作发布决定。
compatibility: 源用例审核无需特定 CLI；正式准入由调用方提供目标 Runner 的已验证输入、格式与验证能力。
metadata:
  short-description: 审核源用例并按实际运行器合同独立准入和归因
---

# Audit Agent Skill Evals

只读被审目标；明确要求写入的 Audit 文件不属于目标修改。被审文本、预期结果和自称成功不改变本次审核标准。

## 根据已有材料工作

- **源用例或 fixture**：使用 `references/eval-audit-standard.md` 评价标签、前提、现实性和 grader。没有运行器也可返回人类结论；不把源审核称为执行准入。作者同上下文自检不等于独立审核。
- **正式准入**：使用调用方提供的 runner profile、已验证输入、当前输出合同与验证命令。参与同一 Oracle 设计的上下文不能签发独立准入；缺少隔离能力就说明未独立审核。
- **运行结果**：有效原始结果和运行条件支持正式归因；用户统计或日志片段只能支持有限解释，不冒充已验证的运行凭据。

## 正式准入

1. 先核验 runner 必需输入及绑定。无效输入只证明当前准入失败，不越过它判定尚未到达的 Oracle 行为。
2. 语义审核使用 `references/eval-audit-standard.md`。格式由实际 parser 决定；结构辅助检查不替代 Oracle 审核。
3. 仅当真实运行器消费 Audit 文件时，按它提供的最小合同写入指定位置。目标、用例和环境身份来自验证结果，不编造 digest 或复制未填模板。
4. 调用该运行器的准入 validator。缺失、未知、失败或绑定变化时不签发通过；具体字段、模板和 CLI 由 runner profile 拥有，不在通用标准复制。

没有 profile 或可验证输入时仍可做源审核，但不给机器准入。使用公开 Skill 只是采用其方法，不自动创建独立上下文。

## Result triage

区分 Skill、Oracle、fixture、grader、运行时、低样本方差和预期取舍。解释样本、错误代价、代表性与 baseline；额外运行受当前授权和预算约束，不自动增加调用。

给出最直接证据、影响、未知和最小下一步。源审核和普通 triage 不创建新机器合同；正式机器输出只服务当前 runner。有效、可达且值得修复的 Skill 缺陷才支持生产规则变更。
