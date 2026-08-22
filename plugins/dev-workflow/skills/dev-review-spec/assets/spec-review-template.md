# Spec Review

- Target: `<spec path>`
- Version: `<version identifier>`
- Assurance: `Fast | Standard | Assured`
- Result: `clean | blocked | incomplete`
- Repair round: `<0 for initial review; increment after each repair>`
- Progress: `initial | advancing | stalled | regressed`
- Automatic repair: `not-needed | continue | stop`

## 结论

用一句话说明是否可以批准。`incomplete` 说明独立 reviewer、目标稳定性或证据中的具体缺口。

## Findings

一次列出当前证据支持的全部 blocker，并按影响排序。每项包含：

- 问题
- 证据或位置
- 对批准或实现的影响
- 类型：`material-decision` / `evidence-needed` / `spec-defect` / `over-specified` / `fact-gap` / `mechanical-validation`
- 修正条件
- 复审新增项来源：`repair-regression` / `previously-hidden` / `critical-omission`，初次 Review 或非新增项省略

没有 blocker 时写“无”。偏好性改进放入非阻塞建议，不改变 Result。

## 非阻塞建议

只记录不会改变当前批准门槛的改进。没有时写“无”。

## 剩余风险

只保留不阻塞批准但用户或实现者应知道的风险。

## 修复与复审

- 允许的修复范围：当前 blocker、必需影响面、直接 regression
- 复审条件：
- 与上一轮相比：
- 停止原因：`无 / stalled / regressed / budget-exhausted / reviewer-conflict`

## 建议动作

给出一个明确的能力级动作，不指定具体 Skill。Automatic repair 为 `stop` 时只给用户决策选项，不继续自动修订。
