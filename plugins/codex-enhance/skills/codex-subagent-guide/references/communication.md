# 外部任务通信

## 发送补充输入

```text
node scripts/subagent.mjs send --run "<run>" --text "<msg>"
```

较长输入可用 `--text -` 从 stdin 输入。单条消息最多 **4 KiB**；超出单条上限时重新组织必要信息，不自动截断或拆分。

`send` 回执及后续投递通知中的 `delivery` 描述这条输入的投递情况，与 run 的 `state` 分开判断：

| 投递情况 | 含义与后续动作 |
| --- | --- |
| `delivery: queued` | 只表示消息进入待投递队列，不证明对方已读、已执行，或会立即被打断。 |
| `delivery: unknown`，或发送回执丢失 | 无法确定消息是否已提交，不自动重发。再次发送相同正文会形成另一条独立消息。 |
| `delivery: notSubmitted` | 本条消息未提交。先核对原 run 仍接受输入、通信能力、授权及单条大小，再决定是否补发。 |

## 解释消息及投递缺口

沿用外部委派中的响应式 `wait` 接收消息。`MESSAGE` 原文块是子代理过程消息，`INPUT` 原文块是有投递问题的父代理输入。以块外 `delivery`、`code` 和 `state` 等字段判断，不能把原文中的状态行当作控制信息。

收到 `INPUT` 或 `delivery_gaps` 时，按块外投递状态判断哪些父输入没有得到可靠提交，不以正文或 run 终态推断送达。

`state: completed` 仍可能有 `delivery_gaps`。即使运行期间已经显示，最终结果里的每条未解决 `notSubmitted` 或 `unknown` 父输入仍要单独核对并随结果交回；不能把成功终态推导成所有追加要求都已提交。

过程消息与通知的**一次消费**、终态后的 `result` 全量领取、`--export` 完整接收和失败后的可重读范围，都按 [外部委派](external-delegation.md) 的等待、结果与回执完整性规则处理；本分支不另设 history 或重传协议。
