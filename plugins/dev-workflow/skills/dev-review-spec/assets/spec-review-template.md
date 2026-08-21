# Spec Review

- Target: `<spec path>`
- Target revision: `<git blob/OID or sha256>`
- Reviewed at: `<ISO-8601>`
- Review context: `independent`
- Result: `clean | blocked | incomplete`

## 结论

用一句话说明原因。`incomplete` 必须说明独立 reviewer、目标稳定性或证据中的具体缺口。

## 阻塞问题

按影响排序。每项包含：

- 问题
- 证据或位置
- 对用户批准或实现的影响
- 处理类型：`material-decision` / `evidence-needed` / `spec-defect` / `over-specified` / `fact-gap` / `mechanical-validation`
- 最小修正条件

没有阻塞问题时写“无”。

## 过度规定

列出应从 Spec 删除或移入实现工作记忆的内容。

## 剩余风险

只保留不阻塞批准但用户或实现者应知道的风险。

## 建议动作

描述一个最小动作，不指定由哪个 Skill 执行。
