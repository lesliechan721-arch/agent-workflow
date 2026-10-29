# 外部任务通信

本次回执确认 communication=true 后才可发送。

## send：发送补充输入

```text
{{aw.command:guide/subagent}} send --run "<run>" --text "<msg>"
```

长消息可文件传入 `--text-file "<file>"` ，`--text-file` 与 `--text` 必须且只能选一项；文件须为非空 UTF-8 普通文件，路径相对 cwd 解析。

单条最多 4096 UTF-8 bytes，超限时重新组织必要信息，不自动截断或拆分。

| 输出 | 如何处理 |
| --- | --- |
| `queued <run>` | 已入队，不证明已读、已执行或立即打断当前轮。 |
| `queued <run> delivery=unknown` | 已入队但投递不明；关闭竞态仍退出 0，不自动重发。 |
| diagnostic | 按实际错误处理；提交前失败不输出 queued，操作失败退出 1。 |

回执丢失也不自动重发，重发会形成另一条消息。共用属性、正文块和消费规则见外部委派。

## 接收消息与投递缺口

用 wait 接收 message，用 result 取得完整报告。input 的 delivery=notSubmitted 表示未提交，先核对原 run 仍接受输入、通信能力、授权和大小，再决定是否补发；unknown 不自动重发。

completed 不证明全部追加要求送达。最终报告中的未解决 input 须随结果交回，过程消息不代替最终交付。
