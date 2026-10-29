# Codex Enhance

在 Codex 中组织通用委派、技术第二意见和大范围事实调查。当前任务负责人采用 Skill 方法，执行者直接完成有界任务。

## 安装

```bash
aw install codex-enhance -p codex
```

插件安装到 Codex。项目启用复用用户级共享 Skill 配置，不产生独立的项目执行配置。外部执行可连接本机已有的 Codex、Claude Code、Oracle、Antigravity 或自定义服务；这不表示插件增加了 Claude 平台安装入口。

## 包含的 Skill

| Skill | 什么时候使用 |
| --- | --- |
| codex-subagent-guide | 已允许委派，需要选择执行配置、提供上下文和等待结果。 |
| codex-advisor | 已安排技术第二意见，或重要判断卡点会影响行动。 |
| codex-explore | 需要在大范围或陌生资料中查找并核验事实。 |

Advisor 和 Explore 通过 Guide 委派；已有完整调度与生命周期方法时直接沿用，不要加载或使用 Guide。只讨论是否委派或执行者只需完成已分配工作时，不要使用 Guide；普通定位、局部修改和可直接验证的事实不要使用 Advisor，少量已知文件的定向读取不要使用 Explore。

## 典型用法

```text
使用 codex-subagent-guide，把这项已授权的实现交给一个执行者。
```

```text
使用 codex-advisor，对当前兼容方案取得第二意见，并核验重要建议。
```

```text
使用 codex-explore，调查这个陌生仓库中的配置读取路径，给出可核验的文件定位。
```

## 配置与执行

通用、探索和咨询配置选择执行器、模型和推理强度。三个 Skill 各有默认空的自定义数组，按顺序使用第一个适用范围匹配项，未匹配时使用内建档位。Guide 保留调用方已选的配置；需要自行选择时才读取执行配置 reference。省略 executor 表示 native，直接使用宿主原生工具与角色。subagentCommands 默认空，默认配置不会自行启动外部服务。

subagentCommands 使用 key 作为唯一显示名称。添加外部执行器时可选内建 Codex、Claude Code、Oracle、Antigravity，或 custom/custom-managed。内建入口无需手填 command/entrypoint；Codex、Claude Code 和 Antigravity 固定 workspace，Oracle 固定 bundle。Antigravity 使用 PATH 中的 agy。custom 使用自己的绝对程序入口和明确模式；custom-managed 使用 aw command install 返回的稳定 commandId，保留完整运行目录。args 定制实际后端参数，env 保存普通环境值，envFrom 引用宿主变量；密钥不要写入普通可分发配置。

Codex、Claude Code、Antigravity 可设置 permissionMode：default（默认）保留用户 args 和 profile；auto 使用后端自动审批；full-access 使用官方完整权限入口。Codex 完整权限同时取消自身审批和沙箱，Claude/agy 不额外关闭终端沙箱，均不取得 OS 管理员权限。auto/full-access 高于 Codex profile 同类默认值；与 args 的同类显式控制冲突时启动前报错，模式不可用不静默回退。Oracle/custom 不接受此字段，native 使用宿主权限。权限模式、communication 和 codexBypassHookTrust 独立，完整权限不自动绕过 hook 信任。

每个执行器的 communication 缺省 true；设置 false 后不建立 AW 通讯桥，不注入其工具、说明或自动父输入，仍检查所选 CLI 环境并应用权限模式，任务、wait/result/stop 及最终结果仍可用。用户已有工具和 MCP 继续由后端管理。开启只表示意图，实际能力由本次回执确定。Antigravity 在环境、桥、必要权限和原生工具准备成功后启用命令通讯；条件不满足时报告具体错误。本机消息发送证据不代表其它平台或账户均已验证。

Antigravity 开启通讯且实际非完整权限时，会按需向用户的 `~/.gemini/antigravity-cli/settings.json` 追加当前 Node + 已安装通讯脚本的精确 allow。规则可跨 run 复用，重复运行去重；任务失败、停止、重装或卸载均不自动删除，旧路径规则也保留。它是用户级许可；每个 run 仍由私有 binding 隔离通道。已有配置、Ask/Deny/strict 保留，配置错误或明确拒绝时失败；不扩大为任意 Node/终端授权。用户可在 agy 权限设置中移除规则。通讯提示优先推荐单命令直接发送；组合管道或shell包装可能因额外权限要求失败，不为此扩大许可或自动切换完整权限。实际资源或沙箱访问错误仍照实报告。

Oracle 可直接选择 oracleEngine=browser/api，界面推荐 browser；省略引擎时继续沿用 Oracle，但设置 reasoningEffort 后必须明确选择。浏览器将 low/medium/high/xhigh 转换为 light/standard/extended/extra-high，并支持新增的 pro 预设；max/ultra 没有浏览器映射。浏览器登录和实际档位由 Oracle 管理。专用字段与 args 中的同类参数重复时会提示修正。

当前 Windows 原生 Oracle 的文件选择不符合固定 v1 协议。内建 adapter 对非空文件选择在提交后端前返回 fileSelectionUnsupported；未指定文件的请求仍可运行。

Codex 的 codexProfile 读取有效 CODEX_HOME 中的 `<name>.config.toml`，把支持字段转换为本次运行覆盖；未支持或无关字段提示后忽略，低层同名配置仍可能生效。转换不保留原生用户配置层身份，可能覆盖项目配置。可适配的 profile hooks 沿用已有逐项信任与禁用状态，不自动批准或写回配置。codexBypassHookTrust 缺省 false；显式 true 会让本次线程内已启用但未信任或内容已修改的普通 hook 执行，包括其它来源的适用 hook，仍遵守禁用与管理限制，不授予工具审批或沙箱绕过权限。字段范围和限制见 [Codex profile](skills/codex-subagent-guide/docs/codex.md#codex-profile-转换)。额外目录 addDirs（--add-dir）仍明确拒绝。

Codex 的 codexCliSource 可选 auto/cli/app，缺省 auto 先查 PATH，仅入口缺失时查 App；cli 只查 PATH，app 只查 App。已找到入口启动失败时不会换来源重试。App 发现面向 macOS 和 Windows，Linux 显式 app 拒绝；Windows 注册包发现和真实启动仍须 Windows 验收，不能从本机证据推断支持。

外部配置可省略 model 和 reasoningEffort，表示使用后端默认。显式要求不支持时报错，不静默替换模型或服务。native 保留已有配置要求。Advisor 固定提供 general、advanced、expert 三个难度档位，默认分别为 gpt-6-astra high、xhigh、max。按问题歧义、耦合、验证难度和遗漏代价选档；无效配置不会触发回退。

外部执行通过 AW 物化的稳定命令入口调用，按 `start --executor <key>` 指定执行器。任务使用 --prompt TEXT 或 --prompt-file PATH，消息使用 --text TEXT 或 --text-file PATH；不接受 -/stdin 输入。--instructions-file 可选，不传时不自动补入默认角色，启用通信时 adapter 仍添加通信说明。start 返回 started/starting 或带句柄的失败回执；starting 后继续原句柄，不重新启动。send/wait/result/stop 复用该句柄，正常回执仅显示调度需要的信息，正文放入 message/input/result/diagnostic 语义块。communication 只返回 true/false/pending，内部环境和传输细节不进入主代理回执。必要 code、投递缺口、失败和停止证据仍保留。环境可用不证明登录、网络或模型资格，默认无执行期限。

workspace 在指定目录执行任务，关注路径写入任务，不接受 --file。bundle 通过 --file 按固定的 AW 文件选择协议 v1 选择文件、目录或 glob；各适配器实现相同规则，不需要调用者按后端改写选择式。调用方法由 Guide 的 [外部委派说明](skills/codex-subagent-guide/references/external-delegation.md) 提供；适配器开发见 [适配器文档](skills/codex-subagent-guide/docs/README.md)。

## 影响与边界

外部服务可能访问网络、读取材料、使用宿主认证并产生模型费用，须使用可信且已获准的服务。插件按 permissionMode 选择权限，后端管理限制继续生效；显式 codexBypassHookTrust 的 hook 信任影响如上，不扩大任务授权。只读咨询不修改被审项目；必要临时分析写入与项目实施是不同授权。

native 的 Advisor/Explore 生成角色只限制把同一任务通过相应 Skill 重新委派：Advisor 对应 codex-advisor，Explore 对应 codex-explore。公共角色资源、通用执行者和外部后端不承担这项局部限制，协作方法仍须符合任务与权限边界。

只读指令、workspace/bundle 名称和文件筛选都不单独证明技术隔离。忽略规则不替代密钥检查，显式路径或链接也可能指向任务目录外。有限材料只能支持相应范围的结论。

等待采用默认 10 分钟的响应式窗口，超时后继续原句柄。过程消息领取后删除，只有固定最终结果可在终态后 1 小时内重读；普通 wait/result 报告最多 8192 UTF-8 bytes，超限使用 `result --output-file PATH` 直接导出同一完整报告；默认拒绝覆盖，完整写入并关闭后才消费。--export 已删除，传入时返回参数错误。服务终态或停止无法确认时保留 unknown 和已有内容，不自动重提。宿主必须允许后台 worker 继续运行；不提供跨父会话恢复。建议代码和候选 patch 只有应用并验证后才算已实施。

升级、重装或删除 Guide 及其托管 adapter 前，先完成或 stop 正在运行的任务；稳定 ID 不保证旧 run 跨版本可继续。五个父侧子命令使用各自精确 allow，宿主强制审核仍可阻止运行，不自动改变后端 permissionMode。

保存设置须 apply 才影响后续外部调用；仅保存继续使用旧安装产物。缺失或损坏按实际诊断通过正常 sync/reinstall 恢复。native 配置或角色刷新后，宿主可能需要受支持的刷新或新会话。
