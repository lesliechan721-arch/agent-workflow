# Antigravity 适配器

公共要求见 [配置与接入](configuration.md)、[Adapter v6](protocol.md) 和 [运行生命周期](runtime.md)。

Antigravity 使用 PATH 中的 `agy --input-format stream-json --output-format stream-json`，保持同一进程与 stdin，workspace 是后端 cwd。model/effort 分别映射 --model/--effort，省略不传空值。adapter 拥有格式、prompt、会话续接/选择、cwd、结束控制、固定的 `--print-timeout 0` 和会话 `--settings`；raw args 不得覆盖它们，也不得包含 help/version、子命令、额外 prompt、--continue/--conversation。权限按 permissionMode 映射；其它 sandbox、agent 参数按实际 CLI 合同校验，不额外放宽沙箱或改写全局 MCP。任务 model/effort 与 args 同类选项重复时拒绝。

communication=true 使用 Guide 共享命令包的 `message` 子命令，transport 仍为 command / turn-boundary，同时提供主动收件。协商固定可执行入口，随后建立私有桥、准备必要权限，并在首条user前检查原生init中的run_command工具；全部准备完成后才发enabled ready。已知工具被禁、配置冲突或资源不可用时按具体原因失败，建桥失败不变成unsupported；不增加每次模型探针。

生成的 POSIX 直接调用对安全字符组成的固定 token 使用裸写形式，避免带引号的 executable 触发 agy 整行匹配；需要引用的路径与正文仍保留字面量转义。子侧提示提供直接文本或 --text-file 文件调用；--text - 和文件参数 - 均拒绝，不读取 stdin。组合管道、重定向或包装仍可能被拒绝；按实际错误报告，不自动切换 full-access。

## 启动版本检查

每次启动及恢复都先固定 PATH 中的同一 executable，再用该入口执行有界 `--version` 查询。最低支持稳定版本为 `1.4.10`，此版本开始提供会话 `--settings`。低版本或无法识别的版本返回 `antigravityVersionUnsupported`；查询失败、超时或输出超限返回 `antigravityVersionCheckFailed`，初始化环境为 unavailable。升级或修复所选 agy 后重试；不切换入口、不以全局 allow 回退。检查先于建桥和授权准备，communication=false 及 full-access 也执行；不会为版本检查调用模型。

## 精确通讯权限与会话设置

仅当 adapter 为 antigravity、communication=true、实际策略非 full-access，且 CLI 和必要安装资源可用时准备精确授权。default 的 raw args 已主动选择 full-access 时也不新增规则。communication=false 及已明确 full-access 都不读取通信权限配置、不生成或传入会话 settings。协商保持只读，授权属于随后准备阶段，必须先于正式 agy 加载 settings。不得以 --app_data_dir、--gemini_dir、改写 HOME、复制用户 home、临时全局 MCP、动态插件或额外 --add-dir 绕过模式或配置来源；保留真实登录、项目、模型、hooks、插件和会话根。

8 个 Native 平台共用命令包的 `message` 子命令，由 `scripts/message.mjs` 处理 send、receive 和帮助。

Guide 使用 `AW_COMMAND_HOST` 中核验过的 Node、AW CLI 和 `AW_HOME` 运行 `aw command show <来源>/agent-subagent --json`，核对 owner、插件版本、内容摘要、当前 revision 和 `message` 的精确启动定义。配置快照更新后，代码与来源一致时可将恢复绑定到当前 revision。主机或入口证据无效时报告错误，并指明可用的同步操作。

实际调用使用固定的 Node、AW CLI entry 和 `command run <来源>/agent-subagent/<平台> -- message`，随后传 `--bridge <当前私有绑定>` 及 send/receive 参数。提示和 allow 使用同一前缀。每次调用仍校验桥接文件、归属、关闭和大小。

授权规则只在本次 agy 进程的 `--settings <私有执行目录>/antigravity-settings.json` 生效。token 前缀规则和整行 regex 规则均匹配到 `-- message`，支持裸写、单引号、双引号和后续字面量参数。规则校验拒绝更换调用目标、插入 Node 选项及 shell 展开、重定向、管道或串联动作。`start`、`stop` 等父侧动作保留宿主的原有权限检查。复杂主机路径及未验证平台返回 `communicationPermissionUnsupported`。

只读校验有效后端用户目录的 `~/.gemini/antigravity-cli/settings.json`。agy 的会话配置会替换显式提供的 allow 数组，因此先保留原 allow 的顺序，再去重补齐本次两条规则。私有文件仅包含 `permissions.allow`；不复制其它用户字段、凭据或限制。未指定的 ask/deny、strict、项目和管理策略仍由 agy 原生加载。重复启动或恢复重新生成当前执行文件，不向用户配置追加规则；raw args 中 `--settings` 及其等号形式由 adapter 拒绝。

用户文件或目录缺失时按空配置处理，不创建它们；不可读、坏 JSON、错误 permissions 类型、不安全路径/归属返回 `communicationPermissionConfigInvalid`。读取期间文件变化返回 `communicationPermissionConflict`，重新开始读取当前配置。保留正常文件、所有者、链接和读取一致性检查；不进行用户文件写前检查、原子替换或 chmod。私有 settings 复用已有私有 JSON 写入工具，创建失败返回 `communicationPermissionWriteFailed`，错误指向执行目录。已知 Ask/Deny/strict 阻止必要命令时，在模型输入前返回 `communicationPermissionDenied`，不删除冲突、不切 full-access；allow 存在本身不能证明更高优先级限制不存在。

会话 settings 随既有 cleanup/TTL 回收，后端退出即失效。agy 仍按原生行为维护用户配置，会话 allow 仅保存在本次私有 settings。用户可从 agy 权限设置手动移除旧通信规则。Node 或 CLI 路径变化时，本次执行重新生成精确规则。诊断 `communicationPermissionSession` 说明会话规则已准备，省略完整 settings、凭据、binding 和正文。

命令许可不证明沙箱能访问Node、脚本依赖、binding、私有请求/响应文件或所需PID。不自动开放整个home、关闭终端沙箱或放行全部命令；本次条件不满足时报告具体错误。default+精确规则、可用账户的auto、full-access分别记录证据；已知账户auto不可用或回退时仍为permissionModeUnavailable，不能因新增allow就算通过。复杂路径和其它平台按实际支持边界处理，不从本机成功外推。

首条及后续输入均为 user NDJSON。活动轮不自动开始下一轮；父输入留在共享队列，已有 receive 优先。result 只结束当前轮；边界处同一输入只通过自动输入或 receive 其中一条路径消费，至多一个自动提交等待确认。stdin.write 成功只证明写管道，submitted 需要同一 conversation 中新增且可关联的 user_input/DONE；旧事件或重复 step 不作确认。写后断线且无确认保留 unknown，确定未接受才为 notSubmitted，不按回答猜测、不自动重发。该映射未获真实证据时不能发布自动交付能力。

原生 result.status 为 ERROR 时，初始化失败和运行中失败均返回 backendFailed，并将有效文本 result.error 作为故障说明放入 message，由正常 wait/result 输出 diagnostic。说明先按现有凭据规则脱敏，再按 Unicode 字符边界限制为 512 UTF-8 字节，为启动回执的恢复提示预留展示预算，超长时标明截断；缺失或无效的 error 使用简短替代说明，不转交原始 stderr。恢复会话可能带出历史错误，该说明只表示后端报告的原因，不证明错误发生在本轮，也不以退出 0 或非空正文覆盖 ERROR。

后端 num_turns 是会话累计统计，只验证其类型和非负安全整数，不与本次输入数比较。result 仍须有活动输入、无 pending、本次 acceptedCount=inputCount、正确会话及唯一终态；成功还需要至少一条输入、SUCCESS、退出 0 和非空正文。run 使用最后一个已确认成功轮次的完整 result.response，不默认拼接所有轮。后续轮失败时不能以旧回答宣布成功，可明确保留部分结果。关闭前分类已接受输入，停止子侧发送，发 closing，再关闭 stdin 并取得本进程退出及所属后代证据；迟到输入不开新轮，无待办则自然结束。关闭 stdin 不等于取消；stop/deadline 只处理可证明归属的进程树，不发 Claude control_request，不按进程名杀其它 agy 或共享服务。exit 0、部分正文或单轮 SUCCESS 均不足以证明 run 成功，停止或清理不明保留 unknown。

## 恢复与工具重绑

恢复通过 `--conversation <sessionId>` 选择绑定 conversation，实际 init 返回的 conversation_id 必须相同；获得真实 ID 后及时发送 session 帧。每次新建当前 command bridge，重新检查 run_command 能力和必要权限，并把当前工具调用说明加入本次新消息，不重复初始任务或旧输入。会话不存在、ID 不符或不接受输入时明确失败，不使用 --continue 选择其它会话、不 fork、不新建回退，也不重试不明投递。用户正常会话根及认证设置保留，后端会话不存于 AW 的临时 adapter/ 中。

该路径仍须在实际 agy、账户、权限模式和原生操作系统上验证；协议实现与公开 CLI 说明不构成真实恢复或工具交付验收。没有实际运行证据时保留此限制，不从其它后端通过外推。
