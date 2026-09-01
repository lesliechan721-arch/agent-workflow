# Audit Agent Skill Evals

在模型执行前审核 Agent Skill Eval 的现实性、Oracle 和错误代价，或在执行后解释失败、混合结果和 baseline 回归。

## 适合使用

- `preflight`：从已验证 EvalSpec 的绑定输入生成一份 EvalAudit v1，决定是否允许执行。
- `result-triage`：从已验证 EvalResult、spec 和 Audit 解释问题来源，给出收集证据或修正 Eval 的建议。

## 工作方式

preflight 保持只读，并且必须由没有参与当前 case/Oracle 设计的上下文完成。机器核对 provider、workspace、current/previous target、case digest 和 selected cases；人工只读 case 明确引用的材料。result-triage 默认在聊天中返回，也可以按用户要求写 `triage.md`。clean success 不需要额外 triage。

## 边界

本 Skill 不创建 case、不运行模型、不修改生产 Skill，也不输出发布资格或机器 gate。实际执行由兼容 Eval Runner 负责。
