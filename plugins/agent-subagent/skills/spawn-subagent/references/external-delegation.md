# 外部委派

用已选配置的 `executor` 值精确匹配下表中的 key。若无任何匹配代表配置无效，结束并报告缺口。

<!-- subagent-commands -->

## 共用回执格式

下文 `<...>` 表示实际值，`[...]` 表示可选部分。run 是启动句柄，不能用展示名代替；code 是错误码，state 是 completed/failed/cancelled/unknown 任务终态。communication 与 resume 分别表示运行中通信和终态恢复能力，值为 true/false/pending：已启用且支持、关闭或不支持、尚未取得结论。两项能力独立。

| 正文块形态 | 读取方式 |
| --- | --- |
| `<message run="…">…</message>` | 子侧过程消息，不代替最终结果。 |
| `<input run="…" delivery="…" code="…">…</input>` | 有投递缺口的父输入，delivery 为 notSubmitted/unknown；completed 也不能证明这些要求已送达。 |
| `<result run="…" state="…">…</result>` | 最终正文与结果证据。 |
| `<diagnostic [run="…"] code="…" [field="…"]>…</diagnostic>` | 简短原因与恢复动作；没有句柄或具体字段时省略相应属性。 |

非 completed 结果必有 text_status（partial 表示部分正文，missing 表示无正文）、generation_started（true/false/null；null 表示无法确认是否已开始生成）和 backend_exit_code（整数或 null；null 表示退出码未知）。固定结果已有 code 或 remote_stop_confirmed 时保留。

正文含结束标签时，为避免歧义标签将使用数字后缀，如 result_2。

## start：启动任务

输入模式由执行器配置决定：

- **workspace**：使用 `--workspace` 指定工作目录。
- **bundle**：只附加 `--file` 选中的文件。

```text
{{aw.command:guide/subagent}} start --executor "<key>" --instructions-file "<instructions-file>" --prompt "<text>"
```

| 参数 | 必填或默认值 | 用途与限制 |
| --- | --- | --- |
| `--executor KEY` | 必填 | 执行器 key。 |
| `--prompt-file PATH` 或 `--prompt TEXT` | 必须且只能选一项 | 文件为非空 UTF-8 普通文件。 |
| `--workspace DIR` | 可选，默认当前目录 | 工作目录。 |
| `--instructions-file FILE` | 可选 | 角色指令；无明确其他角色要求时使用默认 任务指令（`assets/task-instructions.md`）。 |
| `--file SELECTOR` | 可选，可重复 | 仅 bundle 模式可用；选择、忽略规则和外发边界见 文件选择（`references/file-selection.md`）。 |
| `--model MODEL` / `--reasoning-effort EFFORT` | 可选 | 传入调用方已选值：明确要求优先，其次为已选配置；省略属性使用后端默认，不生成空参数；不支持的显式值须报错。 |
| `--name NAME` | 可选，省略时自动生成 | 仅供显示，可重名；首字符须为 ASCII 字母或数字，后续允许 `._-`，总长 1–64。 |
| `--deadline-ms N` | 可选，默认**无执行期限** | 仅明确要求时设置，单位毫秒。 |

文件参数路径相对 cwd 解析。

| 输出 | 如何处理 |
| --- | --- |
| `started <run> communication=… resume=…` | 已就绪，用 wait/result 获取后续消息与结果。 |
| `starting <run>` | 10 秒内尚未就绪，退出 1；继续等待原 run，不再次 start。 |
| `start_failed <run> [state=…] code=…` | 保留句柄并用 wait/result/stop 处理；state 仅在已有可靠终态时出现。 |
| diagnostic，无 run | 创建句柄前失败，按错误处理。 |

start 不消费过程消息或终态通知。回执丢失或非零退出不证明后端未执行，不自动重提任务。

## wait：等待可处理事件

```text
{{aw.command:guide/subagent}} wait --run "<run-a>" --run "<run-b>"
```

默认响应式等待 600000 ms，一次按参数顺序观察 1–16 个不同句柄；`--timeout-ms N` 允许 0–1800000 ms。同一 run 的 send/wait/result/stop 串行调用。

| 输出 | 如何处理 |
| --- | --- |
| `ready <run> communication=… resume=…` | 只补报 start 未报告的首次就绪；若终态同时可见，两项能力信息合入 result/deferred。 |
| message / input / result 块 | 按共用格式处理消息、投递缺口或完整最终结果。 |
| `deferred <run> state=… [communication=… resume=…]` | 终态通知已消费，正文未交付；用 result 读取或导出，wait 不重放此通知。 |
| 首行 `more=true` | 用 `--timeout-ms 0` 排空剩余事件，再恢复长等待；它不表示任务仍运行或 deferred 正文已取得。 |
| `timeout` | 本次窗口到期，继续原任务。 |
| `settled` | 全部目标终态且无未读事件；检查是否还有 deferred 正文未取得。 |

单个结果超限才 deferred，本批空间不足则保留未读并给出 more=true。读取/归属/失联问题返回 diagnostic，保留同批其它有效结果。

## 发送与恢复

通过 start/wait 返回的状态判断任务支持的能力：

- `communication=true`： 与运行中代理通讯。
- `resume=true`: 恢复已结束代理。

**当能力支持并且需要使用时**，可读取 通讯与恢复（`references/communication.md`）。

## result：读取完整结果

```text
{{aw.command:guide/subagent}} result --run "<run>"
```

完整结果太大时可导出到文件 `--output-file "<file>"`；文件路径相对 cwd 解析，父目录须已存在；不覆盖已有文件。

| 输出 | 如何处理 |
| --- | --- |
| message → input → result 块 | 完整结果包含全部未读消息、未被这些事件覆盖的固定投递缺口和最终正文；必要 diagnostic 随对应块交付。 |
| `exported <run> path=… bytes=… consumed=true` | 文件完整写入、关闭并消费成功；path 是 JSON 字符串形式的绝对路径，bytes 是 UTF-8 字节数。 |
| `exported … consumed=false`，附 resultConsumeFailed | 完整文件已存在，消息可能仅部分消费；保留文件，再读可能重复。 |
| resultNotReady / resultTooLarge | 分别继续等待、改用文件导出；超限时未消费。 |
| resultOutputExists | 目标已存在，核对后选择获准的新路径。 |
| resultOutputFailed，含 complete=false | 写入/关闭失败，未消费；按诊断路径和已写 bytes 核对可能留下的不完整文件，bytes 可能为 unknown。 |

## stop：停止任务

```text
{{aw.command:guide/subagent}} stop --run "<run>"
```

| 输出 | 如何处理 |
| --- | --- |
| `stopped <run> remote_stop_confirmed=…` | 已确认本地停止，单独核对远端证据。 |
| `stopping <run> remote_stop_confirmed=…` | 最多观察 30 秒仍未确认本地停止；附 localStopUnconfirmed、退出 1，保留未确认事项。 |

remote_stop_confirmed 的 true/false/unknown 表示远端取消证据，本地停止或 unknown 不证明远端停止。

## 消费与结果保留

操作失败的 diagnostic 写 stderr，已读取任务证据随相关块写 stdout。退出 0 表示命令完成（含 timeout 或读到失败任务），1 为操作失败，2 为参数无效。

wait/result 的 stdout+stderr 合计最多 32,768 UTF-8 bytes，工具须完整接收。

wait 先消费选入回执的消息并保存观察位置，再输出；result 在完整输出成功后消费。已消费的过程消息不保证重放，回执丢失后不能依赖重复读取恢复。部分消费失败可能已有消息删除或造成重复，应保留已完整收到的副本。

最终结果会保留一段时间，可用 result 重读。runExpired/runUnavailable 时说明缺口，不为取回旧结果重新生成。
