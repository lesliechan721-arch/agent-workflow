# `plugin-dependencies-plan.md` 执行计划复审报告

审查对象：`docs/dev/plans/plugin-dependencies-plan.md`  
关联需求：`docs/dev/specs/plugin-dependencies.md`  
审查时间：2026-05-06

本轮复审重点确认四件事：

- 计划实现内容是否和 spec 一致，有没有偏差、遗漏或越界新增
- 计划本身是否自洽，放到当前仓库基线上能不能落地
- 单元测试是否完整覆盖计划变更内容
- 上一轮 review 报告里的问题是否已经修复，以及是否还有新的风险

对照依据：

- 执行计划：`docs/dev/plans/plugin-dependencies-plan.md`
- 需求 spec：`docs/dev/specs/plugin-dependencies.md`
- 当前实现：`packages/cli/src/**`

## Findings

本轮没有发现新的阻塞问题。

上一轮报告指出的 3 个问题，已经在这版计划里补齐：

- 测试清单现在已经明确锁住“重复 install / upgrade 不增加重复 ref”的 ledger 不变量，见 `docs/dev/plans/plugin-dependencies-plan.md:581`；对应 spec 的 canonical edge 唯一性要求见 `docs/dev/specs/plugin-dependencies.md:337-339`。
- 测试清单现在已经明确锁住“同命令卸载完整 dependent 集合时允许继续，并按反向拓扑清理”的路径，见 `docs/dev/plans/plugin-dependencies-plan.md:593-594`、`614`；对应 spec 要求见 `docs/dev/specs/plugin-dependencies.md:300-304`。
- `status` / 控制台的友好状态语义已经被单独写成测试重点，包括“非生效依赖不打坏 ready”“纯 catalog drift 不直接进入 needsAttention”“可清理 auto dependency 的展示条件”，见 `docs/dev/plans/plugin-dependencies-plan.md:595-598`；对应 spec 见 `docs/dev/specs/plugin-dependencies.md:371-378`。

如果只回答“上一轮报告里的问题修没修”，结论是：已经修完，这轮没有看到回退。

## 一致性复核

这版计划和 spec 主线已经对齐，没有再看到明显的需求偏差、遗漏或越界新增。

- manifest 合同、build 后 staging manifest 复校、平台原生 manifest 过滤和作者工具同步，都在计划里有明确任务，和 spec 的 manifest / authoring contract 一致，见 `docs/dev/plans/plugin-dependencies-plan.md:101-135`；对应 spec 见 `docs/dev/specs/plugin-dependencies.md:69-130`、`470-479`。
- location-aware 规则、`target.scope` 硬约束、`--platform auto` 先决、当前 platform 不生效 entry 的处理方式，都被计划收进统一 planner 和满足规则，没有另起第二套语义，见 `docs/dev/plans/plugin-dependencies-plan.md:137-227`；对应 spec 见 `docs/dev/specs/plugin-dependencies.md:132-191`。
- install / upgrade / uninstall / status / receipt 的核心行为都按 spec 分成独立阶段，尤其是 graph-level preflight、edge 延迟提交、upgrade-all explicit roots、snapshot-first status 和自动清理 fail-closed，都没有缺位，见 `docs/dev/plans/plugin-dependencies-plan.md:244-409`、`471-539`；对应 spec 见 `docs/dev/specs/plugin-dependencies.md:192-479`。
- 计划的执行边界和 spec 非目标一致，没有把版本约束、跨 marketplace dependency、原生平台自动补依赖或历史 ledger 自动迁移偷偷带进首版范围，见 `docs/dev/plans/plugin-dependencies-plan.md:76-98`；对应 spec 见 `docs/dev/specs/plugin-dependencies.md:59-68`、`348-351`。

## 可落地性复核

这份计划在当前仓库基线上可以落地，代价是一次明确的结构改造，但不是脱离现有实现重写一套系统。

- 当前基线里，manifest 类型和 ledger 结构确实还不认识依赖字段与 dependency edges，见 `packages/cli/src/types.ts:320-336`、`893-934`。计划已经把这些缺口收进 manifest 合同和 ledger 合同阶段，方向是对的。
- `install` 现在还是按 `platform -> target` 线性执行，见 `packages/cli/src/commands/install.ts:739-860`；`upgrade` 也还在复用 `installTargetsOnPlatforms()`，见 `packages/cli/src/commands/upgrade.ts:1086-1124`、`1287-1303`。计划把这两条路径收口到统一 planner + graph write executor，正好对准当前最需要替换的事务边界。
- `uninstall` 目前还是按用户传入 location 直接取 scope record，不理解 incoming dependents 和自动清理图，见 `packages/cli/src/commands/uninstall.ts:304-333`。计划单独给了 uninstall planner、incoming index 和反向拓扑清理阶段，和现有缺口是一一对应的。
- `status` 已经有 install snapshot 优先、失败后回退到 current catalog / historical 的健康源分层，见 `packages/cli/src/commands/status.ts:213-258`。这说明 spec 要求的 snapshot-first + catalog drift 双层模型不是空中楼阁，而是在现有机制上扩展。

所以落地判断是：

- 能做。
- 需要按计划里的“manifest/ledger/planner/write path/read path/authoring tool”整套推进。
- 不适合只改 install、不改 upgrade / uninstall / status / 作者工具的半套实现。

## 测试覆盖复核

这版计划的测试闭环已经比上一轮完整得多，当前没有再看到明显漏掉的大块变更面。

- 单元测试清单已经覆盖 manifest 合同、planner 展开、scope fallback、edge 去重、graph preflight、install / upgrade 失败收口、卸载保护、status 健康层与 drift 分层、console 友好投影、receipt schema 等核心变化，见 `docs/dev/plans/plugin-dependencies-plan.md:562-599`。
- 集成测试清单也覆盖了自动安装依赖、按平台分流、跨 scope 依赖、upgrade 补齐新增依赖、upgrade-all 根集合、自动清理、联合卸载和 status JSON 投影，见 `docs/dev/plans/plugin-dependencies-plan.md:601-616`。
- 阶段计划里还把测试夹具、parity fixture、snapshot drift fixture、graph executor 回滚场景和 build smoke 都单独列出来了，说明测试不是最后补几条 happy path，而是随改造结构一起设计，见 `docs/dev/plans/plugin-dependencies-plan.md:424-558`。

如果要更严格地说，这份计划仍然依赖实现阶段真的把这些测试补齐并跑完；但从“计划有没有把应测内容写进去”这个角度看，这轮已经达到可执行状态。

## 结论

这版执行计划可以继续推进。

- 上一轮报告里的问题已经修复。
- 本轮没有发现新的结构性问题。
- 计划和 spec 现在基本一致，边界没有跑偏。
- 计划内容和当前代码基线之间有明确接缝，具备落地条件。
- 测试清单已经覆盖这次改造的主要风险面，可以作为实施时的验收约束继续使用。
