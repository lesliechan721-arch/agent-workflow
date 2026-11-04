# Antigravity 适配器

公共要求见 [配置与接入](configuration.md)、[Adapter v5](protocol.md) 和 [运行生命周期](runtime.md)。


Antigravity 使用 PATH 中的 `agy --input-format stream-json --output-format stream-json`，保持同一进程与 stdin，workspace 是后端 cwd。model/effort 分别映射 --model/--effort，省略不传空值。adapter 拥有格式、prompt、会话续接/选择、cwd、结束控制、固定的 `--print-timeout 0` 和会话 `--settings`；raw args 不得覆盖它们，也不得包含 help/version、子命令、额外 prompt、--continue/--conversation。权限按 permissionMode 映射；其它 sandbox、agent 参数按实际 CLI 合同校验，不额外放宽沙箱或改写全局 MCP。任务 model/effort 与 args 同类选项重复时拒绝。

communication=true 使用独立的 AW 托管通信命令，transport 仍为 command / turn-boundary，同时提供主动收件。协商固定可执行入口，随后建立私有桥、准备必要权限，并在首条user前检查原生init中的run_command工具；全部准备完成后才发enabled ready。已知工具被禁、配置冲突或资源不可用时按具体原因失败，建桥失败不变成unsupported；不增加每次模型探针。

生成的 POSIX 直接调用对安全字符组成的固定 token 使用裸写形式，避免带引号的 executable 触发 agy 整行匹配；需要引用的路径与正文仍保留字面量转义。子侧提示提供直接文本或 --text-file 文件调用；--text - 和文件参数 - 均拒绝，不读取 stdin。组合管道、重定向或包装仍可能被拒绝；按实际错误报告，不自动切换 full-access。

## 启动版本检查

每次启动及恢复都先固定 PATH 中的同一 executable，再用该入口执行有界 `--version` 查询。最低支持稳定版本为 `1.4.10`，此版本开始提供会话 `--settings`。低版本或无法识别的版本返回 `antigravityVersionUnsupported`；查询失败、超时或输出超限返回 `antigravityVersionCheckFailed`，初始化环境为 unavailable。升级或修复所选 agy 后重试；不切换入口、不以全局 allow 回退。检查先于建桥和授权准备，communication=false 及 full-access 也执行；不会为版本检查调用模型。

## 精确通讯权限与会话设置

仅当 adapter 为 antigravity、communication=true、实际策略非 full-access，且 CLI 和必要安装资源可用时准备精确授权。default 的 raw args 已主动选择 full-access 时也不新增规则。communication=false 及已明确 full-access 都不读取通信权限配置、不生成或传入会话 settings。协商保持只读，授权属于随后准备阶段，必须先于正式 agy 加载 settings。不得以 --app_data_dir、--gemini_dir、改写 HOME、复制用户 home、临时全局 MCP、动态插件或额外 --add-dir 绕过模式或配置来源；保留真实登录、项目、模型、hooks、插件和会话根。

Guide 在现有 `spawn-subagent-skill` artifact 上声明静态 `guide-communication/message/default`，入口为 `scripts/message.mjs`，runner=node、cwd=caller。它只提供 send、receive 和帮助；父侧 guide/subagent 的五项权限不变。命令随 producer 安装、sync/reinstall 和清理，不在 start 时注册。

仅此通信分支取得受保护的 `AW_COMMAND_HOST` 和固定 AW_HOME。通过同一 Node/CLI 的公开 command list/show，按安装 reader 的完整 producer 身份、resourceRoot 和精确 launch 选择唯一 ready 绑定。无关不可用记录造成的 partial list 不遮蔽健康目标；缺失、损坏、歧义或归属冲突失败并提示 sync/reinstall。缺少主机时须从正式生成的 AW 命令启动；不计算 ID、不按展示名/cwd 猜来源、不从 PATH 找另一 AW、不回退直接脚本。原主机和绑定复用现有 execution 配置保存；恢复重新核验，不切换来源或资源。

实际调用为固定 Node、AW CLI entry、`command run <精确通信 ID> --`，随后传 `--bridge <当前私有绑定>` 及 send/receive 参数。模型提示与 allow 使用相同前缀。bridge、run ID 和正文只作为本次参数；每次调用仍校验私有文件、归属、关闭和大小。稳定 ID 不取代通道权限。

授权规则只在本次 agy 进程的 `--settings <私有执行目录>/antigravity-settings.json` 生效，不写用户或项目配置。规则只覆盖固定 AW 前缀和该通信 ID，包括分隔符 `--`；保留 token 前缀规则及整行 regex 规则，支持固定 token 的裸写、单引号、双引号和后续字面量参数。不能切换 ID、调用管理入口、插入 Node 选项或附加 shell 展开、重定向、管道、串联动作。未知匹配方式、复杂主机路径及未验证平台返回 `communicationPermissionUnsupported`，不扩大许可。确定性匹配检查不代替原生 agy 资格。

只读校验有效后端用户目录的 `~/.gemini/antigravity-cli/settings.json`。agy 的会话配置会替换显式提供的 allow 数组，因此先保留原 allow 的顺序，再去重补齐本次两条规则。私有文件仅包含 `permissions.allow`；不复制其它用户字段、凭据或限制。未指定的 ask/deny、strict、项目和管理策略仍由 agy 原生加载。重复启动或恢复重新生成当前执行文件，不向用户配置追加规则；raw args 中 `--settings` 及其等号形式由 adapter 拒绝。

用户文件或目录缺失时按空配置处理，不创建它们；不可读、坏 JSON、错误 permissions 类型、不安全路径/归属返回 `communicationPermissionConfigInvalid`。读取期间文件变化返回 `communicationPermissionConflict`，重新开始读取当前配置。保留正常文件、所有者、链接和读取一致性检查；不进行用户文件写前检查、原子替换或 chmod。私有 settings 复用已有私有 JSON 写入工具，创建失败返回 `communicationPermissionWriteFailed`，错误指向执行目录。已知 Ask/Deny/strict 阻止必要命令时，在模型输入前返回 `communicationPermissionDenied`，不删除冲突、不切 full-access；allow 存在本身不能证明更高优先级限制不存在。

会话 settings 是可删除的弱执行资源，沿用已有 cleanup/TTL；后端退出即失去会话覆盖效力，启动或任务失败也无须恢复用户配置。agy 自身可能在启动时规范化用户 JSON，但会话 allow 不随之保存；adapter 不阻止其正常配置保存，也不补偿回写文件。旧版遗留的 message.mjs 或托管命令 allow 缺少可证明的 ownership，不自动删除，用户可从 agy 权限设置手动移除。同 producer、来源、集合、key 和 variant 的通信 ID 不随版本或资源路径变化；Node/CLI 前缀变化时为本执行重新生成精确规则。诊断 `communicationPermissionSession` 说明会话规则已准备及通信规则未写入用户配置，不打印完整 settings、凭据、binding 或正文。不增加配置 ledger、回滚副本、租约或锁层级。

命令许可不证明沙箱能访问Node、脚本依赖、binding、私有请求/响应文件或所需PID。不自动开放整个home、关闭终端沙箱或放行全部命令；本次条件不满足时报告具体错误。default+精确规则、可用账户的auto、full-access分别记录证据；已知账户auto不可用或回退时仍为permissionModeUnavailable，不能因新增allow就算通过。复杂路径和其它平台按实际支持边界处理，不从本机成功外推。

首条及后续输入均为 user NDJSON。活动轮不自动开始下一轮；父输入留在共享队列，已有 receive 优先。result 只结束当前轮；边界处同一输入只通过自动输入或 receive 其中一条路径消费，至多一个自动提交等待确认。stdin.write 成功只证明写管道，submitted 需要同一 conversation 中新增且可关联的 user_input/DONE；旧事件或重复 step 不作确认。写后断线且无确认保留 unknown，确定未接受才为 notSubmitted，不按回答猜测、不自动重发。该映射未获真实证据时不能发布自动交付能力。

后端 num_turns 是会话累计统计，只验证其类型和非负安全整数，不与本次输入数比较。result 仍须有活动输入、无 pending、本次 acceptedCount=inputCount、正确会话及唯一终态；成功还需要至少一条输入、SUCCESS、退出 0 和非空正文。run 使用最后一个已确认成功轮次的完整 result.response，不默认拼接所有轮。后续轮失败时不能以旧回答宣布成功，可明确保留部分结果。关闭前分类已接受输入，停止子侧发送，发 closing，再关闭 stdin 并取得本进程退出及所属后代证据；迟到输入不开新轮，无待办则自然结束。关闭 stdin 不等于取消；stop/deadline 只处理可证明归属的进程树，不发 Claude control_request，不按进程名杀其它 agy 或共享服务。exit 0、部分正文或单轮 SUCCESS 均不足以证明 run 成功，停止或清理不明保留 unknown。

## 恢复与工具重绑

恢复通过 `--conversation <sessionId>` 选择绑定 conversation，实际 init 返回的 conversation_id 必须相同；获得真实 ID 后及时发送 session 帧。每次新建当前 command bridge，重新检查 run_command 能力和必要权限，并把当前工具调用说明加入本次新消息，不重复初始任务或旧输入。会话不存在、ID 不符或不接受输入时明确失败，不使用 --continue 选择其它会话、不 fork、不新建回退，也不重试不明投递。用户正常会话根及认证设置保留，后端会话不存于 AW 的临时 adapter/ 中。

该路径仍须在实际 agy、账户、权限模式和原生操作系统上验证；协议实现与公开 CLI 说明不构成真实恢复或工具交付验收。没有实际运行证据时保留此限制，不从其它后端通过外推。
