# Run AW Skill Evals

准备、审核并执行 AW Agent Skill Eval。它接受已有 EvalSpec，也可以从 plugin、Skill、suite、profile 和 case 选择生成 EvalSpec。

## 适合使用

- 准备或验证一个 AW Skill Eval，但暂不执行模型。
- 复用已绑定的 EvalAudit，或在缺失时取得独立 preflight。
- 在可见的成本和副作用边界内执行，并得到已验证 EvalResult。

## 工作方式

执行前只从已验证 Spec/cases 显示 case/runs/baseline、预计真实调用数、provider 进程类别、可能使用现有 credential 环境、模型网络和输出路径。用户已明确要求且预计不超过 10 次内置模型调用时可直接执行；更高成本或 custom process 会再次确认。

clean success 不增加额外 triage。只有执行或评分异常、混合结果、baseline 回归，或结果将用于修改生产 Skill 时，才调用独立 Auditor 做 result-triage。

普通成功路径不运行环境 doctor。只有安装或版本升级、用户明确请求诊断，或执行失败需要定位 provider 环境时，才进入高级诊断分支。

## 边界

本 Skill 不设计 case、不修改生产 Skill、不实现执行引擎，也不作 Quality Review 或发布决定。执行会启动外部进程、访问模型网络并写入已披露的 output 路径。
