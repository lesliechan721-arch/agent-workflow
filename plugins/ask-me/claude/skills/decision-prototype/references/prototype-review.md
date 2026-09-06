# Prototype Review

只有标准网页反馈会显著降低歧义时读取。简单文案、单图或无需定位的示例优先直接展示。

## 何时使用

适合网页 Review：

- 需要在多个可视或可操作候选间切换；
- 用户需要指出具体位置；
- 引导问题、标注或受控参数能显著减少描述误差；
- 需要让网页提交后由 agent 自动继续。

不适合：普通文字选择、单个无需定位的示例，或只需读取技术测量结果。

## 主路径

1. 运行 `node scripts/prototype-review.mjs --help`，以当前 CLI 为命令、参数和 receipt 的唯一事实源。
2. 启动当前 `prototype.json` 的 Review 会话。若返回已有 `submitted` 结果，直接核对并消费；否则取得 URL。
3. 使用当前环境可用的浏览器、页面预览或端口能力打开 URL。没有打开能力时，把 URL 和最短手动方式交给用户，不声称页面已经打开。
4. 长时间阻塞等待网页提交，避免短轮询；客户端不适合长时间阻塞时，按 CLI 提供的状态检查方式继续。
5. 只有已提交且 Prototype ID、revision 匹配的 `feedback.json` 表示用户作出决定。超时、取消、服务不可达或会话不存在都不表示接受、修改或拒绝。

## 渐进反馈

默认先提供：

```text
少量候选 + 都不接受 + 补充评论
```

只有决定需要时才增加：

1. 引导问题；
2. DOM、图片、文本块或流程节点标注；
3. Prototype 声明的受控参数；
4. 真实操作感受确实是决定依据时的高保真交互。

Review Shell 的具体布局和无障碍行为由其实现与浏览器测试负责，不要求 agent 在每次使用时读取 UX 规格。

## 工件和事实源

- `prototype.json` 字段与合法值：`assets/prototype.schema.json`。
- `feedback.json` 字段与合法值：`assets/feedback.schema.json`。
- CLI 参数、状态和 receipt：`prototype-review.mjs --help` 与 stdout。
- 并发提交、revision、session 清理和路径安全：runtime scripts 与确定性测试。
- Review Shell 从已安装 Skill assets 提供；Prototype 目录不生成 `review/`。

不要把这些机器事实复制回本 reference。

## 反馈后的处理

- `accepted`：当前问题已有稳定结论，形成或更新 `verdict.md`。
- `revise`：读取具体反馈，修改 Artifact，递增 revision，再启动新一轮反馈；旧 feedback 不伪装成新 revision 结果。
- `rejected`：当前候选空间不成立，记录原因；是否创建新候选由用户当前意图决定。
- `new-material-question`：停止当前 Prototype，先处理会改变本问题的新材料问题。

这些值只属于 `feedback.json` 及其真实工具消费者，不复制成 Skill 间聊天协议。
