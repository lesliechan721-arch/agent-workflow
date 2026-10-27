# Antigravity 适配器

公共要求见 [配置与接入](configuration.md)、[Adapter v5](protocol.md) 和 [运行生命周期](runtime.md)。


Antigravity 使用 PATH 中的 `agy --input-format stream-json --output-format stream-json`，保持同一进程与 stdin，workspace 是后端 cwd。model/effort 分别映射 --model/--effort，省略不传空值。adapter 拥有格式、prompt、会话续接/选择、cwd、结束控制和固定的 `--print-timeout 0`；raw args 不得覆盖它们，也不得包含 help/version、子命令、额外 prompt、--continue/--conversation。权限按 permissionMode 映射；其它 sandbox、agent 参数按实际 CLI 合同校验，不额外放宽沙箱或改写全局 MCP。任务 model/effort 与 args 同类选项重复时拒绝。

communication=true 使用 command / turn-boundary / activeReceive=true。协商固定可执行入口，随后建立私有桥、准备必要权限，并在首条user前检查原生init中的run_command工具；全部准备完成后才发enabled ready。已知工具被禁、配置冲突或资源不可用时按具体原因失败，建桥失败不变成unsupported；不增加每次模型探针。

生成的 POSIX 直接调用对安全字符组成的固定 token 使用裸写形式，避免带引号的 executable 触发 agy 整行匹配；需要引用的路径与正文仍保留字面量转义。子侧提示只补充权限边界和 `--text -` 读取 stdin 的特殊约定，不讲解通用 shell 语法。组合管道、重定向或包装仍可能被拒绝；按实际错误报告，不自动切换 full-access。

## 精确通讯权限与持久影响

仅当 adapter 为 antigravity、communication=true、实际策略非 full-access，且 CLI 和必要安装资源可用时准备精确授权。default 的 raw args 已主动选择 full-access 时也不新增规则。communication=false 不读取或写入自动授权 settings；full-access 不新增持久通讯规则。协商保持只读，授权属于随后准备阶段，必须先于正式 agy 加载 settings。不得以 --app_data_dir、--gemini_dir、改写 HOME、复制用户 home 或临时全局 MCP 绕过模式或配置来源；保留真实登录、项目、模型、hooks、插件和会话根。

目标为有效后端环境及平台用户目录规则确定的 `~/.gemini/antigravity-cli/settings.json`。从本安装 toolkit 取得 Node executable 与 message.mjs 的实际绝对路径，只授权这个脚本入口。保留两个精确 token 的前缀规则，并追加一条整行 regex 兼容规则，允许相同 Node/脚本路径的裸写、单引号、双引号形式以及后续字面量参数。兼容规则不包含具体 run ID、binding 或正文；只匹配单条命令，不含脚本前的 Node 选项、其它脚本、同名后缀、环境前缀、展开、重定向、管道或命令串联。已有前缀规则的组合匹配仍由 agy 原生处理。脚本继续校验 send/receive/help、私有 binding 和文件访问。路径仍须通过无歧义的安全绝对路径检查；复杂路径和其它平台返回 `communicationPermissionUnsupported`，不放行整个 Node、shell 或安装目录。规则的确定性匹配检查不代替原生 agy 资格。

读取并校验现有 JSON，只向 permissions.allow 追加缺少的入口规则，保留未知字段、allow/ask/deny、strict 和其它策略。旧前缀规则存在时只补兼容规则，两条均存在则不重写。文件缺失可创建最小对象；不可读、坏 JSON、错误 permissions 类型返回 `communicationPermissionConfigInvalid`，不可安全写入返回 `communicationPermissionWriteFailed`，不将错误当空配置覆盖。已知 Ask/Deny/strict 阻止必要命令时，在模型输入前返回 `communicationPermissionDenied`，不删除冲突、不切 full-access；allow 存在本身不能证明更高优先级限制不存在。查询/解析失败与明确不支持分开报告。

写入使用同目录临时文件与原子替换，保留原有必要访问限制，新文件使用私有权限；校验路径类型和所有者，不沿未知链接写入。写前重查文件，来源已变化则放弃候选，返回 `communicationPermissionConflict`；重试重新读取。不承诺与外部编辑器/CLI 强一致，不增加配置 ledger、回滚副本、租约或锁层级。

规则成功写入后长期保留，即使后端启动、建桥或任务失败也不撤销。正常结束、stop、cleanup、sync/reinstall、卸载均不自动删除，旧安装路径规则也保留。诊断只说明新增、已存在或未写入，不打印完整 settings、凭据、binding 或正文。用户可在 agy 公开权限设置中移除规则；修复配置或安装资源后重新开始。

命令许可不证明沙箱能访问Node、脚本依赖、binding、私有请求/响应文件或所需PID。不自动开放整个home、关闭终端沙箱或放行全部命令；本次条件不满足时报告具体错误。default+精确规则、可用账户的auto、full-access分别记录证据；已知账户auto不可用或回退时仍为permissionModeUnavailable，不能因新增allow就算通过。复杂路径和其它平台按实际支持边界处理，不从本机成功外推。

首条及后续输入均为 user NDJSON。活动轮不自动开始下一轮；父输入留在共享队列，已有 receive 优先。result 只结束当前轮；边界处同一输入只通过自动输入或 receive 其中一条路径消费，至多一个自动提交等待确认。stdin.write 成功只证明写管道，submitted 需要同一 conversation 中新增且可关联的 user_input/DONE；旧事件或重复 step 不作确认。写后断线且无确认保留 unknown，确定未接受才为 notSubmitted，不按回答猜测、不自动重发。该映射未获真实证据时不能发布自动交付能力。

run 使用最后一个已确认成功轮次的完整 result.response，不默认拼接所有轮。后续轮失败时不能以旧回答宣布成功，可明确保留部分结果。关闭前分类已接受输入，停止子侧发送，发 closing，再关闭 stdin 并取得本进程退出及所属后代证据；迟到输入不开新轮，无待办则自然结束。关闭 stdin 不等于取消；stop/deadline 只处理可证明归属的进程树，不发 Claude control_request，不按进程名杀其它 agy 或共享服务。exit 0、部分正文或单轮 SUCCESS 均不足以证明 run 成功，停止或清理不明保留 unknown。
