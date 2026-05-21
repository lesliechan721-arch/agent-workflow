# Agent 版本门禁与 Codex 0.131 对齐阶段 10 审计记录

审计时间：2026-05-21
审计范围：`docs/dev/specs/agent-version-gate-and-codex-0131.md`、`docs/dev/plans/agent-version-gate-and-codex-0131-plan.md`、公开文档、作者工具参考、相关 CLI 源码与测试索引。
执行边界：本记录只做阶段 10 文档收口和发布前审计，不更新计划 todo，不改代码。

## 结论

Spec 的 19 条验收标准已经能追溯到计划中的阶段测试矩阵；其中 1-18 主要由单元/集成/smoke 覆盖，19 由公开文档、作者工具和 `public-docs.test` / `authoring-tools.test` / smoke 测试覆盖。父级最终测试已覆盖：`pnpm test:unit`、`pnpm test:integration`、`pnpm test:smoke:build`、`pnpm test:smoke:plugin-scripts`。

本轮审计发现的阶段 10 收口点已在父级修复：控制台向导不再保留 Codex project scope 可无 native runner 继续的旧说明和单测；Codex user native install/uninstall 单测不再用旧 app-server side effect 模拟 native 写入。

## Findings

### 已修复：控制台向导旧 no-native 语义

- 原问题：`packages/cli/src/commands/console-wizard.ts` 曾在 Codex project target 且 `detection.codex.available === false` 时提示“仍然可以继续”。
- 修复结果：控制台写向导现在返回 `agentVersionBlocked`，不再导入或调用 `canExecuteCodexProjectWithoutNative()`。
- 测试证据：`packages/cli/tests/unit/console-wizard.test.ts` 已改为 `blocks Codex project writes when the agent version gate cannot pass`，覆盖 Codex project 写动作在版本门禁无法通过时被阻断。

### 已修复：Codex user native install/uninstall 旧 app-server side effect

- 原问题：`packages/cli/tests/unit/codex-adapter.test.ts` 的 user native install/uninstall 用例仍以 app-server `plugin/install` / `plugin/uninstall` side effect 补写或删除 config/cache，和当前 Codex CLI 主链路不一致。
- 修复结果：安装用例改为由 fake Codex CLI runner 物化 config/cache；卸载用例改为断言 `codex plugin remove`、`codex plugin list` 和 `codex plugin marketplace remove aw`，并去掉旧 app-server side effect。
- 测试证据：`pnpm --filter @yiliang/aw exec vitest run tests/unit/codex-adapter.test.ts` 和完整 `pnpm test:unit` 均已通过。

## 验收追踪

1. Codex 低版本写入前失败：计划阶段 2 已列 `install`、`upgrade`、`upgrade --all`、`uninstall`、cleanup、repair/reinstall、Codex project gate 测试；测试索引指向 `install-command.test.ts`、`upgrade-command.test.ts`、`uninstall-command.test.ts`、`cleanup-command.test.ts`、`repair-command.test.ts`、`reinstall-command.test.ts`、`codex-project-platform-gates.test.ts`。
2. Codex `0.131.0` 通过门禁：阶段 1/2 的 agent-version 和写命令测试覆盖。
3. Claude `2.1.87` 写入前失败：阶段 2 的 Claude 写命令门禁测试覆盖。
4. Claude `2.1.88` 或更高通过：阶段 1/2 的解析与写命令测试覆盖。
5. missing / probeFailed / unparseable：阶段 1 agent-version 单测和阶段 2 写命令错误 payload 覆盖。
6. 严格 SemVer：阶段 1 `agent-version.test.ts` 覆盖合法 token、非法 token 和 prerelease precedence。
7. `--platform both` 无部分写入：阶段 2 direct write gate 与阶段 8 console both 测试覆盖。
8. `AW_FORCE_*_AVAILABLE` 不绕过版本门禁：阶段 1 detect/native-cli 测试覆盖。
9. `status` / `status --verbose --json` agent version 投影：阶段 6 `status-command.test.ts`、`console-model.test.ts` 覆盖。
10. config refresh / SkillTrigger apply 门禁：阶段 3 `config-write.test.ts`、`plugin-config.test.ts`、console/config 集成测试覆盖。
11. 主控制台、诊断详情、发现页：阶段 8 console/discovery 测试覆盖；console wizard 旧 no-native 语义已修复并由单测覆盖。
12. Codex user-scope native hooks manifest：阶段 4 generator、bundle-layout、rendered-contract 和 smoke build 覆盖。
13. Codex project hooks 仍写 `.codex/hooks.json`：阶段 4 adapter/集成测试覆盖。
14. 不迁移旧 user `.codex/hooks.json`，且 user scope 不新写：阶段 4 `codex-adapter.test.ts` 覆盖保留外部 user hooks。
15. app-server 只读 native view 诊断：阶段 7 client/native-state/status 测试覆盖 `plugin/list`、`plugin/installed`、`plugin/read` 和 `nativeViewUnknown`。
16. RPC 不授权写命令/cleanup/takeover/marketplace removal：阶段 7 evidence/status 测试和阶段 5 cleanup/uninstall 授权测试覆盖。
17. Codex native CLI 写入与 marketplace 生命周期：阶段 5 adapter、native-state、cleanup、integration 测试覆盖 `codex plugin add/remove`、`marketplace add/list/remove`、post-check 和不调用 `marketplace upgrade`。
18. Claude 2.1.88 能力回归：阶段 4/9 bundle-layout、smoke build、public docs 和 authoring tools 测试覆盖。
19. 公开文档、作者工具和 fixtures 同步：阶段 9 `public-docs.test`、`authoring-tools.test`、smoke build/plugin-scripts 覆盖。

## 旧表述扫描

- 公开文档与作者工具已改为：写命令要求 Codex `>= 0.131.0` / Claude Code `>= 2.1.88`；Codex user hooks 进入 `.codex-plugin/plugin.json`；Codex user 写入走 `codex plugin` / `codex plugin marketplace` CLI；app-server RPC 只做 verbose/native view 只读诊断；插件作者无需 per-plugin agent version 字段。
- `docs/dev/backup/**` 中仍有旧 RPC / no-native 语义。这些是历史备份材料，不建议作为本期发布文档依据；若项目后续会全文索引开发文档，需要额外标注为历史归档。
- `packages/cli/src/utils/codex-app-server-client.ts` 仍保留 `plugin/install` / `plugin/uninstall` 封装和旧 client 单测痕迹，但当前 `CodexAdapter` 未引用这些写入函数。建议作为发布后清理项，避免未来误用。

## 阶段 10 勾选建议

- 可以勾选阶段 10 “Spec 19 条验收标准都有自动化测试或明确手工验证记录”。
- 可以勾选 `pnpm test:unit`、`pnpm test:integration`、`pnpm test:smoke:build`、`pnpm test:smoke:plugin-scripts` 四项。
- 可以勾选最终回归中的文档同步、fake runner 五态覆盖、`upgrade --all` / `--platform both` / Codex project scope / config refresh / console 写动作 / verbose native view 端到端验证项。
- 最终状态更新或实施复盘由父级统一处理。
