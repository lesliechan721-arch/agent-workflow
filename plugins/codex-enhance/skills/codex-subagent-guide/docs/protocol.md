# 适配器协议

[适配器文档索引](README.md)

## Adapter v5 完整合同

### 1. 进程、通道及版本

worker 以 `shell:false`、`detached:false` 启动 adapter。custom 的 argv 只含已注册的可选 entrypoint；custom-managed 通过同一 AW 主机的 command run 启动，绑定 fixed args 属于 adapter argv；两种分支的 executor args 都只放在 v5 start 请求中。cwd 缺省为本次绝对 workspace，托管 binding 可显式 cwd=resource；v5 workspace 值保持。stdin 持续打开用于控制，stdout 只输出本协议，stderr 是诊断。adapter 及后代继承本次受保护的进程归属 token；禁止重写该 token 或 AW 内部配置控制项。

本合同同时适用于 macOS、Linux 和 Windows。worker 的后台存活、进程身份、停止及私有文件保护按 [操作系统与安装闭包](runtime.md#操作系统与安装闭包) 实现；`detached:false` 只描述 worker 与 adapter 的关系，不要求 worker 随短暂的 start 命令退出。Windows 的归属验证不能依赖 POSIX ps 或读取 Unix 进程环境；归属 token 不替代本机进程身份或受控进程边界。后端入口按本机安全启动方法解析，协议 args 保持 argv 数据，不拼为 shell 文本。

首版支持范围要求 adapter 能观察本次后端进程的实际退出码。完全在 adapter 进程内调用 SDK/HTTP、没有独立后端进程的形态不在首版支持承诺内；不能以 adapter 自己的退出码替代 backendExitCode。null 表示实际退出情况未知，不表示不适用；本轮不新增另一套完成证据。

每行是一个 UTF-8 JSON 对象，以 LF 结束；CRLF 可作为同一分隔，正文中的换行必须 JSON 转义。解析按字节缓冲，不假定一次 read 等于一行；可以一次收到半个对象、多个对象或拆开的多字节字符。拒绝 BOM、空行、非法 UTF-8、EOF 时残缺行、数组、null、顶层非对象。接收端使用标准 JSON 对象解析语义；发送端必须由对象序列化，不手工拼接重复 key。字段名、类型及必填规则严格检查；各对象拒绝未定义字段。

每条消息必须有 `protocolVersion:5` 和 `type`。双方串行写入完整行并处理写回压，不能并发拼接 JSON 字节。一个流上的顺序是发送顺序，两个流之间没有全局顺序；不使用时间戳推测消息已经交付。

每次连接的第一条 worker 输入必须是 start，而且只出现一次。adapter 的第一个事件可以是 session、ready，或第 4 节允许的初始化异常 result。session 可先绑定真实会话；有效 ready 之后才允许提交首次生成。ready 只出现一次；disabled/unsupported 是明确能力描述，缺失或错误不能折算成其中任何一种。

stdout 不得透传后端日志、原始服务事件或 MCP stdout。adapter 负责转成明确的协议事件；调试信息只写 stderr。版本不符、未知事件、未知字段和顺序错误按照第 6 节结束，不猜测旧 v4 含义。

字段名、枚举、错误码、程序生成的说明和诊断、MCP/脚本工具描述及共享 API 说明均使用英文。task/message/result.text 等数据保持原语言和原文，允许中文，不为满足输出语言而翻译。外部原始诊断若需要引用，必须与程序说明分开，向模型展示时进入 diagnostic 块，不能拼到控制字段中。显示层的省略不改变本协议字段及内部结果证据。

### 2. 类型、大小和额度

除非明确标记可选，下面字段均必填。JSON 属性顺序不重要，缺省不等于 null。

| 类型 | 精确定义 |
| --- | --- |
| `Text` | 合法 Unicode 字符串，无 NUL；按 UTF-8 字节计大小。允许换行，不 trim 或规范化；需非空时还要求不是全空白 |
| `Label` | ASCII 名称，严格匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`；不 trim 或替换字符 |
| `Identifier` | 1–256 个 Unicode code point 的单行非空字符串，无控制字符；executor/model/effort 沿现有选择约束 |
| `RunId` | 64 位随机数的 11 字符无填充 Base64URL 编码，区分大小写；由运行层生成，只在本次连接或目录中使用；不是模型应填写的 ID |
| `MessageId` | 32 个小写十六进制字符，由运行层生成，只在本次连接或目录中使用；不是模型应填写的 ID |
| `Code` | 匹配 `^[A-Za-z][A-Za-z0-9]{0,63}$` 的安全错误码 |
| `AbsolutePath` | 非空 Text，在当前 OS 上是规范化绝对路径；用途对应的类型、归属、symlink 和存在性另外校验 |
| `EpochMs` | 非负安全整数，UTC Unix 毫秒；不能为 NaN、浮点数或字符串 |

| 数据 | 上限 |
| --- | --- |
| start 帧 | 8 MiB 编码后字节，不含 LF/CRLF |
| task / instructions 输入 | 各 256 KiB；沿用现有合成逻辑 |
| 合成 prompt | 524352 UTF-8 字节，非空 |
| message.text | 24,576 UTF-8 字节（24 KiB），非空；两个方向和所有工具入口相同 |
| message 帧、含正文的桥接请求/响应及队列记录 | 256 KiB 编码后字节；容纳正文最坏 JSON 转义及封套 |
| ready / session / closing / stop 帧 | 各 4 KiB 编码后字节 |
| delivery 帧 | 16 KiB 编码后字节 |
| result.text | 4 MiB UTF-8 字节；非成功可为空 |
| result 帧 | 32 MiB 编码后字节；考虑正文的 JSON 转义开销 |
| 可选错误 message | 4096 UTF-8 字节 |
| 两个方向的消息 | 无累计条数或累计消息字节上限；每条仍须满足 message.text 和帧大小限制 |
| stderr 诊断 | 整个执行最多 8 MiB；这是运行资源预算，超额触发第 6 节收尾，不能仅截断留存后继续报告 completed |

这些是单帧、单条正文及诊断的资源限制，不给整次 run 的通信设置累计额度。每方向只检查单条字节数，不维护累计消息额度账本。worker 另行保留的全部未解决投递摘要不属于 adapter result 帧，不受 result.text 或 result 帧大小上限限制；按[运行生命周期](runtime.md#停止失联与结果缓存) 完整保留并支持流式导出。result.text 的 4 MiB 与 result 帧的 32 MiB 不是主代理显示额度；普通 wait/result 的 stdout+stderr 合计最多 32,768 bytes，stderr 最多 1024。result 一次读取全部未读事件和固定最终结果；--output-file 将相同完整报告直接写入文件，不受普通报告预算约束。--export 是未知参数，在创建文件或消费前拒绝。单条过程消息、封套与必要诊断必须能独立交付；精确格式、工具预算和文件消费见 [命令输出合同](runtime.md#命令输出合同)。超限消息拒绝，不截断或自动拆分。

实现可以在大帧尚未完整时提前拒绝超限，不得无限缓冲。通道写入等待仍受已显式设置的 deadline 和停止请求约束，不能因回压停止读取控制输入。双方应使用独立读取循环与串行写队列，不在读取循环中等待整个模型 turn 或等待用户答复。

普通名字和路径不作为敏感证明。沿用当前环境脱敏规则，控制 token、envFrom 解析值和凭据不得进入日志、诊断或协议元数据。task/message/final 的权限与已有输入输出处理保持一致，不能因通讯新增一份敏感历史。

### 3. worker → adapter

##### start

```json
{
  "protocolVersion": 5,
  "type": "start",
  "run": {
    "id": "0123456789abcdef0123456789abcdef",
    "name": "api-review_2.1",
    "deadlineAt": null
  },
  "execution": {
    "executor": "codex-local",
    "model": "example-model",
    "reasoningEffort": "example-effort"
  },
  "mode": "workspace",
  "workspace": "/absolute/project",
  "prompt": "Review the selected module. Ask the parent if needed.",
  "args": [],
  "communication": true,
  "resume": true,
  "permissionMode": "default",
  "codex": { "cliSource": "auto", "bypassHookTrust": false, "profile": "advanced" },
  "runtime": {
    "directory": "/absolute/private/run/adapter",
    "toolkit": {
      "module": "/installed/guide/scripts/runtime/adapter-channel.mjs",
      "command": "/absolute/path/to/node",
      "messageScript": "/installed/guide/scripts/message.mjs",
      "mcpScript": "/installed/guide/scripts/message-mcp.mjs"
    }
  }
}
```

示例中的模型和路径只是示例；deadlineAt 为 null 表示默认不设置执行期限。

| 字段 | 规则 |
| --- | --- |
| run | 只含 id、name、deadlineAt；id/name 在连接内固定。deadlineAt 必填，为 null 或 EpochMs；null 表示不设置执行期限。仅显式 start --deadline-ms N 时，由 worker 设为本次执行启动时刻加 N；恢复保留原 N 并计算新时刻；任何消息、等待和轮次不得重置。不能把 null 转成 0、30 分钟或其他默认计时 |
| execution | executor 必填；model、reasoningEffort 可选且只在本次明确解析到值时出现；旧 execution.profile 字段必须拒绝。全部使用 Identifier；省略沿用后端默认，不生成空值 |
| mode | 只能为 workspace 或 bundle |
| workspace | 必须为已存在的绝对目录，是 adapter 和后端的工作目录；不赋予额外访问或写权限 |
| prompt | 非空 Text，首次执行保留任务及显式指令合成后的完整内容；恢复时仅本次新消息；不重新打开指令文件 |
| args | Text 数组，可为空；是后端的实际 argv，不经 shell，不当作 wrapper argv。整帧上限提供累计限制 |
| communication | 必填 boolean，由 plan 将已安装配置缺省归一化为 true；wire 不猜默认值，所有 adapter 均须识别 |
| resume | 必填 boolean，由 plan 将已安装配置缺省归一化为 true；与 communication 独立。配置 false 必须报告 disabled；true 可报告 enabled 或 unsupported |
| sessionId | 可选 Identifier；缺省表示首次执行，存在表示恢复绑定的原 session，不由主代理指定。恢复 prompt 仅为本次新消息，不重放初始任务、角色或旧输入 |
| permissionMode | Codex/Claude/agy 请求必填 default / auto / full-access，由 plan 将配置省略值归一化为 default；Oracle/custom 不携带。各 adapter 按自身分支严格验证，不猜缺省或接收无关配置 |
| codex | 仅 Codex 请求携带且必填；严格对象，必填 cliSource（auto/cli/app）与 bypassHookTrust（boolean），可选 profile（名称，不是路径）。其它 adapter 不携带或解析它；缺字段、类型错误和未知值按协议错误拒绝 |
| runtime.directory | worker 创建的本次专属私有目录；POSIX 为 0700，Windows 使用等效的实际访问控制。只供 adapter 及其工具临时使用，不包含父侧消费游标或最终结果缓存 |
| runtime.toolkit | 四个字段均为 AbsolutePath，由本安装 resourceRoot 解析。command 是 Node executable；其余是随本产物分发的 regular file。adapter 可选用共享工具方法，不在运行时下载依赖 |
| fileSelectors | 仅首次 bundle 执行必填；恢复（有 sessionId）时必须省略，Text 数组，可以为 []；原样保留顺序、空格和重复，按 AW 文件选择协议 v1 校验选择表达式 |
| fileResolver | 仅首次 bundle 执行必填；恢复（有 sessionId）时必须省略，严格对象 `{command: AbsolutePath, args: [AbsolutePath]}`，args 恰好一个安装内解析器入口；保持既有文件选择协议 v1 |

workspace 必须完全省略 fileSelectors/fileResolver，传空数组也非法。恢复 bundle 的 mode 保持 bundle，但 wire 必须省略 fileSelectors/fileResolver，不能传 [] 触发重新解析；原选择只保存在冻结执行配置中，不重新扫描、扩大或重发材料，由原 session 保留上下文。bundle 不支持运行中消息，ready 的 capabilities.communication 只能为 disabled 或 unsupported。环境通过已解析进程环境传入，不增加 env 或 secret JSON 字段。adapter 不读取 AW store 或重新选择 executor。Codex 的 profile 选择由 codex.profile 进入 adapter，不在 plan 改写为 --profile。

runtime.directory 是 adapter 的可写临时边界；result 经 stdout 返回，adapter 不写 worker 的结果缓存。目录路径和 toolkit 只供程序使用，不进入主代理 start 展示。

##### message

只在已收到 ready 且 initialization.capabilities.communication.status=enabled、任务仍开放时正常发送：

```json
{"protocolVersion":5,"type":"message","id":"11111111111111111111111111111111","text":"Check both callers."}
```

字段 id 为 MessageId，text 为非空 Text。同一连接内 id 不重复，不根据正文去重。每条输入应得到一次 delivery；它是适配器的提交结论，不是模型 ACK。

worker 只把每条本地待发消息写到连接一次。断线、超时、未知回执或进程重启都不重发。已经写入连接但没有 delivery 的消息在最终摘要中按 unknown 保留；尚未写入连接的按 notSubmitted 保留。

进入 closing 的事件与反向 message 可能交错。adapter 收到这类迟到消息时不得启动新 turn，应尽力回复 delivery(notSubmitted, runClosed)；连接已关闭时 worker 根据已有证据分类，不补开连接。

##### stop

```json
{"protocolVersion":5,"type":"stop","reason":"requested"}
```

reason 只能为 `requested`、`deadline`、`channelError`。在合法 start 之后任意非终态阶段都可发送，包括初始化中。重复 stop 等价于同一次停止，不能产生新生成；第一个原因用于主要诊断。

adapter 停止接受新任务输入，调用后端正式中断方法，结束子工具等待并核对停止。worker 同时保留已显式设置的 deadline 和进程归属观察。stop 不带任意 PID，不是跨任务信号接口。仅发送成功不证明后端已经停止。

### 4. adapter → worker

##### ready

```json
{"protocolVersion":5,"type":"ready","initialization":{"environment":{"status":"available"},"capabilities":{"communication":{"status":"enabled","transport":"mcp","passiveDelivery":"in-turn"},"resume":{"status":"enabled"}}}}
```

`initialization` 是必填严格对象，只含 environment、capabilities；替换旧顶层 communication，不兼容旧形状。environment 只能是 `{status:"available"}` 或 `{status:"unavailable",code:Code}`。available 表示已按本次选择规则找到可执行入口，不保证认证、网络、余额或模型资格。ready 只允许 available；capabilities 必须包含已确定的 communication 和 resume。未来只增加有定义并经验证的命名能力，不接收任意 JSON 或复制顶层布尔值。

`initialization.capabilities.communication` 允许三种描述：

| status | 完整形状与含义 |
| --- | --- |
| enabled | 必填 transport=mcp/command、passiveDelivery=in-turn/turn-boundary/none；本次发送入口及声明的收件/自动输入入口已配置 |
| disabled | 仅 `{ "status": "disabled" }`；请求关闭，跳过通讯检查和准备，仍检查环境及权限模式，不建 AW 桥、不注入工具或通讯说明 |
| unsupported | 仅 `{ "status": "unsupported" }`；已查询且后端无可用双向能力，继续普通任务 |

enabled 必须同时支持子→父发送和主动接收；passiveDelivery 只控制自动输入与提示词，none 也保留 receive。旧 activeReceive 字段按未知字段拒绝。disabled/unsupported 不带其它字段；bundle 不得 enabled。communication=false 必须 disabled，不能 enabled；协议错、超时、缺字段或配置失败都不能报 unsupported。必须在首次模型提交之前完成 ready 写入；只有 enabled 注入按实际能力生成的说明。

ready 可带 `diagnostics: [{ "code": "profileFieldIgnored", "field": "features.example", "message": "The profile override was ignored; lower-layer configuration remains active." }]`。每项严格为 `{code, field?, message}`：code 为 Code，field 可选且仅字段路径，message 是简短英文说明。不得包含值、令牌、header、命令参数、可信摘要或 profile 原文。按字段组汇总过量诊断并报告总数，仍须满足 ready 帧及输出预算。

接收诊断先校验原始形状，再脱敏。脱敏扩张使 message 或 field 超出单项预算时，保留 code 并明确说明省略；不能因此改写运行终态或丢失最终正文。快照只保存预算内摘要，固定结果保留其余完整安全诊断，并按 result 普通报告或 --output-file 合同读取；主代理只得到必要 code、原因及恢复动作，不输出内部详细状态。

`initialization.capabilities.resume` 严格为 `{status:"enabled"|"disabled"|"unsupported"}`。resume=false 必须 disabled，resume=true 只能 enabled/unsupported，不接收 transport 等其它字段。成功 ready 的两项能力都必须确定。它只声明适配器能力，不保证外部 session、TTL 或本地停止条件永远有效。

worker 验证后进入 running。协议不增加 ready 的反向 ACK；因此 ready 与模型提交之间的故障仍可能形成 unknown，不能据未收到 start 回执重复生成。启动调用的 10 秒只是观察窗口，不是 adapter 的完整执行期限。

worker 将完整 initialization、诊断及更新位置保存到已有最新快照和固定结果。若 start 已交付 pending，后续 wait 首次 ready 或终态（含 deferred），或 result 交付报告时须补报 communication/resume 与必要诊断；transport/passiveDelivery 仅内部使用；快速收尾和快照合并不能吞掉它们。能力交付后无需重复，固定结果中的诊断可随 result 重读。初始化失败仍保存已确定的环境和能力；未检查的成员保持未知。失联且无可靠结论时保持 pending；失败诊断仍可随 result 保存。不新增事件队列、日志账本或 ACK。

##### session：恢复绑定

```json
{"protocolVersion":5,"type":"session","sessionId":"actual-backend-session"}
```

只含 protocolVersion、type 和非空 Identifier sessionId，沿用 4 KiB 控制帧限制。允许 start 后、closing/result 前发送，包括 ready 前；获得真实可恢复 session 后及时发送，不等最终 result。一次执行只绑定一个 ID，相同 ID 重复可忽略，不同 ID 是协议错误；恢复执行只能确认传入的原 ID。

仅当请求 resume=true 且适配器确认支持时可发送 session。worker 在本次执行状态中持久保存绑定，同时确认恢复能力 enabled；后续 ready/result 的能力不得冲突。session 与初始化状态分开保存，因此 ready 前退出也能保留恢复证据。恢复初始化再次失败且尚无新结论时沿用此前已确认能力；明确 disabled/unsupported 优先，旧绑定不能覆盖。没有明确证据不猜 enabled。

session 绑定仅供内部恢复使用，主代理不能传入任意 session 目标。result.sessionId 只是结果信息，不单独证明恢复能力；若保留，必须与绑定一致。调度层不解析或复制聊天历史。后端会话不得仅存在于终态会删除的 runtime.directory 中。

适配器收到 sessionId 必须恢复原会话后只提交本次 prompt，重新建立当前 AW 工具绑定及必要说明；不能重复初始任务或继续使用旧私有通道。会话不存在、无法续接、恢复到不同 ID 或原会话不接受输入时明确失败，不降级新会话、不 fork、不自动重试不明投递。不能保证原会话和工具重绑时应报告 unsupported 或实际失败。本地进程停止不证明 unknown 的远端执行已取消，后端恢复约束由适配器负责。

##### message：子代理发往父代理

```json
{"protocolVersion":5,"type":"message","text":"Does the first caller still need the old parameter?"}
```

只含 text；不接收模型填写的来源、目标或 id。worker 从连接绑定 run 身份，并生成私有消息文件名。只允许 enabled ready 之后、closing 之前发送。原始 stdout、阶段日志和最终正文都不能自动变成 message。

适配器的工具调用成功只说明消息已交给此输出通道，不证明父模型已经收到。worker 不为每条子消息增加接收 ACK，也不因重连重放它。通道失败时子工具明确失败，adapter 进入故障处理。

##### delivery

```json
{"protocolVersion":5,"type":"delivery","id":"11111111111111111111111111111111","status":"submitted"}
```

必填 id、status；可选 code 和 message。id 必须对应本连接已经收到的父消息。status 只能为：

| status | 证据与后续行为 |
| --- | --- |
| submitted | 后端正式输入接口已接受，或明确 receive 工具已产生本次返回；不证明模型已读或完成要求。worker 删除自己的父消息正文副本 |
| notSubmitted | 确认本次消息未提交到后端或收件工具；保留正文和原因通知父代理，不自动重发 |
| unknown | 接口调用或工具交接结果不明，无法证明是否提交；保留正文和原因，不重发 |

一次 delivery 是最终分类，不能再以第二次 delivery 把 unknown 改为 submitted。内部重试只允许在有明确未提交证据且仍在本次授权任务中时进行，并在结果确定后发出一次 delivery。其他 id、重复 delivery 或不一致分类为协议错误。

非 submitted 必须提供 code；可选 message 是有界安全说明。尚未分配的消息在关闭时为 notSubmitted；已经尝试的消息必须依据实际证据，不能一律改成 notSubmitted。

##### closing

```json
{"protocolVersion":5,"type":"closing","reason":"completed"}
```

reason 只能为 `completed`、`failed`、`cancelled`、`error`。它说明收尾原因，不是终态证明。ready 后正常结束必须恰好一次 closing，result 随后输出；worker 收到后拒绝新的 send。worker 因 stop 或故障也可先在本地进入 closing。

adapter 必须在 closing 前停止子侧新发送入口、完成已经进入串行输出队列的子消息，并决定不再开新 turn。closing 后仍可发出已有父消息的 delivery，但不得再发 ready 或子侧 message。控制循环仍需接收迟到父消息并拒绝。

##### result：唯一的最后结果

```json
{
  "protocolVersion": 5,
  "type": "result",
  "state": "completed",
  "generationStarted": true,
  "backendExitCode": 0,
  "text": "The complete final answer from this run."
}
```

| 字段 | 规则 |
| --- | --- |
| state | completed、failed、cancelled、unknown 之一 |
| generationStarted | true 表示已确认生成，false 仅表示有证据证明尚未提交，null 表示无法确认。启动后端进程本身不等于 true |
| backendExitCode | 实际后端进程退出整数，或未知时为 null；completed 必须为 0。会话型后端须先结束本次所属会话及客户端再取得真实退出证据，不伪造 0，也不使用 adapter 的退出码代替 |
| text | Text；completed 必须非空且完整，其他状态可为空或已标明的部分结果 |
| code | 可选 Code；failed/cancelled/unknown 时必填 |
| message | 可选有界 Text，解释故障与可用证据，不回显凭据 |
| sessionId / model | 可选 Identifier，只记录实际后端返回的信息；sessionId 若有绑定须一致，不单独构成恢复能力或主代理投递目标 |
| remoteStopConfirmed | 可选 boolean；只有适用的真实后端停止证据才能写 true，缺失不等于 true |
| initialization | 可选，与 ready 使用相同对象；初始化失败仍严格包含 environment 与 capabilities，只保存已确定结论，尚未知的 communication/resume 可从 capabilities 省略。环境无可靠结论时整个字段省略；有效 ready 后省略则沿用，显式携带须与已发布描述一致 |
| diagnostics | 可选数组；每项为 ready 中定义的 `{code, field?, message}`，初始化失败时也可携带；保存与补报沿用 ready 诊断规则 |

result 只有一次且是最后一条事件。它代表本次执行，不代表其中一个 turn；同一 run 的显式恢复会建立新的独立连接。除初始化失败/初始化中取消外，result 前必须已有 ready 和 closing。ready 前的 result 只能为 failed 或 cancelled、generationStarted=false；若适配器无法证明未提交，应使用 unknown、generationStarted=null，并说明 protocolInvalid 或实际故障。已确定的初始化结论可按 initialization 规则保存，未知通讯不填 unsupported。environment unavailable 只允许初始化失败、generationStarted=false，且不能先发 ready；code/message 和诊断提供恢复指引。协议错误不能伪装成未安装环境。运行中权限或通讯故障按实际结果报告，不改写历史 ready。

result 完整写入后 adapter 关闭自身子工具及输出，并退出 0；退出 0 只表示正常结束了协议，任务本身可能失败。无法形成合法结果的适配器退出非零。worker 不把 adapter 的 0 当作业务成功，也不把非零当作从未生成。

worker 读取 result 后仍等待 adapter 退出和本地所属进程收尾。只有结构、服务终态、完整正文、后端退出、adapter 退出及本地停止证据全部一致，才保存 completed。协议和停止冲突可把 result 降为 unknown，不能把 failed/unknown 升成 completed。

### 5. 生命周期与最小序列

| 当前阶段 | 合法输入 | 合法输出/下一阶段 |
| --- | --- | --- |
| 尚无 start | 仅 start | 不启动后端、不发事件 |
| 初始化中 | stop；不能 message | 可先发 session；ready → running；或初始化失败/取消 result → 结束 |
| running，通讯 disabled/unsupported | stop | 可发 session；closing → 收尾；不允许双方 message/delivery |
| running，通讯 enabled | message、stop | session、子 message、父 delivery；closing → 收尾 |
| 收尾 | 重复 stop、交错的迟到 message | delivery，最后 result；不再 ready/session/子 message |
| result 已发出 | 不再接受任务输入；关闭管道 | 无后续事件，退出 |

不支持通讯的最小 adapter：读取 start、校验配置、检查环境、按请求准备或关闭通讯、ready(initialization: available + communication disabled/unsupported，resume 已确定)、执行任务、closing、result、退出。它仍须响应 stop、EOF 和已显式设置的 deadline；不需要实现 message、delivery、MCP 或接收工具。

支持通讯的典型时序：

```text
worker → adapter  start
adapter → worker session(actual recoverable session ID; optional)
adapter → worker ready(initialization: available, complete communication and resume descriptors)
adapter → worker message(child question)
worker → adapter  message(id=A, parent reply)
adapter → worker delivery(A, submitted)
adapter → worker closing(completed)
adapter → worker result(completed, final text)
```

父消息恰好跨越后端轮次边界时，adapter 持有自己的会话/turn ID。只有确定未提交，且 run 仍开放、原授权及已设置的执行期限允许时，才能安排同一会话的下一轮。提交结果不明时报告 unknown。普通消息不隐含 interrupt。

不要求 closing 与父发送形成跨进程事务。worker 保存未有结论的父消息，即使 result 为 completed，也可在结果旁报告投递缺口。最终回答不证明之后到达的追加要求已完成。

### 6. 停止、断线和错误

| 事件 | adapter / worker 的处理 |
| --- | --- |
| start 输入非法或协议版本不同 | adapter 不提交模型；若无法信任完整 start，只输出安全 stderr 并非零退出。worker 保留实际未提交证据；不能靠非零退出推断 |
| 合法 start 后初始化失败 | adapter 发出合法 failed result，generationStarted=false，退出 0；可保留已确定 initialization，无可靠结论的能力未知 |
| running 协议错/通道错/超限 | 停止接受输入和新 turn，按已知提交阶段停止后端；可写时 closing(error) 和合法 result，写不了时 worker 归为 unknown |
| worker stdin EOF | adapter 将其视为父控制连接失联，停止本次任务和工具，不作为 prompt 结束继续无限运行 |
| adapter stdout EOF 或非零退出，无完整合法 result | worker 保存 unknown 及已有的有限内容；不得用日志替代最终结果，不重开 adapter |
| stop / 已设置的 deadline 到期 | adapter 调用正式中断并继续观察；显式期限存在时 worker 也设置对应截止计时，必要时只停止可证明归属的后代。deadlineAt 为 null 时不因运行时长触发停止 |
| result 后 adapter/后代仍活跃 | worker 有界收尾并保持 unknown，不能先报告 completed |
| 未得到 delivery | 已写入连接的父输入为 unknown；未写入的为 notSubmitted。不存在自动重放 |

deadlineAt 非 null 时，worker 和 adapter 的执行计时都由该固定时刻换算为本地剩余时间；新消息不能延长。deadlineAt 为 null 时，worker、adapter 和子工具桥接都不创建执行期限计时器；单次 receive/wait 的窗口仍有界。停止宽限最多 30000 ms，宽限消耗在本次收尾中，不能每次 stop 重置。未确认本地/远端停止时保存 unknown 和控制证据，而非伪造 cancelled。

cancelled 要求本次存在停止意图、本地执行已停止；已经提交时还需适用的真实远端停止证据。failed 要求确认输入/服务失败且没有仍可能活跃的冲突。unknown 表示证据不足，不授权重跑。

有限 stderr 用于诊断，不归档完整服务事件。8 MiB 限额用于停止异常高输出任务；累计超额时即使已有合法服务结果，也按资源超限收尾，不能通过停止留存或裁剪来保留 completed。该运行额度与每次对主代理显示最多 1 KiB stderr 分别执行，后者只控制显示，不单独改变任务终态。

正常服务 result 缓存由存活 worker 写入，不接受 adapter 指定任意输出路径。worker 已确认丢失且没有终态缓存时，[停止、失联与结果缓存](runtime.md#停止失联与结果缓存)规定的父侧检查只可固化一次 unknown，并沿用首次确认失联时固定的 terminalAt 及当前保留配置；它不能从后端或日志恢复一个成功 result，不建立第二条 Adapter 结果通道。消息、终态通知、最终缓存的消费和当前保留期规则以[运行生命周期](runtime.md#停止失联与结果缓存) 为准。

### 7. 通用初始化与可复用的子侧工具桥接

每次 adapter 初始化均调用 `descriptor.negotiate(context)`，替换 negotiateCommunication；所有 adapter、所有 communication 值均执行。context 包含本次 mode、安装配置、解析后的后端选项、有效环境及可检查资源。协商只读，不提交模型、不修改用户配置、不读最新 AW store。它同时返回环境与命名能力的候选；具体 executable、准备参数及权限规则计划只留在 adapter 内存，不加入 wire。

环境检查确认所需 CLI/custom command 或托管绑定可按当前平台规则找到并执行。Codex 遵守 codexCliSource 的完整选择规则；Claude/agy/Oracle 使用有效 PATH；custom 保留绝对 command/entrypoint。缺失、不可执行、平台不支持分别返回稳定原因；不得以通讯 unsupported 代替。选定入口固定，失败不切换来源或重发。可执行有界无模型的原生初始化/查询，不建独立能力服务或持久健康缓存；该检查不证明认证或账户/模型资格。

候选 capabilities 必须分别提供 communication 与 resume；resume 候选严格为 `{supported:boolean}`。公共 helper 校验环境及两项能力候选，仅环境可用才进入准备。恢复按请求 resume=false 映射 disabled，否则依候选映射 enabled/unsupported；传入 sessionId 而后端不支持时明确失败。communication=false 只跳过通讯检查、桥、工具及说明，不跳过环境或权限模式。明确无通讯实现的 Oracle 可继续普通任务；已知支持路径的权限、资源、查询或建桥失败必须保留实际错误并收尾，不能降为 unsupported。

候选 supported 不等于 ready。准备阶段才建立桥、按需添加 agy 精确权限、完成后端无模型初始化、配置实际工具并生成说明；agy settings 在正式后端加载前完成。全部必要准备成功后才发送 enabled ready，再提交首次模型输入。custom 可采用公共 helper 或实现等价流程，声明、实际入口及说明必须一致。

外部通讯 prose 的唯一来源为 [communication-instructions.md](../assets/communication-instructions.md)。模板按公共、MCP/command、被动输入和主动收件片段组合，不在 common 中维护另一份文案。只在 enabled 时生成；模板或安装资源缺失按 runtime resource 错误失败，不退回旧固定文案。native 不注入这些外部桥指令。

MCP 片段使用实际注册工具名；command 片段使用 bridge.script.command/args 生成完整 send/receive 调用：@@SEND@@ 使用 send --text MESSAGE_TEXT，@@SENDFILE@@ 使用 send --text-file MESSAGE_FILE；移除 @@SENDSTDIN@@，保留私有 binding，不要求模型填 run ID 或路径。按实际命令工具 shell 正确引用；未知 shell 不使用伪通用引用。in-turn 明确当前上下文自动输入，turn-boundary 明确等当前轮结束，none 不承诺自动输入。通信启用时始终包含 active-receive 方法片段，提供默认 600000、最高 1800000 ms 的响应式等待；移除 no-active-receive 分支。需要父回复才能继续时保持任务开放，没有待处理输入及必要答复时正常关闭，不增加 idle 保活或周期拉取。

公共片段保留 24 KiB（24,576 UTF-8 字节）单条上限、无累计额度、不自动拆分/截断/重发不明消息、自动输入不由 receive 重放、父消息不扩张授权，以及最终结果不能由过程消息替代。角色只含角色内容，初始任务组合一次；后续输入保留协作标识，不重复整份角色与说明。

为了让内建与 custom 复用发送、显式收件及脚本/MCP，随安装产物提供 `runtime.toolkit.module`。这是可选接入方法，第三方可实现等价工具；不采用它不改变 v5 行为。

Node 适配器入口：

```ts
createChildBridge({
  directory,          // Private subdirectory of start.runtime.directory
  deadlineAt,         // EpochMs | null; null means no execution deadline
  toolkit,            // start.runtime.toolkit
  emitParentMessage,  // async (text) => void; write v5 messages in order
  submitInput,        // Optional async ({id, text}, {signal}) => Delivery
  canSubmitInput      // Optional synchronous () => boolean
}): Promise<ChildBridge>

type Delivery = {
  status: 'submitted' | 'notSubmitted' | 'unknown';
  code?: string;
  message?: string;
};

interface ChildBridge {
  mcpServer: { command: string; args: string[] };
  script: { command: string; args: string[] };
  acceptInput(message: { id: string; text: string }): Promise<Delivery>;
  hasPendingInput(): boolean;
  close(reason: 'completed' | 'failed' | 'cancelled' | 'error'): Promise<void>;
}
```

这些方法名和行为构成本次建议的共享 API；private 文件布局、随机绑定值和内部等待请求标识不构成作者合同。API 实现及其 MCP/脚本使用同一个版本和消息核心分发，不形成三套队列。

`emitParentMessage` 在本地 stdout 完整写入后 resolve，失败则 reject；工具显示提交到父侧通道，不声称父模型已收件。每次调用都形成一条消息，检查单条字节上限，不设置累计消息数量或字节额度。

`acceptInput` 接受来自 v5 的唯一父消息。桥接器串行分配：已有显式等待者则交给该等待；否则在配置了 submitInput 且当前允许自动提交时分配给它；否则保留给下一次显式收件。返回的 Promise 表示最终 delivery，可能等待实际收件，不得阻塞适配器的控制读取循环。adapter 在 Promise 结束时输出唯一 delivery。

`canSubmitInput` 是可选的同步 readiness 检查，省略时保留已有自动提交行为。返回 false 时输入留在共享队列，显式 receive 仍可领取；返回 true 才能分配给 submitInput。桥接器在现有工具请求扫描中重新检查，不要求额外通知 API。若后端须等待当前 turn 的正式 result 才能提交新输入，应让该检查返回 false，不能先占用输入再等待轮次边界。

`submitInput` 由适配器负责后端提交及明确未提交时的处理，不能阻塞 stop；桥接器通过 signal 取消等待。已经分配给后端的输入不能再交给 receive；后端回执不明时返回 unknown，不自动改道或重发。显式 receive 之后注册，也不能抢走已经提交或正在提交的同一输入。该 readiness 检查不改变 v5 wire 合同。

`hasPendingInput()` 包括未分配及提交结果尚未确定的输入，用于决定是否结束本次 run，不是跨进程新消息的事务性保证。`close()` 幂等：拒绝新发送/收件/输入，唤醒等待工具为 closed，未分配输入返回 notSubmitted，已尝试输入依证据返回结果。关闭期限受剩余收尾宽限限制；不能无限等待后端或 MCP。待处理投递 promise 均结束后，adapter 输出剩余 delivery，再输出 result。

共享桥接器使用 runtime.directory 中的私有临时文件服务跨进程工具请求；由适配器进程中的唯一调度器消费。文件完整写入后原子发布，单次工具返回后删除请求/响应，close 清理可安全删除的工具临时资源。它不保存工具历史、不接受任意目标，不设置第二个 run 状态或独立生命周期。stdio MCP 配置及脚本命令都由该实例生成，身份从本次实例绑定，不能让模型传入 from、父地址、run 目录或其他子代理目标。

对子代理公开的工具只有：

| 工具/脚本操作 | 输入 | 结果 |
| --- | --- | --- |
| `send_parent` / `send --text TEXT` / `send --text-file PATH` | 非空正文；脚本只接受文本或文件，拒绝缺参、互斥和 -，不读取 stdin | `submitted` or an explicit error; no implicit wait |
| `receive_parent` / `receive --timeout-ms N` | timeoutMs 可选，默认 600000，整数 0–1800000 | `received` with the assigned text, `timeout`, or `closed`; no cursor/history/replyTo |

receive 在一条输入可分配时提前返回；有多个显式 receive 时只允许一个活跃调用，其余返回 `receiveAlreadyPending`，避免额外多消费者合同。MCP 和脚本均使用以上语义和 24 KiB 单条正文上限。子侧保留 v5 工具输出：首行为 `send_parent: <outcome>` 或 `receive_parent: <outcome>`，可选 code 和 JSON 字符串 message。received 正文保留原文，使用独立 `BEGIN_MESSAGE:TOKEN` / `END_MESSAGE:TOKEN` 行包围；TOKEN 是每次输出生成且不出现在该正文中的 8 位小写十六进制值，正文前后各有 framing LF，不 trim 原文。父侧五命令的语义标签不用于此子侧工具合同。MCP 标准 envelope 只由包装处理，不把父输入混入工具状态或说明。工具成功状态使用 submitted/received，空结果使用 timeout/closed，错误使用明确的英文 code。

MCP 始终注册 send/receive 两个工具，脚本也始终提供两个入口，不提供 send-only 模式。需要问答才能继续时保持任务开放并采用默认 10 分钟响应式收件；输入或 closed 提前返回，明确更短窗口及剩余 run 时限可缩短它，deadline 或 close 必须唤醒等待。工具 schema/help 拥有参数规则，单一模板补充生命周期和输入语义。

### 8. 最低合同验收

从真实 adapter 进程及公开 helper 入口验证，使用隔离目录及 fake backend。以下各风险只在最低足够真实的层级覆盖：

1. JSONL 的半帧、多帧、Unicode 分片、未知字段、非法 UTF-8、EOF 半帧及大小边界。
2. start 必填 communication/resume、适用后端的 permissionMode 及 Codex 专属对象；enabled/disabled/unsupported、完整能力组合与旧 activeReceive 字段拒绝、缺失/重复 ready、初始化失败和关闭时消息拒绝；关闭跳过通讯检查、桥和说明但仍检查环境及权限模式；晚到能力与诊断由 wait/result 补报，快速终态不能吞掉它们。
3. 双向正文完整且不翻译，24 KiB 正文边界及 256 KiB 编码容器有效；双向发送并消费超过 64 条仍可继续，未消费队列也不因固定条数被拒绝，未解决投递不因旧累计字节额度丢失；名称符合 ASCII 规则，程序输出为英文；重复正文两次、身份固定、内部 ID 关联、重复/未知 delivery 拒绝。
4. 慢输出回压下仍可接收 stop；deadlineAt 为 null 时跨过旧 30 分钟仍运行，显式 deadline、EOF、adapter 崩溃不重启任务。
5. 一个后端 turn 完成时不会误认 run 结束；closing 与父输入交错时分类可查。
6. result 唯一且必须最后；日志、非空正文、单一退出码不能替代服务和本地收尾证据；completed 使用实际后端进程退出码；stderr 超过 8 MiB 后不能仍报告 completed。
7. submitted 删除父正文；未提交/未知进入必要摘要；没有消息历史或自动重放。
8. MCP/脚本/自动输入共用调度，关闭唤醒等待，未等待的消息不被两个入口重复消费。
9. 不支持通讯的第三方只实现最小生命周期也可运行；bundle 文件选择与环境配置语义保留。
10. 从实际安装产物启动所有入口及工具；引用的模块/脚本闭包完整，不依赖开发源码路径。
11. 在原生 Windows 上验证 argv、UTF-8/CRLF 保真、后台存活、双向工具、真实后端退出证据、stop/显式 deadline/EOF、默认无期限及所属后代清理；覆盖私有访问控制、文件占用和 junction/重解析链接保护。共享进程与 foreign 资源不受影响。
12. wait/receive 的默认长等待和上下界有效；消息与关闭及时唤醒，较短的等待工具窗口只续等同一次工作，不重提。零等待排空不变成普通空轮询。
13. session 在 ready 前及终态前持久保存；相同 ID 重复、冲突 ID、恢复 ID 不符、配置关闭却发 session、能力冲突和 result.sessionId 冲突均按合同处理。恢复前失败保留旧结果，发布后失败只属于新执行；再次恢复可沿用已确认能力，不能被 pending 永久遮蔽。
14. 真实父命令经 fake adapter 验证完成/失败/stop 后以原 run、原配置、原 session 和新消息恢复，通信与恢复独立，旧事件不重放，工具重新绑定。实际内建后端至少一条完整恢复路径另取真实证据，fake 不构成产品支持验收。

真实后端的输入、审批、会话恢复/停止和模型是否按期望回应仍需单独验证，fake 只验证本地协议及副作用。
