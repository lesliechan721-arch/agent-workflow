# 测试夹具环境隔离 Spec

日期：2026-05-20
状态：需求确认稿
文档规范：`docs/dev/spec-plan-writing-guide.md`

## 文档定位

这份 Spec 只定义测试夹具环境隔离的需求边界、现状探查结论、测试作者体验、测试层公开合同和验收标准，不写实现计划、阶段拆分、文件改动清单或测试清单。

本需求只收紧测试层默认行为，不改变 `aw` 生产运行时对真实用户环境的默认解析规则。

## 背景

当前测试经常依赖用例自己传入 `env`、`cwd`、fake runner 和临时目录。只要某个测试漏传，CLI 的生产默认值就可能回退到真实 `process.env`、`os.homedir()`、`process.cwd()` 或真实 native CLI，进而写入本机 `~/.aw`、`~/.codex`、`~/.claude`、真实 npm 配置、当前仓库 project scope 状态，甚至调用本机 `codex` / `claude` 命令。

本轮目标是把测试默认值改成安全值：测试写法出错时，要么写到测试临时根目录，要么尽早失败，不能碰真实本机插件数据或真实 native CLI。

## 现状探查结论

这一节只记录影响需求边界的事实，不描述实现步骤。

### 路径解析会回退到真实家目录

- `packages/cli/src/utils/paths.ts` 中 `getClaudeHome()`、`getCodexHome()` 和 `resolveAwHome()` 在缺少 `AW_CLAUDE_HOME`、`AW_CODEX_HOME`、`AW_HOME` 时会回退到 `os.homedir()`。
- `resolveClaudePaths()`、`resolveCodexPaths()` 和 catalog cache 相关路径都会继续使用这些 home 解析结果。
- `packages/cli/src/utils/marketplace.ts` 中 npm user config 解析会走 `env.HOME || env.USERPROFILE || os.homedir()`，缺少隔离环境时可能读取真实 `~/.npmrc`。
- `packages/cli/src/commands/runtime.ts` 中 debug log 默认路径会按命令落到 `resolveAwHome(env)/logs` 或系统临时目录；开启 `AW_DEBUG` 时，漏传隔离 env 也可能把日志写到真实 AW home。
- 当前代码还存在多处 `os.tmpdir()` 派生写路径，例如 status debug log、uninstall rollback 临时目录、artifact refresh staging 和 Codex native cache 备份。只隔离 home 不足以覆盖这些写入。

### CLI 上下文默认使用真实进程状态

- `createCommandExecutionContext()` 默认使用 `input.env ?? process.env`，默认 native runner 是 `execFileNativeCliRunner`。
- `createCliExecutionContext()` 默认使用 `input.cwd ?? process.cwd()`、`input.env ?? process.env`、真实 stdin/stdout/stderr。
- `runCli()` 和 `buildProgram()` 会继续把这些默认值传入命令上下文。
- `tests/helpers/cli-entry.ts` 当前只负责捕获 stdout/stderr，不会默认注入安全 env、fixture cwd、安全 native runner 或 app-server runner。
- `process.cwd()` fallback 不只出现在 CLI 入口层；catalog memo key、npm local prefix/project `.npmrc` 解析、install record 元数据写回和 shared runtime owner 解析也会直接读取当前进程 cwd。

### Smoke 测试没有统一 setup

- `packages/cli/vitest.config.ts` 只给 unit/integration 挂了 `tests/setup/no-network-catalog.ts`。
- `tests/setup/no-network-catalog.ts` 只清理 catalog source override、catalog memo，并 stub 全局 `fetch`，没有隔离 HOME、AW home、XDG、npm userconfig、cwd 或 native runner。
- `packages/cli/vitest.smoke.config.ts` 当前没有 setupFiles，因此 smoke 测试不受现有网络 stub 保护，也没有统一环境隔离入口。
- Smoke 测试里存在直接 import `packages/cli/dist/**` 的链路，dist 模块图里的 catalog memo 和 source override 与 source 模块图相互独立，不能只靠 source setup 清理。

### Native CLI 与 app-server 仍可能调用真实命令

- `packages/cli/src/utils/native-cli.ts` 的默认 runner 会通过 `execFile()` 执行真实命令。
- Codex adapter 会调用 `codex plugin marketplace add <AW_HOME>`；Claude adapter 会调用 `claude plugin marketplace add/install/uninstall`。
- Codex app-server 路径使用单独的 process runner，默认会 `spawn('codex', ['app-server'])`。只隔离 `AW_CODEX_HOME` 不能保证真实 Codex CLI 不读取或写入其它本机状态。
- 现有 `tests/helpers/fake-codex-app-server.ts` 能作为 fake harness，但它不是全局默认，也不能覆盖所有 native CLI 调用。

### 测试里已有大量分散隔离写法

- 多个测试文件直接修改 `process.env`，再在 `afterEach` 手动恢复。
- 多个测试文件直接调用 `runCli()`、`runCliEntry()`、`createCommandExecutionContext()` 或 `createCliExecutionContext()`，入口覆盖面分散。
- 很多测试用 `fs.mkdtemp(path.join(os.tmpdir(), ...))` 自建临时目录；这些目录不一定属于同一个 worker root。
- `setEmbeddedPluginsRootOverrideForTests()`、catalog package source override、catalog resolution memo 等模块级状态依赖测试文件自己 reset。当前 setup 只覆盖一部分 catalog 状态。
- `tests/helpers/repo-managed-state.ts` 的 zero-write snapshot 是事后检测，可以保留，但不能作为第一道防线。

## 核对结论

前期调研提出的三层方案方向正确，但需求边界需要比原稿更严格：

- 全局测试 HOME 隔离必须覆盖 unit、integration 和 smoke，而不是只覆盖当前 `vitest.config.ts`。
- 隔离变量不能只包含 `AW_HOME / AW_CODEX_HOME / AW_CLAUDE_HOME / HOME`，还要覆盖 `USERPROFILE`、`XDG_CONFIG_HOME`、`XDG_CACHE_HOME`、`XDG_STATE_HOME`、npm userconfig、`TMPDIR`、`TEMP`、`TMP`、debug log 可写根和 `os.tmpdir()` 派生写路径。
- safe CLI helper 不能只包 `runCliEntry()`；常见的 `runCli()`、command context、CLI context 和 Codex app-server runner 都要有测试层安全入口。
- 默认禁止真实 native CLI 要同时覆盖 `codex`、`claude` 这类 native runner 调用和 `codex app-server` process runner。
- 路径 fence 第一版应支持注册额外根目录，但必须区分只读 fixture 根和可写状态根，避免读取 repo/dist 产物时顺手放开写权限。
- 测试基础 setup 必须全局接管 `process.cwd()`：每个用例默认切到安全 fixture cwd，并在用例结束后恢复。漏传 `cwd` 时，深层 fallback 也不能看到真实仓库 cwd。
- 模块级测试全局状态要纳入统一清理合同，不能继续完全依赖每个测试文件手动 reset；smoke 里的 dist 模块图也要受同等清理合同约束。

## 目标、范围与非目标

### 目标

1. Unit、integration 和 smoke 测试默认运行在测试专用 home/config/cache/state/temp/cwd 根目录下。
2. 测试中缺少显式 env 时，`HOME`、`USERPROFILE`、`AW_HOME`、`AW_CODEX_HOME`、`AW_CLAUDE_HOME`、XDG 目录、npm userconfig、`TMPDIR`、`TEMP`、`TMP` 和 debug log 都落在测试安全根内。
3. 测试基础 setup 默认把 `process.cwd()` 切到测试 fixture cwd；写入型 CLI 测试缺少显式 cwd 时，不得回退到真实仓库 cwd。
4. 测试夹具能在命令写入前验证关键路径 fence，阻断真实家目录、真实 AW/Codex/Claude home、真实 npmrc、未登记临时目录和未登记 project cwd。
5. 测试 helper 默认禁止真实 `codex`、`claude` native CLI 和真实 `codex app-server`。
6. 确实要验证 native 行为的测试必须显式注入 fake native runner 或 fake app-server harness。
7. 测试可以分别注册只读 fixture 根和可写状态根，兼容现有自建 temp root、fixture repo 和 repo/dist 读取场景。
8. 模块级测试全局状态有统一清理合同，至少覆盖 embedded plugins root override、catalog package source override、catalog resolution memo、fetch stub、env overlay、cwd overlay、native runner guard，以及 smoke 通过 `packages/cli/dist/**` import 的 dist 模块图。
9. 现有 zero-write snapshot 保留为事后检测，但路径 fence 和 safe runner 必须先于写入或 native 调用失败。
10. 新夹具应让测试作者少传参数也安全，而不是要求每个测试记住完整 env/cwd/native runner 组合。

### 范围

- `packages/cli` 的 unit、integration 和 smoke Vitest 运行环境。
- CLI 测试 helper、command context helper、CLI entry helper、native runner fake/guard 和 Codex app-server fake/guard。
- 测试专用 env、cwd、home、XDG、npm userconfig、debug log、`TMPDIR`、`TEMP`、`TMP`、`os.tmpdir()` 派生 staging/rollback 根和路径 fence。
- 测试中使用的 embedded catalog / plugins root override、catalog source override、fetch stub 等模块级全局状态，包括 smoke 直接 import 的 dist 模块图。
- 现有 repo-managed zero-write snapshot 与新 fence 的职责边界。
- 现有测试指南 `docs/testing.md` 中关于测试夹具、默认隔离环境、safe CLI/helper、native runner guard、app-server guard 和 zero-write snapshot 职责边界的说明。

### 非目标

- 不改变生产代码在真实用户环境下的默认路径解析、native CLI 调用或 app-server 调用语义。
- 不要求所有测试第一轮迁移到单一 worker root；已存在的自建 temp root 可以按用途注册为只读 fixture 根或可写状态根继续使用。
- 不把 zero-write snapshot 删除或替换成唯一保护机制。
- 不要求本 Spec 定义实现阶段、迁移批次、具体测试文件清单或重构顺序。
- 不在本轮引入外部沙箱、容器或虚拟机。
- 不要求测试默认禁止读取仓库源码、构建产物或 fixtures；本需求约束的是会代表用户环境写入或调用 native CLI 的路径和进程边界。
- 不把 smoke 显式执行 build/pack 产生的仓库构建输出视为用户状态写入；但这些输出路径不能因此自动成为用户状态可写根。

## 已确认决策

- 隔离强度采用严格模式：HOME、AW home、XDG、npm userconfig、debug log、`TMPDIR`、`TEMP`、`TMP`、cwd、native runner 和 app-server runner 都纳入测试安全边界。
- 路径 fence 第一版支持注册额外根目录，但根目录类型必须拆成只读 fixture 根和可写状态根，不强制所有临时目录立即收敛到同一个 worker root。
- 模块级测试全局状态必须收敛到统一 fixture 或 setup 清理合同，不能只靠测试文件各自手动 reset；source 模块图和 smoke dist 模块图都要覆盖。
- 测试基础 setup 全局接管 cwd；每个用例默认切到安全 fixture cwd，并在用例结束后恢复，避免深层 `process.cwd()` fallback 看到真实仓库。
- 本需求只落 Spec，不把执行顺序和文件改动计划写进本文件。

## 术语与状态模型

### 测试安全根

测试安全根是 Vitest worker 或测试 fixture 分配的临时根目录。测试运行期间，代表用户环境的 home、config、cache、state、npmrc、debug log、temp、AW home、Codex home、Claude home 和默认 fixture cwd 都必须位于测试安全根或已注册可写状态根内。

### 已注册可写状态根

已注册可写状态根是测试显式声明允许写入的额外临时目录，通常来自 `fs.mkdtemp(path.join(os.tmpdir(), ...))` 创建的 fixture repo 或测试状态目录。

注册只表示测试夹具允许 `aw` 在该目录下写入测试状态，例如 project cwd、AW home、platform home、debug log、rollback/staging 临时目录或其它用户状态模拟路径。不表示可以绕过 native runner guard，也不表示该目录下的所有行为都自动正确。

### 已注册只读 fixture 根

已注册只读 fixture 根是测试显式声明允许读取的输入根目录，例如仓库内 fixtures、embedded plugins root、catalog source、build/dist 产物或只读测试资产。

只读 fixture 根不自动获得写权限。若同一目录既要作为输入读取，又要承接用户状态写入，测试必须同时把它注册为可写状态根；否则路径 fence 应阻断写入。

### 路径 fence

路径 fence 是测试层的前置校验。它在 CLI 写入、debug log 创建、catalog cache 写入、native state 写入或 app-server/native runner 调用前，验证相关写路径都位于测试安全根或已注册可写状态根内。

路径 fence 必须 fail early。发现真实家目录、真实 `.aw`、真实 `.codex`、真实 `.claude`、真实 `.npmrc`、未登记 temp root、未登记 project cwd，或尝试写入仅注册为只读 fixture 的目录时，测试应立即失败，并给出能定位缺失 env/cwd/root 注册的错误。

### Safe CLI 入口

Safe CLI 入口是测试层调用 CLI 的默认方式。它负责提供安全 env、安全 cwd、捕获 IO、禁用真实 native CLI、禁用真实 app-server，并在必要时执行路径 fence。

Safe CLI 入口不改变生产 `runCli()` 的公开行为；它只服务测试。

### Native runner guard

Native runner guard 是测试默认 runner。它遇到 `codex`、`claude` 或其它会调用本机 agent CLI 的命令时直接失败，错误信息必须提示测试显式注入 fake runner。

### App-server guard

App-server guard 是测试默认 Codex app-server process runner。它遇到真实 `codex app-server` 启动请求时直接失败，错误信息必须提示测试使用 fake app-server harness。

### 零写入快照

零写入快照是事后检测机制。它用于确认某条命令没有改动指定路径，但不能替代 env/cwd/path fence 或 native runner guard。

## 测试作者体验需求

### 默认安全

测试作者调用推荐的 safe CLI/helper 时，不需要手动传完整 env、cwd、AW home、XDG、npmrc、debug log 路径、temp 路径和 native runner。缺省值必须全部指向测试安全根。

如果测试作者需要独立 fixture repo 或自建 temp root，应通过共享 helper 创建或注册该根目录。承接 cwd 或用户状态写入时注册为可写状态根；只作为 embedded root、catalog source、repo fixture、build/dist 输入或测试资产读取时注册为只读 fixture 根。只有确实需要读写同一目录时，才同时注册两种权限。

### 失败要早且可读

当测试漏传 env、cwd 或 root 注册时，失败信息必须指出：

- 哪个路径不在测试安全根或已注册可写状态根内，或哪个写路径只注册成了只读 fixture 根。
- 该路径来自哪个环境变量、cwd、debug log、native invocation 或 fixture 参数。
- 应使用哪个测试 helper、fake runner 或安全根注册入口修正。

失败不能等到真实文件写入后才由 snapshot diff 暴露。

### Fake 行为显式 opt-in

测试需要覆盖 Codex/Claude native 行为时，必须显式传入 fake native runner，并在断言里检查 runner 收到的命令、args、cwd 和 env。

测试需要覆盖 Codex app-server 行为时，必须显式使用 fake app-server harness。只设置 `AW_CODEX_HOME` 或清空 `PATH` 不算足够隔离。

### 全局状态自动收尾

每个测试用例之间，测试夹具必须恢复或清理会跨用例泄漏的模块级状态。测试作者不应为了常规用例反复手写 `setEmbeddedPluginsRootOverrideForTests(null)`、catalog source reset、fetch reset、env restore 或 `process.chdir()` restore。

如果某个测试确实需要临时覆盖全局状态，应通过共享 helper 设置，并由 helper 或 setup 保证 afterEach 清理。Smoke 测试通过 `packages/cli/dist/**` import 的 dist 模块图，也必须清理同等的 override、memo、env/cwd overlay 和 fetch/native guard 状态。

## 公开合同和命令边界

### Vitest 环境合同

- Unit、integration 和 smoke 测试都必须加载同一组基础隔离 setup。
- 基础 setup 必须在测试开始前创建测试安全根，并设置安全的 HOME、USERPROFILE、AW home、XDG、npm userconfig、debug log 根、`TMPDIR`、`TEMP`、`TMP` 和 temp root 语义。
- 基础 setup 必须在每个测试用例开始前把 `process.cwd()` 切到安全 fixture cwd，并在用例结束后恢复原 cwd。需要临时切换 cwd 的测试必须通过共享 helper 执行，由 helper 负责恢复。
- 基础 setup 必须保留当前禁网络 catalog 的默认保护：未显式 stub 的 `fetch` 继续失败。
- 基础 setup 必须同时清理 source 模块图和 smoke dist 模块图中的 catalog source override、catalog memo、fetch stub、env overlay、cwd overlay、native runner guard 和 app-server guard。若 dist 模块图只能通过动态 import 访问，允许 smoke setup 使用动态 import bridge 清理。
- Smoke 测试可以读取真实 build/pack 产物，但这些路径应注册为只读 fixture 根；代表用户状态的写入路径仍必须位于测试安全根或已注册可写状态根内。

### Env 合同

测试默认 env 至少必须包含：

- `HOME`
- `USERPROFILE`
- `AW_HOME`
- `AW_CODEX_HOME`
- `AW_CLAUDE_HOME`
- `XDG_CONFIG_HOME`
- `XDG_CACHE_HOME`
- `XDG_STATE_HOME`
- npm userconfig 对应变量
- `TMPDIR`
- `TEMP`
- `TMP`

这些路径必须位于测试安全根或已注册可写状态根内。测试显式覆盖这些变量时，也必须通过 fence。

`os.tmpdir()` 派生写路径也属于 temp 合同。测试环境必须让当前平台的 `os.tmpdir()` 解析到测试 temp 根，并在写入前通过 fence 验证 status debug log、rollback staging、artifact refresh staging、native cache backup 等临时写路径位于测试安全根或已注册可写状态根内。

### Cwd 合同

写入型 CLI 测试的 cwd 必须是测试安全根或已注册可写状态根下的 fixture repo。基础 setup 默认切入安全 fixture cwd；safe CLI 入口和底层 command/CLI context 在缺少 cwd 时，都不得回退到真实仓库 cwd 执行写入型命令。

只读型测试如果确实需要使用真实仓库 cwd，必须通过共享 helper 临时切换，并把真实仓库 cwd 视为只读 fixture 根。该测试必须保证不会触发 project scope 写入，并且不应绕过 native runner guard；用例结束后必须恢复安全 cwd。

### Native 与 app-server 合同

测试默认 native runner 不执行真实进程。任何 `codex` 或 `claude` native CLI invocation 都必须失败，除非测试显式注入 fake runner。

测试默认 app-server runner 不启动真实 `codex app-server`。任何 app-server 操作都必须通过 fake harness 或显式 fake runner。

### 路径 fence 合同

路径 fence 必须覆盖下列路径来源：

- AW home、Codex home、Claude home。
- npm userconfig 和 HOME/USERPROFILE 回退路径。
- XDG config/cache/state。
- `TMPDIR`、`TEMP`、`TMP`、`os.tmpdir()` 派生 temp 根、debug log 文件路径、rollback/staging 临时目录。
- catalog cache 和 staging。
- Codex/Claude native config、plugin cache、marketplace/cache 路径。
- project scope cwd、`.codex`、`.claude`、`.agent-workflows` 和 `.agents` 写入路径。
- embedded plugins root override、测试 catalog source、repo fixture 和 build/dist 输入路径必须作为只读 fixture 根处理；只有同时注册为可写状态根时，才允许写入。

Fence 不能只用字符串前缀粗略判断。它必须按规范化后的绝对路径判断父子关系，并区分读权限和写权限，避免相似路径名前缀误判或把只读 fixture 误放成可写根。

### Zero-write snapshot 合同

Zero-write snapshot 继续用于验证“某条命令不应写任何状态”。它的职责是补充检测，不是第一道防线。

当 fence 或 native guard 已经失败时，不需要再依赖 snapshot diff 证明没有写入真实环境。

### 测试文档合同

落地本需求时，必须同步更新 `docs/testing.md`。更新内容应面向测试作者说明新的默认隔离行为、推荐 safe CLI/helper 入口、只读 fixture 根和可写状态根注册方式、全局 cwd 接管、fake native runner / fake app-server harness 的使用边界，以及 zero-write snapshot 只作事后补充检测的职责。

`docs/testing.md` 不能继续把手写 `process.env` 恢复、手写 `process.chdir()` 恢复、直接回退真实 `process.cwd()`、依赖真实 `codex` / `claude` 可执行文件，或用 zero-write snapshot 代替 env/cwd/temp/path fence 描述为常规推荐写法。

## 验收标准

1. Unit、integration 和 smoke 测试都加载统一隔离 setup；smoke 不再缺失基础 setup。
2. 任一测试在未显式传 env 的情况下调用 safe CLI/helper，`HOME`、`USERPROFILE`、`AW_HOME`、`AW_CODEX_HOME`、`AW_CLAUDE_HOME`、XDG 目录、npm userconfig、`TMPDIR`、`TEMP`、`TMP` 和 debug log 都落在测试安全根内。
3. 任一测试用例开始时，`process.cwd()` 已切到安全 fixture cwd；任一写入型测试在未显式传 cwd 的情况下调用 safe CLI/helper 或触发深层 `process.cwd()` fallback，都不会使用真实仓库 cwd 写 project scope 状态。
4. 测试显式传入真实家目录、真实 `.aw`、真实 `.codex`、真实 `.claude`、真实 `.npmrc`、真实 temp root 或未登记 cwd 时，路径 fence 在写入前失败。
5. `os.tmpdir()`、status debug log、uninstall rollback staging、artifact refresh staging 和 native cache backup 等 temp 派生写路径都落在测试安全根或已注册可写状态根内。
6. 测试显式创建的 temp root 注册为可写状态根后可以通过写路径 fence；未注册时不能作为用户状态写入根静默通过。
7. 只读 fixture 根可以用于 embedded root、catalog source、repo fixture 和 build/dist 输入，但不能因为被注册为只读根就获得写权限；需要读写同一目录时必须同时注册为可写状态根。
8. 默认测试 native runner 遇到 `codex` 或 `claude` 命令会失败，并提示注入 fake runner。
9. 默认测试 app-server runner 遇到真实 `codex app-server` 会失败，并提示使用 fake app-server harness。
10. 需要验证 native CLI 参数的测试可以通过 fake runner 完成断言，不需要真实 `codex` 或 `claude` 安装。
11. 需要验证 Codex app-server 协议的测试可以通过 fake app-server harness 完成断言，不启动真实 app-server。
12. `setEmbeddedPluginsRootOverrideForTests()`、catalog source override、catalog memo、fetch stub、env overlay、cwd overlay、native runner guard 和 app-server guard 等跨用例状态由统一 setup/helper 清理；常规测试不需要手写清理才能保持隔离。测试临时注入 fake native runner 或 fake app-server harness 后，下一条未注入 fake 的用例必须重新看到默认 guard。Smoke 中通过 `packages/cli/dist/**` import 的 dist 模块图也必须满足同一恢复合同。
13. Unit、integration 和 smoke 中未显式 stub 的 `fetch` 都继续失败；隔离 setup 不得削弱禁网络 catalog 的默认保护。
14. Fence 错误必须包含不安全路径、路径来源和推荐修复入口；不能只给出泛化失败。
15. Fence 必须通过规范化绝对路径判断父子关系，并用相似前缀路径覆盖误判风险。
16. 只读测试临时使用真实仓库 cwd 时，必须通过共享 helper 表达只读意图、恢复安全 cwd，并验证不会触发 project scope 写入。
17. 现有 zero-write snapshot 仍可用于无写入命令断言，但漏传 env/cwd/native runner 的错误优先由 fence 或 guard 暴露。
18. 新增或迁移后的 CLI 测试入口默认安全；测试作者少传参数时，最多污染测试临时目录，或收到明确失败，不会触碰真实本机插件数据。
19. 生产 CLI 在非测试运行时下的默认路径解析和 native CLI 行为保持不变。
20. `docs/testing.md` 已同步说明新的测试夹具隔离合同，并移除或改写与该合同冲突的旧推荐写法。
