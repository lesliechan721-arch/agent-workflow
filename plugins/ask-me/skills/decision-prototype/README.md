# Decision Prototype

当一个重要决定必须看到、运行或操作候选结果后才能可靠作出时，制作回答单一问题的轻量原型。

原型可以是图片、交互网页、流程 walkthrough、API consumer 示例、状态模拟器或技术 spike。默认先用少量候选和补充评论取得反馈；只有需要精确定位或连续调整时才增加引导问题、标注或受控参数。

需要标准网页反馈时，Skill 启动只绑定 `127.0.0.1` 的临时 Review 会话。页面先显示决定目标和比较重点，再用 tabs 展示单个大预览；用户可以按需并排比较、切换 HTML 宽度、缩放图片或在 drawer 中添加局部标注。页面只有一个反馈提交动作。提交成功后页面停止编辑，Agent 通过 `wait` 读取与准确 Prototype ID 和 revision 绑定的 `feedback.json`。临时服务器和会话文件位于系统临时目录，不复制到 Prototype 目录。

## 适合使用

- 讨论无法让用户判断界面、流程或信息结构。
- 需要用 consumer 示例感受 API 或配置形态。
- 技术路线必须通过最小 spike 获得可行性证据。

## 边界

- 一个原型只回答一个问题。
- 不追求生产级抽象、兼容性或完整异常处理。
- 不自动打开浏览器，也不把原型升级为生产实现。
- 超时或取消不表示用户已经作出决定。
- Prototype 目录只保存 brief、配置、artifact、feedback 和 verdict。

主要指令见 [`SKILL.md`](SKILL.md)，模板见 [`assets/prototype-brief.md`](assets/prototype-brief.md)，评测材料见 [`evals/`](evals/)。
