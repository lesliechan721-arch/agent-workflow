# Codex Enhance

在 Codex 中组织通用委派、技术第二意见和大范围事实调查。当前任务负责人采用 Skill 方法，执行者直接完成有界任务。

## 安装

```bash
aw install codex-enhance -p codex
```

插件安装到 Codex。项目启用复用用户级共享 Skill 配置，不产生独立的项目执行配置。外部执行可连接本机已有的 Codex、Claude Code、Oracle 或自定义服务；这不表示插件增加了 Claude 平台安装入口。

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

通用、探索和咨询 profile 选择执行器、模型和推理强度。省略 executor 表示 native，直接使用宿主原生工具与角色。subagentCommands 默认空，默认配置不会自行启动外部服务。

添加外部执行器时可选内建 Codex、Claude Code、Oracle，或 custom。内建入口无需手填 command/entrypoint；Codex 和 Claude Code 固定 workspace，Oracle 固定 bundle。custom 使用自己的绝对程序入口和明确模式。args 定制实际后端参数，env 保存普通环境值，envFrom 引用宿主变量；密钥不要写入普通可分发配置。

Oracle 可直接选择 oracleEngine=browser/api，界面推荐 browser；省略引擎时继续沿用 Oracle，但设置 reasoningEffort 后必须明确选择。浏览器将 low/medium/high/xhigh 转换为 light/standard/extended/extra-high，并支持新增的 pro 预设；max/ultra 没有浏览器映射。浏览器登录和实际档位由 Oracle 管理。专用字段与 args 中的同类参数重复时会提示修正。

当前 Codex app-server 对 codexProfile（--profile/-p）和额外目录 addDirs（--add-dir）没有等价的官方映射。显式设置 codexProfile，或在 args 中使用这些选项，会在提交后端前返回 parameterUnavailable。调用方须修正显式配置后再运行；AW 不会忽略这些设置后继续执行。

外部 profile 可省略 model 和 reasoningEffort，表示使用后端默认。显式要求不支持时报错，不静默替换模型或服务。native 保留已有配置要求。专属咨询配置仅在已设置时显示，选中后整体使用；无效配置不会触发回退。

外部任务可以直接写进 --prompt，长任务或已有文件可以从 stdin 输入。--instructions-file 可选，可以复用已有角色文件；不传时不会自动补入默认指令。顾问和调查的职责约束仍需明确传达。使用 `start` 启动，按句柄执行 `send`、多目标 `wait`、单目标 `result` 和 `stop`。能力由本次回执报告 true/false/pending；默认无执行期限。控制字段使用英文，消息和最终回答保留原语言并放入独立原文块。内部 JSONL 不作为用户界面。

workspace 在指定目录执行任务，关注路径写入任务，不接受 --file。bundle 通过 --file 按固定的 AW 文件选择协议 v1 选择文件、目录或 glob；各适配器实现相同规则，不需要调用者按后端改写选择式。调用方法由 Guide 的 [外部委派说明](skills/codex-subagent-guide/references/external-delegation.md) 提供；适配器开发见 [适配器文档](skills/codex-subagent-guide/adapters.md)。

## 影响与边界

外部服务可能访问网络、读取材料、使用宿主认证并产生模型费用，须使用可信且已获准的服务。插件不自动改变后端权限、绕过审批或关闭正常工具。只读咨询不修改被审项目；必要临时分析写入与项目实施是不同授权。

native 的 Advisor/Explore 生成角色只限制把同一任务通过相应 Skill 重新委派：Advisor 对应 codex-advisor，Explore 对应 codex-explore。公共角色资源、通用执行者和外部后端不承担这项局部限制，协作方法仍须符合任务与权限边界。

只读指令、workspace/bundle 名称和文件筛选都不单独证明技术隔离。忽略规则不替代密钥检查，显式路径或链接也可能指向任务目录外。有限材料只能支持相应范围的结论。

等待采用默认 10 分钟的响应式窗口，超时后继续原句柄。过程消息领取后删除，只有固定最终结果可在终态后 1 小时内重读；`result --export` 完整写入 stdout，接收目的地由调用者选择。服务终态或停止无法确认时保留 unknown 和已有内容，不自动重提。宿主必须允许后台 worker 继续运行；不提供跨父会话恢复。建议代码和候选 patch 只有应用并验证后才算已实施。

保存设置须 apply 才影响后续外部调用；仅保存继续使用旧安装产物。缺失或损坏按实际诊断通过正常 sync/reinstall 恢复。native 配置或角色刷新后，宿主可能需要受支持的刷新或新会话。
