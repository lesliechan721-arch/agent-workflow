# 运行生命周期与平台支持

[适配器文档索引](README.md)

## 命令输出合同

### 1. 英文控制信息与原文数据

程序生成的字段、枚举、错误码、提示、help、运行说明、工具描述和诊断使用英文。任务、父子消息、模型最终回答及必要的外部原始数据保留原语言；不翻译、不因含中文而拒绝。敏感值继续按现有规则脱敏，不新增原文副本。

每段模型正文、过程消息、未提交输入或引用的外部诊断都放在独立原文块内。不能把正文直接拼到状态行、错误码、工具说明或响应外部；模型回答中声称完成，不影响结构化 state。标记只是阅读边界，不是内容可信或执行授权的证明。

名称、句柄、状态、code 等受约束值可以直接放在单行控制字段中。路径等其他动态标量使用 JSON 字符串转义作为单行值，原始换行、引号和控制字符不能改变结构；这不使整个响应成为 JSON。第三方多行诊断进入 DIAGNOSTIC 块，不能混入控制字段。

### 2. 平铺控制字段与短正文边界

首行固定为 `<command>: <outcome>`。wait 仅在还有已观察到但未消费的事件时紧接一行 `more: true`；省略时为 false。没有目标记录时，响应只有命令结果行。故 `wait: timeout` 和 `wait: settled` 各只需一行。

有内容时，按 --run 输入顺序分目标组，组间空一行。每组先列 `agent`（即运行名称）、`run`、`state`，身份只声明一次；同组的状态、消息和最终结果均归属该句柄。无法验证目标时只列 run 和错误，不编造名称或状态。每个组内继续使用第 4 节的事件顺序，不按正文种类重排。两条相同正文仍分别成块。

控制字段不使用 RESPONSE 或 META 包装。原文块按用途使用以下标记，均独占一行并以 LF 结束：

```text
BEGIN_MESSAGE:TOKEN
<original process message>
END_MESSAGE:TOKEN
```

用途只有 `MESSAGE`（过程消息或子侧收件）、`INPUT`（未解决投递的父输入）、`FINAL`（最终正文）和 `DIAGNOSTIC`（外部原始诊断）。不同用途遵守相同分隔规则，不嵌套。每次呈现生成一个 **8 位小写十六进制 TOKEN**；格式化前检查它没有出现在本次实际输出的任何数据中，碰撞则换一个。TOKEN 只用于当前输出，不保存、不查找、不用于路由或鉴权。纯控制响应不需要 TOKEN；result --export 的完整 stdout 与独立 stderr 各自生成边界。

BEGIN 行后原样写入正文，再写一个属于封套的 LF，然后写对应 END 行。无论原文是否以换行结束，都不 trim 或修改原文；这个额外 LF 不属于正文。内部精确计数 UTF-8 字节，但默认不显示 body_bytes。正文中的假状态行、代码块或不同 TOKEN 的假标记不能关闭实际原文块。边界检查必须覆盖所有选中的正文、动态字段和诊断。

正常启动示例：

```text
start: ready
agent: api-review_2.1
run: <opaque-handle>
state: running
environment: available
communication: true
communication_status: enabled
communication_transport: mcp
communication_passive_delivery: in-turn
communication_active_receive: true
```

短结果的首次 wait 示例；正文为 16 个 UTF-8 字节，句柄只是示例：

```text
wait: changed
agent: api-review
run: <opaque-handle>
state: completed
BEGIN_FINAL:8a731c0d
No issues found.
END_FINAL:8a731c0d
```

more 不表示任务仍运行，也不表示 deferred 正文会在下次 wait 重放。END 只分隔原文，不能证明调用工具没有裁掉中间内容；完整交付还须满足第 4 节的调用工具预算合同。

### 3. 必要字段、条件字段与结果内容

| 输出 | 必要控制信息 |
| --- | --- |
| start | agent、run、state、environment、communication；未知成员为 pending，环境为 available/unavailable，简单通讯能力为 true/false；首次已知时附完整能力字段及诊断；结果词为 ready/notReady/error |
| send | agent、run、state、delivery；成功为 queued，关闭竞态不明为 unknown；结果词为 queued/unknown/error |
| wait | 结果词为 changed/timeout/settled/error；有事件的目标组包含 agent/run/state，失败目标带 code；more、environment 及 communication 按条件出现 |
| result（含 --export） | 结果词为 read；agent/run/state、按序的全部未读消息/问题通知、固定最终结果；initialization 的公开字段按条件补报。--export 使用相同报告格式，无保存回执 |
| result 超限 | 结果词为 error，code 为 resultTooLarge；agent/run/state、result_bytes、output_limit_bytes、英文导出指引 |
| stop | agent/run/state、已确认的本地停止信息或明确缺口；结果词为 stopped/stopping/error；本地停止不等于业务 cancelled |
| 子侧发送/接收 | command 为 send_parent/receive_parent；结果词为 submitted/received/timeout/closed/error，接收原文独立放入 MESSAGE 块；不另暴露运行句柄 |
| 诊断/错误 | English code 及英文程序说明；外部原始诊断独立成块；独立 stderr 首行为 diagnostic: error |

**环境、能力与诊断通知。** environment 为 pending/available/unavailable；无可靠结论时 pending，unavailable 时附 environment_code。communication 保留 pending/true/false；enabled 计算为 true，disabled/unsupported 为 false。首次取得已确定的通讯描述时输出 communication_status；enabled 同时输出 communication_transport、communication_passive_delivery、communication_active_receive，disabled/unsupported 只输出 status。transport 描述子侧发信/主动收件接口，不描述父侧 CLI。

start 总是显示当时的简单状态。若只交付 pending，后续 wait 的首个状态/终态记录（含 deferred），或 result 完整报告须补报完整描述及 ready/result 诊断。诊断以 DIAGNOSTIC 原文块显示并随固定结果保存，result 可重读。快照合并、closing 或快速终态不能吞掉尚未交付内容；不增加事件日志或 ACK。能力交付后无需重复；start 即使显示终态也只确认能力观察，不消费终态通知。stop 不推进观察位置；result 输出并消费成功才推进，超限或输出失败不推进。初始化失败可报告已确定环境；未检查的通讯仍为 pending，不能填 false。environment:unavailable 可与 communication:pending 同时出现。环境尚无可靠结论的失败或失联保持 pending，首次终态明确显示未知项。固定结果中的 initialization 与安全诊断可重读。诊断仍须脱敏并满足既有帧/输出预算，过多时按字段组汇总并给总数。

完整最终结果的内部数据仍包含名称、句柄、真实终态、有效期、生成阶段、实际后端退出码、适用的停止证据、故障和全部未解决投递。显示层只按下表省略已确定的正常值，不能删除缓存或程序合同中的证据。

| 信息 | 显示规则 |
| --- | --- |
| agent/run/state | 每个目标组一次；真实状态不省略 |
| more | 仅 true 显示；省略严格表示 false |
| result: included | 不显示；完整 FINAL 块和同组完整最终投递缺口共同表示结果已包含 |
| result: deferred | 必须显示，并附第 4 节的大小与读取指引 |
| text_status | completed 的完整正文可省略 complete；其他状态必须显示 partial 或 missing，不因非空改为 complete |
| generation_started/backend_exit_code | completed 时可省略 true/0；failed/cancelled/unknown 时显示真实值，未知显示 null |
| remote_stop_confirmed | 有停止意图或远端停止证据影响分类时显示 true/false/unknown；缺失证据不能显示 true；其他场景可省略 |
| expires_at | 不向主代理显示；完整结果、deferred、--export 报告均省略，也不以其他字段显示到期时间。内部保留缓存时间并执行固定 TTL |
| code、故障与未解决投递 | 实际存在时必须显示；必要父输入原文不能省略 |
| body_bytes | 仅内部精确计数，默认不显示 |

一个终态结果组先给出结果控制字段和必要故障。有投递缺口时，在最终正文前显示 `delivery_gaps: <count>`；随后逐条列 `delivery: notSubmitted/unknown`、code、必要原因及 INPUT 块，再给 FINAL 块。没有缺口时省略 delivery_gaps，含义为 0。运行中的投递问题也使用 delivery/code/INPUT，不能只显示正文。诊断与最终回答分块，缺失正文仍输出空 FINAL 块并标 missing。已在 wait 显示过的问题，若最终仍未解决，可以再次进入固定结果；这不是历史接口。

例如完成结果可以同时带有 unknown 投递缺口：

```text
wait: changed
agent: api-review
run: <opaque-handle>
state: completed
delivery_gaps: 1
delivery: unknown
code: inputDeliveryUnknown
BEGIN_INPUT:8a731c0d
Check both callers.
END_INPUT:8a731c0d
BEGIN_FINAL:8a731c0d
The first caller is valid.
END_FINAL:8a731c0d
```

这里 completed 只证明任务结果满足完成条件，不能证明追加输入已经提交。unknown 不等于明确失败，也不授权安全重跑。不得只输出最终正文而省略其投递缺口；不能容纳整个结果组时必须按第 4 节处理。

最终结果缓存固定后，重复读取的业务字段、正文和缺口不变；TOKEN 和首次按条件补报的 initialization 公开字段可以不同。result 首次还包含全部未读过程消息和问题通知；成功消费后不再出现这些内容。固定最终结果中的未解决投递摘要不因通知已读而删除。读取允许重现最终结果，不要求整份报告或封套字节相同。

多目标 wait 某个目标失败时仍检查其他有效目标，并在预算内交付。存在已交付变化时结果词为 changed，仅错误时为 error；本次检查遇到任一目标读取失败则退出 1，即使该目标的完整错误记录因预算延后，也须给出有界命令级提示并保留该记录待取。无读取错误的 changed/timeout/settled 退出 0。deferred、more 和任务 failed/unknown 本身不使读取命令失败。

### 4. 8 KiB 显示预算、调用工具预算与 wait 选择

##### 脚本和单事件上限

wait 与未加 --export 的 result 每次调用的 stdout 与 stderr 合计最多 **8192 UTF-8 字节**。控制字段、标记、空行、分隔 LF 和诊断都计入。stderr 至多 **1024 字节**，仍占同一总预算；不得透传 adapter stderr。先确定有界诊断，再装入 stdout 事件，保留后续读取失败所需的错误提示空间。只允许缩短程序诊断摘要，不能截断消息、父输入或最终正文后声称完整。

两个方向的单条过程消息均最多 **4096 UTF-8 字节**。一个普通消息或投递问题的完整呈现最多 **7168 字节**，其中包含命令行、目标身份、实际状态、待补报能力、所有标记、必要错误 code 和指引；再加最坏 1024 字节 stderr，也必须可独立交付。实现必须按最大合法字段验证这个上界，不能把“实际能放下”作为消息入队后的附加条件。

为满足该上界，普通事件的控制字段及标记合计最多 1024 字节，附加可显示诊断合计最多 1024 字节，消息原文最多 4096 字节，余下 1024 字节留给响应级提示。Adapter 的可选错误 message 仍最多 4096 字节；显示层可以提炼有界英文诊断，code 和投递分类必须保留。引用的外部诊断如果无法完整容纳，可以省略原文并显示 `diagnostic_omitted: true`，不能裁改后伪装为完整引用。父输入和模型消息不是可省略的诊断。

#### 调用工具合同

本节面向调用工具集成的实施与验收，不作为 Skill 的原生工具教程。字节预算不等于调用工具 token 预算；实施者须为支持的实际调用链固定并验证预算。沿用 v6 的首版验收配置：Codex exec_command 与 write_stdin 的 `max_output_tokens: 16384`；存在 functions.exec/functions.wait 包装时，外层分别为 `max_output_tokens: 16384` / `max_tokens: 16384`。具体传参遵守实际工具 schema。每个验收样本只转交一条命令的原始 output，不以多命令汇总、摘要、head/tail 或额外 JSON 字符串化代替完整交付；覆盖启动、等待和续读。

这组参数是首版技术取值，不是对所有调用工具的无条件保证。实施验收必须经实际执行工具及全部中间包装，证明最大合法 8192 字节响应、最大单条消息及封套都完整进入模型上下文；覆盖高 token 密度文本、中文、换行、可合法出现的控制字符及序列化开销。不能只用平均字节/token 比例、stdout 文件完整、首尾标记仍在或没有报错证明完整。

支持声明须有真实链路证据，不能只因为设置了数值就认为通过。更低的固定工具上限必须先调整调用预算并验证；仍不能完整承载时，该工具调用路径不受支持，不能先消费再试。运行脚本不新增调用工具预算参数或探测协议。Guide 的运行正文保留选择边界和消费后果：使用能完整承载回执的工具调用路径，裁剪时标记交付不完整，已消费过程消息不保证重读。result --export 的完整 stdout 不受脚本显示上限限制，但调用工具仍可能裁剪，主代理须事先选择完整接收路径，见第 5 节。已有回执丢失边界继续有效，不增加 ACK、历史或恢复账本。

##### 完整事件选择

1. 检查全部目标后，按 --run 输入顺序处理可见变化；每个 run 先考虑合并后的最新状态，再按接收顺序考虑过程消息/投递问题。状态和每条消息是独立事件，组头及条件能力随对应状态或终态记录原子选入，不留下无归属正文。
2. 以完整事件为单位装入响应并精确计数。普通事件放不下时停止装入；该事件及后续事件保持未读，显示 more: true。单条合法普通事件必须满足上述空响应可交付上界。
3. 首次终态是一个结果组，包含最终正文和全部最终投递缺口。能放入剩余预算时完整交付；若可独立放入空响应（包括必要封套和已确定诊断），只是剩余空间不足，则整个终态保持未读并标 more。只有整个组连空响应都放不下时，才改为有界 deferred 通知；连通知都放不下时也保持未读。
4. included（由完整内容表达）或 deferred 终态通知均只消费一次，最终缓存不删除。同一终态 run 尚未输出的普通消息继续保持未读。more 只计算未消费事件，不计算已交付 deferred 的正文。
5. 消费前完成全部序列化、边界碰撞检查及字节计数，再按本文运行生命周期消费。本规则不引入事务式消费保证；工具调用前须已满足预算合同，回执丢失遵守原有边界。

deferred 至少包含 agent/run/state、尚未交付的环境与通讯字段（若适用）、`result: deferred`、result_bytes、`deferred_reason: outputLimit` 以及读取指引；有最终投递缺口时还须给出 delivery_gaps 数量，避免误认为 completed 已包含全部追加输入。该通知最多 2048 字节。所有逐条分类、code 和原文由随后的完整 result 显示或导出，不用不完整 FINAL 组替代。

`result_bytes` 在 wait 的 deferred 记录中表示固定最终结果按单目标 result 呈现所需的 UTF-8 字节数（含封套，不含本次诊断及独立未读过程消息），不改变 wait 以完整终态组选择的规则。在 resultTooLarge 中，它表示本次 result 完整报告（全部未读消息和固定最终结果，含封套、不含本次诊断）的字节数；`output_limit_bytes` 为 8192。二者不是 token 数或 JSON 帧大小。

wait 的 deferred 固定结果大于 8192 字节时提示 `Use result --run <handle> --export with a destination that accepts the full output.`；否则提示 `Use result --run <handle>.`。后一种情况可由 wait 自身封套或诊断使单结果放不下引起；随后的 result 仍须计入所有未读消息及实际诊断，可能返回 resultTooLarge。resultTooLarge 始终指引使用 --export 并由调用者选择完整接收方式。指引使用真实句柄和安全引用，不接受或生成目的路径。

未加 --export 的 result 先检查全部未读事件与固定结果能否一起完整显示，不能复用 wait 的部分选择规则。超限时只输出有界错误及指引，不消费任何事件；报告能完整输出时，按第 5 节输出及消费。已交付的 deferred 不在后续 wait 自动展开；即使省略 more（即 false）也必须按指引取得完整结果。

### 5. result 全量报告、--export 与消费

`result --run <handle>` 和 `result --run <handle> --export` 都先按接收顺序列出全部未读过程消息及运行中问题通知，再列出固定最终结果。组头 agent/run/state 只出现一次；尚未交付的环境与通讯字段随组头补报。终态结果部分仍按第 3 节显示必要故障、最终投递缺口及 FINAL 块。问题通知和固定结果中的投递摘要是不同数据：前者只消费一次，后者作为最终判断证据允许重读。没有未读消息时只输出固定最终结果及适用的能力字段，不创造空消息块或 more 字段。

两种调用均用 `result: read` 和同一套字段、UTF-8 字节与原文边界。--export 是不带值的布尔标志，小报告也可使用；它只取消该次 stdout 的 8 KiB 显示上限，stderr 仍最多 1024 字节。最终正文仍最多 4 MiB，单条消息和诊断仍受各自限制；未读消息和投递摘要不设置累计条数或总输出字节上限。报告可流式校验、计数与输出，不能绕过接收端校验或读取任意 backend scratch。

`--output-file` 被删除并在副作用前拒绝；不再输出 exported、output_file、bytes_written，也不提供 outputFileExists/exportIncomplete 文件管理错误。脚本不接收目的地、不创建或管理文件、不执行重定向命令。主代理可用调用工具的能力把 stdout 写到文件、传给管道或其他接收端；目的地选择、覆盖规则、权限、下游完整保存和副本清理由主代理负责。run 过期不删除调用者保存的副本。

##### 输出与消费顺序

1. 确认 run 终态、归属和有效期；同一 run 的 wait/result（含 --export）由单逻辑父串行调用。确定本次全部未读内容和固定结果，检查内容可读性、边界碰撞；默认模式再核对 8192 字节总预算。前置失败不消费消息、终态通知或能力观察位置。
2. 将完整报告写入 stdout。未加 --export 时不允许部分显示；加 --export 时完整写出且处理背压，不因超过 8192 字节裁剪或停止。写入失败（包括 EPIPE）返回非零并尽力在有界 stderr 报告 `resultOutputFailed`；不开始消费。
3. 全部 stdout 写入完成后，删除本次未读消息和问题通知，最后推进终态及状态/能力观察位置；成功退出 0。最终缓存保留。wait 随后无未读事件时 settled；再次 result 只读固定最终结果。
4. 输出完成后的消费失败返回非零，stderr 报告 `resultConsumeFailed`；已删除内容不回滚，未删除内容和未完成的观察位置保留。stdout 的 `result: read` 不是整次成功的证明，调用者还须检查退出码和 stderr。进程异常中断可能发生于输出与消费之间；再次读取可出现已经输出但未删除的消息，不提供跨二者的 exactly-once 保证。

本顺序不增加 ACK、事务、已读集合、历史副本或重试队列。与 wait 的有界批次消费顺序分别定义，不能将 wait 的部分交付规则套到 result。工具回执丢失或裁剪发生在脚本成功消费之后时，已删除过程消息不能重读；只有固定最终结果仍可重读。

##### 调用工具的输出限制

--export 不取消调用工具的输出限制，也不要求任意大报告直接进入 Agent 上下文。主代理在调用前选择能完整接收 stdout 的方式；例如让执行工具直接保存到文件，再分段读取，或将输出转发给其他完整接收端。不能先经会裁剪的工具回执取得字符串，再将这个字符串保存并声称完整。完整接收不要求把全部正文一次放入模型上下文。

脚本可观察的 stdout 写入完成，只说明字节已交给接收端；不能证明下游写盘、管道消费者或工具返回给模型的内容完整。下游失败及工具裁剪由主代理根据所选工具的状态核对；若脚本已消费，不保证过程消息可恢复。验收需分别覆盖默认 8 KiB 报告完整进入工具回执，以及 --export 大报告经文件或非文件接收端完整保留；包括工具回执裁剪、管道断开和消费失败。第 4 节的固定 token 配置不构成 --export 任意大输出的承载保证。

## 停止、失联与结果缓存

### 3. start

1. start 固定本次安装配置、执行器和输入，创建私有运行目录及句柄。
2. worker 接管适配器、消息及收尾。默认不设置执行期限，内部 `deadlineAt` 为 null；仅显式提供 `--deadline-ms N` 时，从 worker 启动时刻加 N 毫秒得到本次固定期限。
3. adapter 在首次提交模型前发出一次合法 `ready`，携带完整 initialization 对象和可选 diagnostics。worker 保存它们，start 返回。
4. start 最多等待 10 秒初始化。未取得 ready 时显示 `state: starting`、原句柄、`code: startupNotReady`，环境按已知结论显示、未知为 `environment: pending`，通讯未知为 `communication: pending`，退出 1；不能伪造 false。调用者继续 wait/stop 同一任务。

`--deadline-ms` 是可选的本次执行时长，不写入配置。N 必须是正的安全整数，且与启动时刻相加后仍为合法 EpochMs；非法值在创建运行资源前拒绝。省略时不创建执行超时计时器，不默认填入 30 分钟，也不从 wait/receive 窗口或缓存 TTL 推导任务期限。明确期限不会被新消息、后端轮次或再次等待延长。默认无期限仍响应 stop、通道断开、协议错误和真实后端退出；后端或宿主的实际限制按真实错误报告。

`false` 表示描述为 disabled 或 unsupported，两者由 communication_status 区分。缺字段、协议错误、初始化失败和通讯配置故障不能折算为 unsupported。支持路径初始化失败须结束并报告实际错误；运行中故障进入收尾，不静默降级。

`true` 表示 enabled，子代理已取得相应发送入口，及本次声明的被动输入或主动收件能力。它不保证立即打断、模型已读或追加要求完成；父侧按完整描述判断实际方式，不要求模型周期性检查信箱。

任务可能在 start 返回前已经结束，此时显示实际终态和原句柄；未有 ready 时按已有结论显示环境，未知能力仍为 pending。start 不返回最终正文，也不消费任何过程消息或终态通知。它显示的非终态可作为初始状态观察位置，但终态始终保留为未读，使随后第一次 wait 仍能取得结果。stop 不消费 wait 的事件；result 按第 4 节交付并消费全部未读事件。

晚到环境、ready、诊断及终态的观察和补报按[环境、能力与诊断通知](#3-必要字段条件字段与结果内容)执行，复用已有快照与观察位置。

不提供 start 预览或替代的预览命令。help 只读；参数形状检查在创建运行资源前完成。bundle 正式启动时仍通过既有 fileResolver 解析选择式，不将删除 preview 扩大为删除文件选择能力。

### 4. wait 与单目标 result

##### wait：一个窗口观察全部目标

至少提供一个 `--run`，重复句柄合并，最多 16 个不同目标。`--timeout-ms` 默认 **600000**，允许整数 **0–1800000**。默认给任务至少 10 分钟的响应式等待窗口，有新事件立即返回，不强制等满。明确的更短用户等待窗口、已设置的剩余执行时限或即时检查可缩短本次窗口。超时或中断只结束这次 wait，不终止任务、不重新调用模型、不延长任务或缓存期限。

等待策略同时适用于 Guide 的原生与外部路径。等待工具单次上限不足 10 分钟时，使用允许的最长窗口续等同一任务；这个限制不把默认预算降成短轮询。执行工具的短期让出、脚本内部检查周期和 Agent 主动重新检查是不同层：内部检查可保持响应性，Agent 不应据此每几秒发起新 wait。只有 more: true 等明确的待取事件可以用零等待排空。start 的 10 秒初始化观察和 stop 的 30 秒收尾观察保持各自用途。

先检查全部目标；已有新消息、状态变化、投递缺口或需要处理的错误时立即返回。否则使用同一个截止时间观察全部目标，任意目标变化即返回。按目标输入顺序、各目标的待取事件顺序组织输出；同次可见的变化在预算内一起交付，不输出未变化目标的重复状态，不能先等完 A 再检查 B。

程序可使用短周期检查及文件通知。通知只是提示；订阅后再次检查，定时检查保底。各 run 的进度独立保存，更换等待集合不会重置 B 的状态位置。

| 情况 | 输出与行为 |
| --- | --- |
| 新过程消息/状态/故障 | 仅返回有变化的目标及本批完整事件；名称/句柄每组一次，原文逐条分块；有未交付的已确定环境或能力时附对应字段 |
| 首次终态通知 | 能容纳时附完整最终正文和全部投递缺口，不另写 result: included；单个完整组本身放不下时标 result: deferred，附大小及读取/导出指引；只是本批空间不足时保留整个终态未读 |
| 窗口结束，无变化 | 只有 `wait: timeout`；没有目标旧状态或正文 |
| A 已返回终态，B 仍运行 | 后续 wait A B 不被旧 A 终态唤醒，不重放 A 的终态或正文；A 仍有未读过程消息时可以交付 |
| 全部目标终态且没有未读事件 | 立即返回 `wait: settled`；不重放各目标终态或正文 |
| 某目标过期 | 返回该目标 runExpired，不再返回缓存正文；同时保留其他可读目标的本批结果 |
| 目标已清理、丢失或不能证明归属 | 返回 runUnavailable，不创建或接管执行 |

状态更新可合并为最新快照，但内部更新序号必须能发现两次检查之间发生过变化，且不得吞掉尚未交付的能力。这个序号不是历史。每个 run 只有一个逻辑父接收者；对同一 run 的 wait/result（含 --export）应串行调用，首版不支持重叠的多消费者。

**消费边界。** 所支持的调用工具链须先满足输出预算合同；脚本再在字节预算内构造完整响应，消费本批事件并输出。过程消息取出即删；终态通知只消费一次，不删除最终缓存。未选入本批的消息、问题通知和状态保持未读，下次 wait 可立即取出，并标 more: true。没有剩余事件时省略 more，含义为 false；它不表示任务结束或 deferred 正文已交付。不会因报告终态而顺带删除尚未输出的过程消息。

删除失败则本次不交付受影响的消息并报告读取失败。正常路径不保留已读消息集合或历史副本；若消费后工具回执丢失，该批过程消息和终态通知不能由 wait 重放。最终结果仍可通过 result 读取。部分消费失败不引入事务式恢复、ACK 或重试队列。

每次 wait 的 stdout 与 stderr 合计至多 8 KiB；stderr 最多 1 KiB。单条消息最多 4 KiB，普通事件含封套和必要诊断最多 7 KiB，所以它必须可在空响应中与最坏 stderr 一起交付。批次放不下的事件保持未读。若单个结果可在空响应中完整显示，只是本批空间不足，则整个终态保留未读并标 more；只有单个完整结果本身放不下时，才交付 deferred 通知并消费该通知，缓存保留。详见 [命令输出合同](#命令输出合同) 的精确计数和选择规则。

调用工具预算的首版技术取值和实际链路验收保留在输出合同，作为实施与维护依据；Guide 不重复 exec、续读或外层编排工具的 schema 教程。验收仍须证明 8 KiB 最大响应经过实际调用工具全链路完整可见；字节/token 比例和首尾标记不能代替验证。不能满足时不得使用该工具调用路径消费消息。Guide 说明裁剪意味着交付不完整、过程消息无法重读及最终结果的导出路径；不为此增加 ACK、历史或自动重跑。

完整结果若有 notSubmitted/unknown 投递缺口，先显示缺口数量、逐条分类、code 和父输入原文，再显示最终正文。completed 仍可带投递缺口。正常 completed 可省略 generation_started: true、backend_exit_code: 0 和 text_status: complete；失败、未知和部分正文必须显式保留影响判断的证据。内部结果数据不按显示省略规则删减。

##### result：一次取完未读消息，并读取最终结果

`result --run <handle>` 必须且只能指定一个句柄；不接受多个 --run、超时或 history。只在终态且未过期时交付完整报告：先按接收顺序输出全部未读过程消息和运行中问题通知，再输出固定最终结果。最终结果包括名称、句柄、真实终态、最终正文、未解决投递摘要及必要故障证据。名称/句柄只声明一次；尚未交付的能力按第 3 节补报。

完整报告成功输出后，删除本次全部未读消息和问题通知，并消费终态通知及对应状态/能力观察位置。此后 wait 无其他未读事件时返回 settled。仅固定最终结果可在原定 1 小时内重复读取；后续 result 不重放已经删除的过程消息，不启动模型、不续期。最终结果内的未解决投递摘要仍随结果保留；问题通知的删除不会删除这份判断最终结果所必需的证据。这不构成过程消息历史。

未终态返回 resultNotReady 并立即退出 1，不借 result 提前排空过程消息；过期返回 runExpired，资源已删除/不可用返回 runUnavailable。未知/失败任务可以读取已固定的部分正文和缺口，不能将部分结果标为完整。所有读取在取内容前检查有效期；合法取得的本次报告可完成输出，不因输出耗时延长之后的可读期限。

**默认输出。** 未加 `--export` 时，全部未读消息、固定最终结果、封套及诊断合计能完整容纳在 8 KiB 预算内才输出。否则仅返回 `code: resultTooLarge`、完整报告字节数及 `--export` 指引，退出 1；不输出部分正文、不消费任何消息或通知、不改变观察位置。即使最终正文很短，只要未读消息使完整报告超限，也按此规则处理。

**完整输出。** `result --run <handle> --export` 中的 `--export` 是无参数布尔标志，小报告也可使用。它将相同的完整报告直接写入 stdout，取消该调用的 8 KiB 显示上限；不接受目的路径，不创建、覆盖或登记输出文件。删除 `--output-file` 及其文件回执；旧参数按无效输入拒绝，在扫描、读取或消费前退出 2。主代理自行选择文件重定向、管道、其他接收工具或直接显示。报告使用相同平铺字段、条件省略和原文边界，不输出到期时间。最终正文仍最多 4 MiB、单条消息仍最多 4 KiB、stderr 仍最多 1 KiB；完整报告不设置累计消息或总输出字节上限。

**消费和失败边界。** result 在输出前完成内容可读性、边界碰撞及默认模式大小检查；大报告允许多遍流式检查，不要求一次全部装入内存。完整 stdout 写入成功后才删除消息和推进观察位置；可观察到的读取或输出失败（包括管道断开）返回非零，尚未开始消费，不报告整次成功。消费期间删除失败则返回非零并报告 `resultConsumeFailed`，未删除消息和未完成的观察位置保留；已删除内容不回滚。正常路径不保留已读集合、ACK、事务、重试队列或历史副本。异常中断或部分消费失败后的再次读取可能包含已经输出但尚未删除的消息，不能承诺跨输出与删除的 exactly-once。

脚本写入成功不证明调用工具、下游文件或其他接收端已完整保存。调用工具可能限制或裁剪输出；`--export` 不提高工具上限。主代理须在调用前选择可完整接收的路径，必要时直接将 stdout 保存或转发，再按需读取。工具裁剪或回执丢失时，已消费的过程消息无法由 result/wait 重读，只有固定最终结果仍可重读；完整保存的副本由主代理管理。工具不管理这些副本的路径、覆盖、权限、清理或下游持久化，也不随 run 过期删除它们。

### 5. send、子侧问答和结束

过程消息限于合法 UTF-8 文本；空白正文、NUL、非法编码及超限拒绝。正常传输保持原文，不 trim、不按正文去重、不执行 shell。两次相同文本是两条消息。所有界面保留已有敏感值脱敏边界；脱敏与诊断都不增加原文副本。

send 对 starting 返回 `runNotReady`，对不支持通讯的 running 返回 `communicationUnsupported`，对 closing/终态返回 `runClosed`，对过期或不可用目标给出相应错误，不改换执行器。

成功 send 显示 `delivery: queued`。它只表示写入本次待发资源；不保证后端接受或模型已处理。发送前后检查当前状态，关闭竞态无法确认交付时显示 `delivery: unknown`，不能把文件写入当作送达证明。

worker 给待发消息分配内部标识，经 v5 提交。adapter 只报告 `submitted/notSubmitted/unknown`。明确提交后删除父侧正文副本；明确未提交或未知则在 wait 中显示正文和原因，或归入终态的投递缺口。实现不得把一个不明提交自动发往另一通道。

子代理通过已配置的 MCP 或脚本发送；仅 activeReceive=true 时有 receive_parent(timeoutMs) 或等价脚本来保持有界等待。发送不隐含问答匹配或等待，不要求 Agent 填写 ACK、replyTo、消息 ID。自动输入与显式收件由同一个调度器分配，已提交输入不再由 receive 重放。没有主动收件入口时，发问也不会让 run 自动保活；缺必要回复须在结果中标出未完成部分。

一个后端 turn 完成不必然结束 run。已经接受且明确未提交的消息可在原授权及已设置的执行期限内进入同一会话下一轮；无待处理输入则收尾。进入 closing 后不再接受新输入；迟到消息明确归类，不重开会话。子代理不能先结束任务，再期待父回复自动启动下一轮。

### 6. 最小临时存储与过期

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

### 7. stop 与任务状态

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

确认 worker 已不存在、没有最终缓存且按第 6 节固定的期限尚未过期时，由当前单逻辑父调用原子保存一次 `unknown` 结果，code 为 `workerLost`。该分支不启动 worker/adapter、不接管其会话，不成为后台恢复机制。只保留已经原子保存且可验证的部分正文及投递证据；没有正文则为空，并显示 `Final text was not saved.`。不读取零散日志、后端 session 或 scratch 文件拼装答案；无法证明的生成阶段为 null。仍待处理的父消息按已写入连接的证据归为 unknown，否则 notSubmitted；若连写入阶段也无法证明，一律 unknown。

这份结果沿用首次确认失联时已固定的到期时间；扫描可能早于本次 result 读取确认失联，因此不能从写入缓存或读取结果的时刻重新起算 1 小时。读取统一优先使用合法最终缓存，所以原快照即使停在 running，也不能覆盖该 unknown。父调用的消费/固化操作串行执行，不增加恢复锁或账本；缓存写入失败返回 `runStateUnavailable`（退出 1），不假装已有可重复读取的终态。

终态通知尚未被 result 消费时，首次 wait 将这次 unknown 作为未读终态变化，按第 4 节包含完整可用结果或 deferred 摘要，并推进观察位置，后续 wait 不重放。result 成功输出这份已固定的 unknown、部分正文、缺口和全部未读消息后，按第 4 节消费消息与终态通知并退出 0；再次 result 只返回固定最终结果。stop 先采用同一失联结论，再按归属证据处理仍存活的 adapter/后代；本地停止信息可更新，但不把失联结果改成完成或重跑任务。过期后只允许已有停止/清理路径，不再生成缓存。

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
| 文件提交与回收 | 私有状态仍完整写入后原子发布；Windows 的占用或访问拒绝须明确报告，不能先删除旧状态再写入。调用者保存 --export 输出的目标不由工具管理。扫描不跟随 symlink、junction 或其他重解析链接；无法证明归属或停止时保留资源，不能因为删除失败扩大清理范围 |
| 安装闭包 | worker、adapter、工具桥接及必要的平台 helper 来自当前安装 resourceRoot 和正式依赖。按目标架构分发并校验；不要求运行时访问开发 checkout、临时下载 helper 或增加系统服务 |

Windows 原子 JSON 发布对 rename 的 EPERM、EACCES 和 EBUSY 最多重试五次，总退避等待为 620ms；每次复用同一份已保护的临时文件，不先删除旧文件，也不重发后端输入。持续失败保留错误。worker 能保存最终结果时，文件错误的 DIAGNOSTIC 块包含操作名及运行资源类别，不包含绝对路径、动态文件名、原始错误正文或堆栈。

这些是实现和验收约束，不要求新增全局进程账本、常驻 supervisor、锁层级或跨会话恢复协议。具体平台 API 与可复用模块由实施者在同等行为边界内选择。Windows 的启动、持续收件、停止、导出和过期回收须在实际 Windows runner 上验证，并保留所用架构及后端范围。

## 升级与验证

开发阶段直接更新 v5 的 start/ready 结构，不支持旧 ready 的顶层 communication/communicationSupported，也不支持缺少 communication 或适用 permissionMode 的 start 请求，不增加版本协商或迁移。不保留旧 run/poll/v4 执行器、preview 参数或结果文件旁路。result 使用无参数 --export；不接收输出目的路径。Manifest v3、Config Definition v4、Store v5、Catalog v7、installed-runtime-config v2 和 Eval instruction-v2 不联动改号。通过正常 build/sync/reinstall 更新产物；旧运行由原工具完成或停止，不扫描、接管或删除旧协议资源。

确定性验证采用 `pnpm plugin:test codex-enhance` 和 [测试指南](https://github.com/lesliechan721-arch/agent-workflow/blob/main/docs/testing.md) 的最低足够真实层级。协议、helper 和 fake 后端保护本地合同及副作用；产物测试须从实际 build/materialization 的 resourceRoot 启动 worker、adapter、脚本和 MCP 工具，保留角色资源、四个模板注入点与原生角色局部边界。不得依赖开发 checkout、宿主 node_modules 或临时下载 helper。

[最低合同验收](protocol.md#8-最低合同验收)、8 KiB 实际工具链完整交付和 --export 完整保存分别取得证据。fake 不能关闭 Codex 自动收件、Claude 会话输入、真实后端停止、模型效果或原生 OS 的证据缺口。Windows 须在真实 Windows runner 验证，macOS/Linux 证据不外推。文案和结构自检不证明模型理解或任务效果；真实模型与 Eval 遵守 [插件维护流程](https://github.com/lesliechan721-arch/agent-workflow/blob/main/docs/plugin-maintenance.md) 的独立审核和授权要求。

仍需分别记录真实证据的范围包括：Codex profile精确字段的实际消费者、config/read层完整性、hook来源与信任/bypass；Windows注册包内CLI发现与握手；Antigravity复杂路径、用户/共享/项目策略组合、沙箱文件与PID可见性、auto账户资格及原生平台行为。macOS App的无模型握手不证明profile消费者或Windows行为。Antigravity消息发送以实际父侧通道收到消息为依据；模型结果正文、回执标记或随机文本比较不用于决定通讯能力是否存在。组合命令权限拒绝保留为该次调用失败，不能仅因此认定所有通讯不支持。协议、投递分类、输入不重放和停止事实仍须验证；help、fake和文档不替代真实后端证据，不声明未经证明的平台支持。
