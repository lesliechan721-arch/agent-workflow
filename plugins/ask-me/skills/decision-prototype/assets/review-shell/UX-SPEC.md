# Prototype Review Shell UX

## 页面结构

```text
[当前决策问题]
[目标、优先级、约束]

[候选 tabs] [可选：并排比较]
[大尺寸 Preview]

[候选选择与总体判断]
[按需：引导问题、标注、受控参数或原因]

[提交反馈]
```

## 候选与 Preview

- tabs 默认一次显示一个候选，避免 Preview 被压缩。
- 可主动切换并排比较；移动端保持单 Preview。
- HTML 支持 desktop/mobile viewport；图片支持缩放；文本和 API 示例保持可读行宽。
- `single` 使用 radio，`multiple` 使用 checkbox，`none` 不显示选择控件。

## 渐进反馈

先让用户查看候选并选择总体判断，再显示相关详细输入：

- `accepted`：要求满足选择基数，详细说明可选。
- `revise`：要求满足选择基数，并至少提供评论、引导答案、标注或非默认参数之一。
- `rejected`：清空候选选择，并要求不接受原因。
- `new-material-question`：清空候选选择，并要求需要先澄清的新问题。

## 标注

点击稳定目标后打开 drawer。Preview 显示编号 marker；点击标注列表可回到目标。不要使用 `window.prompt`。

## 提交和无障碍

- 页面只有一个主按钮“提交反馈”。
- 提交成功后禁用编辑，并说明 Agent 已收到反馈。
- 后续同 revision 页面不得覆盖首个反馈，并应说明当前提交未替换已有结果。
- 所有选择、drawer 和提交可使用键盘；错误靠近对应控件；状态不能只依靠颜色表达。
