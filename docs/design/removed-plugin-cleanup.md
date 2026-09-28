# 已移除插件的停用

## 决定沿革

2026-09-25，用户确认了已移除插件的整体清理：健康 Active Catalog 中精确插件缺席才是移除证据；归属、路径和后检查必须安全；部分失败保留残留和重试入口，不建立补偿事务。2026-09-26，用户又确认当时的整体清理可以在扩大范围的 Review 后修改 User 和当前 Project 的需求、配置与输出。这些决定中的安全和失败恢复依据继续适用。

2026-09-28，用户确认 User / Project 统一恢复：将已移除插件改为独立停用任务；普通清理不再自动分类、跨 scope 扩大或默认删除配置。下文给出当前合同，恢复命令的公共结构见[架构说明](../architecture.md)。历史的自动整体 `cleanup` 设计不再是可执行入口或授权依据。

## 入口与识别

普通 `aw uninstall`、`aw cleanup`、`aw cleanup --force` 只处理明确选择的 scope 和 Agent 中可证明归属的现场，不修改 Intent、部署偏好或插件配置，也不因 Catalog 缺席自动进入停用。离线清理和受限 force 仍可在来源不可用、弱状态损坏时使用充分的 live 或离线证据；未知、foreign 和 shared 内容保留。

独立入口是 `aw intent retire <source/plugin> --scope user|project`，TUI 显示“停用已移除插件”。必须有健康的本地 Active、可核验的 Catalog logical identity，以及该 Active 中精确插件缺席。来源不可用、网络失败、Active 损坏、Manifest 无效或 bundle 缺失均不能证明移除。识别只读本地证据，不 fetch、不运行 renderer、preApply 或依赖安装规划。不存在的输出或已删除的 root 不阻止对剩余配置、禁用 activation、原生安装或 Portable 残留重新停用。

## 范围与 Review

停用只修改显式选择的 user 或当前 project。`--target` 可重复，只限定这些 Agent 的输出；未指定时，从该 scope 已观察的现场准备精确候选并展示，不根据 Catalog 缺席推断另一 Agent 或 scope 无需求。Review 分别列出当前 scope root、最后一个引用对应的 source binding、该插件的本地 dependency placement override、保存配置、输出、共享 Native 影响和 Portable/未知残留。Agent 选择保留。`--delete-config` 才选择删除当前 scope 的保存配置；TUI 默认不选。`--yes` 只确认 Review 冻结的精确范围，不绕过归属、安全路径或脚本/下载授权。

身份和归属使用已有记录，不建立持久 ledger。可读 owner、Intent、marketplace、config envelope 中的来源身份必须与选择一致；冲突则保留对象并报告。Native 安装或 Codex activation 不能只按同名推断归属，必须能关联 AW-owned marketplace、公开注册和精确 plugin identity。损坏配置的精确 reset 仍遵守 namespaced path 和 allowed-root 边界；异常目录、特殊节点与 foreign owner 保留。Review 绑定 Active 缺席、两类强配置的原始证据、目标和 live ownership。首次副作用前，在同一个 `AW_HOME` mutation lock 内重新核验；变化则返回 stale Review。

## 执行与残留

先原子修改选中 scope 的 Intent 与部署偏好，再按明确选择原子删除配置。任一强配置写入失败，停止尚未开始的输出删除，报告已提交事实；各文件不组成跨文件事务，也不回滚已成功项。Intent 只删除精确 root 和失去最后引用的 binding；偏好只删除该插件的本地 placement override，保留 agents。普通停用不修改另一 scope 的 Intent、偏好、配置或 activation，也不扫描其它项目。

强配置完成后，对获准且安全的独立输出尽力执行并逐目标后检查。Native 卸载所需的 marketplace 归属证据必须保留至 remove 和 absent 核验结束。共享包不能安全移除时保留并报告；删除所选范围的 activation 不能使残留 shared package 因默认值重新启用，必要时保留明确的 disabled 记录并显示为残留。Codex 私有缓存由官方命令管理；AW 不猜测或递归删除。Portable 在两个 scope 都没有自动安全卸载合同，只报告 backend-action-unsupported、可观察残留和精确人工检查指引。未知或部分失败不能伪称完成，下一次停用仍能发现配置、禁用 activation、Native、AW 输出和 Portable 残留。

JSON 使用统一 `aw-recovery` schema 1，分别报告 `declarationChanged`、`preferencesChanged`、`configChanged` 和 `outputsMayHaveChanged` 的实际事实，以及精确 target、blocker 和 recoveryActions。只读 `aw status --scope ...` 保留残留、未知和 config-only 事实；TUI 不靠过滤隐藏未处理对象。

## 验收

按[测试指南](../testing.md)验证：普通清理不改强配置；停用只改选中 scope；未选 `--delete-config` 时保留设置；坏 Active 不触发停用；Review stale 在写前停止；强配置失败不继续输出删除；shared/foreign/Portable 残留可见且可重试；后检查不能只依赖 backend 退出码。真实新增 Native remove 行为仍需隔离资格证据，不能由 fake runner 推断平台支持。
