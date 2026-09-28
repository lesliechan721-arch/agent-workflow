# 已删除插件的整体清理

本文件定义 `cleanup` 对已从当前 Active Catalog 删除的插件的目标行为，是[架构说明](../architecture.md)中普通离线清理的特定例外。设计已于 2026-09-25 经用户确认。

## 目标与已确认范围

用户明确清理已删除插件后，AW 应删除该插件的安装、激活、保存设置、安装意图和专属生成内容。不能只禁用 Codex 插件，再靠列表过滤隐藏残留。

已确认的产品选择：

- 普通 `cleanup` 自动识别已删除插件，不增加独立清理模式。
- 以插件为单位，覆盖 Codex、Claude、用户范围和当前项目；原有平台和 scope 选择不能静默限制或扩大这次操作，必须显示实际范围并取得确认。
- 删除 Codex 共享原生安装。其他项目可能因此无法继续使用该插件；不扫描或改写其他项目，它们的本地记录留到各自清理时处理。
- 完成清理后，当前可见范围内不应再有该插件的 `configOnly` 或安装列表项。

“删除”与“不可用”不同。来源读取失败、来源被移除、Active 缺失或损坏，都不能单独证明插件已从 Catalog 删除。

2026-09-26，用户在统一项目恢复设计中再次确认保留此例外。Project v3 的普通本地清理保留共享需求和配置；已删除插件的整体清理经扩大范围确认后可以删除目标 Project v3 root、无引用的 source binding、User v2 root、该插件本机依赖覆盖与两处设置。Agent 选择保留。此授权不等于跨 provider 自动清扫；可观察 Portable 残留若不能安全处理，必须作为未完成项报告，不能据 Native 清理成功宣称全部清理完成。

## 识别与入口

普通 `cleanup` 先按现有来源解析取得精确 `source/plugin` 身份。只有当前 Active snapshot 通过现有读取和验证合同、且插件 entry 确实不存在，才把该精确来源下的插件分类为已删除；每个待删除对象还必须分别满足下述归属证据，不能要求所有记录都拥有 sourceIdentity 字段。不得把 `bundleUnavailable` 错误码、TUI 摘要缺失或插件目录读取失败直接当作删除证据。

归属证据沿用现有数据，不增加持久记录：

- owner marker、Intent、marketplace root 或 user config 提供 source identity 时，必须与所选来源匹配；可读记录里的身份冲突不能被整体清理覆盖。
- project config 使用现有 source/plugin namespaced 路径及 envelope 的 Catalog logical identity；不要求它含 user scope 的 source identity。有效 envelope 的来源、插件或 binding 冲突时保留并报告。
- 损坏或旧格式 config 无法读出 binding 时，按显式选中的 source/plugin、user/current-project 的现有 reset 路径合同定位。Review 明示删除该路径的保存设置，校验 allowed root 和祖先路径后才删除，不从坏内容猜路径。namespace 正确但内容不可解析，不永久阻断设置清理。
- native 安装及 Codex activation 不独立证明来源。必须通过已有 AW-owned marketplace root 的 source identity、marketplace name，以及公开平台注册的 canonical root 关联绑定精确 plugin@marketplace；不能仅凭名字相同推断。关联冲突或不足时保留该对象，显示阻塞原因并要求修复已有来源/marketplace 证据后重试，不盲目重建 ownership。
- 仅配置或已无任何残留时，不要求先创建 marketplace 或安装原生管理器。CLI 精确 selector 可依据当前来源及 Active 的缺席事实识别目标；无对象可删就是无变化。

读取仅限本地 Active，不 fetch、不 source sync、不运行 renderer、preApply 或依赖安装规划。来源读取失败时，仍可运行已有范围的离线清理，不得因此永久阻断恢复；结果说明未执行整体清理以及恢复来源后重试的方法。插件仍在 Active 中时维持现有普通清理语义。

CLI 与 TUI 共用同一分类结果和清理实现：

- CLI 的普通 `cleanup source/plugin` 自动选择整体清理。交互模式显示目标、两个平台、用户及当前项目、保存设置删除和其他项目影响，再确认。非交互及 JSON 模式使用新增 `cleanup --yes` 授权该范围；未授权时不写入。`--yes` 不代替 managed Codex runtime 的现有授权。
- 显式 `--platform` 或 `--scope` 仍用于初始目标选择，但已删除插件的整体清理会超出这些位置。确认内容及 JSON 确认失败结果必须明确这一点；`--yes` 的帮助文本必须说明其授权的是已删除插件的整体清理。
- TUI 复用现有“清理”动作及 Review，不增加独立模式。Review 必须显示实际扩大后的全部目标、设置删除，以及共享原生包删除对其他项目的影响。
- 批量操作逐插件分类。未删除插件保持原 scope/platform；已删除插件按整体范围展示。相同插件的多个位置合并为一次整体清理，Codex 原生卸载只执行一次。未确认的批次不开始其中任何写入。
- 已删除插件只有保存设置、禁用激活记录或原生安装残留时，仍提供清理入口，不要求先存在可安装的 Catalog summary 或 installed placement。CLI 精确 selector 可在已无残留时重复运行并成功返回无变化。

`cleanup --force` 保持既有专属损坏输出恢复边界，不取得原生管理器、不转为整体清理。它用于解决整体清理发现的专属输出归属证据损坏；之后重新运行普通 `cleanup` 完成整体清理。帮助与结果不能把 force-only 成功描述为“已删除插件已整体清理”。

## 删除边界

| 对象 | 整体清理行为 |
| --- | --- |
| Codex 原生安装 | 通过兼容官方 CLI 移除精确 `plugin@marketplace`，并通过新的 official list observation 确认 absent；不能以调用成功或内存状态代替后检查 |
| Codex 激活配置 | 原生安装确认 absent 后，移除用户与当前项目的精确插件激活条目，包括 `enabled=false`；保留配置文件内的其他插件与用户字段 |
| Claude 原生安装 | 通过现有 adapter 清理用户与当前项目的精确 namespaced 安装；保留其他项目与未绑定 bare-key 安装 |
| AW 输出 | 按 source identity、plugin、platform、scope 的精确 ownership 清理用户和当前项目的专属 Skill、规则、角色等；不重放历史脚本 |
| Project Portable 输出 | 仅报告可观察残留及精确恢复指引；未经验证的 provider 删除能力不得当作已完成，结果保留 partial |
| AW 插件设置 | 删除该来源、该插件的 user 和当前 project config store，不依赖已删除 manifest/schema；复用现有 schema-independent reset 的路径边界和文件删除能力；异常目录/特殊节点保留并报告，见失败规则 |
| 安装意图 | 从 User v2 移除目标插件在两个平台的 root 和依赖覆盖；从当前 Project v3 移除该插件的无平台 root 与无引用 source binding，并清除本机偏好中属于该插件的依赖覆盖；保留 Agent 选择和其它插件需求 |
| AW marketplace 投影 | 删除精确归属该插件的生成目录及 marketplace 中的条目；其他插件内容、动态 native projection、来源配置和共享 marketplace 根保持有效，不删除整个共享根 |
| Catalog store | 不改写 immutable snapshot，不删除整个 source/store；历史 snapshot 的空间回收继续由现有 store prune 负责 |
| 平台私有缓存 | 由官方卸载命令管理；AW 不猜测、递归删除 Codex/Claude 私有缓存路径，不承诺官方卸载后所有内部字节均消失 |
| 其他项目 | 不扫描、不改写；共享原生安装已移除的影响在确认中说明 |

AW marketplace 目录是可重建投影，原生平台安装是另一份由平台管理的状态。两者都必须处理；不能只删除其中之一就报告整体成功。shared 表示与其他位置共用，不表示该插件自己的原生包在本次明确授权后不可删除。

不执行依赖级联清理。当前 Catalog 若有其他插件仍声明依赖该已删除插件，不删除那些插件或配置；保留其诊断和恢复入口。不为此增加跨项目引用计数、安装账本或历史项目注册表。

## Review、执行与失败

沿用现有单个 `AW_HOME` mutation lock。Review 绑定来源身份、Active generation 与插件缺席、user/current-project Intent、设置删除目标、精确 native 身份、激活记录和待删除 AW 输出的现有 evidence。设置证据不公开 secret 或原始内容。

锁内在首次写入前重新分类、重新检查上述 evidence 和路径边界。插件重新出现、来源身份或 Active generation 改变、设置或现场发生变化时，TUI 返回 stale Review，要求重新检查；CLI 同样不能执行基于旧范围获得的确认。非交互 `--yes` 授权锁内重算后的上述固定整体范围，但不能绕过身份与安全检查。

写入使用现有强配置原子操作，不建立跨文件事务：

1. 先完整读取并验证 user/current-project Intent；按文件原子取消目标 root/override。任一 Intent 无法读取时，尚未开始的写入不执行。取消过程部分失败时停止后续输出删除，报告已发生的修改，重试处理剩余部分；不伪称两个文件原子提交。
2. 在同一授权范围内尽力执行原生卸载、AW 专属输出清理和设置 reset。独立目标允许部分成功，不补偿回滚已成功的卸载、Intent 或设置删除。
3. Codex 原生移除失败或无法确认 absent 时，不通过删除用户激活条目恢复平台默认启用行为。保留或设为明确禁用，并把该条目和原生安装列为未完成目标；后续正常清理继续重试。
4. marketplace 投影中该插件的身份和卸载所需证据保留到相关 native 卸载及后检查完成，再删除对应投影。重试不依赖已删除的 config 或 Intent，不建立持久清理 journal。
5. 全部执行后重新观察实际结果，生成现有 Receipt v6 的 changes、targetResults、warnings 和 recoveryActions。不得以单一 native CLI 退出码判定整体成功。

无法证明归属、unsafe path、foreign owner 不能被 `--yes` 绕过。强配置无法安全 reset、专属输出删除失败、原生 remove 失败或后检查未知，都不得报告整体 succeeded。独立部分可继续，失败部分保留具体原因和重试普通 cleanup、受限 force cleanup、修复路径或恢复来源的入口。

整体清理删除正常或损坏 JSON 的 regular config file；目标自身是 symlink 时，只按现有 reset 合同 unlink 链接，不删除指向内容。目标是异常目录或特殊节点时，不调用会将其改名隔离的 reset 分支，也不递归删除；保留精确原路径并报告 partial，使下一次 cleanup 仍能观察到它。提示用户修复节点，或显式使用现有 config reset 并按其结果处理隔离内容。后者属于用户另行执行的恢复，不把隔离内容自动纳入整体清理，也不声称已删除用户另行保留的备份。

即使剩余目标只是在上次失败后留下的禁用激活、AW 投影或原生安装，下一次命令仍须可定位并重试。若证据不足，报告明确受阻原因和已有恢复方式，不能当作不存在。

## 状态与列表

Status 保持只读。Catalog 删除本身不触发自动卸载或配置删除。

- 有 AW 设置的插件在用户尚未清理时保留 `configOnly`；对确认已删除的插件提供整体清理动作。
- 对确认已删除插件，official observation 为 installed 的原生残留，以及待清理的 AW 投影，必须产生可见的未完成清理状态，不能因为 activation 为 false 就被当作已清理。
- 原生状态无法观察时报告 unknown/诊断，不把它变成 absent；这类目标不能被列表过滤隐藏。
- 没有 Catalog entry、没有期望状态或诊断、没有可公开观察的安装及 AW 输出、也没有设置的空记录不生成插件列表项。
- 全部清理成功并刷新后，插件从当前列表和问题中心消失；当前详情页按既有路由恢复规则返回安全列表。未触及的其他项目不属于本次成功声明。

仅有可识别的禁用 activation 记录时，它仍是整体清理的目标：TUI 显示待清理状态并提供清理入口，不将其显示为可安装的 Catalog 插件。归属证据不足时显示受阻原因；不能靠过滤让该残留消失。只有激活条目和其他本次范围内的残留都不存在时，才完全隐藏插件。已有列表过滤需要按这个目标行为调整，不能替代整体清理的副作用与后检查。

## 实施落点与验收

复用现有 source/Active reader、cleanup 编排、native adapter、config reset、ownership 和 TUI Review。模块可拆出小的领域 helper，但不建立平行状态存储、通用事务框架或另一套原生安装探测。

主要落点：`commands/rebuild-command.ts` 的 cleanup 分类及编排，`offline-cleanup-evidence.ts` 与 `operation-plan.ts` 的 Review evidence，`rebuild-integration.ts` 的精确 native 卸载及投影处理，`plugin-config.ts` 的 reset 复用，Status 与 TUI 的残留和 config-only 动作，以及 CLI cleanup 的确认参数。

按[测试指南](../testing.md)选择最低且足够真实的测试层：

1. 安装含 Codex native、Claude、AW 输出和 user/project 设置的插件，再从健康 Active 删除。整体 cleanup 后，官方 fake observation 为 absent，两处激活、设置、目标 Intent/override、专属输出和 AW 投影均移除；真实 Status→TUI 不显示该插件。
2. 同 source 另一插件、同名其他 source 插件、其他项目文件、foreign 内容和 immutable Catalog snapshot 保持不变；共享 marketplace 仍可用于另一插件。确认页准确说明其他项目失去共享原生安装。
3. 仅 config、仅 disabled activation、仅 native、仅 AW 投影及已全部 absent 均可进入相应清理并幂等；config-only 和 disabled-only TUI 可执行整体清理。覆盖 user/project 不同 binding、坏 JSON reset 路径、身份冲突及 native 归属证据缺失的受阻恢复。
4. 来源 unavailable、Active 损坏、插件 entry 存在但 bundle 损坏均不误入整体清理，已有离线及 force 恢复继续可用。
5. Review 后 Active/identity/config/现场漂移在首次写入前拒绝；未确认 CLI、JSON 和 TUI 不写入。带平台/scope 参数与混合批量操作准确展示实际范围。
6. native remove、postcheck、设置 reset、Intent 第二文件写入或投影清理失败时，receipt 正确报告 partial/failed，原生失败不会因移除 activation 而默认启用；再次 cleanup 可以完成剩余工作。
7. 损坏 config、symlink、foreign owner 和异常目录保留上述安全边界，不能被错误标为整体成功；unknown 原生状态和实际残留不会被 TUI 过滤隐藏。

实施交付需相关 unit/integration、完整 unit/integration、build 和 diff check。普通测试使用隔离 homes 与 fake native runner；真实 Codex remove/list 行为若需要新增兼容承诺，使用显式隔离 qualification 验证，不能用 mock 代替。设计阶段未增加新的真实平台验证结论。
