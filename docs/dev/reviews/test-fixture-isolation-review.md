# `test-fixture-isolation.md` 需求评审报告（复审）

审查日期：2026-05-20  
审查对象：[docs/dev/specs/test-fixture-isolation.md](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:1)  
审查范围：旧问题修复情况、文档自洽性、当前基线可落地性、验收标准覆盖度、需求/公开合同/验收标准追溯关系

## Findings

本轮复审未发现新的阻断项，也没有保留中的或高优先级问题。上轮报告指出的关键缺口已经补齐，当前这版 Spec 可以进入实现。

## 旧问题修复情况

### 1. temp root / `os.tmpdir()` 合同已补齐

这部分现在已经从“背景里的风险描述”收紧成了明确合同：

- 目标、范围和已确认决策都把 `TMPDIR`、`TEMP`、`TMP` 与 temp 语义纳入隔离边界，[spec:78](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:78)-[spec:79](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:79)、[spec:92](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:92)、[spec:109](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:109)
- Env 合同明确要求 `os.tmpdir()` 指向测试 temp 根，并把 temp 派生写路径纳入 fence，[spec:200](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:200)-[spec:217](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:217)
- 路径 fence 合同和验收 4-6 也把 rollback staging、artifact refresh staging、debug log、native cache backup 等写路径列成显式检查项，[spec:233](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:233)-[spec:244](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:244)、[spec:263](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:263)-[spec:265](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:265)

这和当前基线风险是对得上的，因为仓库里确实还有多处 `os.tmpdir()` 派生写入，例如 [packages/cli/src/commands/runtime.ts:261](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/packages/cli/src/commands/runtime.ts:261)、[packages/cli/src/commands/uninstall.ts:857](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/packages/cli/src/commands/uninstall.ts:857)、[packages/cli/src/utils/artifact-refresh.ts:348](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/packages/cli/src/utils/artifact-refresh.ts:348)、[packages/cli/src/utils/codex-native-state.ts:354](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/packages/cli/src/utils/codex-native-state.ts:354)。

### 2. 只读 fixture 根 / 可写状态根已经拆开

旧稿里最容易留下误解的点，现在已经补成了两类根模型：

- 已注册可写状态根，[spec:121](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:121)-[spec:126](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:126)
- 已注册只读 fixture 根，[spec:127](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:127)-[spec:131](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:131)

目标、作者体验、路径 fence 合同和验收 6-7 也都围绕这条边界展开，[spec:83](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:83)-[spec:84](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:84)、[spec:161](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:161)-[spec:163](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:163)、[spec:242](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:242)、[spec:265](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:265)-[spec:266](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:266)。

这个修复是必要的，因为 smoke 基线确实既要读 repo 内的 build/dist 产物，又不能把这些目录顺手放成用户状态可写根，例如 [packages/cli/tests/smoke/catalog-fetch-smoke.test.ts:205](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/packages/cli/tests/smoke/catalog-fetch-smoke.test.ts:205)-[packages/cli/tests/smoke/catalog-fetch-smoke.test.ts:215](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/packages/cli/tests/smoke/catalog-fetch-smoke.test.ts:215)。

### 3. source 模块图和 smoke dist 模块图的清理合同已补齐

这版 Spec 已经明确把 source 与 dist 两套模块图都纳入统一清理合同：

- 目标 8、已确认决策 3、作者体验和 Vitest 环境合同都把 smoke 的 dist 模块图列入同等清理范围，[spec:84](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:84)-[spec:85](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:85)、[spec:111](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:111)、[spec:185](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:185)、[spec:195](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:195)
- 验收 12 进一步要求 source 图与 smoke 通过 `packages/cli/dist/**` 导入的 dist 图都满足同一恢复合同，[spec:271](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:271)

这和当前基线也完全对得上：现有 setup 只清源码模块图，[packages/cli/tests/setup/no-network-catalog.ts:1](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/packages/cli/tests/setup/no-network-catalog.ts:1)-[packages/cli/tests/setup/no-network-catalog.ts:12](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/packages/cli/tests/setup/no-network-catalog.ts:12)；smoke 还在测试文件里手动清 dist 图状态，[packages/cli/tests/smoke/catalog-fetch-smoke.test.ts:162](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/packages/cli/tests/smoke/catalog-fetch-smoke.test.ts:162)-[packages/cli/tests/smoke/catalog-fetch-smoke.test.ts:193](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/packages/cli/tests/smoke/catalog-fetch-smoke.test.ts:193)。

### 4. cwd 隔离已经从“入口默认值”收紧到“全局接管 + 底层 fallback 合同”

这次最关键的收紧之一，是不再只依赖某个 helper 记得传 `cwd`：

- 核对结论与已确认决策要求基础 setup 全局接管 `process.cwd()`，[spec:70](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:70)-[spec:71](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:71)、[spec:112](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:112)
- Cwd 合同和验收 3 / 16 把“每条用例进入安全 cwd、深层 fallback 也不能回到真实仓库 cwd”写成了可验行为，[spec:221](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:221)-[spec:223](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:223)、[spec:262](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:262)-[spec:263](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:263)、[spec:275](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:275)

这和基线风险是匹配的，因为当前 `createCommandExecutionContext()`、`createCliExecutionContext()`、catalog memo key 与 npm project config 解析都还会直接读取真实进程状态，[packages/cli/src/commands/runtime.ts:1375](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/packages/cli/src/commands/runtime.ts:1375)-[packages/cli/src/commands/runtime.ts:1406](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/packages/cli/src/commands/runtime.ts:1406)、[packages/cli/src/utils/plugin-catalog.ts:281](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/packages/cli/src/utils/plugin-catalog.ts:281)-[packages/cli/src/utils/plugin-catalog.ts:301](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/packages/cli/src/utils/plugin-catalog.ts:301)、[packages/cli/src/utils/marketplace.ts:271](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/packages/cli/src/utils/marketplace.ts:271)-[packages/cli/src/utils/marketplace.ts:307](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/packages/cli/src/utils/marketplace.ts:307)。

### 5. native runner guard / app-server guard 的跨用例恢复验收已补齐

上轮报告里那条主要 finding，这一版已经修掉了：

- 作者体验与 Vitest 环境合同已经要求共享 helper 或 setup 负责跨用例收尾，[spec:181](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:181)-[spec:185](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:185)、[spec:195](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:195)
- 验收 12 现在已经明确写出：测试临时注入 fake native runner 或 fake app-server harness 后，下一条未注入 fake 的用例必须重新看到默认 guard；这条恢复合同同时覆盖 smoke 的 dist 模块图，[spec:271](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:271)

这条补完之后，上一轮复审里最主要的验收缺口已经不存在了。

## 其余判断

### 文档自洽性

这版文档现在整体是自洽的：

- 背景、目标、术语、作者体验、公开合同和验收标准都围绕同一条主线展开：默认安全、fake 显式 opt-in、先 fence/guard、再谈 zero-write snapshot，[spec:15](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:15)-[spec:17](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:17)、[spec:77](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:77)-[spec:86](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:86)、[spec:133](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:133)-[spec:155](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:155)、[spec:187](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:187)-[spec:257](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:257)、[spec:258](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:258)-[spec:279](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:279)
- “smoke 可以读取真实 build/pack 产物”与“repo/dist 只作为只读 fixture 根，不自动放开用户状态写入”这两条边界并不冲突，[spec:104](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:104)-[spec:105](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:105)、[spec:196](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:196)
- 我没有看到新的逻辑漏洞，也没有看到需求、术语或验收彼此打架的地方。

如果还想继续优化阅读体验，可以在目标 8 或“全局状态自动收尾”里再显式点名一次 `app-server guard`。不过这属于表述收紧，不构成问题，因为公开合同和验收已经把它写清楚了。

### 当前基线下是否可落地

可以落地，但它是一次测试 runtime 基础设施收口，不是补一个 helper 就结束。

可落地的依据主要有这些：

- Vitest 现有配置已经有 setup 注入点，unit/integration 与 smoke 的差距主要是统一接入，[packages/cli/vitest.config.ts:3](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/packages/cli/vitest.config.ts:3)-[packages/cli/vitest.config.ts:11](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/packages/cli/vitest.config.ts:11)、[packages/cli/vitest.smoke.config.ts:3](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/packages/cli/vitest.smoke.config.ts:3)-[packages/cli/vitest.smoke.config.ts:11](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/packages/cli/vitest.smoke.config.ts:11)
- CLI 上下文、native runner 和 Codex app-server runner 都已经有清晰的注入边界，适合挂 guard/fake，[packages/cli/src/commands/runtime.ts:1368](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/packages/cli/src/commands/runtime.ts:1368)-[packages/cli/src/commands/runtime.ts:1455](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/packages/cli/src/commands/runtime.ts:1455)、[packages/cli/src/utils/native-cli.ts:75](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/packages/cli/src/utils/native-cli.ts:75)-[packages/cli/src/utils/native-cli.ts:120](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/packages/cli/src/utils/native-cli.ts:120)、[packages/cli/src/utils/codex-app-server-client.ts:129](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/packages/cli/src/utils/codex-app-server-client.ts:129)-[packages/cli/src/utils/codex-app-server-client.ts:137](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/packages/cli/src/utils/codex-app-server-client.ts:137)、[packages/cli/src/utils/codex-app-server-client.ts:710](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/packages/cli/src/utils/codex-app-server-client.ts:710)-[packages/cli/src/utils/codex-app-server-client.ts:720](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/packages/cli/src/utils/codex-app-server-client.ts:720)
- 仓库已经有可复用的 fake Codex app-server harness，不需要从零设计 fake 协议面，[packages/cli/tests/helpers/fake-codex-app-server.ts:1](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/packages/cli/tests/helpers/fake-codex-app-server.ts:1)-[packages/cli/tests/helpers/fake-codex-app-server.ts:72](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/packages/cli/tests/helpers/fake-codex-app-server.ts:72)
- 插件脚本 runner 已经证明“把 home 和 temp 一起导向测试临时根”在当前代码语境里可行，[packages/cli/src/utils/plugin-scripts.ts:767](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/packages/cli/src/utils/plugin-scripts.ts:767)-[packages/cli/src/utils/plugin-scripts.ts:809](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/packages/cli/src/utils/plugin-scripts.ts:809)

另外，仓库里目前没有 `test.concurrent`、`it.concurrent` 或 `describe.concurrent` 这类并发用例声明，因此“每条用例前后接管 `process.cwd()`”在当前基线下也是可操作的。现有大量手写 `process.chdir()`、`process.env` 恢复和模块级 override reset，会带来迁移成本，但它们体现的是收口工作量，不是实现阻塞点。

### 验收标准是否覆盖需求变更

现在已经覆盖到了。

- env/home/temp、cwd、路径 fence、只读/可写根、native runner guard、app-server guard、fake opt-in、source/dist 模块图清理、禁网络 `fetch`、fence 可读性、真实 repo cwd 的只读例外、zero-write snapshot 的职责边界、生产默认行为不变、`docs/testing.md` 同步更新，都能在验收 1-20 里找到对应条目，[spec:260](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:260)-[spec:279](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:279)
- 上轮最关键的缺口，也就是 fake native runner / fake app-server harness 的跨用例恢复，现在已经被验收 12 明确锁住，[spec:271](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:271)

从需求变更覆盖度看，这份验收已经足够作为实现完成的判定面。

### 需求、公开合同和验收标准是否能互相追溯

现在三层关系已经能互相追溯，不再有“合同写了，但验收接不住”的系统性问题。

几个关键链路都能顺着走通：

1. 目标 2 的 env/home/temp 隔离，落到 Env 合同和路径 fence 合同，再落到验收 2 / 4 / 5 / 6，[spec:78](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:78)、[spec:198](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:198)-[spec:217](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:217)、[spec:263](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:263)-[spec:265](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:265)
2. 目标 3 的 cwd 隔离，落到 Cwd 合同，再落到验收 3 / 16，[spec:79](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:79)、[spec:219](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:219)-[spec:223](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:223)、[spec:262](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:262)-[spec:275](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:275)
3. 目标 5-8 的 native/app-server guard、全局状态清理和 source/dist 双模块图收尾，落到作者体验与 Vitest 环境合同，再落到验收 8-12，[spec:81](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:81)-[spec:84](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:84)、[spec:175](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:175)-[spec:185](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:185)、[spec:225](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:225)-[spec:229](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:229)、[spec:267](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:267)-[spec:271](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:271)
4. 目标 9-10 的 zero-write snapshot 职责边界和“少传参数也安全”，落到 zero-write snapshot 合同与作者体验，再落到验收 17 / 18，[spec:85](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:85)-[spec:86](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:86)、[spec:246](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:246)-[spec:250](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:250)、[spec:276](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:276)-[spec:277](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:277)
5. `docs/testing.md` 的公开文档更新要求也已经进了测试文档合同与验收 20，[spec:252](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:252)-[spec:256](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:256)、[spec:279](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/specs/test-fixture-isolation.md:279)

所以从追溯性角度看，这份 Spec 现在已经能同时服务需求确认、实现收口和验收判定。

## 更优方案建议

不建议再改需求方向。更值得优化的是实现收口方式：

1. 用一个统一的 `TestIsolationContext` 或 `createTestIsolationFixture()` 承接安全 env、安全 cwd、只读/可写根注册、native/app-server guard，以及 source/dist 双模块图清理。
2. 让 `runCliEntry()`、`runCli()`、command context helper、CLI context helper 都从这个上下文取默认值，避免每层各补一套保护。
3. 把 fake native runner / fake app-server harness 的临时覆盖与自动恢复做成夹具级默认行为，不把 restore 责任留给测试作者记忆。

## 结论

上轮报告发现的问题已经修复到位。我现在认为这份 Spec 在当前仓库基线下是自洽、可落地、验收可判定、追溯关系完整的，可以作为实现输入继续往下走。

当前没有剩余阻断项。若还想进一步优化，可在需求层再显式点名一次 `app-server guard` 的跨用例恢复责任，但这只是表述增强，不影响当前 Spec 进入实现。
