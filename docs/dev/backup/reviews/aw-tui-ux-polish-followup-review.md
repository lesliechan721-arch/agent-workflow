# `aw-tui-ux-polish-followup` 第四轮实现复审报告

审查对象：
- 需求合同：`docs/dev/specs/aw-tui-ux-polish-followup.md`
- 实施计划：`docs/dev/plans/aw-tui-ux-polish-followup-plan.md`
- 当前实现范围：本轮 worktree 中与 followup 复审相关的 `diagnose` 迁移、shared runtime owner replay，以及对应公开文档与单测

复审时间：2026-05-16

## 复审结论

未发现阻断或需修复的问题。

本轮重点复核了第三轮 finding“owner 文件缺失时 shared runtime replay 仍会 fallback”的修复是否彻底收口。当前 `replaySharedSkillTriggerRuntimeFromOwner()` 在 owner 不可用时会直接返回 `failClosed`，不会再 materialize 或提交 embedded 默认策略；owner 可读后也会继续按合同从 owner location 的当前 effective 配置解析 SkillTrigger 真值，解析失败同样 fail closed：`packages/cli/src/install-state/shared-runtime-owner.ts:634-731`。对应缺失 owner 文件的回归用例已经补上，并且断言 runtime 保持原状态、返回稳定恢复指引：`packages/cli/tests/unit/install-state-shared-runtime-owner.test.ts:571-626`。这和 Spec / Plan 对 shared runtime owner fail-closed 的要求一致：`docs/dev/specs/aw-tui-ux-polish-followup.md:447-449`、`docs/dev/plans/aw-tui-ux-polish-followup-plan.md:391-412`。

对前几轮历史 finding 的回归复查结果也保持稳定：

- `aw diagnose` 旧入口会在 Commander 介入前直接转成迁移错误，不再暴露旧 help 或旧选项：`packages/cli/src/index.ts:158-170`、`packages/cli/src/index.ts:1637-1640`、`packages/cli/tests/unit/cli-entry.test.ts:686-721`。
- 公开文案里的旧 `diagnose` 组合表述已清理为 `status --verbose / repair / cleanup`，公开文档测试也对这些残留短语做了守护：`packages/cli/src/commands/diagnose.ts:1424-1428`、`docs/plugin-authoring.md:239`、`docs/plugin-installation-technical-details.md:54`、`packages/cli/tests/unit/public-docs.test.ts:107-134`。

就本轮复审覆盖到的 followup 相关改动来看，代码变更范围收敛，行为和需求合同一致，新增测试也补到了上一轮缺失的关键分支，没有再看到新的实现质量、性能或覆盖空洞问题。

## 复审范围

- 合同与计划
  - `docs/dev/specs/aw-tui-ux-polish-followup.md`
  - `docs/dev/plans/aw-tui-ux-polish-followup-plan.md`
- 历史复审报告
  - `docs/dev/reviews/aw-tui-ux-polish-followup-review.md`
- 本轮重点核查的实现与测试
  - `packages/cli/src/index.ts`
  - `packages/cli/src/commands/diagnose.ts`
  - `packages/cli/src/install-state/shared-runtime-owner.ts`
  - `packages/cli/tests/unit/cli-entry.test.ts`
  - `packages/cli/tests/unit/diagnose-command.test.ts`
  - `packages/cli/tests/unit/install-state-shared-runtime-owner.test.ts`
  - `packages/cli/tests/unit/public-docs.test.ts`
  - `packages/cli/tests/unit/status-dependencies.test.ts`
  - `docs/plugin-authoring.md`
  - `docs/plugin-installation-technical-details.md`

## 已验证的历史 Findings

- 第一轮 finding 1：`aw diagnose --help` 不再漏出旧 help；旧入口统一返回迁移错误，stdout 保持为空。
- 第一轮 finding 2：公开文档和用户可见文案里的 `diagnose` 残留已经清理，并有文档测试守护。
- 第二轮 finding：owner digest 失效、owner record/location 不匹配、owner effective config 不可解析时，shared runtime replay 已按合同 fail closed。
- 第三轮 finding：owner 文件缺失时也已改为 fail closed，不再 fallback 到 embedded default。

## 已运行测试

- `pnpm --filter @yiliang/aw exec vitest run tests/unit/install-state-shared-runtime-owner.test.ts tests/unit/cli-entry.test.ts tests/unit/public-docs.test.ts tests/unit/diagnose-command.test.ts tests/unit/status-dependencies.test.ts`

结果：5 个测试文件全部通过，共 115 个用例通过。

## 结论

第三轮 owner 文件缺失问题已完全修复，前几轮 `diagnose` 迁移和 shared runtime replay 的历史修复也没有回退。本轮复审未发现新的阻断项或需继续修复的问题。

Review status: PASS
