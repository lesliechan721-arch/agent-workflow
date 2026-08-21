# Decision Prototype

当一个重要决定必须看到、运行或操作候选结果后才能可靠作出时，制作回答单一问题的轻量原型。

原型可以是图片、交互网页、流程 walkthrough、API consumer 示例、状态模拟器或技术 spike。它默认可丢弃，产物不是生产实现；真正需要长期保存的是用户确认的决定和证据。

## 适合使用

- 讨论无法让用户判断界面、流程或信息结构。
- 需要用 consumer 示例感受 API 或配置形态。
- 技术路线必须通过最小 spike 获得可行性证据。

## 边界

- 一个原型只回答一个问题。
- 不追求生产级抽象、兼容性或完整异常处理。
- 不自动把原型升级为生产实现。
- 完成后返回独立的决定记录；它不拥有后续访谈、Spec 或实施流程。

主要指令见 [`SKILL.md`](SKILL.md)，模板见 [`assets/prototype-brief.md`](assets/prototype-brief.md)，评测材料见 [`evals/`](evals/)。
