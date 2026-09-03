# Run AW Skill Evals

准备、审核并执行 AW Agent Skill Eval。它接受已有 EvalSpec，也可以从 plugin、Skill、suite、profile 和 case 选择生成 EvalSpec。

## 适合使用

- 准备或验证一个 AW Skill Eval，但暂不执行模型。
- 复用已绑定到 provider、workspace、current/previous target、case digest 和 selected cases 的 EvalAudit，或在缺失时取得独立 preflight。
- 在可见的成本和副作用边界内执行，并得到已验证 EvalResult。

## 工作方式

执行前只从已验证 Spec/cases 和 validator receipt 显示 case/runs/baseline、预计真实调用数、provider 类别、可能使用 credential、模型网络和输出路径。用户已明确要求且预计不超过 10 次内置模型调用时可直接执行；更高成本或 custom process 会再次确认。

Engine 负责执行预检、隔离和清理。若它阻断运行，Runner 只报告诊断和恢复选项，不复刻检查、不绕过，也不自动重试。只有用户明确接受 Engine 提示的本次 unmanaged 风险后，Runner 才给该次命令增加相应 flag。

clean success 返回已验证 EvalResult 和 Engine 记录的执行模式，不增加额外 triage。只有执行或评分异常、混合结果、baseline 回归，或结果将用于修改生产 Skill 时，才调用独立 Auditor 做 result-triage。

普通成功路径不运行环境 doctor。只有安装或版本升级、用户明确请求诊断，或模型已启动后的执行失败需要定位 provider 环境时，才进入高级诊断分支。

## 边界

本 Skill 不设计 case、不修改生产 Skill、不实现执行引擎，也不作 Quality Review 或发布决定。执行会启动外部进程、访问模型网络并写入已披露的 output 路径。
