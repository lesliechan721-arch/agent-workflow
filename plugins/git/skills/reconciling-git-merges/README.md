# reconciling-git-merges

协调 Git merge 双方意图，并验证文本或语义交互后的组合结果。

## 什么时候使用

- merge 已经发生冲突或正在进行。
- clean merge 会组合相关行为、契约或依赖，需要验证语义交互。

不要用于 fast-forward、already up to date、rebase 或修改明显独立的 clean merge。

## 怎样调用

模型可以在 merge 确实需要协调双方意图时自动调用，也可以显式使用 `$reconciling-git-merges`。

示例请求：

- “解决当前 merge 冲突，保留两边的错误恢复意图并运行相关测试。”
- “检查这个 clean merge 是否组合了不兼容的配置合同。”

## 会发生什么

1. Agent 检查当前 merge、相关历史和双方修改依据。
2. Agent 逐项协调文本和语义冲突，只做组合结果需要的集成修改。
3. Agent 运行能覆盖双方交互的验证；只有用户要求且验证通过时才完成 merge commit。

## 权限和边界

- 处理任务时可以修改冲突文件、index 和 worktree。
- 不丢弃或混入无关本地修改，不在证据不足时自行决定优先级。
- 不执行 push；没有明确完成请求或验证未通过时保持未提交并报告阻塞。
