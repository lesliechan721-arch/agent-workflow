# 运行生命周期与平台支持

[适配器文档索引](README.md)

## 命令输出合同

程序控制 token、code、help、工具描述与诊断使用英文；任务、父子消息和最终正文保留原语言。敏感值按既有规则脱敏。语义标签是阅读边界，不是内容可信性或任务授权的证明。


支持 `--prompt-file`、`--text-file`、`--output-file`，不支持 `--prompt -`/`--text -` 读取 stdin。`--details`、`result --export` 及等价的主代理详细信息入口按未知参数拒绝。父侧各单值参数重复提供、输入形式同时提供、跨命令参数或未知参数都返回 `argumentsInvalid`、exit=2；子侧通信脚本的参数错误见 [文件输入与输出](#文件输入与输出)。

输出采用 UTF-8 和 LF。固定控制 token 不翻译；动态说明可以保留原文。短控制行的属性顺序固定如下，方括号表示仅在适用时出现：

| 情况 | stdout |
| --- | --- |
| start 已 ready | `started <run> communication=true\|false` |
| start 在 ready 前已失败，或创建句柄后发生操作错误 | `start_failed <run> [state=<实际终态>] code=<实际code>`，随后必要 diagnostic；exit=1 |
| start 的 10 秒观察窗口到期 | `starting <run>`，随后 diagnostic(code=startupNotReady)；exit=1，必须复用该句柄 |
| wait 首次补报 ready | `ready <run> communication=true\|false` |
| send 已入队 | `queued <run>`；这不是后端已收到的证明 |
| send 投递结果不明 | `queued <run> delivery=unknown`；已入队后的关闭竞态仍 exit=0，不代表可靠送达；实际操作失败才 exit=1 |
| wait 没有事件且窗口结束 | `timeout` |
| wait 全部目标终态且已消费通知 | `settled` |
| 本批仍有已观察未交付事件 | 第一行 `more=true`，再输出选定事件；不同时输出 timeout/settled |
| stop 已确认本地停止 | `stopped <run> remote_stop_confirmed=true\|false\|unknown` |
| stop 在现有最多 30 秒窗口后仍未确认本地停止 | `stopping <run> remote_stop_confirmed=true\|false\|unknown`，附 `localStopUnconfirmed` diagnostic，exit=1 |

ready 与终态在 start 同次观察中可见时，只要已取得成功 ready，就返回 started 和已确定的 communication；后续 wait/result 交付终态。ready 前的快速终态使用 start_failed，state 写实际固定终态；尚未形成可靠终态的操作失败省略 state，不将操作失败冒充任务终态。code 采用实际稳定错误码；固定终态未提供 code 时使用 `startupFailed`。创建句柄后任何失败都必须保留该句柄，并说明用 wait/result/stop 继续处理；创建前失败使用无 run 的 diagnostic。start 不消费过程消息或终态通知。

上表控制行均以一个 LF 结束。run 使用现有已校验 handle，不接受展示名。普通 started/queued 不重复打印 name、environment 或 backend_exit_code。必要错误使用下述 diagnostic，不输出内部状态快照。

正文块的全部分支如下。属性按列出顺序输出；没有该证据时省略可选属性，禁止写猜测值。

```text
<message run="<run>">
<原始子消息>
</message>
<input run="<run>" delivery="notSubmitted|unknown" code="<code>">
<未确认投递的父输入原文>
</input>
<result run="<run>" state="completed|failed|cancelled|unknown"
  [communication="true|false|pending"] [text_status="partial|missing"]
  [generation_started="true|false|null"] [backend_exit_code="<integer>|null"]
  [code="<code>"] [remote_stop_confirmed="true|false|unknown"]>
<固定最终正文>
</result>
<diagnostic [run="<run>"] code="<code>" [field="<field>"]>
<简短原因与必要恢复动作>
</diagnostic>
```

上例为便于阅读换行列属性，实际 opening tag 是单行。属性值按 XML 属性转义 `& < > "`；业务正文不转义、不 trim，正文前后各加入一个 framing LF，即使原文已经以 LF 结尾也不删除它。块之间不插空行。整个格式供 Agent 阅读，不承诺可作为 XML 文档解析。

每块独立检查原文是否含其完整结束标签。没有冲突就用基本名；有冲突依次试 `_2`、`_3`，选择第一个完整结束标签未出现在该块原文中的名称，并同时更换 opening/closing tag。计入预算的是最终选定名称，不重写正文。

result 的 state 必填。非 completed 必须有 text_status（有正文为 partial，否则 missing）、generation_started（true/false/null，null 为无法确认是否已开始生成）、backend_exit_code（未知为 null）；固定结果已有 code 或停止证据则必须带出，不能因简化输出丢失。首次可见初始化信息合入 communication 属性；如果从未得到通讯结论则为 pending，并用 diagnostic 保留已知环境失败 code。ready 与终态同时可见时不另发 ready 行。completed 若存在输入投递缺口，仍必须先输出 input，不能只展示成功正文。

wait 按传入 run 顺序分组；每组先输出所选未读事件，保持现有队列顺序，再输出首次 ready 或终态。完整 result 报告先输出全部未读事件，再输出未被这些事件覆盖的固定投递缺口，最后输出最终正文；同一 gap 依现有存储 ID 在同一响应内只显示一次。失败的安全原因使用 diagnostic 块，紧邻对应 input/result 前；没有 run 的参数错误允许省略 run。

必要错误始终可见：控制端操作失败的 diagnostic 写 stderr；作为已读取任务证据的 diagnostic 随相关块写 stdout。只交付稳定 code、简短原因、必要 field 与恢复动作，不输出环境快照、通信传输方式或被动投递策略；内部详细信息仅供脚本处理，不通过新参数、导出模式或诊断块转交主代理。表中已有的失败结果与停止证据仍须保留。

正常 wait/result 的 stdout+stderr 最多 8192 UTF-8 bytes，stderr 最多 1024；保留安全错误所需预算，再选完整事件。可省略冗长诊断原文并输出 `code="diagnosticOmitted"`，但保留原稳定 code、原因和必要恢复动作；不得截断 message/input/result 正文后当作完整消费。单消息仍最多 4096 bytes，最终正文最多 4 MiB。

wait 的单个完整终态组即使独占本次预算仍放不下时输出 `deferred <run> state=<terminal-state>`，首次初始化可再附 `communication=true|false|pending`，随后 `resultTooLarge` diagnostic 只指向 `result --output-file`；完整构造并选入本批后只消费这一次终态通知，保留最终结果缓存和未选消息；后续 wait 不重放该 deferred，result 仍可读取完整报告。若结果单独可容纳，只是本批剩余空间不足，则整个终态保留未读并输出 more=true，不降为 deferred。正常 result 必须完整报告，放不下返回 `resultTooLarge`、exit=1、不消费，并提示使用 `result --output-file`。文件导出不受 8192-byte 普通报告上限约束；最终正文的 4 MiB 限制及其它内容限制保持。

### 通信能力与内部提示词

主代理回执只公开 `communication=true|false|pending`：true 表示通信已启用，false 表示整体通信关闭或不支持，pending 表示初始化尚无结论。启用通信即具有发送和主动接收，MCP 与 command 都不提供裁剪为 send-only 的运行模式。

删除 `communication_active_receive` 及内部对应 `activeReceive` 能力开关。Adapter v5 的 enabled 通信对象固定为 `{status:"enabled",transport:"mcp"|"command",passiveDelivery:"in-turn"|"turn-boundary"|"none"}`；disabled/unsupported 分支仍保持原合同。supported negotiation 的启用对象为 `{supported:true,transport:"mcp"|"command",passiveDelivery:"in-turn"|"turn-boundary"|"none"}`，不支持仍为 `{supported:false}`；桥接/工具生成不再接受该开关或 --send-only。新 validator 拒绝旧 activeReceive 字段；现有 custom adapter 的 enabled ready/协商需要随本次合同更新，不承诺旧能力对象继续可用。其余 v5 帧、消息投递与停止边界不变，不增加兼容状态机。

transport 与 passiveDelivery 仅在 adapter/worker 内部使用，不转发为 communication_transport/status/passive_delivery 等主代理字段。passiveDelivery 控制自动输入调度和子代理提示词；不改变主动接收入口始终可用这一条件。内部仍可区分 disabled/unsupported，但主代理只得到 false 与必要失败原因。

子代理通信提示词使用 common、transport 和 passiveDelivery 对应片段；通信启用时始终包含 active-receive 方法片段，移除 no-active-receive 分支。该模板标记是内容区段，不是能力状态。MCP 总是注册 send/receive 两个工具，脚本总是提供对应的两个调用入口；需要父侧答复时，子代理按已有响应式等待方法保持任务开放。实际 receive 收到输入或关闭时提前返回，仍受 deadline 和停止规则约束，不改变消息消费和 TTL。

## Wait 的一次交付边界


复用现有 observed.json 的 `{sequence,initializationSequence,terminalConsumed}`，不增 ACK、ready 日志或第二游标文件。

1. 返回候选只包括未读消息/投递事件、首次终态、尚未报告的成功 ready，以及须处理的读取/归属/失联问题。sequence 增长本身不构成候选。
2. start 沿用既有“形成回执并保存观察位置，再输出”的边界。只有回执确实携带已取得的初始化信息时才推进 initializationSequence；starting 尚未取得初始化时不消费就绪通知。start 始终不推进 terminalConsumed，也不删除过程消息。
3. wait 发现成功 ready 且 initializationSequence 尚未消费时，选择 ready；通信 disabled/unsupported 也算 ready，但 communication=false。只有 closing 变化且没有新成功初始化时不返回。若该 run 已有终态，改在完整 result 或 deferred 中合并首次能力信息。
4. wait 保留既有顺序：按字节预算构造完整候选响应 → 只消费选入本批的完整事件并保存观察位置 → 输出最终响应。选中 final 或 deferred 都将 terminalConsumed 置 true；它只表示终态通知已经消费，不表示 deferred 正文已输出，也不删除固定最终缓存。初始化信息随本批完整控制行/块被选中时才推进 initializationSequence。纯 sequence 变化不消费初始化或终态通知。
5. 消息删除失败时从本次响应中移除该消息并报告 runReadFailed；观察位置保存失败时不声称该控制通知已交付。按现有逻辑重算最终预算并保留其它成功事件，不增加事务补偿。未选入本批的消息/通知保持未读，more=true 只表示仍有已观察未交付事件，不表示 deferred 正文尚未读取。
6. 一个 run 的读取错误不能阻止其它有效 run 在预算内交付；本次命令包含操作错误时 exit=1。读取 failed/cancelled/unknown 任务本身仍 exit=0。全部无事件时按固定期限返回 timeout 或 settled。

wait/start 在消费或保存观察位置后发生 stdout/工具回执丢失，不保证重放已消费通知或过程消息；固定最终结果仍可在 TTL 内通过 result 读取。这与 result 的“完整输出成功后消费”是两种既有边界，不能合并成一个输出回调规则。文件导出按 [文件输入与输出](#文件输入与输出) 执行完整写入及关闭后消费。部分消费失败可能重复，也可能已有消息删除；不承诺 exactly-once。父调用者继续串行调用同一 run 的 wait/result。读结果不延长终态后 1 小时的固定 TTL。

## 文件输入与输出


start 必须且只能提供 `--prompt TEXT` 或 `--prompt-file PATH`；父侧和子侧通信 send 对 `--text TEXT`/`--text-file PATH` 同理。以上命令不读取 stdin，也不在缺少参数时回退到 stdin。`--prompt -`、`--text -`（含引号形式）和文件参数值 `-` 均是参数错误。缺参、同时提供两种输入、重复单值参数、跨命令参数、未知参数及上述 `-` 形式，父侧统一使用 `argumentsInvalid`，子侧沿用 `invalidArguments`，exit=2，在创建任务、提交消息或读取 stdin 前拒绝。需要原文为单字符 `-` 时，使用内容为 `-` 的普通文件；名为 `-` 的文件须用 `./-` 或绝对路径引用。相对输入/输出路径均相对调用相应命令时保存的 caller cwd，不相对 --workspace 或 producer root。

子侧私有通信脚本支持 `--text-file PATH`，与父侧消息文件采用相同的路径、内容、大小和读取失败规则；私有通道绑定及权限范围保持。提示词的 command 与 command-argument 两分支都只展示文本或文件方式：`@@SEND@@` 注入带 `send --text MESSAGE_TEXT` 的调用，`@@SENDFILE@@` 注入带 `send --text-file MESSAGE_FILE` 的调用；两者使用同一私有绑定与现有 shell 引用规则。移除 `@@SENDSTDIN@@` 及其生成逻辑。MCP send 仍使用 text 字段；通用 AW stdio 透传、Adapter v5/MCP 传输和文件选择器的内部 stdin JSON 协议使用各自合同。

文件路径必须指向普通文件；不接受目录、FIFO、设备或最后一段 symlink。读取一次并按严格 UTF-8 校验，不去 BOM、不 trim 内容；非空检查仍排除全空白，拒绝 NUL。prompt-file 最大 256 KiB，父侧与子侧 text-file 均最大 4096 bytes；instructions-file 仍最大 256 KiB，合成 prompt 最大 524352 bytes。参数校验、读取及完整内容校验在创建/提交外部任务或输入前完成。

result 仅提供普通 stdout 报告和 `--output-file PATH` 文件导出。`--export` 单独传入或与 `--output-file` 同时传入都按未知参数返回 `argumentsInvalid`、exit=2，在创建文件或消费消息前拒绝。文件导出与正常 result 使用相同的完整报告结构；相同 run snapshot 和未读事件应产生相同报告字节；文件导出只扩大报告容量，不增加内部字段。output-file 以独占创建打开目标，不覆盖文件或 symlink，不创建父目录、不换路径；新文件请求权限 0600，Windows 沿用系统 ACL。不将目标文件计入 run 的到期清理。

先校验可读取的终态并准备完整报告，再创建文件；成功顺序固定为完整写入 → 关闭成功 → 消费消息/通知 → 输出回执。stdout 的成功行固定为：

```text
exported <run> path=<JSON-string> bytes=<decimal> consumed=true
```

path 是实际绝对输出路径，使用 JSON.stringify 的单行字符串转义；bytes 是已完整关闭文件的 UTF-8 实际字节数，不是字符数或预算估值。consume 失败时输出同一行，但 `consumed=false`，stderr 输出 resultConsumeFailed，exit=1；它明确表示完整文件存在，未读消息可能部分消费，重读可重复。若消费成功后 stdout 回执写失败，仍报 resultOutputFailed；不撤销消费，不删除完整文件。

创建失败/已存在时不消费，报 `resultOutputExists` 或 `resultOutputFailed`。写入/关闭失败时不消费，也不输出 exported；stderr diagnostic 的 code 为 resultOutputFailed，并包含 JSON 转义的路径、`complete=false` 和已成功写入字节数（无法确定时为 unknown）。保留可能不完整的文件，不自动 unlink。完整导出无需先缓存全部报告，但必须对同一冻结事件列表/终态记录测量与输出，不能把中途新事件算作已消费。

文件输入失败使用 `inputFileInvalid`（路径/类型/UTF-8/NUL/空内容）、`inputFileReadFailed`（I/O），超限复用 taskTooLarge/messageTooLarge；参数互斥等形状错误按本节规定，父侧使用 argumentsInvalid，子侧使用 invalidArguments。既有 instructions-file 错误码不改。输入校验错误 exit=2，实际 I/O 失败 exit=1。

普通消息或投递问题的完整呈现最多 7168 UTF-8 bytes，必须能与最坏 1024-byte stderr 一起独立交付。单条正文最多 4096 bytes；控制信息与标签合计最多 1024 bytes，可显示诊断合计最多 1024 bytes，其余 1024 bytes 留给响应级提示。必要稳定 code 和投递分类保留；不能为满足预算裁剪业务正文。过长外部诊断可以省略原文并报告 diagnosticOmitted，不能把截断引用当作完整证据。

## 调用工具的输出预算


本节面向调用工具集成的实施与验收，不作为 Skill 的原生工具教程。字节预算不等于调用工具 token 预算；实施者须为支持的实际调用链固定并验证预算。沿用 v6 的首版验收配置：Codex exec_command 与 write_stdin 的 `max_output_tokens: 16384`；存在 functions.exec/functions.wait 包装时，外层分别为 `max_output_tokens: 16384` / `max_tokens: 16384`。具体传参遵守实际工具 schema。每个验收样本只转交一条命令的原始 output，不以多命令汇总、摘要、head/tail 或额外 JSON 字符串化代替完整交付；覆盖启动、等待和续读。

这组参数是首版技术取值，不是对所有调用工具的无条件保证。实施验收必须经实际执行工具及全部中间包装，证明最大合法 8192 字节响应、最大单条消息及封套都完整进入模型上下文；覆盖高 token 密度文本、中文、换行、可合法出现的控制字符及序列化开销。不能只用平均字节/token 比例、stdout 文件完整、首尾标记仍在或没有报错证明完整。

支持声明须有真实链路证据，不能只因为设置了数值就认为通过。更低的固定工具上限必须先调整调用预算并验证；仍不能完整承载时，该工具调用路径不受支持，不能先消费再试。运行脚本不新增调用工具预算参数或探测协议。Guide 的运行正文保留选择边界和消费后果：使用能完整承载回执的工具调用路径，裁剪时标记交付不完整，已消费过程消息不保证重读。大报告使用 --output-file 直接导出，再按需读取文件。已有回执丢失边界继续有效，不增加 ACK、历史或恢复账本。

## 启动、等待与发送

start 固定本次安装配置、执行器和完整输入，创建私有 run，由长期 worker 管理 adapter、队列与收尾。句柄为 `aw5-<id>-<key>`，共 38 个字符：id 为 64 位随机数的 11 字符无填充 Base64URL 编码，key 为独立 128 位随机数的 22 字符无填充 Base64URL 编码。id 定位私有目录，读取时另行核对 key 与归属；两者均区分大小写，须完整保留。默认没有执行期限，deadlineAt 为 null；只有显式 --deadline-ms N 才从 worker 启动时刻固定期限。N 必须为正安全整数，且相加后仍为合法 EpochMs。新消息、轮次和等待不延长期限。start 最多观察初始化 10 秒；starting 或 start_failed 已产生的句柄必须继续使用，不能自动重新 start。

wait 接受 1–16 个不同句柄，重复句柄合并。--timeout-ms 默认 600000，允许整数 0–1800000；先检查全部目标，再用同一截止时间等待任一可消费事件。纯 closing、sequence 增长或重复快照不唤醒。默认使用响应式长等待；调用工具窗口较短时续等同一任务，只有 more=true 或明确即时检查才使用零等待。等待结束不终止任务、不启动模型、不延长缓存期限。

send 对 starting 返回 runNotReady，对关闭或不支持通信返回 communicationUnsupported，对 closing/终态返回 runClosed，对过期或不可用返回相应错误。queued 只证明本地入队；关闭竞态可返回 delivery=unknown，不能当作后端或模型已接收。worker 按 v5 保存 submitted/notSubmitted/unknown；未解决投递在结果前以 input 块保留，不自动重发。

启用通信时，子代理同时取得 send 和 receive。需要父回复才能继续时，保持任务开放并使用默认 10 分钟的响应式 receive；收到输入、closed、deadline 或停止时提前返回。自动输入和主动收件共用同一调度器，已提交输入不能再次领取。一个后端 turn 完成不等于 run 完成；已接受且明确未提交的输入可在原授权和期限内进入同一会话下一轮，closing 后不再开轮。

result 必须且只能指定一个句柄，不接受 timeout 或 history。尚未终态报 resultNotReady，过期报 runExpired，资源不可用报 runUnavailable。failed/unknown 的固定部分正文可读取；仅固定最终结果在终态后 1 小时内可重读，过程消息成功消费后删除。

## 停止、失联与结果缓存

### 1. 最小临时存储与过期

这里保留的是本次执行及结果缓存，不提供消息历史。数据范围和期限如下。

| 数据 | 保留与删除 |
| --- | --- |
| prompt、副本、后端临时输出、子工具请求 | 只在运行及收尾期间使用；本地执行停止后删除不再需要的内容 |
| 发往子代理的正文 | 只保留待提交/未确认消息；提交成功即删，失败或未知转为有界问题通知 |
| 子代理过程消息及运行中问题通知 | 只保留待取出的内容；wait 取出或 result 完整输出后删除，不提供 history |
| 最新运行快照、状态观察序号、归属和进程证据 | 支持 wait/stop/安全删除，不保留完整状态事件日志 |
| 最终正文、终态、未解决的投递摘要、必要故障诊断 | 正常终态首次通过 wait 或 result 交付，且在 `terminalAt + 3600000 ms` 前可通过 result 重复读取；worker 失联形成的 unknown 使用首次确认失联时固定的到期时间 |

正常终态的缓存有效期从 worker 提交最终结果的时刻开始，固定 1 小时；读取和重试不续期。任务运行中不设置缓存到期时间，显式执行期限也不直接决定缓存期限。未保存终态且原 worker 已确认不存在时，以首次确认失联的时刻固定 `terminalAt`，内部到期时间为 `terminalAt + 3600000 ms`；之后的观察、结果固化和读取均复用它。

起算信息原子保存于已有的小型归属/时间元数据，与正文解析分开，不新增账本。wait/result/stop 的失联检查和普通扫描共用这一判断；扫描不读消息或拼装结果，只可在确认原 worker 不存在且尚无终态起算信息时保存一次时间。先保存起算信息，再尝试写入 unknown 缓存；缓存写入失败、缺失或损坏都不重置期限。起算信息无法安全读取或保存时报告失败并保留资源，不猜测时间。没有后续调用时，未被发现的孤立资源可能继续留存。所有这些时间只供程序使用，主代理回执和导出报告不输出 `expires_at`，也不以另一名称显示到期时间。

不提供公开 cleanup。普通 `start/send/wait/result/stop` 在操作前执行一次有限的过期扫描；help 保持只读；无效参数不触发扫描。扫描只检查当前用户、当前协议命名空间内的直属运行目录，不扫描任意临时目录，不读取消息正文，不维护全局索引或 tombstone。

删除必须同时满足：已过期、资源归属可证明、本地所属执行已停止。仍活跃或无法证明停止时保留资源和最小控制信息；TTL 不授权杀进程。过期后仍可显式 stop 这些所属执行；停止证据更新后由普通过期扫描回收资源，但 wait/result/send 不再读取正文或发送输入。过期扫描不读取强配置、不取得额外 AW_HOME 写锁。

扫描失败或权限问题只报告安全摘要，不撤销当前命令的有效结果。只读取直属目录的小型归属/时间/进程信息，不解析缓存正文；不为扫描建立额外索引或调度状态。只有可证明归属且停止的目录可以删除，foreign/shared、symlink 和无法识别的目录一律保留。

**按需清理的已接受边界：**过期会立即影响该句柄的可读性，但物理删除发生在后续脚本调用中。之后没有调用、目录受权限阻碍或进程停止无法证明时，不承诺按时删除。用户已接受此边界以避免常驻清理器。缓存丢失也不授权重新生成。

两个方向都不限制整次 run 的发送或接受条数，也不设置累计消息字节额度。单条仍最多 4096 UTF-8 字节；检查在各方向的唯一接收者执行，超限明确拒绝，不静默截断或自动拆分。已消费/已提交正文及时删除，未处理消息及未解决投递摘要按实际需要保留；不为已消费消息建立累计额度计数或历史副本。

消息数量取消上限不改变文件 I/O、通道回压和停止处理。实现按事件读取和输出，避免一次把全部消息装入内存；完整结果的投递摘要可流式读取和导出。磁盘或通道实际失败须报告，不能静默丢弃已接受输入，不能用固定累计条数或总量阈值冒充资源故障。单条大小和输出合同共同保证普通事件可独立交付。Adapter 帧与 final 的限额见协议附件，它们不等于显示限额或完整投递摘要的总量上限。

### 2. stop 与任务状态

| 状态 | 含义 |
| --- | --- |
| starting | worker 存在，尚未确认 ready；可 wait/stop |
| running | 本次任务开放；按能力允许 send |
| closing | 已停止接受新输入，正在停止/提交结果并核对本地收尾 |
| completed/failed/cancelled/unknown | 本次结果已固定；result 可在缓存有效期内反复读取，不能重新发送或续接 |

stop 发出本次停止意图并有界等待，最多 30 秒。未能确认停止时返回真实 closing/unknown 及已有证据；不把等待超时说成 cancelled。重复 stop 不创建新工作。worker 失联时只按保存的 PID、启动身份和归属证据处理剩余所属进程，不按进程名或共享进程组停止。

资源释放统一由过期扫描负责，不提供公开 cleanup 或提前删除入口。损坏的消息或最终正文不阻止过期清理，删除依据与内容解析分开；归属证据无法读取时不猜测、不扩大删除范围。删除后的句柄不可恢复，不影响已复制到父对话的结果。stop 在完成本次停止处理后再检查该目录是否已过期；满足归属与停止条件时可立即回收，未过期时仍保留最后结果。

worker 消失、后端终态不明、输出超限、协议冲突或本地收尾不明均保留 unknown。只有真实服务完成、完整非空正文、后端与 adapter 的成功退出以及本地收尾证据成立，才报告 completed。服务完成与投递缺口分别展示。远端停止未知不因本地退出而变成已取消。

**worker 失联且未保存终态。** wait/result/stop 共用同一个轻量检查：先验证运行归属；已有到期信息时检查有效期，再按 PID 和启动身份确认原 worker 是否已经不存在。若已有合法最终缓存，直接复用。若 worker 仍存活，result 仍报 resultNotReady；无法检查进程身份时返回 `runObservationFailed`（退出 1），不凭超时固化终态。

确认 worker 已不存在、没有最终缓存且按本节固定的期限尚未过期时，由当前单逻辑父调用原子保存一次 `unknown` 结果，code 为 `workerLost`。该分支不启动 worker/adapter、不接管其会话，不成为后台恢复机制。只保留已经原子保存且可验证的部分正文及投递证据；没有正文则为空，并显示 `Final text was not saved.`。不读取零散日志、后端 session 或 scratch 文件拼装答案；无法证明的生成阶段为 null。仍待处理的父消息按已写入连接的证据归为 unknown，否则 notSubmitted；若连写入阶段也无法证明，一律 unknown。

这份结果沿用首次确认失联时已固定的到期时间；扫描可能早于本次 result 读取确认失联，因此不能从写入缓存或读取结果的时刻重新起算 1 小时。读取统一优先使用合法最终缓存，所以原快照即使停在 running，也不能覆盖该 unknown。父调用的消费/固化操作串行执行，不增加恢复锁或账本；缓存写入失败返回 `runStateUnavailable`（退出 1），不假装已有可重复读取的终态。

终态通知尚未被 result 消费时，首次 wait 将这次 unknown 作为未读终态变化，按前述输出合同包含完整可用结果或 deferred 摘要，并推进观察位置，后续 wait 不重放。result 成功输出这份已固定的 unknown、部分正文、缺口和全部未读消息后，按前述输出合同消费消息与终态通知并退出 0；再次 result 只返回固定最终结果。stop 先采用同一失联结论，再按归属证据处理仍存活的 adapter/后代；本地停止信息可更新，但不把失联结果改成完成或重跑任务。过期后只允许已有停止/清理路径，不再生成缓存。

## 操作系统与安装闭包

Windows 支持指原生 Windows 进程和文件系统上的完整 start/send/wait/result/stop 闭环。不能用 WSL、交叉编译、mock 或仅通过文件选择测试替代运行证据。实现复用仓库已有平台能力时须核对其生命周期；当前 Eval 的 Windows Job helper 只提供可参考的既有机制，不自动证明适合本次后台 worker。

| 边界 | 必须保持的行为 |
| --- | --- |
| 启动与参数 | Node 入口、所选后端 executable 及受支持的包管理器 shim 在当前系统正确解析；通过 executable 与 argv 传参。不得把 prompt、消息、路径或配置拼成 shell 命令。无法安全解析的入口在模型提交前报错，不静默换后端 |
| 后台生命周期 | start 命令退出后，获准的 worker 继续运行；wait 调用结束也不回收 worker。若使用 Windows Job，所有者和句柄生命周期绑定本次长期执行，不能因短命令退出而关闭它。宿主不允许时在提交前报告限制，不申请 breakaway 来绕过宿主约束 |
| 进程归属与停止 | 按当前 OS 取得本次 root、后代和启动身份的可靠证据。Windows 不依赖 POSIX ps、负 PID 进程组或 Unix 信号含义。只停止可证明属于本次运行的进程；PID 复用、共享浏览器及归属未知都不能扩大范围。本地停止与远端取消分别取证 |
| 路径 | 使用当前 OS 的绝对路径及类型校验；覆盖盘符、空格、中文、安装目录移动及跨盘工作目录。UNC 等路径只有满足相同归属、访问控制和写入语义时才接受，不能用字符串前缀代替边界检查。文件选择语法继续以既有 v1 为准 |
| 文本与管道 | 任务、指令、消息和结果按 UTF-8 字节处理，保留正文原有 LF/CRLF、中文和非 BMP 字符。内部协议分隔遵守 v5，程序封套使用 LF；stdin、stdout、导出不经过控制台代码页或 shell 文本管道的隐式重编码 |
| 私有资源 | POSIX 目录/文件分别使用 0700/0600；Windows 用当前用户的受保护目录与实际访问控制取得等效保密边界，mode 数字或 chmod 成功本身不构成证据。身份校验使用当前 OS 的用户与归属事实，不能把 Unix uid 设为通用前提 |
| 文件提交与回收 | 私有状态仍完整写入后原子发布；Windows 的占用或访问拒绝须明确报告，不能先删除旧状态再写入。--output-file 的完整导出由调用者保留，run TTL 不删除该文件。扫描不跟随 symlink、junction 或其他重解析链接；无法证明归属或停止时保留资源，不能因为删除失败扩大清理范围 |
| 安装闭包 | worker、adapter、工具桥接及必要的平台 helper 来自当前安装 resourceRoot 和正式依赖。按目标架构分发并校验；不要求运行时访问开发 checkout、临时下载 helper 或增加系统服务 |

Windows 原子 JSON 发布对 rename 的 EPERM、EACCES 和 EBUSY 最多重试五次，总退避等待为 620ms；每次复用同一份已保护的临时文件，不先删除旧文件，也不重发后端输入。持续失败保留错误。worker 能保存最终结果时，文件错误的 diagnostic 块包含操作名及运行资源类别，不包含绝对路径、动态文件名、原始错误正文或堆栈。

这些是实现和验收约束，不要求新增全局进程账本、常驻 supervisor、锁层级或跨会话恢复协议。具体平台 API 与可复用模块由实施者在同等行为边界内选择。Windows 的启动、持续收件、停止、导出和过期回收须在实际 Windows runner 上验证，并保留所用架构及后端范围。

## 升级与验证

开发阶段直接更新 v5 的 start/ready 结构，不支持旧 ready 的顶层 communication/communicationSupported，也不支持缺少 communication 或适用 permissionMode 的 start 请求，不增加版本协商或迁移。不保留旧 run/poll/v4 执行器、preview 参数或结果文件旁路。result 支持普通报告和 --output-file PATH；--export 按未知参数拒绝。Manifest v3、Config Definition v4、Store v5、Catalog v7、installed-runtime-config v2 和 Eval instruction-v2 不联动改号。通过正常 build/sync/reinstall 更新产物；升级、重装或删除前先完成或 stop 所有活跃外部任务；旧运行由原工具完成或停止，不扫描、接管或删除旧协议资源。

确定性验证采用 `pnpm plugin:test codex-enhance` 和 [测试指南](https://github.com/lesliechan721-arch/agent-workflow/blob/main/docs/testing.md) 的最低足够真实层级。协议、helper 和 fake 后端保护本地合同及副作用；产物测试须从实际 build/materialization 的 resourceRoot 启动 worker、adapter、脚本和 MCP 工具，保留角色资源、配置表与通信模板注入点与原生角色局部边界。不得依赖开发 checkout、宿主 node_modules 或临时下载 helper。

[最低合同验收](protocol.md#8-最低合同验收)、8 KiB 实际工具链完整交付和 --output-file 完整保存分别取得证据。fake 不能关闭 Codex 自动收件、Claude 会话输入、真实后端停止、模型效果或原生 OS 的证据缺口。Windows 须在真实 Windows runner 验证，macOS/Linux 证据不外推。文案和结构自检不证明模型理解或任务效果；真实模型与 Eval 遵守 [插件维护流程](https://github.com/lesliechan721-arch/agent-workflow/blob/main/docs/plugin-maintenance.md) 的独立审核和授权要求。

仍需分别记录真实证据的范围包括：Codex profile精确字段的实际消费者、config/read层完整性、hook来源与信任/bypass；Windows注册包内CLI发现与握手；Antigravity复杂路径、用户/共享/项目策略组合、沙箱文件与PID可见性、auto账户资格及原生平台行为。macOS App的无模型握手不证明profile消费者或Windows行为。Antigravity消息发送以实际父侧通道收到消息为依据；模型结果正文、回执标记或随机文本比较不用于决定通讯能力是否存在。组合命令权限拒绝保留为该次调用失败，不能仅因此认定所有通讯不支持。协议、投递分类、输入不重放和停止事实仍须验证；help、fake和文档不替代真实后端证据，不声明未经证明的平台支持。
