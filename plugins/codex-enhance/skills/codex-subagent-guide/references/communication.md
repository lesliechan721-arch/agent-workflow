# 外部任务通信

按本次完整能力描述行动：communication_status 必须为 enabled 才可发送；transport 指子侧 MCP/命令接口，passive_delivery 指父输入自动进入时点，active_receive 指子侧能否主动等待回复。queued 不能证明打断当前轮。配置开启或协商候选都不证明已就绪；必要桥、工具及权限准备成功后才会 enabled。权限或准备失败须按实际错误处理，不能当作 unsupported 或改用完整权限。

通信开关与 permissionMode 独立；关闭通讯仍检查环境和应用权限模式。agy 精确脚本许可是长期用户设置，成功写入后失败或 stop 不撤销；许可不证明沙箱访问或真实通讯资格。需要判断其写入、拒绝或不支持原因时读取 [Antigravity 合同](../adapters.md#antigravity)。

agy子侧优先使用生成的单命令`send --text TEXT`，将消息作为正确引用的单个参数。组合管道、重定向和shell包装可能需要额外许可，失败时按实际权限错误处理；不自动添加其它命令allow或切换full-access。脚本的`--text -`仍为stdin入口，单独的`-`正文需按生成提示处理。实际发送以父侧通道收到消息为依据，模型正文或回执标记是否符合任务预期是另一项判断。

in-turn 可自动进入当前轮；turn-boundary 只在当前轮结束后进入；none 没有自动输入。active_receive=true 时子侧可用实际收件入口保持响应式等待，默认 600000 ms、最高 1800000 ms；false 时发问不会自动暂停或保活，当前轮无已接受待办输入仍会关闭。必要答复未到时，子侧须在最终结果说明未完成部分。父代理不能期待任务结束后回复会重新打开原 run。

子侧说明由 adapter 按实际能力从单一模板生成，使用实际工具名或完整绑定命令。调用方不预读、拼接说明或猜测工具名。自动输入和主动收件共用队列，同一父输入不由 receive 重放；不需要周期拉取。

## 发送补充输入

```text
node scripts/subagent.mjs send --run "<run>" --text "<msg>"
```

较长输入可用 `--text -` 从 stdin 输入。单条消息最多 **4096 UTF-8 字节（4 KiB）**；超出单条上限时重新组织必要信息，不自动截断或拆分。整次 run 无累计消息条数或字节上限。

`send` 回执中的 `delivery` 描述这条输入的投递情况，与 run 的 `state` 分开判断：

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
