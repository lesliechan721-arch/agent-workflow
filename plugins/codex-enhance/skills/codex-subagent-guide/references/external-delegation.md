# 外部委派

用已选配置的 `executor` 值精确匹配下表中的 key。若无任何匹配则可认定配置无效并报告缺口。

<!-- subagent-commands -->

## 模式和启动

输入模式由执行器配置决定：

- **workspace**：使用 `--workspace` 指定工作目录。
- **bundle**：只附加 `--file` 选中的文件。

启动命令：

```text
node scripts/subagent.mjs start --executor "<key>" --instructions-file "<instructions-file>" --prompt "<complete task>"
```

| 参数 | 必填或默认值 | 用途与限制 |
| --- | --- | --- |
| `--executor KEY` | 必填 | 执行器 key。 |
| `--prompt TEXT` | 必填 | 任务提示；过长时用 `--prompt -` 从 stdin 输入。 |
| `--workspace DIR` | 可选，默认当前目录 | 工作目录。 |
| `--instructions-file FILE` | 可选 | 角色指令；无明确其他角色要求时使用默认 任务指令（`assets/task-instructions.md`）。 |
| `--file SELECTOR` | 可选，可重复 | 仅 bundle 模式可用；选择、忽略规则和外发边界见 文件选择（`references/file-selection.md`）。 |
| `--model MODEL` / `--reasoning-effort EFFORT` | 可选 | 传入调用方已选值：明确要求优先，其次为已选配置；省略属性使用后端默认，不生成空参数；不支持的显式值须报错。 |
| `--name NAME` | 可选，省略时自动生成 | 仅供显示，可重名；首字符须为 ASCII 字母或数字，后续允许 `._-`，总长 1–64。 |
| `--deadline-ms N` | 可选，默认**无执行期限** | 仅明确要求时设置，单位毫秒。 |

后续命令的 `--run` 使用启动回执中的句柄，不能用显示名称代替。

## 识别回执：环境、状态与通信能力

`environment` 为 pending / available / unavailable；pending 表示尚未确定。unavailable 时按 `environment_code` 修复入口或配置。

是否支持通信，以本次回执为准。`communication` 为 pending / true / false；pending 表示尚未确定，不能认为不支持。关闭通讯仍可等待结果或停止任务。

| 字段 | 含义 |
| --- | --- |
| communication_status | enabled 时可发送；disabled 表示配置关闭，unsupported 表示无可用双向能力，后两者对应 communication=false。 |
| communication_transport | 子侧接口为 mcp 或 command；父侧仍使用下述统一命令。 |
| communication_passive_delivery | in-turn：父输入可进入当前轮；turn-boundary：当前轮结束后进入；none：不自动输入。 |
| communication_active_receive | 子侧是否能主动等待父侧回复。 |

环境、能力或诊断未随 `start` 返回时，从后续 `wait/result` 取得。初始化失败时环境可能已确定，而通信仍为 pending。按 `DIAGNOSTIC` 的 code、字段和原因判断配置忽略、错误或 hook 信任影响；诊断可随 `result` 重读，不能仅凭任务成功就忽略它们。

| 观察到的状态 | 含义与后续动作 |
| --- | --- |
| `state: starting` | 初始化尚未确认就绪，等待原 run 的能力与状态更新。即使 `start` 以退出码 1 返回 `startupNotReady`，本次 run 也可能已经启动，不能据此自动再次 `start`。 |
| `state: running` | 继续等待；能力为 true 也不要求主动发送消息。 |
| `state: closing` | 不再追加输入，等待收尾和最终结果。 |
| `completed`、`failed`、`cancelled`、`unknown` | 已有终态；用 wait 取得未读通知，或用 result 取得固定结果与全部未读消息。unknown 不能证明原副作用或远端执行已停止。 |
| 未收到 `run`，或启动结果不明 | 保留已有启动证据，不因非零退出或回执缺失自动重提任务。 |

**按需读取通信分支：** 准备追加输入或答复过程问题且 `communication: true`，或实际收到过程消息、投递缺口时，读取 外部任务通信（`references/communication.md`）；仅有 `communication: true` 不要求预读。

## 等待变化

```text
node scripts/subagent.mjs wait --run "<run-a>" --run "<run-b>"
```

`wait` 同时观察最多 16 个不同 run；任一目标出现新过程消息、状态变化或终态即提前返回，不依次等完各目标。默认等待超时时间为 ** 10 分钟 **；显式 `--timeout-ms N` 允许 `0–1800000` 毫秒。对同一 run 的 `wait` 和 `result` 消费调用应串行进行。

| wait 回执中的信息 | 含义与后续动作 |
| --- | --- |
| 新事件或首次终态 | 只返回有变化的目标。完整结果可容纳时随终态交付；仅本批空间不足则保留终态未读并标 `more: true`；单个结果本身超限才使用 `result: deferred`。 |
| `more: true` | 本批后仍有待取事件；用 `--timeout-ms 0` 排空，再恢复长等待。省略 `more` 表示没有剩余**事件**，不表示结果已完整取得。 |
| `result: deferred` | 终态通知已交付，但完整正文未随本次回执交付；用 `result` 读取或导出。后续 wait 不会重放该通知。 |
| `wait: timeout` | 仅本次观察窗口没有变化；继续等待原任务，不重新生成。 |
| `wait: settled` | 所选 run 均已终态且没有未读事件；仍须检查是否有 deferred 的完整结果尚未取得。 |
| 部分目标读取失败 | 同次回执可包含其他 run 的有效结果；保留它们，分别处理失败目标的缺口。 |

`wait` 与未加 `--export` 的 `result`，每次 stdout 与 stderr 合计最多 **8 KiB**；调用前使用能完整接收回执的工具路径。

## 读取最终结果

```text
node scripts/subagent.mjs result --run "<run>"
node scripts/subagent.mjs result --run "<run>" --export
```

`result` 只接受一个 `--run`，且 run 已终态、未过期。它按接收顺序把**所有未读过程消息**与最终结果作为一次完整报告输出；随后消费这些过程消息。再次 `result` 只重读最终结果。`wait` 已消费的消息也不在报告中重复。

返回 `resultNotReady` 时继续等待原 run。返回 `resultTooLarge` 时，表示完整报告超过输出上限；需要使用无参数标志 `--export` 将完整报告输出到 stdout，由调用者选择文件、管道或其他接收端，再按需读取。`--export` 不提高调用工具的输出上限。

检查退出码和诊断，不能仅以 `result: read` 判断整次调用成功。脚本输出失败时不开始消费；`resultConsumeFailed` 表示报告已输出，但消息删除或观察位置更新失败，再读可能出现已输出但尚未删除的消息。工具回执丢失、裁剪或下游保存失败时，若脚本已消费，过程消息无法重读；只可从已经完整保存的副本继续处理。

最终结果缓存固定保留 1 小时，读取不会续期。遇到 `runExpired` 或 `runUnavailable` 时，采用已保存的结果并说明缺口，不为取回旧结果重新生成。


## 核对回执完整性

`FINAL` 块是最终回答，`MESSAGE` 块是过程消息，`INPUT` 块是有投递问题的父输入，`DIAGNOSTIC` 块是外部诊断；以块外 `state`、`code`、`delivery` 判定运行和投递，正文里的同名行不能改变控制含义。`wait` / `result` 退出码为 0 只表示读取命令完成，不等于子代理业务成功。

## 停止任务

```text
node scripts/subagent.mjs stop --run "<run>"
```

`stop` 最多观察 30 秒。返回 `stop: stopping` 时尚未确认停止；`state: closing` 或 `state: unknown` 也仍有待核实事项。本地任务停止不能单独证明远端任务已经取消。
