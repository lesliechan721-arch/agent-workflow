# Decision Prototype

用可体验证据回答一个有边界的决定。独立调用即可使用，不要求先创建 Shape 或开发 Spec。

先判断缺少什么证据，再选择原型形态与反馈通道。状态问题使用可操作模型，界面问题使用有实质差异的候选，技术问题使用实际实验。简单文案可以直接在聊天中比较。

需要保存时采用用户或仓库的目录约定。默认在 `prototypes/<decision-id>/` 保存说明、`artifact/` 和结论；使用标准网页 Review 或用户明确要求时才添加 `prototype.json`，网页提交时才产生 `feedback.json`。Review Shell 从 Skill assets 服务，临时会话不写入原型目录。

网页反馈优先采用用户可交互的原生预览，其次由 `prototype-review.mjs open` 打开默认浏览器；`wait` 接收真实提交，运行时独立回收会话。具体用法见脚本 `--help`。

主代理保持用户沟通和证据判断；高成本构建可委派 Builder。持久化不自动意味着必须使用子代理。
