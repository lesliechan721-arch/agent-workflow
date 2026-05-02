# Skill Trigger 安装偏好实现复审报告

审查对象：`docs/dev/plans/skill-trigger-install-preference.md` 对应的当前实现代码
复审时间：2026-04-28

## 主要发现

本轮复审未发现新的中高严重度问题。

上一轮报告里提到的两类问题，这次都已经确认修复：

- Codex / Claude 的默认触发语义归一化已经和平台真实行为对齐
- `pnpm test:unit` 不再依赖预先生成的 `packages/cli/plugins-dist`

我这次专门做了反向验证：先临时移走 `packages/cli/plugins-dist`，再直接运行 `pnpm test:unit`，28 个测试文件、167 个测试全部通过。说明上一轮报告里那条“单测入口仍耦合 build 产物”的问题已经关闭，不需要再保留为当前发现。

## 结论

从代码实现质量、计划一致性、测试覆盖和额外未知问题四个维度看，这项实现已经基本收口，可以认为按计划落地完成。

当前实现已经把计划里的主链路完整接上了：

- `skillTriggers` / `allowInstallOverride` 的权威来源固定在 embedded / pristine bundle，没有把 `~/.aw` 的运行时副本反向当成规则真值
- `install`、显式 `upgrade`、`upgrade --all`、`uninstall`、`aw init --force`、stale refresh、bundle fingerprint refresh 都接入了 skill trigger 的物化、replay、re-election、回滚和 warning 流
- degraded ledger 下的拒绝 / 放行边界、warning 输出顺序、status 的 `unknown` 合同，和计划文档一致
- status 仍保持只读；只有 local marketplace 可被当前 bundle 和 layout 证明为可信时，才读取 runtime skill 文件做比对
- sibling drift warning、write order 胜者选举、default/manual/auto 的语义签名比较，都已经和计划中的共享 marketplace 模型对上

## 平台语义核对

这次还额外对照了 Codex 和 Claude Code 的参考源码，确认实现使用的事实标准没有偏：

- Codex：`allow_implicit_invocation` 缺省为 `true`。参考 `codex-rs/core-skills/src/model.rs:25-30`，以及 `core-skills/src/loader_tests.rs:568-599`
- Claude Code：`user-invocable` 缺省为 `true`，`disable-model-invocation` 缺省按 `false` 处理。参考 `claude-code-source-code/src/skills/loadSkillsDir.ts:216-219`、`255-258`、`628-634`

这也解释了为什么当前实现里：

- Codex 的 `default` 和 `auto` 在缺省 `policy.allow_implicit_invocation` 场景下语义等价
- Claude 的 `manual` 需要同时写 `disable-model-invocation: true` 和 `user-invocable: true`
- Claude 的 `auto` 不能强行改写 `user-invocable`，而是要从 pristine 默认文件继承

## 测试核对

本轮实际验证结果如下：

- `pnpm test:unit`
  - 在临时移走 `packages/cli/plugins-dist` 后运行
  - 结果：28 个测试文件、167 个测试全部通过
- `pnpm test:integration`
  - 结果：7 个测试文件、87 个测试全部通过
- `pnpm test:smoke:build`
  - 结果：1 个测试文件、3 个测试全部通过

从覆盖面看，关键矩阵已经比较完整：

- manifest / bundle / authoring contract
- install / explicit upgrade / `upgrade --all`
- uninstall 后的 re-election
- degraded ledger 分支
- rebuild replay 与 warning 合同
- status 的 matched / mixed / unknown / drift 输出
- CLI 入口的参数解析、warning 顺序和失败路径
- Codex / Claude 默认值归一化

## 未发现的额外问题

这轮没有再发现除上一轮已修复项之外的未知功能问题，也没有看到明显的计划偏差或测试缺口。

如果后续还要继续加码，我认为更值得关注的是后续需求演进风险，而不是当前这版实现的收口质量：

- 一旦未来要支持“已从当前 catalog 删除、但历史 ledger 仍残留”的 replay 兼容，现有首版边界需要重新设计
- 如果未来平台上游再改变 skill 默认字段语义，签名归一化和状态判断要同步跟进

但在当前计划范围内，这份实现已经可以认为通过复审。
