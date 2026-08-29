# Decision Prototype

当一个重要决定必须看到、运行或操作候选结果后才能可靠作出时，制作回答单一问题的轻量原型。

原型可以是图片、交互网页、流程 walkthrough、API consumer 示例、状态模拟器或技术 spike。默认先用 2–4 个候选、`都不接受` 和补充评论取得反馈；只有需要精确定位或连续调整时才升级到引导问题、标注、受控参数或高保真交互。

需要标准网页反馈时，Skill 可以创建只绑定 `127.0.0.1` 的 Review Shell。机器反馈保存在与当前 Prototype revision 绑定的 `feedback.json`。复杂 Prototype 可以使用 builder 子代理，但用户决定仍由当前 Skill 负责。

## 适合使用

- 讨论无法让用户判断界面、流程或信息结构。
- 需要用 consumer 示例感受 API 或配置形态。
- 技术路线必须通过最小 spike 获得可行性证据。

## 边界

- 一个原型只回答一个问题。
- 不追求生产级抽象、兼容性或完整异常处理。
- 不自动把原型升级为生产实现。
- 完成后返回独立的决定记录；它不拥有后续访谈、Spec 或实施流程。
- 原型默认可丢弃；长期保留的是当前有效决定、证据和仍未解决的问题。

主要指令见 [`SKILL.md`](SKILL.md)，模板见 [`assets/prototype-brief.md`](assets/prototype-brief.md)，评测材料见 [`evals/`](evals/)。
