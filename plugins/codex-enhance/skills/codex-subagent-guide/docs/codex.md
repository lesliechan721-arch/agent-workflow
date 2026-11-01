# Codex 适配器

公共要求见 [配置与接入](configuration.md)、[Adapter v5](protocol.md) 和 [运行生命周期](runtime.md)。

Codex 固定 workspace，通过 app-server 管理本次 thread/turn、正式输入和中断。Codex 使用 mcp / in-turn，同时提供主动收件，活动轮用 turn/steer，无活动轮时新开 turn。

`codexProfile` 从有效 CODEX_HOME 读取 profile-v2 的 `<name>.config.toml`，将完整配置转换为本次启动或线程覆盖；明确无效或与 AW 控制冲突的配置报错。它不保留原生用户配置层身份，可能覆盖项目配置，不与原生 exec --profile 完全等价。字段范围、覆盖顺序、hooks 状态映射、信任与 bypass、失败码见 [Codex profile 转换](#codex-profile-转换)。raw --profile/-p 使用相同转换路径，与专用字段同时出现时拒绝；不直接传给 app-server。额外目录 addDirs（--add-dir）仍无等价映射，显式使用返回 parameterUnavailable。

## 恢复与工具重绑

首次执行通过 thread/start 建立会话，恢复通过 app-server 的 thread/resume 传入绑定 threadId，并保留原 cwd 和执行配置；确认实际返回 ID 一致后才提交本次新消息。原线程仍有 active/inProgress turn 时明确失败，不投递、不 fork、不新建回退。使用 --ephemeral 时不保留可恢复会话，resume 报 unsupported；配置关闭时为 disabled。

得到真实 thread ID 时及时发送 session 帧。每次恢复以同一 run 的私有 AW MCP server key 替换为当前 bridge 的 command/args，重新注入必要通信说明，避免模型调用旧绑定；不复制聊天历史或重复初始任务。只有私有 receive_parent 设置 tools.receive_parent.output_token_limit=32768，不改其它工具或全局用户配置。真实 CLI 必须支持所用 API、持久化及工具预算；本地协议或 fake 通过不构成真实会话恢复和完整工具交付验收。

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

本节定义 profile 的传递、覆盖与失败边界。支持范围使用有理由的黑名单；路由表只决定生效阶段，不是字段白名单。未知字段和嵌套成员完整交给所选 Codex，不删除 Provider、MCP、权限或工具的部分结构来使其通过。

### 含义、覆盖与失败

`codexProfile` 从本次有效环境的 CODEX_HOME 读取 profile-v2 `<name>.config.toml`，未设置时使用 Codex 用户 home 规则。名称不是任意路径。只读一次，不写基础 config、不复制 home、不改变账号或会话根。raw `--profile/-p` 使用同一路径，与专属字段同时出现时拒绝；不直接传给 app-server。

profile 是运行时增量覆盖，不保留原生用户配置层身份，可能覆盖项目配置。普通优先级为 Codex 基础/项目配置 → profile → raw args → 任务 model/effort。任务与 args 的显式同类冲突仍失败；管理限制由 Codex 执行。每个输入先检查黑名单、控制冲突和路径来源，不能用后续覆盖隐藏已知不支持的输入。

表保留未覆盖成员，数组整体替换。压成运行时覆盖前还须保留已知原生合并语义：按来源归一化 agents/memories 别名，高层 alias 不输给低层 canonical；Shell 的 filters 与旧 exclude/include_only 按高层表示替换，filter key 按大小写无关规则处理；结构化 feature 布尔只覆盖 enabled，保留其它设置；credentials 按 env 来源替换冲突 provider；permissions/application 的 network.domains 按原生 host 归一化后覆盖。未知成员不因这些已知转换而丢失。

`permissionMode=default` 保留原配置；auto 覆盖 `approval_policy=on-request`、`approvals_reviewer=auto_review` 并保留沙箱；full-access 覆盖 `approval_policy=never`、`sandbox_mode=danger-full-access`。raw 同类显式冲突保持拒绝。命名 permissions/default_permissions 原样交 Codex，不删除它们来规避非法组合。具体边界见[权限模式](configuration.md#执行器权限模式)。模式、communication 与 codexBypassHookTrust 独立。

AW 不自动添加或依赖 `--strict-config`，不另做全量 schema 严格校验。普通未知字段、非法值及组合按所选 Codex 的非严格行为处理；后端可能告警后采用默认配置，因此“请求被接受”不证明全部配置生效。用户已显式传入的 strict 参数保持原有支持。后端结构化 configWarning 以不含原文或值的 `backendConfigWarning` 摘要保存，不自动终止。

无法读取、TOML 语法错、黑名单、AW 控制冲突、必须转换的结构无效、不能无损表达或启动 argv 过长，在启动后端前失败。初始化或 thread/start、thread/resume 实际报错时停止，不发首轮、不删字段重试、不切换后端。修正配置或换用所需 Codex 后重新开始任务。未提供的字段保持缺失，null 不代表删除。

诊断沿用 Adapter v5 的 `{code, field?, message}` 与 ready/result/快照补报。保留字段路径和具体原因，动态 key 必要时使用位置或占位符，禁止泄露值、token、header、命令参数、可信摘要、原始 config/read 或后端错误正文。错误区分 profile 不可读、黑名单、AW 控制冲突、转换与后端失败；不再用 profileFieldIgnored/profileFieldIrrelevant 删除本次配置后继续执行。

完整透传会使过去被 AW 忽略的设置开始生效，或明确报错，包括工具、代理及认证设置。升级后应按所需行为核对 profile。Adapter v5 与已有恢复合同不变，不新增配置副本、信任账本或锁。

### 线程控制与路由

AW workspace 使用进程 cwd 和 `params.cwd`。最终模型使用 `params.model`，不重复放 config。service_tier 只用 `config.service_tier`，缺失保持缺失。ephemeral 使用顶层参数。approval_policy、approvals_reviewer、sandbox_mode、default_permissions 保留原名进入 config；TOML `[permissions]` 是定义表，不能映射到只接受名称字符串的 RPC 顶层 permissions。

profile effort 是线程默认值；任务显式 effort 同时覆盖默认并在每轮 turn/start.effort 传入。instructions 保留 config.instructions，不能提升为 baseInstructions，否则会改变“显式 base instructions → 指令文件 → instructions”的优先级。developer_instructions 保留原名。AW 角色、任务和已就绪通信说明仍在任务载荷中。

以下字段完整进入 thread/start.config；恢复沿用 thread/resume：

| 类别 | 字段 |
| --- | --- |
| 模型输出 | model_reasoning_effort、model_reasoning_summary、model_verbosity |
| 上下文与压缩 | model_context_window、model_auto_compact_token_limit、model_auto_compact_token_limit_scope、model_post_turn_compact_threshold_percent、compact_prompt、experimental_compact_prompt_file |
| 指令与注入 | instructions、developer_instructions、model_instructions_file、include_environment_context、include_environment_context_time |
| 项目说明 | project_doc_max_bytes、project_doc_fallback_filenames |
| Shell 与预算 | allow_login_shell、shell_environment_policy、background_terminal_max_timeout、tool_output_token_limit |
| 权限与审核 | approval_policy、approvals_reviewer、sandbox_mode、sandbox_workspace_write、permissions、default_permissions、auto_review |
| 工具与 MCP | web_search、tools、完整 mcp_servers、mcp_optional_startup_grace_ms |
| 技能、代理及驻留 | skills、agents、thread_unload_delay_secs |
| Hooks | 完整 hooks，附下文来源映射；executor 的 bypass_hook_trust |

features 按直接子项分流：已确认线程消费的 hooks 使用 `config["features.hooks"]`；其它子项初始全部放启动，包括完整的结构化 feature。不能在请求中发送只有 hooks 的 features 整表，否则会覆盖启动 feature 表。后续只有取得线程消费者证据后才移动路由，不因此限制未知 feature。

其余未被黑名单拒绝的字段默认启动 `-c key=<TOML value>`。必须启动的已知配置包括：

| 类别 | 字段 |
| --- | --- |
| Provider 与模型目录 | model_provider、完整 model_providers、model_catalog_json |
| 服务地址 | openai_base_url、chatgpt_base_url |
| 登录与凭据 | forced_login_method、forced_chatgpt_workspace_id、cli_auth_credentials_store |
| 存储日志 | sqlite_home、log_dir、experimental_thread_store |
| 遥测 | otel、analytics |
| 进程功能 | features.api_key_model_discovery、features.code_mode_host 及其它非线程子项 |
| 待确认消费者 | review_model、plan_mode_reasoning_effort、plugins、MCP 全局认证及其它未列字段 |

这些配置可能影响共享模型管理器、客户端、认证、数据库或遥测的初始化。Provider 的 experimental_bearer_token、auth、aws、gateway_oauth、capabilities 等成员完整保留，原生类型与互斥关系由 Codex 校验。

同一最终字段只传一处。TOML 使用真实序列化与 argv 数组，不拼 shell、不用 JSON 代替 TOML。动态表名称和 header/state key 中的点号保持字面键。日期时间和负零表示因当前解析/序列化库无法保证原始精度而明确报错，日期样式的普通字符串不受影响。整数形式的浮点数保留浮点类型，经启动通道传入。RPC 无法无损表达但启动通道可以原样表达的其它 TOML 值，可在发送前转入启动通道；Hooks 等必须线程处理的字段无法转换时直接报错，不在后端失败后换路由重试。

### 路径与完整对象

路径在合并前按各自来源处理。已确认 AbsolutePathBuf 字段的 profile 相对路径以所读 profile 文件父目录解析；raw 以 AW workspace 解析。覆盖 model_instructions_file、experimental_compact_prompt_file、model_catalog_json、sqlite_home、log_dir、sandbox_workspace_write.writable_roots、agents 角色 config_file、skills.config.path 等已核验字段。保持词法来源身份，不对 profile hook 来源文件任意 realpath。

MCP cwd、带路径 command、权限路径表达式、遥测证书等按各自原生类型与消费者核对。能保持原生含义则等价传递；已知路径表示无法可靠转换时报 profileConversionUnsupported，提示绝对路径。命令名、整串命令、args、URL、环境值、提示词与项目文件名候选不按普通路径重写。未知字段不按名字猜路径，也不保证未来字段的来源语义。

MCP 完整表与 AW 私有 server 合并，当前私有名称冲突报错；若用户表因 TOML 表示需要放在启动通道，私有 server 使用单字段请求覆盖，避免替换启动表；communication=false 不注入该 server。仅私有 receive_parent 保留既有输出预算，不改用户工具预算。基础/项目的 MCP、插件、工具、技能和代理仍由 Codex 发现。

### 明确拒绝的配置

| 字段或条件 | 原因 |
| --- | --- |
| allow_symlinked_codex_home | 只读取基础用户配置层，运行时覆盖无法复制来源身份 |
| 配置内 profile/profiles | 旧式选择机制，区别于合法的 raw --profile/-p 入口 |
| js_repl_node_path/js_repl_node_module_dirs | 上游已废弃并忽略 |
| agents.job_max_runtime_seconds | 已移除，原生仅为兼容而接受的空操作；不限制其它 agents 字段 |
| orchestrator.skills | 兼容性空操作，原生使用 cloud.skills |
| ghost_snapshot.ignore_large_untracked_files、ignore_large_untracked_dirs、disable_warnings 及前两项旧别名 ignore_untracked_files_over_bytes、large_untracked_dir_warning_threshold | 已移除的快照设置，原生只接受而不生效 |
| tui/desktop/file_opener | 本 app-server 执行模式没有纯客户端消费者 |
| hook prompt/agent；SessionEnd+mcp_tool | 已核验后端不能执行 |
| 配置内 cwd、AW-owned workspace/协议参数、私有 MCP 名称 | AW 控制冲突，不是 Codex 全局不支持 |
| 配置内 bypass_hook_trust、raw hook bypass flag | 必须通过 executor codexBypassHookTrust 控制 |

每项命中都会终止任务，不删除字段继续运行。没有列入黑名单的配置继续交 Codex。未知 hook 事件或成员也不因 AW 列表而丢弃；确需迁移来源状态、但无法确定事件状态标识时，以 profileHookMappingUnsupported 失败，不猜测或伪称后端不支持。无须迁移的未知配置原样传递。

### Hooks 状态、信任与 bypass

profile TOML 的 hook 对象及 `hooks.state` 完整保留。已核验后端不执行 `prompt`、`agent` handler 及 `SessionEnd` 的 `mcp_tool`；命中时在启动后端前报错，信任和 bypass 不改变这一限制。`features.hooks` 仍由实际配置决定，不因存在 hook 定义或开启 bypass 而强制设为 true。共享 `hooks.json`、基础/项目配置及插件的 hook 继续由 Codex 原生发现；不复制它们的定义来模拟 profile 层，也不把它们重新归属为 profile hooks。

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
2. 合并 profile 与显式 args 的 hook 增量。表保留完整成员并按原生覆盖规则合并，事件数组及 handler 数组按上游覆盖规则整体替换，不拼接、不删除个别元素。更高优先级的显式定义胜出；只有最终仍由该 profile 提供的 handler 才获得其原来源状态。仅命令相同或序号相同不能证明来源相同。已消费的 raw `-c hooks...` 从启动覆盖取出，与 profile hooks 一起在线程请求中发送一次；不先传一份启动 hooks 再重复覆盖。
3. app-server 初始化完成后、首次 `thread/start` 前，以本次 `cwd` 调用 `config/read`，设置 `includeLayers: true`。用返回的原始层及层来源取得已有状态，不能只读取 profile 的 `hooks.state` 或返回的普通有效配置。基础 `config.toml` 可能保存 profile 的信任记录。只有 User 与 SessionFlags 层可贡献状态，按 Codex 的低到高顺序合并完整状态记录，保留 `enabled`、`trusted_hash` 及未知成员；含 `disabledReason` 的这些层仍须读取。项目、插件及管理层不能因此获得写入用户信任的能力。
4. 在上述状态上按本参考的覆盖顺序纳入本次 profile 和显式 args 的状态增量，每个来源只合并一次。为最终 profile handler 建立原 key 到 SessionFlags key 的对应；目标序号以最终发送的数组为准。原 key 形如 `<profile 文件路径>:pre_tool_use:0:0`；非 Windows 目标形如 `/<session-flags>/config.toml:pre_tool_use:0:0`，Windows 按上游从 `C:\` 解析的合成路径生成，须在 Windows 验证实际表示。
5. 将原状态记录（含存在的 `enabled`、`trusted_hash` 及未知成员）原样复制到对应目标 key，不补造缺失值，不计算或替换可信摘要。保留其它来源的状态；显式运行时状态依已确定优先级处理。目标 key 已有记录时必须核对它属于哪个最终定义，不能让另一 handler 或旧序号的状态自动给当前 profile hook 授信或覆盖其禁用偏好。不能无歧义、无损解决的对应或冲突须失败，不能任选一条可信记录。
6. 在首次 `thread/start.config` 中一次发送最终嵌套 `hooks` 对象与明确的 `bypass_hook_trust` 布尔值。含路径、冒号和点号的 hook key 是 `hooks.state` 内的字面键，不能展开成顶层 dotted path。由 Codex 计算当前内容摘要并执行信任判定；状态必须在适用的 SessionStart 等启动 hook 执行前就位，不能启动线程后再补。

来源路径变化会改变 hook key；它不直接改变规范化内容摘要。因此，未变内容保留已有信任，变化内容保留旧摘要并由 Codex 判为 Modified，无原可信记录的仍为 Untrusted。不开 bypass 时，这些普通 hook 的未信任状态不使整个任务失败，也不由 AW 自动交互批准；它们保持不执行。AW 不创建信任文件、账本或锁，不写回 profile、基础配置或 `hooks.json`。

需要读取的状态无法取得、必要层信息缺失或读取失败时，用 `profileHookStateUnavailable` 终止；来源键、最终数组对应或状态冲突无法可靠适配时，用 `profileHookMappingUnsupported` 终止。二者都在首次 `thread/start` 前失败，不静默忽略已支持 hooks，不自动切换 bypass。完整状态集合中没有某条记录是正常未信任状态，不等于读取失败。AW 来源映射必须解释的结构或状态类型错误仍用 `profileValueInvalid`；其它原生字段值由 Codex 校验。恢复方式是修正配置、恢复可读状态，或更换具有所需能力的 CLI 后重新开始；不得通过写入信任或重发不确定任务自动修复。

bypass 只由 executor 的 codexBypassHookTrust 提供，缺省 false；无 profile 也可开启。在首次 thread/start.config 显式发送 bypass_hook_trust 布尔值，不放启动 -c。profile 中 bypass_hook_trust 报错并指向专属字段；raw --dangerously-bypass-hook-trust 返回 parameterUnavailable，raw -c bypass_hook_trust=... 作为 AW 控制冲突返回 adapterArgumentsInvalid，不隐式启用。每次显式开启 bypass 都提供 `hookTrustBypassed` 诊断，说明线程范围与禁用/管理限制；沿用上述诊断的 ready/result 保存和补报机制。`config/read` 的原始层、hook 命令、MCP 输入、可信摘要及 profile 原文只用于本次内存适配，不放入诊断或运行快照。状态映射不恢复用户配置层身份、原生 profile 优先级或共享 `hooks.json` 来源身份；不承诺与原生 profile 完全等价。
