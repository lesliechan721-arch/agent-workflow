# `aw-interactive-console-ux.md` 需求复审报告

审查对象：`docs/dev/specs/aw-interactive-console-ux.md`
审查时间：2026-05-05
审查重点：需求合理性、当前基线可落地性、上一轮问题修复情况，以及修复后是否引入新漏洞

## Findings

未发现新的阻断性需求问题、逻辑漏洞或当前基线无法落地的问题。

上一版报告指出的 `scope` 禁词规则和可复制命令示例冲突已经修复。Spec 现在明确把禁用范围限定在面向人的 prose、标题、状态标签、普通 warning 和 TUI 标签，并允许可复制命令、argv 数组、flag 名、JSON 字段、TypeScript 类型/接口示例保留真实技术标识，见 `docs/dev/specs/aw-interactive-console-ux.md:95`、`112`。非 TTY 主入口示例也同步补了 `--scope` 例外说明，见 `docs/dev/specs/aw-interactive-console-ux.md:145`、`151`；输出验收也改成 prose 不泄露 `scope`，技术片段例外，见 `docs/dev/specs/aw-interactive-console-ux.md:642`、`644`。

## 上轮问题复核

上一轮报告里的问题已经按正确方向闭环：

- `PluginConsoleAction` 已补成稳定 action union，并区分打开向导和立即写状态；写动作要求带 `platform`、`scope`、必要时带 `projectKey`，见 `docs/dev/specs/aw-interactive-console-ux.md:429`、`447`、`516`。
- `artifactRefreshFailed` 的 `重新应用配置` 已明确为独立动作，不再等同于保存未修改的配置表单；它会基于 tracked refresh keys 重跑 refresh，并返回稳定 `artifactRefresh` receipt，见 `docs/dev/specs/aw-interactive-console-ux.md:222`、`610`。
- session visibility 已覆盖 `blockedByProjectTrust`、`projectTrustUnknown`、`shadowedByProjectDeveloperInstructions`、`unknownByExternalLayer` 四种状态，并映射到 `partial` + 友好原因码，见 `docs/dev/specs/aw-interactive-console-ux.md:539`、`613`。
- 删除旧交互入口的验收已经补齐 `install/uninstall/upgrade --interactive/--no-interactive`、`config configure`、`config reset --interactive/--no-interactive`，见 `docs/dev/specs/aw-interactive-console-ux.md:625`、`629`。
- 默认输出禁词和可复制命令示例的冲突已通过技术片段例外闭环，验收口径也从“全文不得出现 `scope`”改成“prose 不泄露 `scope` 术语”，见 `docs/dev/specs/aw-interactive-console-ux.md:112`、`644`。

更早一轮报告里的问题也保持闭环：`可升级` 有可计算规则；同名插件多平台/多位置改为 location-level action；`externalOwnership` 已区分纯外部来源和 AW 证据冲突；current catalog 不可用时不会展示升级或依赖 schema 的配置动作；无归属 `nativeResidue` 不会接到普通自动清理。

## 需求合理性

本轮 spec 的产品边界是合理的：`aw` 主入口承担交互控制台，子命令退回稳定脚本 API；默认输出只说用户能理解的结果，诊断细节转移到 `--verbose`、`--debug` 和 JSON。这个方向能解决当前编号 prompt、默认 receipt 过重、status 暴露内部矩阵的问题。

状态优先级也基本正确：外部 ownership 冲突、tracking identity 损坏、native incomplete、dynamic artifact drift/refresh failed 等会压过 `可升级`；project trust 和 session visibility 只降为 `部分可用`，不会把磁盘健康状态误报成损坏；catalog 不可用时禁用升级和依赖 schema 的配置动作。这个映射避免了把“可见性不确定”“残留无归属”“当前目录不可读”混成同一个安装状态。

配置向导的写入语义也没有明显漏洞：多字段整体校验、一次 patch、一次 refresh；切换写入位置时只写显式修改的 key，尤其不复制 sensitive effective value；`config reset --yes` 保留 manifest-optional 清理分支。这些约束可以防止 TUI 为了体验而绕过现有配置安全边界。

## 可落地性评估

整体可以在当前基线下落地，不需要推翻底层架构。现有代码已经有 discovery/status 数据源、Codex native config/cache/recovery 证据、dynamic artifact tracking/refresh、project trust/session visibility、install/upgrade/uninstall/config 的安全预检和 rollback 语义。Spec 新增的友好状态投影层、TUI 控制器、配置写入共享 helper、`reapplyConfigRefresh` 入口，都可以作为现有命令 API 之上的收敛层实现。

关键基线能力已经存在：

- `install` / `upgrade` 已经能在写状态前跑 Codex project write safety 和 required config preflight；TUI 可以在这一层抽出“先预检、再配置表单”的流程。
- `refreshArtifactsAfterConfigWrite()` 已支持 `resetAllTrackedKeys`，能支撑 `reapplyConfigRefresh` 不改 config store、只重跑 tracked dynamic artifact refresh 的语义。
- `status` 里已经保留 native enabled/cache/recovery、managed artifact health、session visibility、catalog compatibility 等机器字段，可以在其上新增友好投影。
- `config reset` 当前已经有 current catalog 缺失时跳过 artifact refresh 的分支，和 spec 要求的 manifest-optional 清理方向一致。

当前基线仍保留旧子命令交互和 `config configure`，并且默认输出会泄露 marketplace、app-server、repo-managed、scope 等内部细节；这与 spec 的目标一致，属于待实施内容，不是需求漏洞。`@inquirer/prompts` 作为新依赖和实际 registry 可用性仍需在实现前验证，spec 已把它列为实施风险。

## 剩余风险

以下是实施风险，不是需求漏洞：

- 这是 breaking change，删除旧交互入口时必须同步 README、公开安装文档、架构/测试文档、插件作者技能和历史计划文档，否则用户会看到互相冲突的命令。
- JSON receipt 一旦发布就会变成脚本合同，开工前最好把 `targets`、`actions`、`native`、`artifactRefresh` 和 `status --json.consoleItems` 的字段再做一次 schema review。
- 友好投影层必须集中实现并复用，不能让 TUI、默认 `aw status` 和 `status --json.consoleItems` 各自写一套状态判断。

## 结论

上一轮报告发现的问题已经闭环，本轮没有发现新的需求问题。当前 spec 可以继续作为实现基础；实现时重点控制友好状态投影、JSON receipt schema 和旧交互入口删除后的文档同步。
