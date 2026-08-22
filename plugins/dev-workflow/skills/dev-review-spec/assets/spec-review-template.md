# Spec Review

- Target: `<spec path>`
- Version: `<version identifier>`
- Assurance: `Fast | Standard | Assured`
- Result: `clean | blocked | incomplete`

## 结论

用一句话说明是否可以批准。`incomplete` 说明独立 reviewer、目标稳定性或证据中的具体缺口。

## Findings

一次列出当前证据支持的全部 blocker，并按影响排序。每项包含：

- 问题
- 证据或位置
- 对批准或实现的影响
- 类型：`material-decision` / `evidence-needed` / `spec-defect` / `over-specified` / `fact-gap` / `mechanical-validation`
- 修正条件

没有 blocker 时写“无”。偏好性改进放入非阻塞建议，不改变 Result。

## 非阻塞建议

只记录不会改变当前批准门槛的改进。没有时写“无”。

## 剩余风险

只保留不阻塞批准但用户或实现者应知道的风险。

## 与上一份 Review 比较

仅在复审时保留：

- 已解决：
- 仍存在：
- 新发现：

## 建议动作

给出一个明确的能力级动作，不指定具体 Skill。Review 需要用户决定时，只给用户可选动作，不继续自动修订。
