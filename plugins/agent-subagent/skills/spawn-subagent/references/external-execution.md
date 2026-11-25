# 外部执行协议

本文档用于已确定外部执行器 `key` 后的命令调用与生命周期管理。尚未完成选型、需要查看可用执行器或确认模型/推理强度时，先读取 选型与自省（`references/executor-selection.md`）；若 `key` 不在当前已配置清单中，立即停止并报告缺口，不私自切换执行器或材料目的地。

## 共用回执格式

`<...>` 为实际值，`[...]` 为可选部分。`run` 是启动句柄，不可用展示名代替；`code` 是稳定错误码；`state` 为 `completed`/`failed`/`cancelled`/`unknown` 终态。`communication` 与 `resume` 分别表示运行中通信与终态恢复能力（`true`/`false`/`pending`：已启用且支持、关闭或不支持、尚未取得结论），两项独立。

| 正文块形态 | 读取方式 |
| --- | --- |
| `<message run="…">…</message>` | 子侧过程消息，不代替最终结果。 |
| `<input run="…" delivery="…" code="…">…</input>` | 有投递缺口的父输入（`notSubmitted`/`unknown`）；`completed` 不证明这些追加要求已送达。 |
| `<result run="…" state="…">…</result>` | 最终正文与结果证据。 |
| `<diagnostic [run="…"] code="…" [field="…"]>…</diagnostic>` | 简短原因与恢复动作；无句柄或字段时省略相应属性。 |

非 `completed` 结果必含 `text_status`（`partial`/`missing`）、`generation_started`（`true`/`false`/`null`；`null` 表示无法确认是否已开始生成）与 `backend_exit_code`（整数或 `null`）；固定结果已有 `code` 或 `remote_stop_confirmed` 时保留。正文含同名结束标签时，标签自动加数字后缀（如 `result_2`）。

## start：启动工作区任务

所有外部执行均基于工作区目录运行；需要子代理关注的相对或绝对路径直接写入任务提示。

```text
{{aw.command}} start --executor "<key>" --prompt "<text>"
```

| 参数 | 必填或默认值 | 用途与限制 |
| --- | --- | --- |
| `--executor KEY` | 必填 | 已配置的外部执行器 `key`。 |
| `--prompt-file PATH` 或 `--prompt TEXT` | 二选一必填 | 非空 UTF-8 普通文件（≤256 KiB）或文本；不支持 `-` 或 stdin。 |
| `--workspace DIR` | 可选，默认当前目录 | 工作目录。 |
| `--instructions-file FILE` | 可选（三态） | **省略**：自动注入中性默认角色（`assets/task-instructions.md`）；**空字符串 `""`**：不注入任何角色指令；**文件路径**：由父侧读取该 UTF-8 普通文件（≤256 KiB）一次并前置拼入外部 prompt，文件缺失或无效时明确报错。 |
| `--model MODEL` / `--reasoning-effort EFFORT` | 可选 | 优先级：`明确要求 > 生效配置 > inspect 选型 > 省略沿用后端默认`；不传空字符串；`inspect` 标明 `[efforts=none]`（如已将强度编码于模型 ID 中的变体模型）时勿传 `--reasoning-effort`。后端报错拒绝时，若属**配置偏好**且允许回退，改按 `inspect --executor "<key>"` 可用项或省略该参数沿用后端默认重试并说明实际值（不切换执行器）；若属调用方**明确硬要求**被拒，停止并报告缺口。 |
| `--name NAME` | 可选，默认自动生成 | 仅展示，可重名；`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`。 |
| `--deadline-ms N` | 可选，默认**无执行期限** | 仅明确要求时设置，单位毫秒。 |

`--prompt-file`、`--instructions-file` 与 `--workspace` 的相对路径均按调用者 `cwd` 解析（引用其他 Skill 资产文件时传绝对路径）。

| 输出 | 处理方式 |
| --- | --- |
| `started <run> communication=… resume=…` | 已就绪，用 `wait`/`result` 获取后续消息与结果。 |
| `starting <run>` | 10 秒内未就绪（退出 1）；继续 `wait` 原句柄，不重新 `start`。 |
| `start_failed <run> [state=…] code=…` | 保留句柄并用 `wait`/`result`/`stop` 处理；`state` 仅在已有可靠终态时出现。 |
| `diagnostic`（无 run） | 创建句柄前失败，按错误处理。 |

`start` 不消费过程消息或终态通知；回执丢失或非零退出不证明后端未执行，不自动重提任务。

## wait：等待可处理事件

```text
{{aw.command}} wait --run "<run-a>" --run "<run-b>"
```

默认响应式等待 `600000` ms，一次按参数顺序观察 1–16 个不同句柄；`--timeout-ms N` 允许 `0–1800000` ms。同一句柄的 `send`/`wait`/`result`/`stop` 串行调用。

| 输出 | 处理方式 |
| --- | --- |
| `ready <run> communication=… resume=…` | 补报 `start` 未报告的首次就绪；若终态同时可见，合入 `result`/`deferred`。 |
| `message` / `input` / `result` 块 | 按共用格式处理消息、投递缺口或完整最终结果。 |
| `deferred <run> state=… [communication=… resume=…]` | 终态通知已消费但正文超限未交付；用 `result` 读取或 `--output-file` 导出，`wait` 不重放。 |
| 首行 `more=true` | 用 `--timeout-ms 0` 排空剩余事件，再恢复长等待；不表示任务仍在运行或 `deferred` 正文已取得。 |
| `timeout` | 本次窗口到期，继续等待原句柄。 |
| `settled` | 全部目标终态且无未读事件；核对是否仍有 `deferred` 正文未取。 |

仅单个结果超限时才 `deferred`；本批回执空间不足则保留未读并返回 `more=true`。同批个别句柄读取、归属或失联出错返回 `diagnostic`，不影响同批其他有效结果。

## 发送与恢复

按 `start`/`wait` 报告的能力判断：`communication=true` 支持运行中双向通信，`resume=true` 支持终态恢复。**仅在能力支持且需要发消息、恢复任务，或收到过程消息与投递缺口时**，读取 通讯与恢复（`references/communication.md`）。

## result：读取或导出完整结果

```text
{{aw.command}} result --run "<run>"
{{aw.command}} result --run "<run>" --output-file "<file>"
```

结果超 32 KiB 预算时用 `--output-file` 导出到新文件（相对调用者 `cwd` 解析，父目录须存在，不覆盖已有文件）。

| 输出 / 错误码 | 处理方式 |
| --- | --- |
| `message` → `input` → `result` 块 | 含全部未读消息、固定投递缺口与最终正文；必要 `diagnostic` 随对应块交付。 |
| `exported <run> path=… bytes=… consumed=true` | 文件完整写入关闭且消费成功（`path` 为 JSON 绝对路径，`bytes` 为 UTF-8 字节数）。 |
| `exported … consumed=false`（附 `resultConsumeFailed`） | 完整文件已存在，未读消息可能仅部分消费；保留文件，重读可能重复。 |
| `resultNotReady` / `resultTooLarge` | 分别继续等待、改用 `--output-file` 导出（均未消费）。 |
| `resultOutputExists` | 目标已存在，核对后换获准的新路径（未消费）。 |
| `resultOutputFailed`（含 `complete=false`） | 写入或关闭失败（未消费）；按诊断路径与已写 `bytes`（可能为 `unknown`）核对可能残留的不完整文件。 |

## stop：停止任务

```text
{{aw.command}} stop --run "<run>"
```

- `stopped <run> remote_stop_confirmed=…`：已确认本地停止，远端取消状态单独核对。
- `stopping <run> remote_stop_confirmed=…`（附 `localStopUnconfirmed`，退出 1）：30 秒内未确认本地停止，保留未确认事项并继续核对。

`remote_stop_confirmed` 取值为 `true`/`false`/`unknown`，表示远端取消证据；**本地停止或 `unknown` 不证明远端已停止**。

## 预算、消费与保留边界

- 操作失败的 `diagnostic` 写 stderr，已读取的任务证据写 stdout；退出码 `0` 完成（含 `timeout` 或读到失败任务）、`1` 操作失败、`2` 参数无效。需要完整诊断时可传 `--diagnostics`。
- `wait`/`result` 的 stdout+stderr 合计上限 32,768 UTF-8 字节。`wait` 先消费选入回执的消息再输出，`result` 在完整输出成功后消费；已消费的过程消息不保证重放，回执丢失后不能依赖重读恢复，部分消费失败时保留已收到的完整副本。
- 最终结果在保留期内（默认 24 小时，以已应用配置为准）可用 `result` 重读；`runExpired`/`runUnavailable` 时说明缺口，不为取回旧结果重新生成。
