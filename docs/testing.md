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
| Smoke | 见下方命令表 | 真实 build、pack、fetch 和插件脚本产物 |
| Plugin test | `pnpm plugin:test <plugin>` | 插件自己的确定性 Node 测试 |
| Model eval | 见[插件维护指南](plugin-maintenance.md) | 需要模型理解、判断、路由或完成任务的语义合同；不进入普通 CI |

### Coverage and Smoke Commands

| 命令 | 责任 |
|------|------|
| `pnpm test:coverage` | 运行默认 unit/integration 测试并生成覆盖率报告 |
| `pnpm test:smoke` | 运行完整 smoke suite |
| `pnpm test:smoke:build` | 校验 `pnpm build` 产物 |
| `pnpm test:smoke:pack:cli` | 校验 CLI tarball 内容 |
| `pnpm test:smoke:pack:catalog` | 校验 sidecar/full catalog tarball 内容 |
| `pnpm test:smoke:pack` | 串行校验 CLI 与 catalog tarball |
| `pnpm test:smoke:fetch` | 校验 catalog fetch、选择、cache 复用和兼容性失败边界 |
| `pnpm test:smoke:plugin-scripts` | 校验真实插件脚本 staging、依赖闭包和 bundle 布局 |

普通测试使用 synthetic catalog、隔离 home 和 fake native runner。不得调用用户真实 Codex/Claude 配置，也不得修改仓库外状态。

## Fixture and Assertion Rules

- Unit 使用 synthetic catalog 和 fake native runner。
- Integration 覆盖 CLI 与真实模块桥接，但不访问用户 home。
- 写命令测试只构造 current catalog、live owner 和平台组件 fixture。
- Strict cache 测试只构造 cache、selector、lock 和 marketplace fixture，不依赖安装状态 fixture。
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
| Strict catalog cache 或 selector | Unit + Performance + Smoke | `packages/cli/tests/unit/local-marketplace.test.ts`、`pnpm test:perf:gate`、`pnpm test:smoke:fetch` |
| 平台输出或 adapter | Unit + Integration | 对应平台 unit/integration；插件产物按[插件维护指南](plugin-maintenance.md)验证 |
| 插件作者合同 | Integration + Plugin test | `pnpm test:integration`、`pnpm plugin:test <plugin>` 和专用作者工作流要求的验证 |
| Build、bundle 或 tarball | Smoke | 对应 build、plugin-scripts、CLI pack 或 catalog pack smoke |
| 公开 JSON 或 schema | Unit + Integration | 对应 schema 测试、CLI JSON harness，并同步架构和消费者文档 |

所有文档或代码改动最后运行 `git diff --check`。

## Build Reuse

`scripts/build/ensure-cli-build.mjs` 只在输入、输出和 package identity 都匹配 generation stamp 时复用 build。并发 build 使用 lock；测试必须覆盖输入变化、输出变化、symlink、并发 owner 和 snapshot 隔离。

常规 unit/integration 不应隐式执行 package manager。真实依赖安装、build 后 production closure 和 tarball 内容进入 smoke。

## Performance Tests

性能测试位于 `packages/cli/tests/perf/`。每个预算必须输出一条具有唯一名称的结构化摘要：

```text
AW_PERF_SUMMARY {"name":"..."}
```

Performance gate 必须校验摘要名称集合。缺少、重复或未知名称都必须让门禁失败。

性能预算使用宽松、跨平台的上限。它们用于发现数量级回退，不用于比较微小波动。失败时先确认机器负载，再检查远程调用次数、重复 catalog 校验、cache publication 和 live component probe 数量。

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
