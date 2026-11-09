# Agent Subagent

组织已授权的通用子代理委派，选择执行配置并管理结果。提供通用委派方法、原生子代理调度和外部执行资源。

## 安装

```bash
aw target set codex
aw plugin install agent-subagent --scope user
aw target set claude
aw plugin install agent-subagent --scope user
```

两个平台均支持 user/project 安装。共享配置在个人层维护；项目安装没有独立配置。

## 包含的 Skill

`spawn-subagent` 用于已授权的实际委派、上下文准备、等待和续接。只讨论是否委派或执行者直接完成已分配任务时，不需要采用此 Skill。技术第二意见和事实调查由独立的 `codex-enhance` 插件提供。

```text
使用 spawn-subagent，把这项已授权的实现交给一个执行者。
```

## 配置与执行

通用配置选择执行器、模型和推理强度。自定义数组默认为空，按顺序使用第一个适用范围匹配项，未匹配时使用内建档位。Guide 保留调用方已选的配置；需要自行选择时才读取执行配置 reference。省略 executor 表示 native，直接使用宿主原生工具与角色。subagentCommands 默认空，默认配置不会自行启动外部服务。

subagentCommands 使用 key 作为唯一显示名称。添加外部执行器时可选内建 Codex、Claude Code、Oracle、Antigravity，或 custom/custom-managed。内建入口无需手填 command/entrypoint；Codex、Claude Code 和 Antigravity 固定 workspace，Oracle 固定 bundle。Antigravity 使用 PATH 中的 agy。custom 使用自己的绝对程序入口和明确模式；custom-managed 使用 aw command install 返回的稳定 commandId，保留完整运行目录。args 定制实际后端参数，env 保存普通环境值，envFrom 引用宿主变量；密钥不要写入普通可分发配置。

Codex、Claude Code、Antigravity 可设置 permissionMode：default（默认）保留用户 args 和 profile；auto 使用后端自动审批；full-access 使用官方完整权限入口。Codex 完整权限同时取消自身审批和沙箱，Claude/agy 不额外关闭终端沙箱，均不取得 OS 管理员权限。auto/full-access 高于 Codex profile 同类默认值；与 args 的同类显式控制冲突时启动前报错，模式不可用不静默回退。Oracle/custom 不接受此字段，native 使用宿主权限。权限模式、communication 和 codexBypassHookTrust 独立，完整权限不自动绕过 hook 信任。

每个执行器的 communication 和 resume 缺省 true，分别请求通信与恢复能力，实际以本次回执为准，两者独立。关闭通信但保留恢复合法。communication 设置 false 后不建立 AW 通讯桥，不注入其工具、说明或自动父输入，仍检查所选 CLI 环境并应用权限模式，任务、wait/result/stop 及最终结果仍可用。用户已有工具和 MCP 继续由后端管理。开启只表示意图，实际能力由本次回执确定。Antigravity 在环境、桥、必要权限和原生工具准备成功后启用命令通讯；条件不满足时报告具体错误。本机消息发送证据不代表其它平台或账户均已验证。

Antigravity 开启通讯且实际非完整权限时，会按需向用户的 `~/.gemini/antigravity-cli/settings.json` 追加当前 Node + 已安装通讯脚本的精确 allow。规则可跨 run 复用，重复运行去重；任务失败、停止、重装或卸载均不自动删除，旧路径规则也保留。它是用户级许可；每个 run 仍由私有 binding 隔离通道。已有配置、Ask/Deny/strict 保留，配置错误或明确拒绝时失败；不扩大为任意 Node/终端授权。用户可在 agy 权限设置中移除规则。通讯提示优先推荐单命令直接发送；组合管道或shell包装可能因额外权限要求失败，不为此扩大许可或自动切换完整权限。实际资源或沙箱访问错误仍照实报告。

Oracle 可直接选择 oracleEngine=browser/api，界面推荐 browser；省略引擎时继续沿用 Oracle，但设置 reasoningEffort 后必须明确选择。浏览器将 low/medium/high/xhigh 转换为 light/standard/extended/extra-high，并支持新增的 pro 预设；max/ultra 没有浏览器映射。浏览器登录和实际档位由 Oracle 管理。专用字段与 args 中的同类参数重复时会提示修正。

当前 Windows 原生 Oracle 的文件选择不符合固定 v1 协议。内建 adapter 对非空文件选择在提交后端前返回 fileSelectionUnsupported；未指定文件的请求仍可运行。

Codex 的 codexProfile 读取有效 CODEX_HOME 中的 `<name>.config.toml`，把完整配置转换为本次运行覆盖；已确认线程生效的字段优先使用 RPC，其余使用启动 -c。明确无效或与 AW 控制冲突的配置报错，不再删除字段后继续。适配器不自动启用严格模式，普通未知字段与非法值仍按所选 Codex 的原生行为处理。过去被忽略的配置可能因此开始生效或报错。转换不保留原生用户配置层身份，可能覆盖项目配置。可适配的 profile hooks 沿用已有逐项信任与禁用状态，不自动批准或写回配置。codexBypassHookTrust 缺省 false；显式 true 会让本次线程内已启用但未信任或内容已修改的普通 hook 执行，包括其它来源的适用 hook，仍遵守禁用与管理限制，不授予工具审批或沙箱绕过权限。字段范围和限制见 [Codex profile](skills/spawn-subagent/docs/codex.md#codex-profile-转换)。额外目录 addDirs（--add-dir）仍明确拒绝。

Codex 的 codexCliSource 可选 auto/cli/app，缺省 auto 先查 PATH，仅入口缺失时查 App；cli 只查 PATH，app 只查 App。已找到入口启动失败时不会换来源重试。App 发现面向 macOS 和 Windows，Linux 显式 app 拒绝；Windows 注册包发现和真实启动仍须 Windows 验收，不能从本机证据推断支持。

外部配置可省略 model 和 reasoningEffort，表示使用后端默认。显式要求不支持时报错，不静默替换模型或服务。四个通用档位默认均为 native，省略 model 和 reasoningEffort 时不主动覆盖宿主选择；不承诺覆盖用户强制环境设置或宿主管理政策。按歧义、耦合、验证难度和遗漏代价选档；无效配置不会触发回退。

外部执行通过 AW 物化的稳定命令入口调用，按 `start --executor <key>` 指定执行器。任务使用 --prompt TEXT 或 --prompt-file PATH，消息使用 --text TEXT 或 --text-file PATH；不接受 -/stdin 输入。--instructions-file 可选，不传时不自动补入默认角色，启用通信时 adapter 仍添加通信说明。start 返回 started/starting 或带句柄的失败回执；starting 后继续原句柄，不重新启动。send/wait/result/stop 复用该句柄，正常回执仅显示调度需要的信息，正文放入 message/input/result/diagnostic 语义块。communication 和 resume 均只返回 true/false/pending，内部环境和传输细节不进入主代理回执。必要 code、投递缺口、失败和停止证据仍保留。环境可用不证明登录、网络或模型资格，默认无执行期限。

workspace 在指定目录执行任务，关注路径写入任务，不接受 --file。bundle 通过 --file 按固定的 AW 文件选择协议 v1 选择文件、目录或 glob；各适配器实现相同规则，不需要调用者按后端改写选择式。调用方法由 Guide 的 [外部委派说明](skills/spawn-subagent/references/external-delegation.md) 提供；适配器开发见 [适配器文档](skills/spawn-subagent/docs/README.md)。

## 影响与边界

外部服务可能访问网络、读取材料、使用宿主认证并产生模型费用，须使用可信且已获准的服务。插件按 permissionMode 选择权限，后端管理限制继续生效；显式 codexBypassHookTrust 的 hook 信任影响如上，不扩大任务授权。只读咨询不修改被审项目；必要临时分析写入与项目实施是不同授权。

Codex 默认通用角色为 subagent，完成有界任务。调用方可选择本次可用的其他角色，任务与权限边界继续生效。

只读指令、workspace/bundle 名称和文件筛选都不单独证明技术隔离。忽略规则不替代密钥检查，显式路径或链接也可能指向任务目录外。有限材料只能支持相应范围的结论。

等待采用默认 10 分钟的响应式窗口，超时后继续原句柄。过程消息领取后删除；普通 wait/result 总回执最多 32 KiB（32,768 UTF-8 字节），大报告使用 `result --output-file PATH` 直接导出同一完整报告，默认拒绝覆盖，完整写入并关闭后才消费。父子消息正文最多 24 KiB，长消息用普通 UTF-8 文件和 --text-file，避免宿主命令行长度限制。--export 已删除，传入时返回参数错误。

运行资料位于 `~/.aw-subagent`。subagentRetentionHours 默认 24 小时，从每次执行结束时起算；使用命令开始时的最新生效配置，0 表示永不过期且不扫描，负数不接受。结果读取不续期，导出文件不随 TTL 删除。入口元数据在执行容器为空、mtime 年龄严格超过 max(2 × TTL, 24 小时) 后才可清理，默认严格超过 48 小时。命令触发独立后台扫描，同 run 分轮清理，失败静默跳过，不保证及时或全部删除。

已完成、失败或主动停止的任务可在未过期、resume=true、有绑定 session 且本地进程树已确认停止时，通过原 send 启动下一次执行；unknown 还须核对实际证据，本地停止不证明远端取消。恢复保持原句柄、执行器和 AW 配置，不能覆盖模型、权限或 workspace。适配器恢复原后端 session 并重新绑定当前通信工具，不能新建会话冒充恢复；具体后端和版本有各自边界。恢复只保留最新一次结果，需要旧结果时先导出；同一用户可凭完整句柄跨父会话串行操作，不提供遗失句柄查找。启动或投递不明时保留 unknown 和已有内容，不自动重发。宿主必须允许后台 worker 继续运行。建议代码和候选 patch 只有应用并验证后才算已实施。

升级、重装或删除 Guide 及其托管 adapter 前，先完成或 stop 正在运行的任务；稳定 ID 不保证旧 run 跨版本可继续。五个父侧子命令使用各自精确 allow，宿主强制审核仍可阻止运行，不自动改变后端 permissionMode。

保存设置须 apply 才影响后续外部调用；仅保存继续使用旧安装产物。缺失或损坏按实际诊断通过正常 sync/reinstall 恢复。native 配置或角色刷新后，宿主可能需要受支持的刷新或新会话。

切换到本插件前，先结束旧 Guide 任务并保存所需结果。新插件使用自己的默认值和显式配置，不续接旧任务；外部 key 必须在本插件重新配置。
