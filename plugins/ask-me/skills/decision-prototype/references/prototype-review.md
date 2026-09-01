# Prototype Review

只有标准网页反馈会显著降低歧义时读取。简单文案、单图或无需定位的示例优先直接展示。

## 用户流程

1. 页面先说明现在需要决定什么，以及本次目标、比较重点和约束。
2. 候选默认使用 tabs 和一个大 Preview；静态小卡片可以按需并排。
3. 用户查看候选后给出总体判断。方向选择默认单选；只有候选允许组合时使用多选；单一候选不显示选择控件。
4. 页面根据总体判断和 Prototype 配置，再显示需要的引导问题、标注、受控参数或原因输入。
5. 页面只提供一个“提交反馈”动作。提交后显示 Agent 已收到反馈，并停止编辑。
6. `wait` 收到反馈后返回，agent 自动继续。

命令和 receipt 见 [Prototype Review 运行时接口](prototype-review-runtime.md)。详细布局见 [Review Shell UX](../assets/review-shell/UX-SPEC.md)。

## 反馈层级

1. 少量候选 + `都不接受` + 评论；
2. 引导式问题；
3. DOM、图片、文本块或流程节点标注；
4. 仅使用 Prototype 声明的 CSS 变量或其它受控 token；
5. 只有真实操作感受是决定依据时使用高保真交互。

这些能力可以组合，不需要声明互斥 UI mode。

## UI 要求

- Decision frame 显示为目标、优先级和约束，不显示 raw JSON。
- 标注使用页面内 drawer，并在 Preview 和列表中显示对应 marker；不要使用 `window.prompt`。
- `accepted` 和 `revise` 遵守 Prototype 的选择基数；`rejected` 和 `new-material-question` 不保留候选选择。
- `revise` 至少需要评论、引导答案、标注或 token 变化。
- `rejected` 和 `new-material-question` 要求用户说明原因或新问题。
- 页面可用键盘完成候选查看、选择、填写和提交。

## 工件

Prototype 目录只包含：

```text
brief.md
prototype.json
artifact/
feedback.json
verdict.md
```

Review Shell 由已安装 Skill 的 assets 直接提供；server/session 位于临时运行目录。不要生成 `review/`。

所有候选必须位于 `artifact/`，并指向普通非符号链接文件。会话只服务 Review Shell 和当前 Prototype 的 `artifact/`，不服务 Prototype 根中的其它文件。

## 标注

- 静态 HTML 关键元素使用 `data-prototype-id`；文本块或流程节点可增加 `data-prototype-kind`。
- 图片使用归一化坐标。
- 脚本型 HTML 使用不带 same-origin 权限的 sandbox，不能使用 DOM 标注或 CSS 变量控制。
- 反馈绑定 Prototype ID 和 revision；新 revision 不静默继承无法重新定位的旧标注。

## 反馈结果

- `accepted`：当前问题已有稳定结论。
- `revise`：读取具体反馈，修改 artifact，递增 revision，再启动新会话。
- `rejected`：当前候选空间不成立。
- `new-material-question`：先处理当前 Prototype 无法回答的新材料问题。

这些值只属于 `feedback.json` 及其真实工具消费者，不复制成 Skill 间聊天协议。
