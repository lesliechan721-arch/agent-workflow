# Codex 适配器

公共要求见 [配置与接入](configuration.md)、[Adapter v5](protocol.md) 和 [运行生命周期](runtime.md)。

Codex 固定 workspace，通过 app-server 管理本次 thread/turn、正式输入和中断。Codex 使用 mcp / in-turn / activeReceive=true，活动轮用 turn/steer，无活动轮时新开 turn。

`codexProfile` 从有效 CODEX_HOME 读取 profile-v2 的 `<name>.config.toml`，将精确支持字段转换为本次启动或线程覆盖；未支持和无关字段诊断后忽略。它不保留原生用户配置层身份，可能覆盖项目配置，不与原生 exec --profile 完全等价。字段范围、覆盖顺序、hooks 状态映射、信任与 bypass、失败码见 [Codex profile 转换](#codex-profile-转换)。raw --profile/-p 使用相同转换路径，与专用字段同时出现时拒绝；不直接传给 app-server。额外目录 addDirs（--add-dir）仍无等价映射，显式使用返回 parameterUnavailable。

## Codex CLI 来源

| codexCliSource | 查找规则 |
| --- | --- |
| auto，缺省 | 先查本次有效 PATH；仅没有可执行入口时查 App 内嵌 CLI |
| cli | 只查 PATH，缺失即失败 |
| app | 跳过 PATH，只查 App 内嵌 CLI，缺失即失败 |

PATH 按目标 OS 的命令解析规则处理 executable、symlink 和 Windows shim。找到入口后固定绝对路径；启动失败、协议不支持或运行错误都不能切换来源或重发任务。

macOS 依次检查用户 `~/Applications`、系统 `/Applications` 内的 Codex.app / ChatGPT.app；同目录 Codex.app 优先。候选须具有 `CFBundleIdentifier=com.openai.codex`，并包含有效 `Contents/Resources/codex`。该相对路径是已观察布局，不是官方跨版本保证。

Windows 由当前用户注册的 `OpenAI.Codex_*!App` 取得实际 package identity，再查询安装根；只在这些包内有界发现 codex.exe 常规文件。遵守当前架构与包边界，不扫描磁盘、不固定版本目录或发布者后缀。候选不能唯一确定时报告歧义，系统查询失败与未安装分别诊断。Linux 的 auto/cli 使用 PATH，显式 app 在提交模型前拒绝。

内嵌入口须位于匹配 App/package 的真实目录内，类型、执行权限及 argv 启动有效。使用所选路径完成无模型 app-server 初始化后才能提交任务；继承本次 cwd、环境、CODEX_HOME、认证和配置，不启动图形 App，不复制 binary 或下载依赖。诊断提供 path/app 来源、所选路径及可取得的版本。缺失时给出所选策略及修正 PATH、安装对应来源或更改策略的指引。App 更新移除入口时本次失败，下次新 run 重新发现。Windows 注册包发现与启动仍须 Windows 真机验收，不能用 macOS 或 fake 证据宣布支持。


## Codex profile 转换

本节面向适配器维护者，定义 profile 的配置支持范围、转换与失败边界。

### 含义、覆盖与失败

`codexProfile` 从本次合并环境的有效 CODEX_HOME 读取 profile-v2 `<name>.config.toml`，未设置时使用 Codex 用户 home 规则。名称须符合所选 CLI 的 profile-v2 名称合同，不能作为任意路径。只读一次，不写基础 config、不复制 home、不改变账号或会话根。基础、项目和管理配置仍由所选二进制加载。

profile 是本次增量默认覆盖，不是 AW 执行档位，也不保留原生用户配置层身份；转换可能覆盖项目配置，不与 exec --profile 完全等价。未支持、未核验嵌套字段和相对普通文件路径提示后忽略；已知无关字段单独分类。忽略只是不施加该覆盖，低层同名工具、权限或 hooks 仍可能生效。

普通字段从低到高为：Codex 基础/项目配置 → 支持的 profile 默认覆盖 → executor args 的同类显式选项 → 任务 model/reasoningEffort。任务与 args 的显式同类冲突仍失败；profile 被更高显式值覆盖。codexProfile 与 raw --profile/-p 同时出现时拒绝；仅 raw profile 也走同一转换，不传给 app-server。管理策略及受约束字段始终生效。

executor 的 permissionMode 缺省 default，保留 profile 与用户显式 args 的权限选择。auto 在首次 thread/start.config 覆盖 approval_policy=on-request、approvals_reviewer=auto_review，并保留有效沙箱；full-access 覆盖 approval_policy=never、sandbox_mode=danger-full-access。后续轮次沿用同一配置。非 default 与 raw args 的同类显式控制冲突时返回 adapterArgumentConflict；auto 可保留显式沙箱限制。具体别名与拒绝范围见 [权限模式](configuration.md#执行器权限模式)。模式不可用或回退时报告 permissionModeUnavailable，不换模式或重发；Codex --full-auto 不能替代 auto_review。

permissionMode、communication 和 codexBypassHookTrust 独立。full-access 不自动启用 hook bypass，auto 不改变信任或禁用状态；关闭通讯仍检查环境和应用权限模式。管理限制继续由后端执行。

启动字段合并后用真实 TOML 序列化为 `-c key=<TOML value>`，线程字段放 `thread/start.config`。同根表按允许叶子合并后一次序列化，不能混用顺序不明的整表/叶子赋值；provider/plugin/MCP 内部点号保留为字面键。启动覆盖继续参与线程构建，不重复放在线程覆盖中。cwd 使用 thread/start 顶层并与进程 cwd 一致；模型配置走 config，任务 effort 每轮明确放 turn/start.effort，省略才沿用默认值，首轮与后续轮一致。

AW 拥有 cwd、控制协议、任务及私有通讯绑定。profile 不能替换或禁用 AW MCP server；冲突失败。用户与 profile MCP 合并后，在同一最终表加 AW server；communication=false 不添加它。profile 的基础/developer 指令按 Codex 字段生效，model_instructions_file 与 inline instructions 保留后端已核验优先关系；AW 显式角色、任务和已就绪通讯说明仍在任务载荷中。拼接不提高权限。

无法读取、TOML 语法错、已支持字段类型错、无法无损转换的数值或控制边界冲突均在模型提交前失败。日期时间、非有限浮点数、JSON 不安全整数不静默转字符串，null 不代表删除。不用 JSON.stringify 代替 TOML，也不拼 shell。普通文件路径仅绝对路径；相对表示跳过相应字段/完整条目并告警。命令名、URL、环境值、提示词、文件名候选与命令参数不按文件路径处理。启动 argv 过长明确失败，不截断或写用户配置。

诊断使用 v5 的 `{code, field?, message}`，随 ready 或初始化失败 result 返回，由运行快照与固定结果保存；start 未见 ready 时 wait/result 补报，result 可重读。仅含英文 code、字段路径和简短原因，不含值、令牌、header、命令参数、摘要或原文；过量按字段组汇总并报告总数，遵守现有帧/显示预算。稳定分类为 profileFieldIgnored、profileFieldIrrelevant、profileValueInvalid、profileUnreadable、profileConversionUnsupported。显式 args/model/effort 不套用忽略策略。

### Hooks 状态、信任与 bypass

支持下文字段表列出的 profile TOML hook 事件、handler 及 `hooks.state`。其中 `SessionEnd` 只支持 `command`，不支持 `mcp_tool`；信任和 bypass 都不能使该组合执行，按下文的整事件覆盖规则处理。`features.hooks` 仍由实际配置决定，不因存在 hook 定义或开启 bypass 而强制设为 true。共享 `hooks.json`、基础/项目配置及插件的 hook 继续由 Codex 原生发现；不复制它们的定义来模拟 profile 层，也不把它们重新归属为 profile hooks。

下面的执行结果适用于功能已开启、事件已触发且其它后端条件成立的普通、非内建、非受管理 hook：

| 已有状态 | `codexBypassHookTrust: false`，默认 | `codexBypassHookTrust: true` |
| --- | --- | --- |
| 已启用，可信摘要与当前内容匹配 | 可执行 | 可执行 |
| 已启用，内容已修改或没有可信摘要 | 不执行；保留 Modified / Untrusted | 可执行；不把状态改成 Trusted |
| `enabled = false` | 不执行 | 不执行 |
| 管理策略不允许该 hook | 不执行 | 不执行 |

bypass 的作用范围是本次线程发现的适用 hooks，包括其它配置及插件来源。它不会持久批准 hook，也不突破 `allow_managed_hooks_only`。两种模式共用状态读取和映射：开启 bypass 仍须保留原来源的禁用偏好，不能因不检查摘要就省略 `enabled` 适配。

状态适配在同一个 adapter 进程内完成，顺序如下：

1. 读取所选 profile 时，保留每个 hook 的实际配置文件来源路径、事件、原分组和 handler 序号。来源路径按 Codex 原生 profile-v2 规则表示；它不是脚本路径，不任意追加前缀或执行 symlink realpath 替换。事件状态键使用上游的 snake_case 标识，两个序号均从 0 开始。
2. 合并 profile 与显式 args 的 hook 增量。表按已允许字段合并，事件数组及 handler 数组按上游覆盖规则整体替换，不拼接、不删除个别元素。更高优先级的显式定义胜出；只有最终仍由该 profile 提供的 handler 才获得其原来源状态。仅命令相同或序号相同不能证明来源相同。已消费的 raw `-c hooks...` 从启动覆盖取出，与 profile hooks 一起在线程请求中发送一次；不先传一份启动 hooks 再重复覆盖。
3. app-server 初始化完成后、首次 `thread/start` 前，以本次 `cwd` 调用 `config/read`，设置 `includeLayers: true`。用返回的原始层及层来源取得已有状态，不能只读取 profile 的 `hooks.state` 或返回的普通有效配置。基础 `config.toml` 可能保存 profile 的信任记录。只有 User 与 SessionFlags 层可贡献状态，按 Codex 的低到高顺序逐字段合并 `enabled` 和 `trusted_hash`；含 `disabledReason` 的这些层仍须读取。项目、插件及管理层不能因此获得写入用户信任的能力。
4. 在上述状态上按本参考的覆盖顺序纳入本次 profile 和显式 args 的状态增量，每个来源只合并一次。为最终 profile handler 建立原 key 到 SessionFlags key 的对应；目标序号以最终发送的数组为准。原 key 形如 `<profile 文件路径>:pre_tool_use:0:0`；非 Windows 目标形如 `/<session-flags>/config.toml:pre_tool_use:0:0`，Windows 按上游从 `C:\` 解析的合成路径生成，须在 Windows 验证实际表示。
5. 将原记录中存在的 `enabled` 和 `trusted_hash` 原样复制到对应目标 key，不补造缺失值，不计算或替换可信摘要。保留其它来源的状态；显式运行时状态依已确定优先级处理。目标 key 已有记录时必须核对它属于哪个最终定义，不能让另一 handler 或旧序号的状态自动给当前 profile hook 授信或覆盖其禁用偏好。不能无歧义、无损解决的对应或冲突须失败，不能任选一条可信记录。
6. 在首次 `thread/start.config` 中一次发送最终嵌套 `hooks` 对象与明确的 `bypass_hook_trust` 布尔值。含路径、冒号和点号的 hook key 是 `hooks.state` 内的字面键，不能展开成顶层 dotted path。由 Codex 计算当前内容摘要并执行信任判定；状态必须在适用的 SessionStart 等启动 hook 执行前就位，不能启动线程后再补。

来源路径变化会改变 hook key；它不直接改变规范化内容摘要。因此，未变内容保留已有信任，变化内容保留旧摘要并由 Codex 判为 Modified，无原可信记录的仍为 Untrusted。不开 bypass 时，这些普通 hook 的未信任状态不使整个任务失败，也不由 AW 自动交互批准；它们保持不执行。AW 不创建信任文件、账本或锁，不写回 profile、基础配置或 `hooks.json`。

需要读取的状态无法取得、必要层信息缺失或读取失败时，用 `profileHookStateUnavailable` 终止；来源键、最终数组对应或状态冲突无法可靠适配时，用 `profileHookMappingUnsupported` 终止。二者都在首次 `thread/start` 前失败，不静默忽略已支持 hooks，不自动切换 bypass。完整状态集合中没有某条记录是正常未信任状态，不等于读取失败。profile 中已支持字段的类型或数值错误仍用 `profileValueInvalid`。恢复方式是修正配置、恢复可读状态，或更换具有所需能力的 CLI 后重新开始；不得通过写入信任或重发不确定任务自动修复。

bypass 只由 executor 的 codexBypassHookTrust 提供，缺省 false；无 profile 也可开启。在首次 thread/start.config 显式发送 bypass_hook_trust 布尔值，不放启动 -c。profile 中 bypass_hook_trust 诊断后忽略并指向专属字段；raw --dangerously-bypass-hook-trust 和 raw -c bypass_hook_trust=... 返回 parameterUnavailable，不隐式启用。每次显式开启 bypass 都提供 `hookTrustBypassed` 诊断，说明线程范围与禁用/管理限制；沿用上述诊断的 ready/result 保存和补报机制。`config/read` 的原始层、hook 命令、MCP 输入、可信摘要及 profile 原文只用于本次内存适配，不放入诊断或运行快照。状态映射不恢复用户配置层身份、原生 profile 优先级、相对路径基准或共享 `hooks.json` 来源身份；不承诺与原生 profile 完全等价。


### 精确字段范围

以下为首版允许集合，不按前缀或整表自动接受未来字段；扩展须有参数、消费者与路径语义证据。范围接受不证明模型或所选 CLI 的消费者行为，真实验收仍按适配器合同执行。

按真实 TOML 类型验证和转换，保留内部对象与数组。profile 是增量层，只校验实际出现的值，不要求 profile 重复低层已有的必需字段；合并后的必需性由 Codex 配置加载器校验。scalar 按字段处理；动态表按具体项处理；数组不删除个别元素来制造新的有效含义。未知子字段可独立忽略时保留已支持子字段；会破坏整项必要语义时，整项作为未支持项忽略并明确报告，不能发送半个认证或权限结构。

未支持和无关字段只诊断键路径及原因，不报告值。支持字段的类型无效、不能无损转成目标协议值或违反控制边界时失败。相对普通文件路径是未支持表示，跳过对应字段/完整条目并告警。跳过不表示清除低层配置。

#### 启动覆盖

| 字段 | 首版处理与限制 |
| --- | --- |
| `model_catalog_json` | 支持绝对文件路径；在 app-server 启动时应用，不把文件内容塞入 argv |
| `model_provider` | 支持字符串；与本次 provider 定义合并后用于启动与共享模型发现 |
| `model_providers.<id>` | 支持下表的基础 provider 子字段；保留 id 内部点号 |
| `openai_base_url`、`chatgpt_base_url` | 支持字符串；仅传值，不替代登录或改变 AW 环境 |
| `forced_login_method`、`forced_chatgpt_workspace_id`、`cli_auth_credentials_store` | 支持上游对应标量类型；由实际 Codex 初始化校验，不自动登录 |

provider 首版子字段：`name`、`base_url`、`model_catalog_url`、`env_key`、`env_key_instructions`、`wire_api`、`query_params`、`http_headers`、`env_http_headers`、`request_max_retries`、`stream_max_retries`、`stream_idle_timeout_ms`、`websocket_connect_timeout_ms`、`requires_openai_auth`、`supports_websockets`。

这些字段按已适配的 Codex `ModelProviderInfo` 类型验证；映射中的 header/query 值不能出现在诊断。命令式 `auth`、`aws`、`gateway_oauth`、`capabilities` 和直接 bearer token 等未纳入首版。出现这些可能决定认证/协议语义的字段时，忽略整个相应 provider 定义并告警。若 `model_provider` 引用的是本次被忽略定义，同时忽略该 profile 的 selector 并单独提示，避免发送残缺 provider；低层是否已有同名定义仍由 Codex 加载。用户显式 args 指定的无效 provider 不按此策略忽略。

`features` 首版只支持以下精确开关，统一经启动覆盖传入，不整表放行：

| 开关 | 值与消费者 |
| --- | --- |
| `api_key_model_discovery` | 布尔值；共享模型管理器的发现设置 |
| `code_mode_host` | 布尔值，或仅对已出现的 `enabled` 布尔字段作覆盖；共享 Code Mode host 的建立 |
| `code_mode` | 布尔值，或仅对已出现的 `enabled` 布尔字段作覆盖；普通任务工具调用模式 |
| `model_catalog_in_context` | 布尔值；进入会话上下文的模型目录信息 |
| `plugins` | 布尔值；后端插件能力开关，与 `plugins.<id>.enabled` 选择配合 |
| `standalone_web_search` | 布尔值；独立搜索工具能力，仍受 provider 和模型限制 |
| `hooks` | 布尔值；Codex hook 功能开关。与 executor 的信任绕过开关独立；false 时不因配置 hook 或开启 bypass 而强制启用 |

结构化 feature 表中其它字段、其它开关与废弃别名未纳入首版，逐项提示后忽略，保留低层既有配置。只设置 enabled 不能覆盖或删除低层结构化 feature 的其它选项。这些支持范围仍需真实消费者验收，不能将设置接受等同于所有模型必定使用。以后扩展某个开关时必须同时确定传入阶段与消费者。

`sqlite_home`、`experimental_thread_store`、`otel`、`thread_unload_delay_secs` 首版暂不转换，按未支持字段提示；本次不为短生命周期外部执行增加存储/遥测配置适配。

#### 线程覆盖

| 字段组 | 首版支持字段和限制 |
| --- | --- |
| 模型与输出 | `model`、`model_reasoning_effort`、`model_reasoning_summary`、`model_verbosity`、`service_tier`；上游或模型可能过滤不支持值，不以“已发送”证明必定生效 |
| 上下文与压缩 | `model_context_window`、`model_auto_compact_token_limit`、`model_auto_compact_token_limit_scope`、`model_post_turn_compact_threshold_percent`、`tool_output_token_limit`、`compact_prompt`、`experimental_compact_prompt_file`；文件字段仅绝对路径 |
| 指令 | `instructions`、`developer_instructions`、`model_instructions_file`；后者仅绝对路径；保留 Codex 对基础文件/inline 指令的优先关系，不替换 AW 任务载荷 |
| 项目说明 | `project_doc_max_bytes`、`project_doc_fallback_filenames`；fallback 项按文件名验证，不改成路径 |
| 搜索 | `web_search`；首版不转换 `tools.web_search` 的复杂子表，按未支持字段提示 |
| shell | `allow_login_shell`、`shell_environment_policy` 的已定义字段 `inherit`、`ignore_default_excludes`、`exclude`、`include_only`、`set`；环境策略仅作用于后端 shell 工具，不等于进程/provider 认证环境 |
| 工具等待 | `background_terminal_max_timeout`；不是 AW 总 deadline |
| 审批 | `approval_policy`、`approvals_reviewer`；服从上文 permissionMode 覆盖；后端仍要求交互时明确失败，不由 AW 自动批准或忽略 |
| 基础沙箱 | `sandbox_mode`、`sandbox_workspace_write.writable_roots`、`sandbox_workspace_write.network_access`、`sandbox_workspace_write.exclude_tmpdir_env_var`、`sandbox_workspace_write.exclude_slash_tmp`；writable_roots 仅绝对路径，含不支持元素时不删个别项来改变权限 |
| MCP | `mcp_servers.<name>` 见下表；`mcp_optional_startup_grace_ms`；保留 AW server，配置关闭时不添加它 |
| 插件选择 | `plugins.<id>.enabled`；只选择已存在插件，不安装/下载，不支持未经核验的其它插件策略子字段 |
| Hooks | 下节列出的 TOML 事件、handler 与 `hooks.state`；依上文 hooks 状态映射保留逐项状态，首次 thread/start 即带入，不作为未经核验的整表透传 |
| 上下文开关 | `include_environment_context`、`include_environment_context_time`；只支持这两个精确字段，不用 include_* 通配 |

MCP 首版支持两类完整条目：

- stdio：`command`、`args`、`env`、`env_vars`、`cwd`、`enabled`、`required`、`startup_timeout_sec`、`tool_timeout_sec`、`enabled_tools`、`disabled_tools`。command 可以是后端 PATH 命令名；显式路径 command 与 cwd 必须为绝对路径。
- HTTP：`url`、`bearer_token_env_var`、`http_headers`、`env_http_headers`，以及上述公共 enabled / required / timeout / tool 选择字段。

动态 MCP 名称保留原样。stdio / HTTP 互斥，认证和启动约束遵守上游合同。交互登录、未知传输或未适配认证结构不声明支持；影响条目整体语义时跳过整项并告警。AW 通讯绑定始终由运行器拥有，不从 profile 读取。

命名 `permissions` / `default_permissions`、`auto_review`、`skills`、`agents`、MCP OAuth 存储/登录参数及其它 tools 子表首版暂不转换，按未支持执行字段处理。该范围不限制基础配置本来已启用的工具、技能或子代理；也不创建新的委派授权。

#### Hooks 精确范围

支持 `hooks` 内以下事件数组；右列同时规定状态 key 的事件标识：

| TOML 事件名 | 状态 key 事件标识 |
| --- | --- |
| `PreToolUse` / `PermissionRequest` / `PostToolUse` | `pre_tool_use` / `permission_request` / `post_tool_use` |
| `PreCompact` / `PostCompact` | `pre_compact` / `post_compact` |
| `SessionStart` / `SessionEnd` / `UserPromptSubmit` | `session_start` / `session_end` / `user_prompt_submit` |
| `SubagentStart` / `SubagentStop` / `Stop` / `Interrupt` | `subagent_start` / `subagent_stop` / `stop` / `interrupt` |

每个事件是 matcher group 数组；group 支持可选字符串 `matcher` 和 `hooks` handler 数组，按上游已定义的缺省处理。首版 handler 范围如下：

| 类型 | 支持字段与类型 |
| --- | --- |
| `type = "command"` | 必填字符串 `command`；可选字符串 `commandWindows`（接受上游别名 `command_windows`）、`statusMessage`；可选非负整数 `timeout`（秒）、`additionalContextLimit`（token）；可选布尔 `async` |
| `type = "mcp_tool"`，仅限 `SessionEnd` 以外事件 | 必填字符串 `server`、`tool`；可选可无损转换到 TOML / JSON 的对象 `input`；可选非负整数 `timeout`（秒）、字符串 `statusMessage` |
| `hooks.state.<key>` | 对象；可选布尔 `enabled`、字符串 `trusted_hash`，缺省保持缺失。key 保留为内部字面键，收集时遵守上游去除首尾空白及忽略空键的规则 |

类型、必需字段及数值范围按已适配的 Codex `HookEventsToml`、`MatcherGroup`、`HookHandlerConfig` 和 `HookStateToml` 验证；数值同时满足本节处理原则的无损转换限制。超时缺省、截取、平台命令选择、matcher 和执行限制仍由 Codex 实际消费者处理；AW 不为这些字段重写可信摘要。command 是后端命令文本，不把整串当文件路径，不拆分或重写参数。MCP hook 沿用后端已存在 server，不新增或改写 AW 私有通讯绑定。

`prompt`、`agent` handler 及 `SessionEnd + mcp_tool` 组合在所查后端尚不能执行，首版不支持；bypass 不改变这些限制。未知事件单独告警后忽略。一个已知事件数组含未支持 handler、上述受限组合或未知 group/handler 子字段时，整条 profile 事件覆盖以 `profileFieldIgnored` 告警后跳过，保留其它事件及低层原生来源；不删除单个 handler、重排数组或剥除会改变定义的字段后复用旧信任。因而 SessionEnd 数组混有 command 与 mcp_tool 时也跳过整个 profile 事件覆盖，单独的受支持 SessionEnd command 不受此限制。已支持字段类型错误仍失败。状态对象的未知子字段按本节处理原则处理；无有效原记录时不能生成新的可信摘要。raw args 的不支持或无效值按显式参数错误在首次 thread/start 前拒绝，不套用 profile 忽略策略。

仅转换本次 profile/显式参数的 TOML hook 增量；基础/项目/插件 hooks 和共享 `hooks.json` 保持原生发现。`bypass_hook_trust` 不属于 profile 字段允许列表，专用 executor 字段及线程请求映射由上文 hooks 状态映射定义。

#### 已知无关及来源限制

| 类别 | 字段和处理 |
| --- | --- |
| 已知无关 | `review_model`、`plan_mode_reasoning_effort`、`tui`、`desktop`、`file_opener`：忽略并以 irrelevant 分类报告 |
| 来源身份敏感 | `allow_symlinked_codex_home`：未支持，告警后忽略，不用 -c 假装恢复用户配置层身份；hooks 按精确范围及上文状态映射适配 |
| 非原生 profile 字段 | `bypass_hook_trust`：告警后忽略，不提升为 AW profile 扩展；显式启用使用 executor 的 `codexBypassHookTrust` |
| 旧 profile 选择 | `profile`、`profiles`：不是本次 profile-v2 入口；告警后忽略，不改读旧表 |
| 其它未列字段 | 未支持，告警后忽略；不据字段名猜路径或消费者阶段 |

上述“首版未支持”都是公开范围限制。诊断需要足以让使用者判断是否修正 profile、改用基础配置或另选执行方式。
