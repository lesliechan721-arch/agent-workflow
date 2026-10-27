# 适配器配置与接入

[适配器文档索引](README.md)

## 职责与源码入口

`subagent.mjs` 固定安装配置和输入，启动一个长期 worker；worker 持续管理一个 v5 adapter、父侧队列、快照、停止及最终结果。adapter 拥有后端会话、子侧工具及收件调度。一个 run 不重连、重放、resume 或跨父会话续接。

| 入口 | 责任 |
| --- | --- |
| [subagent.mjs](../scripts/subagent.mjs) | start/send/wait/result/stop 参数、安装 reader、英文文字输出和退出码。 |
| [worker.mjs](../scripts/worker.mjs) | 本次持续执行和收尾；宿主须允许 start 返回后存活。 |
| [plan.mjs](../scripts/runtime/plan.mjs) / [runner.mjs](../scripts/runtime/runner.mjs) | 精确选择 executor、入口、模式、输入和环境。 |
| [protocol.mjs](../scripts/runtime/protocol.mjs) | 严格 v5 JSONL、大小及状态合同。 |
| [adapter-channel.mjs](../scripts/runtime/adapter-channel.mjs) | 子侧发送、显式收件和自动输入共用调度。 |
| [message.mjs](../scripts/message.mjs) / [message-mcp.mjs](../scripts/message-mcp.mjs) | 脚本与 MCP 工具包装，不拥有另一份队列。 |
| [processes.mjs](../scripts/runtime/processes.mjs) / [platform.mjs](../scripts/runtime/platform.mjs) | 本机安全启动、私有资源、进程归属和停止；Windows 使用同产物的 [windows-job.ps1](../scripts/runtime/windows-job.ps1) 持有本次原生 Job。 |
| [resolve-files.mjs](../scripts/resolve-files.mjs) | bundle 公共文件选择 v1；通用运行层不扫描材料。 |
| [contracts.mjs](../scripts/runtime/contracts.mjs) / [files.mjs](../scripts/runtime/files.mjs) | 限值、路径、原子文件及安全诊断。 |
| 内建 `adapters/*-v5.mjs` | Codex、Claude Code、Oracle、Antigravity 后端映射；真实支持范围分别验证。 |

Guide 保留调用方角色和任务约束。调用方先选定 executor/model/reasoningEffort，运行层只消费传入值；省略指令文件时不猜测默认角色。原生 Advisor/Explore 角色的局部禁止重复同一委派段落不注入共享资源或外部 prompt。

## 配置、呈现与生效

配置声明由 [plugin manifest](https://github.com/lesliechan721-arch/agent-workflow/blob/main/plugins/codex-enhance/.agents-plugin/plugin.json) 拥有。subagentCommands 每项具有 key、adapter；key 大小写敏感、唯一，native 为保留值。配置中的 executor 精确引用 key；运行入口必须显式传入 executor。key 只在 Guide 自身的安装配置中查找，其他插件的调用不扩大注册表来源。

| adapter | mode | 用户配置入口 |
| --- | --- | --- |
| codex | 固定 workspace | permissionMode、codexProfile、codexCliSource、codexBypassHookTrust，以及 args、env、envFrom。 |
| claude-code | 固定 workspace | permissionMode、args、env、envFrom；不配置 wrapper command/entrypoint。 |
| oracle | 固定 bundle | args、env、envFrom；不配置 wrapper command/entrypoint。 |
| antigravity | 固定 workspace | PATH 中的 agy；permissionMode、args、env、envFrom；不增加专用认证字段。 |
| custom | 必填 workspace 或 bundle | 绝对 command、可选绝对 entrypoint，加上相同的 args/env/envFrom。 |

内建 mode 可以在原值中省略，显式错误值必须拒绝。command/entrypoint 不属于内建分支，不仅在 TUI 隐藏，也由共享校验器拒绝。切换 adapter 只修改草稿；不适用字段的移除和固定 mode 的变化须在保存前可见，取消不改原配置。args 是实际服务 argv 数组，env 是普通字符串 KV，envFrom 是宿主变量引用 KV，不把容器塞成 JSON 字符串。

所有分支均可设置布尔 `communication`，缺省为 true；它表达用户意图，不证明后端支持通讯。关闭后仍检查环境并应用权限模式，保留 start/wait/result/stop 和最终结果缓存，只跳过 AW 桥、工具绑定、通讯说明及父输入自动调度；用户已有 MCP、插件和工具继续由后端管理。不增加每次 start 的通讯开关。

Codex 的 `codexCliSource` 为 auto/cli/app，缺省 auto；`codexBypassHookTrust` 为布尔值，缺省 false。后者使本次线程已启用但未信任或内容已修改的普通 hook 可执行，范围包括所选 profile 之外的适用 hooks；仍保留禁用状态与管理策略，不授予审批或沙箱绕过权限。两个字段在其它 adapter 上均拒绝，错误类型或枚举同样拒绝。它们与 codexProfile、communication 独立组合，固定读取本产物已安装配置。

```json
{
  "generalTaskProfile": { "executor": "codex-local" },
  "advisorGeneralProfile": { "executor": "oracle-review" },
  "subagentCommands": [
    { "key": "codex-local", "adapter": "codex", "codexProfile": "advanced", "codexCliSource": "auto", "codexBypassHookTrust": false, "communication": true },
    { "key": "claude-local", "adapter": "claude-code" },
    { "key": "agy-task", "adapter": "antigravity", "communication": false },
    {
      "key": "oracle-review",
      "adapter": "oracle",
      "args": ["--engine", "api"],
      "envFrom": { "OPENAI_API_KEY": "REVIEW_OPENAI_API_KEY" }
    },
    {
      "key": "custom-review",
      "adapter": "custom",
      "mode": "bundle",
      "command": "/absolute/path/to/node",
      "entrypoint": "/absolute/path/to/custom-adapter.mjs",
      "args": ["--region", "example-region"]
    }
  ]
}
```

这是字段值示例，不是完整 store。外部 profile 的 model/effort 可省略，调用方按本次显式要求、已选配置、后端默认确定参数，再传给脚本；运行层不查找 profile 或继承其模型参数；省略不生成空参数。native 保持已有必填要求。非法配置或不可用执行器不触发换后端或近似模型替换。

Config Definition v4 的有限对象分支、标量 const 和叶级数组/KV 由 Core 统一实现，CLI、TUI、生效值与物化共用。Manifest v3、Store v5、Catalog v7 和 installed-runtime-config v2 不联动改号。正式字段合同见 [架构说明](https://github.com/lesliechan721-arch/agent-workflow/blob/main/docs/architecture.md)，作者维护入口见 [插件维护指南](https://github.com/lesliechan721-arch/agent-workflow/blob/main/docs/plugin-maintenance.md)。

renderer 只在 Guide 的 external-delegation 中生成执行器表，只显示 key、mode；不展示未经本次初始化的能力，不把表塞进所有 Skill 或角色。profile 表对外部省略的 model/effort 显示“后端默认”；native 不补造这样的缺省配置。Guide 的档位表位于按需读取的 execution-profiles reference；Advisor 显示 general / advanced / expert，依次对应 advisorGeneralProfile / advisorAdvancedProfile / advisorExpertProfile，保留 native、gpt-6-astra 和 high / xhigh / max 默认值。

AW 在物化时注入安装态 JSON 和配置 reader（保留文件名 .aw-runtime-config.json、scripts/aw-runtime-config.mjs）；插件不伪造或覆盖保留资源。reader 从本产物返回 installedIdentity、获准的 effectiveValues（仅 subagentCommands）和 resourceRoot，不读最新 store 或同名 sibling。保存未 apply 时新调用继续用旧安装资源，活跃调用也不重读配置换后端。缺失或损坏通过正常 sync/reinstall 恢复。

## 执行器权限模式

Codex、Claude Code、Antigravity 的 `permissionMode` 可选 default / auto / full-access，缺省 default，显示名为“默认”“自动”“完整权限”。Oracle/custom 显式携带时拒绝；native 使用宿主权限。它读取本产物已安装配置，不增加每次 start 开关，不改变 execution 的 executor/model/reasoningEffort 含义。

| 模式 | Codex app-server | Claude Code | Antigravity |
| --- | --- | --- | --- |
| default | 不增加权限覆盖 | 不增加权限参数 | 不增加权限参数 |
| auto | 首次 thread/start.config 设置 approval_policy=on-request、approvals_reviewer=auto_review，保留有效沙箱和网络限制 | --permission-mode auto | --mode auto |
| full-access | 首次 thread/start.config 设置 approval_policy=never、sandbox_mode=danger-full-access，等价 --dangerously-bypass-approvals-and-sandbox | --dangerously-skip-permissions | --dangerously-skip-permissions |

default 保留用户 args、profile 及后端正常加载的用户、项目和管理配置；用户显式 full-access 不会被撤销。这是保留用户选择，不是 AW 默认提权。auto/full-access 高于 Codex profile 同类默认值，其它字段保留；后续轮次沿用同一线程配置，不写用户 Codex config。Codex --full-auto 的 on-request + workspace-write 不等于 auto_review；Claude --allow-dangerously-skip-permissions 只允许以后切换，不能证明启动时已进入完整权限。

非 default 时，args 中重复控制本模式的显式参数在后端启动或 settings 写入前返回 `adapterArgumentConflict`，即使值相同也拒绝。Codex 包括审批策略、reviewer、full-auto、完整 bypass；full-access 另包括沙箱模式及别名，auto 可保留显式沙箱限制。短选项、--name=value、分离值及 -c 同类叶子都检查。Claude 包括 --permission-mode 和主动跳过审批入口；agy 包括 --mode、--dangerously-skip-permissions。原 model/effort 冲突规则不变。

权限模式、communication 和 codexBypassHookTrust 独立。关闭通讯仍应用权限模式；full-access 不启用 hook bypass，auto 不改变 hook 信任或禁用记录。Claude/agy 不额外关闭用户终端沙箱。完整权限不取得 OS 管理员权限；后端仍执行不可覆盖的管理限制、显式 Ask/Deny 和关键路径保护，拒绝时报告实际失败。

参数可解析不证明模式生效。用已知版本合同及有界、无模型的公开信息检查可提前取得的限制；明确不可用返回 `permissionModeUnavailable`，不改用其它模式。仅在启动后出现 auto 不可用或回退信号时立即停止，保存真实提交/停止证据，不重发；已提交输入不能写 generationStarted=false。不为账户或模型资格增加每次模型探针。本机 agy 1.4.7 已有账户不能使用 auto、回退 default 的真实证据，不能将该路径算作 auto 通过。

## Prompt 与模式

CLI 只有 --executor 和 --prompt 必填。旧 --profile 参数按未知参数拒绝；native、未知 key、重复 key 和无效注册配置在后端启动前报错，通过 config、sync 或 reinstall 修复。任务可用 --prompt TEXT 或 --prompt -；stdin 读到 EOF，拒绝 TTY、空白、非法 UTF-8、重复 prompt 和超限。--instructions-file PATH 可选；相对路径相对调用 cwd，与 --workspace 的文件选择基准分开。

不传指令文件时，协议 prompt 保留任务原文，不添加默认角色或空标题。显式传入时要求非空、可读 UTF-8 文件，runner 读取一次后组合为“执行指令”和“本次任务”两个段落。保留原文本，不截断，不向 adapter 发送指令文件路径让它再次打开。显式坏文件不能当成省略。指令与任务各最多 256 KiB，组合结果不套用单份上限。adapter 只在通讯已就绪时追加相应说明；无指令文件也可追加，调用方不预读或拼接这份说明。

所有适配器都消费一个 prompt，不需要独立 instruction channel 能力声明。提示词拼接不提供 system/developer 权限，不代替业务授权或技术隔离。native 的角色通道不受影响。

workspace 只提供工作目录和任务，CLI 出现任何 --file 均在扫描和适配器启动前失败，code 为 filesNotAllowedInWorkspace，退出 2；包括 --file ''。关注文件写进 prompt，不能作为隐藏的材料参数传递。

bundle 提供 fileSelectors 原值数组和 fileResolver 命令描述。runner 只校验输入形状、NUL 与空选择项，不展开、不读取材料元数据或 ignore 文件。无 --file 则 []，不隐式增加材料。需要路径的适配器可调用公共解析器；原生消费必须符合相同的 AW 文件选择协议 v1。Oracle 在符合协议时直接消费原值，不调用 helper 或构建投影。完整协议与失败处理见 [文件选择与公共解析器](file-selection.md#文件选择与公共解析器)。

## 参数和环境

args 中每项是一个真实后端 argv 值，不执行 shell split、变量插值或 shell。空字符串 argv 合法，NUL 非法。后端入口按最终 PATH 解析；不自动下载，不使用 Codex 专属 binary 环境变量替代通用配置。

内建 wrapper 拥有启动子命令、prompt stdin、工作目录、结构化输出、bundle 文件输入和等待参数。args 与这些控制项冲突时明确拒绝，包括公开别名；不得让 args 把调用变成帮助、预览、仅入队、续接其它会话或多次生成。Oracle 的 --file/-f 及文件选择别名也不能通过 args 在 fileSelectors 之外追加来源。

CLI 已传入 model 或 effort 时，args 不能再次设置同一后端控制项；没有解析值时，args 可以设置或沿用后端默认。检查只覆盖 wrapper 拥有的参数，不复制完整后端 parser 或建立通用功能黑名单。显式不支持的参数报告真实错误，不忽略或重试其它模型。

保留后端正常配置、权限、项目指令、hooks、插件、MCP 和工具。wrapper 不自动设置只读或关闭工具；权限仅按明确选择的 permissionMode 或用户 args 配置，仍必须在本次授权内。后端自己的权限与任务授权不是一回事。

环境处理顺序：捕获原宿主环境，排除 AW 内部上下文和本次控制项；从原宿主快照解析 envFrom；合并 env 与 envFrom；最后注入 runner 控制值。同一目标键同时出现在 env 和 envFrom 时拒绝。来源不存在时报错，存在但为空保留空值；不支持链式引用或 ${...} 替换。

变量名为 `[A-Za-z_][A-Za-z0-9_]*`，值不得包含 NUL。env 只保存普通字面值，不能保存密钥。envFrom 只存来源名；解析后的秘密不进入安装资源、stdin JSON、执行器表。继承其余普通宿主环境及后端认证设置，最终环境通过 spawn.env 交给 adapter，再按实际后端接口使用。

`AW_PLUGIN_CONTEXT`、`AW_PLUGIN_*` 作者上下文、`AW_SUBAGENT_*` 运行控制项不能借 env/envFrom 注入。本次私有目录、工具绑定与进程归属标记由运行层设置；现有 Eval 进程标记按原合同继承但不可覆盖。诊断脱敏已解析 envFrom 值及可识别凭据，不输出完整 env 或请求。受信任适配器可能读取宿主凭据，环境过滤不构成隔离。

## 内建后端的共同要求

只有本次工具与调度配置就绪才能报告 enabled。普通父输入不隐含强制 interrupt；轮次边界和提交竞态由 adapter 处理。

保留 cwd、模型、推理强度、配置、args、env/envFrom、认证、项目指令、hooks、插件、MCP、工具权限及审批。显式 args、model、effort 无法映射时在首次模型提交前报错；Codex profile 的忽略策略仅按 [Codex 实现](codex.md#codex-profile-转换) 的精确范围使用。不复制 Eval 的权限配置，不自动关闭工具；权限提升只按明确选择的 permissionMode 或 args，受后端管理策略及本次授权约束。

后端缺失、必要接口不支持、认证或模型错误按真实结果报告。实际版本可供诊断，精确版本字符串不证明资格。所有首版支持路径须有本次独立后端进程的实际退出证据；不以 adapter 退出代替。
