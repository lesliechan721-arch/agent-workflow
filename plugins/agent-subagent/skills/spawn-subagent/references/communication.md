# 通讯与恢复

共用属性、XML 正文块格式与消费边界见 外部执行协议（`references/external-execution.md`）。

## send：发送消息或恢复已结束任务

```text
{{aw.command}} send --run "<run>" --text "<msg>"
{{aw.command}} send --run "<run>" --text-file "<file>"
```

- `--text` 与 `--text-file` 二选一必填，不支持 `-` 或 stdin；文件须为非空 UTF-8 普通文件，相对路径按调用者 `cwd` 解析。
- 单条上限 **24,576 UTF-8 字节**；超限时重新组织必要信息，不截断或自动拆分。
- 运行中任务需 `communication=true`；已结束任务在 `resume=true`、未过期、已绑定原 session 且本地进程树确认停止时，`send` 自动恢复原会话（沿用原执行配置，`result` 仅保留最新一轮结果；如需留存旧结果须在恢复前用 `result --output-file` 导出）。

| 输出 | 处理方式 |
| --- | --- |
| `queued <run>` | 已入队，不证明后端已读、已执行或打断当前轮。 |
| `queued <run> delivery=unknown` | 已入队但投递不明（关闭竞态仍退出 0）；不自动重发。 |
| `started` / `starting` / `start_failed` | 进入终态恢复，按 外部执行协议（`references/external-execution.md`）的 `start` 回执规则处理。 |
| `diagnostic` | 按实际错误处理；提交前失败不输出 `queued`，操作失败退出 1。 |

回执丢失时不自动重发，避免产生重复消息。

## 接收消息与投递缺口

用 `wait` 接收过程 `message`，用 `result` 获取完整报告。

- `<input delivery="notSubmitted">`：确认未提交；先核对原 `run` 仍开放、支持通信、授权与大小限制，再决定是否补发。
- `<input delivery="unknown">`：投递结果不明；保留缺口上报，不自动重发。
- `completed` 不证明所有追加要求已送达；最终报告中未解决的 `input` 须随结果交回，过程消息不代替最终交付。
