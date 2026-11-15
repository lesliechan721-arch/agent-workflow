# 托管命令

为插件脚本提供稳定入口、声明命令包及权限时读取。完成主 Skill 的能力检查后，查询 `aw dev plugin capabilities --surface managed-commands --json`；权限查询 extensions surface，管理操作查询 `aw command --help`。字段、默认值和校验由当前 CLI/Core 提供。

## 选择资源与配置

producer 拥有资源及更新/删除生命周期；set 是一次完整替换的命令集合，key/variant 标识集合内入口。使用 `managedCommands.packages/sets` 声明，不在五类组件集合重复登记。

| 资源归属 | 选择 |
| --- | --- |
| 已有动态 Skill 的完整 final 目录 | artifact producer，显式指定 platform，并引用本次完整集合中唯一的动态 Skill artifactId。 |
| 某平台的静态 Skill 目录 | static-skill producer，指定 platform 和 skillKey。 |
| 独立工具或明确跨平台共享的目录 | package producer，声明 sourceDir、固定 scope 和触发安装的 platforms。 |

共享原生包中的 producer 使用 canonical user 配置，project 激活不另造身份；独立位置使用真实 RenderUnit scope。AW 将 placementKey 绑定物理实例，作者不提供它。不同位置的同名 set 不互换，共享包取消一个 activation 不撤销仍引用的绑定。独立包始终只有一份配置；两平台需要不同配置时分开声明 producer，不按内容相同推断共享。user 消费者不能引用 project 包。

目录须自包含，先 bundle 依赖，不链接回开发目录。entry 留在 producer 内，runner 使用 node 或 executable，不提供 shell runner。静态 entries 不需要 renderer；配置决定集合或包文件时声明相应 refreshKeys，采用 Artifact renderer（`references/aw-artifact-renderer.md`）。

命令需要宿主原生工具时，采用原生工具（`references/native-tools.md`）声明协议和消费者。AW 在入口启动前按已安装 producer 的声明，从当前 CLI 依赖解析工具；命令保持原业务参数和输出。插件不维护工具版本或摘要，也不增加下载器或公开 prepare 命令。

命令及生成文件只用非敏感配置，秘密通过 envFrom 引用宿主环境。独立包使用 args/env 或普通配置文件，不使用 Skill runtimeConfig reader，也不在执行时读最新 store。仅保存配置不改变运行行为；apply 后分别核对保存与 producer 刷新结果，partial 不等于全部生效。

## 引用与权限

声明、结构化权限和正文引用要求 `aw.managed-commands.v1`。正文用双花括号包围 `aw.command:` 加 `set/key` 或 `set/key/variant`；AW 展开为 `aw command run <id> --`。权限使用同一 `{set,key,variant?}`，argsPrefix 限定所需子命令。不要自行计算 ID、硬编码来源或安装路径。

引用须指向同 owner、同物理部署且作用域合法的有效命令，不能按最近发布记录选择同名 set。AW 扫描 final 中全部 Markdown，包括代码块；教学示例也会展开，需拆开前缀表达。脚本、JSON 和环境值不展开。核对最终正文与权限指向同一 ID。

Claude 的 allow 与沙箱例外独立；需要例外时声明 `agentOverrides.claude.sandbox.excludedCommands`，另要求 `aw.claude.sandbox-exclusions.v1`。按实际需要限定命令 ID 与子命令前缀，不扩大到整个 aw 或其它 ID。生成规则正确不证明宿主实际放行。

## 维护与核对

命令随 producer 安装、刷新和清理，不在 preApply 注册。平台卸载保留独立包；显式 package sync 刷新，package remove 删除并使全部引用失效。sync 使用本地 Active bundle，不隐式同步来源。移除集合入口后，相关平台通过普通 sync 更新消费者。

用 command list/show 的实际身份、错误和恢复指引定位；旧项目移动或来源变化时，从 list 取 pkg-id 精确 remove，不带 --scope。损坏资源可 sync/reinstall；force 仍不得删除 foreign/shared 内容。

作者 prepare/验证使用隔离命令主机，不注册真实用户绑定。核对集合空数组撤销、配置 apply、正文/权限一致及共享包维护；实际宿主和跨 OS 行为单独取证。Portable 不注册本机命令，按 Portable 分发（`references/portable-skills.md`）提供独立内容。

动态 producer 的 omitted 是有意关闭，unmet 保留未满足，未返回被引用 ID 或改为非 Skill 是准备失败。三种情况不能合并为空集合；组件和命令完整校验后一起发布。
