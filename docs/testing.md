# Testing Guidelines

本文件面向仓库维护者，负责测试书写、测试层级选择和验证命令。产品行为以[架构说明](architecture.md)为准；单插件作者合同见[插件作者指南](plugin-authoring.md)，Catalog 聚合与发布合同见[Catalog 作者指南](catalog-authoring.md)。

`pnpm test` 使用 package source 和默认 Vitest 多项目配置，只运行 unit 和 integration 测试，不要求预先生成 `dist/`。Performance、dist contract 和 smoke 测试使用独立命令，不包含在 `pnpm test` 中。

默认多项目按资源顺序运行：pure 使用最多 4 workers，filesystem-isolated 和 integration 使用最多 2 workers，process-lifecycle 使用 `forks`、1 worker 且关闭 file parallelism。Performance 和 smoke 各使用 1 worker；performance gate 先完成 process-lifecycle 自测，再运行业务性能预算。

日常开发使用以下三个入口：

- 快速反馈：`pnpm test:unit:fast`，运行 command options、command receipt、hooks contract、platform support 和 template engine 五个稳定文件。
- 修改范围验证：`pnpm --filter @lesliechan721/aw test tests/unit/<file>.test.ts`；将路径替换为本次修改直接影响的 unit 或 integration 文件，必要时再用 `-t <name>` 缩小到用例。
- 交付验证：按下方 Validation Matrix 运行所需的完整命令；默认 unit 和 integration 全量入口是 `pnpm test`。Performance、smoke 和需要 single worker 的锁测试继续使用各自的专用 Vitest 配置。

## Test Layers

| 层 | 命令 | 责任 |
|----|------|------|
| Unit | `pnpm test:unit` | 纯函数、validator、renderer、source state、ownership、status、config 和编排逻辑 |
| Integration | `pnpm test:integration` | CLI 入口、作者工具、写命令和平台 adapter 组合 |
| Performance | `pnpm test:perf` | 独立性能预算；不进入普通 unit |
| Performance gate | `pnpm test:perf:gate` | 预算结果和 fast unit wall-time 门禁 |
| Smoke | 见下方命令表 | 真实 build、stage、pack、fetch 和插件脚本产物 |
| Native qualification | `pnpm qualification:codex-project-native` | 显式验证精确 Codex CLI 的 shared native 与 project activation 行为；不进入普通测试或构建 |
| Native performance qualification | `pnpm qualification:codex-native-performance` | 显式验证精确 Codex CLI 的 scoped list、隔离本地安装和中位数预算；不进入普通测试或构建 |
| Plugin test | `pnpm plugin:test <plugin>` | 插件自己的确定性 Node 测试 |
| Model eval | 见[插件维护指南](plugin-maintenance.md) | 需要模型理解、判断、路由或完成任务的语义合同；不进入普通 CI |

### Coverage and Smoke Commands

| 命令 | 责任 |
|------|------|
| `pnpm test:coverage` | 运行默认 unit/integration 测试并生成覆盖率报告 |
| `pnpm test:dist` | 正式 build 一次，再运行 Eval、Core、CLI authoring 的 dist contract 和 CLI build smoke |
| `pnpm test:smoke` | 运行完整 smoke suite |
| `pnpm test:smoke:build` | 等价于 `pnpm test:dist`；校验正式 build 产物，并证明官方入口使用 `--strict-requirements` 语义 |
| `pnpm test:smoke:pack:cli` | 校验 CLI tarball 内容，并在只暴露 tarball 已声明依赖的隔离视图中运行 bin 和关键 ESM import |
| `pnpm test:smoke:authoring:external` | 从三个已安装 tarball 在全新 Workspace v1 执行 `catalog init → plugin init/validate/test/build → catalog build/validate → path source add → source sync → install source/plugin -p both`，并验证隔离 homes 内的 receipt 和安装结果 |
| `pnpm test:smoke:publish:catalog` | 使用本地 bare remote 校验 catalog staging、Git publish、fetch 和 Git provider 消费 |
| `pnpm test:smoke:publish:release` | 构造 prepared descriptor 并调用 publisher，校验 `Eval → Core → CLI → CLI tag → Catalog`、显式轴和不确定远端失败 |
| `pnpm test:smoke:fetch` | 通过本地 bare Git remote 校验 publish、fetch 和 Git provider 消费；复用 publish catalog smoke |
| `pnpm test:smoke:plugin-scripts` | 校验真实插件脚本 staging、依赖闭包和 bundle 布局 |
| `pnpm test:smoke:ask-me-browser` | 使用 Playwright Chromium 驱动真实 `decision-prototype` Review `start/wait` 会话，校验预览、标注、反馈校验、键盘提交和会话清理 |
| `pnpm test:qualification:codex-project-native:harness` | 使用 fake executable 验证 qualification harness 的解析、隔离、脱敏、精确版本门禁和 schema；不提供 native 支持证据 |
| `pnpm qualification:codex-project-native` | 使用 PATH 中精确 `codex-cli 0.151.0` 运行离线真实 qualification，并输出单个 schema 1 JSON report |
| `pnpm test:qualification:codex-native-performance:harness` | 使用 fake executable 验证三个版本的参数、隔离、缺失 binary 和报告合同；不提供真实性能证据 |
| `pnpm qualification:codex-native-performance` | 使用显式提供的精确 `0.145.0`、`0.151.0` 或 `0.153.0` binary，运行五次本地 native plugin 安装并输出 schema 1 JSON report |

首次运行 browser smoke 前，使用 `pnpm --filter @lesliechan721/aw exec playwright install chromium` 安装与当前 Playwright 版本匹配的 Chromium。browser smoke 属于完整 `pnpm test:smoke`，但不属于 `plugin:test` 或 `release:verify:cli:core`。

`release:verify:cli` 包含真实 plugin-scripts staging smoke，以及使用临时本地 bare Git remote 的 `test:smoke:fetch` publish/fetch/provider smoke。该 plugin smoke 固定 packageRoot 的 pnpm 版本，通过隔离 store 视图复用 workspace install 记录的 pnpm 内容，并在移除 `npm_execpath`、PATH 中的 Corepack/pnpm 和 pnpm 在线解析后运行；fetch smoke 不访问真实网络。

Catalog build 的 unit/integration 必须覆盖第三方公开 `aw catalog build` 的默认 advisory，以及官方 strict scanner 对不匹配 requirement 的阻断。`pnpm test:smoke:build` 必须证明官方 `pnpm build` 使用 `--strict-requirements` 语义；`release:verify:catalog:core` 通过该 build 覆盖此门禁。

普通测试使用 synthetic catalog、隔离 home 和 fake native runner。不得调用用户真实 Codex/Claude 配置，也不得修改仓库外状态。

Codex project native qualification 是显式 suite。它不得由 `pnpm test`、unit、integration、build 或 release 默认链隐式调用。runner 必须覆盖真实用户 home 环境变量，使用自己的临时 Codex home、AW home、项目和本地 marketplace，只执行本地命令，并在成功或失败后清理。报告不得包含真实或临时绝对路径、credential 或 native stderr；退出码反映最低 qualification 合同。报告是一次性兼容性证据，不是 installed ledger。macOS 报告只证明该次 macOS 运行；Windows 必须在 Windows 上独立运行，未运行时保留明确的 evidence gap。

Harness 的确定性测试可以使用 fake executable，但 fake 只验证 runner 本身。native kind 的 `supported` 结果、project activation 和 trust 行为只能来自显式真实 qualification；无法从 `0.151.0` 离线 JSON 或行为证明的 kind 必须报告 `unsupported`。

Native performance qualification 必须通过 `CODEX_QUALIFICATION_VERSION` 选择 `0.145.0`、`0.151.0` 或 `0.153.0`，并通过 `CODEX_QUALIFICATION_CLI` 提供本机已有的精确 binary。runner 不自动下载。每个 sample 使用新的临时 home、项目和 local marketplace。三个版本都验证 marketplace-scoped JSON list；`0.153.0` 还要求该 local list 在阻断 proxy 时成功。代表性 local native install 的五次同机中位数必须低于 15 秒；有可比较旧实现证据时，也可接受改善至少 70%。binary 缺失或版本不精确时必须报告未运行或失败，不能用 fake harness 代替。

含 `buildImports` 或 `skillRuntimeFiles.import` 的 synthetic fixture 必须显式构造同一 source set 的 catalog runtime resolver。`plugin:test` 和 eval materialization 通过真实入口验证 resolver 注入；单插件 helper 缺 resolver 的 fail-closed 行为在最低 unit 层验证，不建立 sibling layout fallback。

## Fixture and Assertion Rules

- Unit 使用 synthetic catalog 和 fake native runner。
- Integration 覆盖 CLI 与真实模块桥接，但不访问用户 home。
- 写命令测试只构造 Active catalog snapshot、live owner 和平台组件 fixture。
- Catalog source 测试只构造 source、state、store 和 snapshot fixture，不依赖安装状态 fixture。
- Source mutation 测试验证 add/update 只提交 config；sync 失败不撤销原 Active；`sync --check` 不写 store 或 Active。
- Offline cleanup 测试验证 source 缺失时仍能删除可证明属于 AW 的输出。`cleanup --force` 测试还必须证明它只删除专属目标、保留 foreign/shared 内容，并报告 dependent 的 partial 风险。
- TUI unit 和入口测试使用真实 Ink mount；不要用静态组件快照代替交互行为。
- Platform tests 断言 MCP、apps、hooks、permissions、roles、instructions、Skill 和 command 的最终平台输出，不建立独立安装健康数据库。
- JSON 测试同时断言 schema、单一 stdout 对象、stderr 诊断边界和退出码。
- Eval case 声明 `workspace_valid: true` 时，contract test 必须 materialize `workspace_files`，通过公开 `aw catalog status --json` 验证 marker、metadata、inventory、依赖图和 snapshot evidence，并对预期有效插件运行 `aw plugin validate --json`。Prose 标记不能代替该 fixture validation。
- Conversation Eval 的 `environment.pathPrepend` 只能引用相对 suite/case Eval 根的已存在 fixture。Runner 测试必须证明路径不能逃逸或包含符号链接、只有已声明 fixture 被复制和设为 executable，且 PATH 不引用仓库私有 CLI。确定性 contract test 不运行模型 Eval，也不审核 Oracle。

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
| Catalog source state 或 source mutation | Unit + Smoke | `packages/cli/tests/unit/catalog-providers.test.ts`、`packages/cli/tests/unit/catalog-source-command.test.ts`、`pnpm test:smoke:fetch` |
| Offline cleanup 或 `cleanup --force` 恢复 | Unit + Integration | 对应 ownership/rebuild 定向测试；交付前 `pnpm test:unit`、`pnpm test:integration` |
| 平台输出或 adapter | Unit + Integration | 对应平台 unit/integration；插件产物按[插件维护指南](plugin-maintenance.md)验证 |
| 插件作者合同 | Integration + Plugin test | `pnpm test:integration`、`pnpm plugin:test <plugin>` 和专用作者工作流要求的验证 |
| Catalog 作者与 Publisher 合同 | Plugin test + Smoke | `pnpm plugin:test aw-catalog-development`、Catalog build/publish smoke 和 [Catalog 作者指南](catalog-authoring.md)要求的隔离验证；删除分支的 Agent-facing command/return boundary 与 empty inventory 指令只在已安装 Skill 的静态合同测试中覆盖，CLI 删除行为由 integration 覆盖 |
| Eval schema、fixture environment 或 conversation runner | Unit + Plugin test | 定向 Eval contract/runner unit、`workspace_valid` fixture validation 和相关 `pnpm plugin:test`；不运行昂贵 model Eval |
| 第三方作者公开闭环与 tarball dependency closure | Smoke | `pnpm test:smoke:authoring:external`；它不得通过 monorepo cwd、`NODE_PATH` 或 workspace symlink 取得依赖 |
| Build、bundle、staging、Git publisher 或 tarball | Smoke | 对应 build、plugin-scripts、catalog stage/publish 或 CLI pack smoke |
| 公开 JSON 或 schema | Unit + Integration | 对应 schema 测试、CLI JSON harness，并同步架构和消费者文档 |
| Codex shared native/project activation qualification | 独立 qualification | `pnpm test:qualification:codex-project-native:harness`，并在支持的本机运行 `pnpm qualification:codex-project-native`；Windows 未实跑时必须报告证据缺口 |
| Codex native 性能与版本合同 | Unit + Integration + 独立 qualification | Codex observation/native CLI 定向 unit、grouped write 与 Git batch integration、`pnpm test:qualification:codex-native-performance:harness`；有精确 binary 时分别运行三个版本的 `pnpm qualification:codex-native-performance`，缺失版本必须报告证据缺口 |

所有文档或代码改动最后运行 `git diff --check`。

## Build Reuse

`scripts/build/ensure-build.mjs` 只在输入、输出和 package identity 都匹配 generation stamp 时复用 build。并发 build 使用 lock；测试必须覆盖输入变化、输出变化、symlink、并发 owner 和 snapshot 隔离。

Release unit/integration 覆盖 schema 2 CLI target 更新的 package 同步、Catalog exact version mutation、local prepared artifacts、CLI attempted marker、Catalog publication journal、启用轴的 `Eval → Core → CLI → CLI tag → Catalog` 顺序，以及 Catalog-only 不访问 npm/CLI tag 的边界。fixture 使用注入的本地 remote 或 registry 命令，不访问真实 official remote 或 npm registry。

一键发布还必须覆盖参数互斥、白名单元数据 commit、所选轴远端隔离、空远端首个 beta 候选、所选轴无候选短路，以及注解 CLI tag 的创建、幂等补发和冲突拒绝。tag integration 使用本地 bare Git remote；不得写真实 `origin`。

Catalog publisher 测试必须覆盖 plan 的授权身份、`apply --expected-plan-digest --yes`、journal 的 `prepared|uncertain|published`、相同 journal plan 的对账或续跑、不同 plan 的 version 提升，以及 branch/tag 都存在、都缺失、只缺一个和冲突。对于 `prepared` 或 `uncertain`，journal 或隔离 repo 缺失或损坏时必须停止并提升版本；`published` journal 缺失时 immutable tag 仍占用版本。首次写入前 fixture 保留隔离 repo；成功 fixture 只保留 JSON journal。测试使用本地 bare remote，不访问真实网络。

| 发布风险 | 最低证据 |
|---|---|
| CLI target 同步两个 public package 与 workspace dependency | prepared release unit |
| beta/release 独立选择 CLI target 和 Catalog metadata beta | prepared release unit |
| CLI tag 指向 prepared source commit | CLI tag integration |
| npm 成功后 tag 可补发 | release entry unit + CLI tag integration |
| CLI 成功后 Catalog 失败保留部分成功 | release publish smoke |
| Catalog plan、journal、channel 和 immutable tag | Catalog publisher integration + smoke |

常规 unit/integration 不应隐式执行 package manager。真实依赖安装、build 后 production closure 和 tarball 内容进入 smoke。

## Performance Tests

性能测试位于 `packages/cli/tests/perf/`。每个预算必须输出一条具有唯一名称的结构化摘要：

```text
AW_PERF_SUMMARY {"name":"..."}
```

Performance gate 必须校验摘要名称集合。缺少、重复或未知名称都必须让门禁失败。

性能预算使用宽松、跨平台的上限。它们用于发现数量级回退，不用于比较微小波动。source 预算使用确定性的本地 path 和 bare Git fixture，覆盖至少两个 Git source 与一个 Path source、large Catalog、Active store 读取、`sync --check`、sync、remote deadline 失败和进程清理确认；不依赖公网。TUI/Review 与公开 install/write 预算使用隔离 home 和受控 fake native runner，并通过结构化阶段事件验证单份 state snapshot、Active validation、依赖 collision 传播和 dependency plan。普通 warm 路径 provider 调用必须为零，本地 Catalog 阶段 p95 上限为 500ms；命令总时长只使用宽松的测试 runner 门槛，不代表第三方 native CLI 保证。失败时先确认机器负载，再检查远程调用次数、重复 catalog 校验和 live component probe 数量。

Codex 优化的主要门禁是确定性计数，不是 500ms fake runner 断言。最低层测试分别验证：成功 native CLI 的 process-table observation/scan 为 0；20 个同 marketplace target 的 project/all-scope list 不超过 2；user-only generation 不超过 1；所有 Codex list 都是 `plugin list --marketplace <name> --json`；锁内 no-op 不超过 2，真实 mutation 的 pre/post 合计不超过 4，含 Preview 的完整 TUI project mutation 不超过 6；root 和五个同源依赖只建立并提交一个 marketplace generation；plugin validate 使用一个 `cat-file --batch`，Git 总进程不超过 5。已有 timeout、abort 和进程树清理测试负责失败路径，不在 performance suite 重复。wall-clock 只保留线性时间回退、宽松 runner deadline 和显式真实 qualification 证据。

## Test Isolation

- 使用测试提供的隔离 `AW_HOME`、`AW_CODEX_HOME`、`AW_CLAUDE_HOME` 和 workspace。
- 三个 package 的 Vitest 入口由统一进程树 wrapper 运行。正常结束、`SIGINT` 和 `SIGTERM` 会清理本次 wrapper 通过 PID 与 start identity 证实的进程树；清理期间再次收到中断信号时立即升级强制清理。只有确认清理成功时才返回标准信号退出码，清理无法验证时必须报告错误并以 `1` 退出。wrapper 自身被 `SIGKILL`、宿主崩溃或断电时不承诺清理。
- 合成长驻 detached 测试子进程必须设置有界的自退出时限，防止测试宿主被强制终止后永久遗留；行为断言仍必须证明正常路径会在更短的既定期限内主动清理。
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
