# `codex-explore` 重设计实现复审报告

审查对象：`docs/dev/plans/codex-explore-skill-redesign-plan.md`  
关联需求：`docs/dev/specs/codex-explore-skill-redesign.md`  
审查范围：`packages/cli/src/**`、`packages/cli/tests/**`、`plugins/codex-explore/**`、`.agents/skills/create-agent-workflows-plugin/**`、公开文档  
复审日期：`2026-05-09`

## Findings

本轮未发现新的 open finding。

## 已关闭项

1. `repair` 现在会优先保留 install record 里的 `skillTriggerPreference`，不再把显式 `auto` 静默降级成 `default`，也不再让 project scope 去读 user scope runtime。

实现依据：

- `packages/cli/src/commands/repair.ts:1325-1341` 现在先读取 `record.record.options?.skillTriggerPreference`，只有在“用户没有显式传 `--skill-trigger`、record 里也没有偏好、且当前是 Codex user scope”这三个条件同时满足时，才回退到 runtime 推断。
- 这样一来，显式安装得到的 `auto` / `manual` / `default` 真值会先以 install record 为准，project repair 也不会再错误读取 user runtime。

回归覆盖：

- `packages/cli/tests/integration/codex-explore-plugin.test.ts:1866-1965` 补了 user scope repair 保留显式 `auto` 的集成回归。
- `packages/cli/tests/integration/codex-explore-plugin.test.ts:1968-2081` 补了 project repair 不受 user runtime 干扰的集成回归。

2. 动态 `codex.skill` 现在会正确向安装入口暴露可覆盖的 skill trigger 语义，不再因为被排除出静态 materialization 集合就丢失 install option applicability。

实现依据：

- `packages/cli/src/utils/skill-trigger-preferences.ts:332-467` 新增了基于 manifest dynamic target 的 applicability 计算，并把静态 skill 与动态 `codex.skill` 的结果做合并。
- 这和计划要求一致：dynamic skill 要从静态写盘集合里排除，但仍然要保留 `skillTriggers.<skill>.allowInstallOverride` 的安装期语义。

回归覆盖：

- `packages/cli/tests/unit/skill-trigger-install-options.test.ts:421-450` 新增单测，验证 dynamic `codex.skill` 在排除静态 materialization 的同时，install option 仍然返回 `overridable`，并保留显式 `auto` 选择。

3. 上一版报告提到的 README 公开口径问题仍保持修复状态，而且已经有专门测试锁住。

实现依据：

- `README.md:51-53` 继续把 `codex-explore` 描述为“通用只读探索 workflow”，明确覆盖代码库、文档、网络资料、日志和用户材料。

回归覆盖：

- `packages/cli/tests/unit/public-docs.test.ts:19-27` 会在 README 退回“只读代码库探索流程”旧表述时直接失败。

## 计划对齐情况

这轮复审没有看到新的实现偏差或遗漏。结合代码抽查和完整回归，当前实现与计划保持一致：

- `codex-explore` 已经稳定收敛成单一 `codex.skill` 入口，没有恢复旧 `lightweight-instruction` 或 `codex-explorer-role` 形态。
- `repair`、`refresh`、`status`、`diagnose`、`cleanup`、`uninstall`、stale prune、shared runtime owner replay 和本地 marketplace rebuild replay 都继续走 dynamic skill contract，没有把同名 skill 写回静态 materialization。
- `explorerModel` 和 `modelReasoningEffort` 的配置刷新、user/project 双 scope 闭环、README 对外口径、作者工具校验和 smoke/pack 验证都还在计划定义的范围内，没有发现漏项。

## 验证结果

本轮按串行方式复跑了关键验证链，结果如下：

- `node plugins/codex-explore/scripts/render-artifacts.test.mjs`：通过
- `node .agents/skills/create-agent-workflows-plugin/scripts/validate_plugin.js plugins/codex-explore`：通过
- `pnpm build`：通过
- `pnpm test:unit`：72 个测试文件，748 个测试通过
- `pnpm test:integration`：15 个测试文件，239 个测试通过，20 个 legacy 场景保持 `skip`
- `pnpm test:smoke:build`：5 个测试通过
- `pnpm test:smoke:pack`：2 个测试通过

补充说明：

- 这些套件共享 `plugins-dist` 等构建产物，并行执行时会互相干扰，所以验证结论以串行复跑结果为准。
- `pnpm test:smoke:pack` 仍会输出若干 sourcemap 指向缺失源码文件的 warning，但测试通过，且这不是本轮 `codex-explore` 重设计引入的新问题。

## 复审结论

上一版实现报告里的问题都已经修复，本轮也没有发现新的 open finding。当前代码实现质量良好，和计划没有看到实质性偏差，测试覆盖已经覆盖到这轮变更内容及其关键回归点，可以把这次实现评为通过。
