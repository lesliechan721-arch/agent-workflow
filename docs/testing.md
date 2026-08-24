# Testing Guidelines

本文件面向仓库维护者，负责测试书写、测试层级选择和验证命令。产品行为以[架构说明](architecture.md)为准；插件模型 Eval 和评审流程以[插件维护指南](plugin-maintenance.md)指向的专用 Skill 为准。

`pnpm test` 使用默认 Vitest 配置，只运行 unit 和 integration 测试。Performance 和 smoke 测试使用独立命令，不包含在 `pnpm test` 中。

## Test Layers

| 层 | 命令 | 责任 |
|----|------|------|
| Unit | `pnpm test:unit` | 纯函数、validator、renderer、cache、ownership、status、config 和编排逻辑 |
| Integration | `pnpm test:integration` | CLI 入口、作者工具、写命令和平台 adapter 组合 |
| Performance | `pnpm test:perf` | 独立性能预算；不进入普通 unit |
| Performance gate | `pnpm test:perf:gate` | 预算结果和 fast unit wall-time 门禁 |
| Smoke | 见下方命令表 | 真实 build、stage、pack、fetch 和插件脚本产物 |
| Plugin test | `pnpm plugin:test <plugin>` | 插件自己的确定性 Node 测试 |
| Model eval | 见[插件维护指南](plugin-maintenance.md) | 需要模型理解、判断、路由或完成任务的语义合同；不进入普通 CI |

### Coverage and Smoke Commands

| 命令 | 责任 |
|------|------|
| `pnpm test:coverage` | 运行默认 unit/integration 测试并生成覆盖率报告 |
| `pnpm test:smoke` | 运行完整 smoke suite |
| `pnpm test:smoke:build` | 校验 `pnpm build` 产物 |
| `pnpm test:smoke:pack:cli` | 校验 CLI tarball 内容，并在只暴露 tarball 已声明依赖的隔离视图中运行 bin 和关键 ESM import |
| `pnpm test:smoke:stage:catalog` | 校验显式版本 catalog staging 和本地 path source 消费 |
| `pnpm test:smoke:publish:catalog` | 使用本地 bare remote 校验 catalog staging、Git publish、fetch 和 Git provider 消费 |
| `pnpm test:smoke:publish:release` | 构造 prepared descriptor 并调用 publisher，校验 `Eval → CLI → CLI tag → Catalog`、显式轴和不确定远端失败 |
| `pnpm test:smoke:fetch` | 通过本地 bare Git remote 校验 publish、fetch 和 Git provider 消费；复用 publish catalog smoke |
| `pnpm test:smoke:plugin-scripts` | 校验真实插件脚本 staging、依赖闭包和 bundle 布局 |

`release:verify:cli` 包含真实 plugin-scripts staging smoke，以及使用临时本地 bare Git remote 的 `test:smoke:fetch` publish/fetch/provider smoke。该 plugin smoke 固定 packageRoot 的 pnpm 版本，通过隔离 store 视图复用 workspace install 记录的 pnpm 内容，并在移除 `npm_execpath`、PATH 中的 Corepack/pnpm 和 pnpm 在线解析后运行；fetch smoke 不访问真实网络。

普通测试使用 synthetic catalog、隔离 home 和 fake native runner。不得调用用户真实 Codex/Claude 配置，也不得修改仓库外状态。

含 `buildImports` 或 `skillRuntimeFiles.import` 的 synthetic fixture 必须显式构造同一 source set 的 catalog runtime resolver。`plugin:test` 和 eval materialization 通过真实入口验证 resolver 注入；单插件 helper 缺 resolver 的 fail-closed 行为在最低 unit 层验证，不建立 sibling layout fallback。

## Fixture and Assertion Rules

- Unit 使用 synthetic catalog 和 fake native runner。
- Integration 覆盖 CLI 与真实模块桥接，但不访问用户 home。
- 写命令测试只构造 current catalog、live owner 和平台组件 fixture。
- Catalog cache 测试只构造 source、`current` 和 `last-good` fixture，不依赖安装状态 fixture。
- Source mutation 测试验证 config 先提交；之后 refresh 失败只出现在 receipt，不撤销已提交 config。
- Offline cleanup 测试验证 source 缺失时仍能删除可证明属于 AW 的输出。`cleanup --force` 测试还必须证明它只删除专属目标、保留 foreign/shared 内容，并报告 dependent 的 partial 风险。
- TUI unit 和入口测试使用真实 Ink mount；不要用静态组件快照代替交互行为。
- Platform tests 断言 MCP、apps、hooks、permissions、roles、instructions、Skill 和 command 的最终平台输出，不建立独立安装健康数据库。
- JSON 测试同时断言 schema、单一 stdout 对象、stderr 诊断边界和退出码。

## Test Value Gate

每个新增或修改的确定性测试必须先证明它保护可观察风险。测试只允许锁定以下价值之一：

- 生产行为：通过真实公共入口、helper、lifecycle、renderer、validator 或 bundle 路径观察输入、输出、副作用和状态转换。
- 失败边界：验证无效输入、失败传播、恢复、隔离、安全或原子性合同。
- 结构化公开合同：解析并断言对消费者公开的 JSON、manifest、schema、receipt、status、artifact plan 或平台产物。公开兼容范围必须在 package、bundle、catalog 或其它真实发布产物层验证。

以下测试不通过门禁：

- 读取源码、脚本、配置或文档，再用字符串、快照或正则匹配固定文本。
- 锁定内部函数排列、私有调用顺序、局部变量、源文件布局或其它实现细节，但没有可观察风险。
- 仅镜像当前 package、plugin、release 或依赖版本。版本值只能作为验证比较、选择、迁移或拒绝行为的边界 fixture。
- 在多个层级重复同一风险。每个风险只由最低且足够真实的层级负责；跨层测试必须增加新的边界证据。
- 测试文档 prose。文档准确性由评审、链接检查或示例所调用的真实入口验证，不锁定叙述句子。

Skill 和 prompt 的确定性测试只保留结构、模板、平台元数据、关键禁止项和最小安全不变量。需要模型理解、判断、路由、措辞或任务完成质量的语义合同必须交给 eval，不得用 prose 正则或固定句子代替 eval。

只有当静态文本本身是消费者读取的公开合同，而且没有合适的行为测试时，才允许静态断言。例外必须在测试断言旁使用以下精确格式，并填写可观察风险和不适合行为测试的具体原因：

```ts
// Static contract exception: <可观察风险>; behavior test is not suitable because <原因>.
```

方便实现、已有快照或覆盖率不足都不是例外原因。

## Validation Matrix

先运行与改动直接相关的最小测试，再按下表完成交付验证。表中的产品合同只链接[架构说明](architecture.md)，不在本文件重复定义。

| 变更域 | 负责层级 | 交付验证 |
|--------|----------|----------|
| 纯函数、helper、validator、renderer | Unit | 相关定向 unit；交付前 `pnpm test:unit` |
| CLI 入口、write、status、config、TUI | Unit + Integration | 相关定向测试；交付前 `pnpm test:unit`、`pnpm test:integration` 和 `pnpm build` |
| Catalog source cache 或 source mutation | Unit + Smoke | `packages/cli/tests/unit/catalog-providers.test.ts`、`packages/cli/tests/unit/catalog-source-command.test.ts`、`pnpm test:smoke:fetch` |
| Offline cleanup 或 `cleanup --force` 恢复 | Unit + Integration | 对应 ownership/rebuild 定向测试；交付前 `pnpm test:unit`、`pnpm test:integration` |
| 平台输出或 adapter | Unit + Integration | 对应平台 unit/integration；插件产物按[插件维护指南](plugin-maintenance.md)验证 |
| 插件作者合同 | Integration + Plugin test | `pnpm test:integration`、`pnpm plugin:test <plugin>` 和专用作者工作流要求的验证 |
| Build、bundle、staging、Git publisher 或 tarball | Smoke | 对应 build、plugin-scripts、catalog stage/publish 或 CLI pack smoke |
| 公开 JSON 或 schema | Unit + Integration | 对应 schema 测试、CLI JSON harness，并同步架构和消费者文档 |

所有文档或代码改动最后运行 `git diff --check`。

## Build Reuse

`scripts/build/ensure-cli-build.mjs` 只在输入、输出和 package identity 都匹配 generation stamp 时复用 build。并发 build 使用 lock；测试必须覆盖输入变化、输出变化、symlink、并发 owner 和 snapshot 隔离。

Release unit/integration 覆盖 CLI target 更新的 package 同步、local prepared artifacts、attempted marker、启用轴的 `Eval → CLI → CLI tag → Catalog` 顺序和 Catalog-only compatibility。fixture 使用注入的本地 remote 或 registry 命令，不访问真实 official remote 或 npm registry。

一键发布还必须覆盖参数互斥、白名单元数据 commit、所选轴远端隔离、空远端首个 beta 候选、所选轴无候选短路，以及注解 CLI tag 的创建、幂等补发和冲突拒绝。tag integration 使用本地 bare Git remote；不得写真实 `origin`。

| 发布风险 | 最低证据 |
|---|---|
| CLI target 同步两个 public package 与 workspace dependency | prepared release unit |
| beta/release 独立选择 CLI 和 Catalog 候选 | prepared release unit |
| CLI tag 指向 prepared source commit | CLI tag integration |
| npm 成功后 tag 可补发 | release entry unit + CLI tag integration |
| CLI 成功后 Catalog 失败保留部分成功 | release publish smoke |
| Catalog channel 和 immutable tag | Catalog publisher integration + smoke |

常规 unit/integration 不应隐式执行 package manager。真实依赖安装、build 后 production closure 和 tarball 内容进入 smoke。

## Performance Tests

性能测试位于 `packages/cli/tests/perf/`。每个预算必须输出一条具有唯一名称的结构化摘要：

```text
AW_PERF_SUMMARY {"name":"..."}
```

Performance gate 必须校验摘要名称集合。缺少、重复或未知名称都必须让门禁失败。

性能预算使用宽松、跨平台的上限。它们用于发现数量级回退，不用于比较微小波动。source 预算使用确定性的本地 path 和 bare Git fixture，覆盖 `current`/`last-good` 读取、多个 Git/path source fanout、remote deadline 失败和进程清理确认；不依赖公网。失败时先确认机器负载，再检查远程调用次数、重复 catalog 校验和 live component probe 数量。

## Test Isolation

- 使用测试提供的隔离 `AW_HOME`、`AW_CODEX_HOME`、`AW_CLAUDE_HOME` 和 workspace。
- 平台命令使用 fake native runner。
- 需要进程树检查的测试在允许 POSIX/Windows 进程检查的环境运行。
- 测试结束后清理自己的临时目录和 mock。
- 不读取或改写真实 home、全局 native plugin 或真实项目配置。

## Completion Check

- 每个新增或修改的测试都能说明被保护的可观察风险。
- 同一风险由最低且足够真实的测试层负责，没有重复覆盖。
- 测试不读取或修改真实用户环境。
- 公开合同变化已同步架构说明和适用的插件作者 reference。
- 已运行 Validation Matrix 要求的命令和 `git diff --check`。
