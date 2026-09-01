# Design Agent Skill Evals

为 Agent Skill 创建或修改最小、现实且可审核的 Eval case/suite，覆盖 trigger、conversation 或 custom-process 场景。

## 适合使用

- 建立 materially distinct 的代表、回归、边界、挑战和诊断场景。
- 把 unit、participants、错误成本 policy 和 runtime 条件放在 suite 级。
- 为关键边界增加有理由的 Oracle、允许方差或 minimal counterexample。

## 结果

交付物是与当前 Eval 合同一致的 case/suite、必要 fixture 和 `Audit status: not assessed`。普通 case 不重复 suite metadata；只有关键 tag 才增加条件性审核信息。

## 边界

本 Skill 只写用户指定的 Eval 资产。它不审核自己的 Oracle、不运行模型 Eval，也不修改生产 Skill。
