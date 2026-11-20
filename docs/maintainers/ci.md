# 持续集成（CI）规范

本文件面向仓库维护者，定义官方 GitHub Actions 持续集成管线的职责、触发机制、矩阵配置、Windows 与 macOS 测试分片规则、自动 Beta 验证复用与产物验证边界。本地测试执行参见 [测试指南](testing.md)，发版流水线参见 [官方发布与失败恢复指南](release.md)。

---

## 1. CI 职责与触发条件

官方 CI 管线分为日常集成验证与发布候选验证两类：

1. **Pull Request 与 main 分支集成（`ci.yml`）**：
   - **触发条件**：对 `main` 分支提交 PR，或向 `main` 分支推送。
   - **职责**：运行代码风格检查（Lint）、类型检查（TypeScript 类型检查包含在 `pnpm build` 中）、单元测试、集成测试、Check-only 源码类型合同测试、Dist 契约测试（`pnpm test:dist:contracts`）以及三操作系统插件矩阵测试。
2. **自动 Beta 触发（`beta.yml`）**：
   - 只有同一 main push 的精确 SHA 在 `ci.yml` 的全部必要检查成功后才调用 `beta.yml`。
   - 规划器复查该 SHA 仍为 main tip，分别比较 CLI 五包的规范化生产输入（包括原生源码、工具链和平台包生产逻辑）与 Catalog 完整生产内容。
   - 有变化的产品自动准备 beta，版本提交和源码 tag 只放在 `release-source/<product>/<version>` 分支，**`main` 分支绝不接收自动版本提交**。默认稳定版后从下一 patch beta 开始；显式修改稳定目标可指定 major/minor。
3. **发布候选验证（Release Candidate CI）**：
   - 触发条件：发布工作流启动时准备的候选分支或 tag。
   - 职责：在全量矩阵上执行完整验证，包括两架构真实 Windows 资格测试与六平台候选 smoke，成功后方准许进入发布步骤。

---

## 2. 操作系统与环境矩阵

### 2.1 基础环境与普通测试 Runner

CI 覆盖三个主流操作系统平台，固定使用 Node 24（另有 Linux Node 22 兼容验证）：

- **Linux Node 22/24 普通测试**：按 Node 版本和 unit/integration 分为四个独立 runner：
  - **Unit 入口**：运行三个 package 的单元测试、`test:workers`，随后运行 `test:types`。
  - **Integration 入口**：运行普通 integration 与串行 `process-lifecycle`。
- **macOS arm64 普通测试**：普通 integration 按历史耗时分为两个独立 runner，每片默认最多 2 workers；分片 2 随后串行运行 integration 中的 `process-lifecycle` 测试。
- **Linux 插件环境**：Linux 插件测试执行独立的构建，并将构建出的 CLI 严格配置到 `PATH` 中。
- **矩阵复合 Action**：插件测试由普通矩阵 job 调用共享的 `.github/actions/plugin-tests` 复合 action，与其他测试平铺显示，覆盖 Linux x64、macOS arm64 和 Windows x64。
- **原生打包 smoke**：macOS arm64 的插件 job 和 Windows 插件分片 1 在插件合同完成后运行 `pnpm test:smoke:pack:cli`，复用该 job 的 Node、构建产物与 Windows native context，并保留失败诊断。Linux 的打包 smoke 继续由 release verification 执行；集成测试 job 不再串行等待打包测试。macOS 与 Windows 的 pack job 另行缓存 npm 的 `_cacache` 下载数据，并显式向 smoke 传入该缓存目录；安装 prefix 仍每次新建，不缓存已安装产物。

### 2.2 Windows 独立测试分片与长时任务（CI1）

为应对 Windows 上文件系统与子进程创建耗时较高的特点，Windows CI 分别为**普通集成测试**与**插件测试**设计了两套完全独立的 Runner、分片算法与超时配置：

#### 2.2.1 Windows 普通集成测试三路分片（Vitest Runner）

- **Job 名称**：`win32 x64 / Node 24 / integration 1 of 3`、`2 of 3`、`3 of 3`。
- **工作目录**：`packages/cli`。
- **执行命令**：
  ```bash
  node ../../scripts/test/run-vitest.mjs run --project integration tests/integration --config vitest.integration-shard.config.ts --shard "<index>/3"
  ```
- **并发与 Runner**：采用三个独立的 Vitest runner，默认使用 1 worker（并发解析遵循优先级：串行约束优先，其次显式参数，再环境变量 `AW_TEST_WORKERS`；CI 环境变量默认配置为 1）。
- **完整互斥校验入口**：
  为验证各分片在测试文件分配上的严格互斥与完整性，在 `packages/cli` 目录下执行：
  ```bash
  node ../../scripts/test/run-vitest.mjs list --project integration tests/integration --config vitest.integration-shard.config.ts --shard "<index>/3" --json
  ```
  **必须使用 `list --shard --json` 检查，严禁使用 `list --filesOnly`**。
- **分片 3 附加任务**：
  除集成测试外，分片 3 额外承接串行 `process-lifecycle` 测试（`node ../../scripts/test/run-vitest.mjs run --project process-lifecycle --pool=forks --maxWorkers=1 --no-file-parallelism tests/integration tests/unit/test-command-diagnostics.test.ts`）与诊断回归。
- **作业超时**：该集成测试 Job 超时上限设置为 60 分钟。

#### 普通集成测试的耗时分配

Windows 三片与 macOS 两片使用 `packages/cli/scripts/integration-sequencer.mjs`。它从 Vitest 实际发现的文件出发，按对应平台的历史耗时从长到短，把下一文件交给当前预计耗时最短的分片；相同耗时按相对路径排序，分配不依赖本地 Vitest cache。文件不拆分，分片内继续使用 Vitest 默认排序。

`packages/cli/scripts/integration-durations.json` 保存 CI 文件级测试耗时（秒）与来源 run。新增或重命名的文件使用该平台历史耗时的中位数，不会因缺少记录而漏跑；已删除文件的记录不参与测试发现。观察到持续失衡或重测试发生变化时，从成功 CI 的文件汇总刷新数据并核对来源，不按单次总 job 时长调权重。这些值用于相对分配，不是性能门槛或 wall-clock 保证。

macOS job 名为 `darwin arm64 / Node 24 / integration 1 of 2` 和 `2 of 2`，使用上述命令并将分片参数改为 `<index>/2`。Windows 分片 3 和 macOS 分片 2 的串行生命周期步骤不参与普通 integration 分片。插件测试仍采用下面的独立算法。

CI 显式设置 `AW_TEST_SHARD_PLATFORM` 为 `win32` 或 `darwin`；本地未设置时使用宿主平台。跨平台检查分配时可显式选择对应 profile，这只检查分配，不能代替该平台实际测试。自定义 sequencer 只允许 `--project integration`；不指定分片 config 的本地完整测试入口保持原行为。

更新分片后，对每个平台运行全部 `list --shard --json`，核对各片文件集合互斥、并集等于未分片发现的集合。`pnpm test:workers` 另用真实 Vitest fixture 验证这一边界，包括耗时表中不存在的 `.tsx` 文件。

#### 2.2.2 Windows 插件测试三路分片（Node File Shard）

- **Job 名称**：`Windows x64 / Node 24 / plugins 1 of 3`、`2 of 3`、`3 of 3`。
- **复合 Action**：调用 `.github/actions/plugin-tests/action.yml`。
- **执行命令**：
  ```bash
  pnpm plugin:test --all --test-concurrency 1 --test-shard "$env:TEST_SHARD" --test-shard-profile windows-ci --native-mode source-candidate --native-context "$env:RUNNER_TEMP/aw-native-context.json"
  ```
- **分片分配算法**：
  默认 `--test-shard` 由 Node 按测试文件相对路径的字母顺序排序后轮流分配，不拆分单个文件。Windows CI 显式使用 `--test-shard-profile windows-ci`，按历史耗时对少量插件的三个 Node 片做置换；同一插件的所有目标平台与 native/portable backend 使用同一映射。该 profile 只接受 `--all` 和 `<index>/3`，无效组合在准备插件前失败。
  映射及来源 run 位于 `packages/cli/scripts/test-plugin-scripts.ts` 的 `WINDOWS_CI_NODE_TEST_SHARDS`；未列入的插件保持原片号。新增或重命名文件仍由 Node 自动纳入三片覆盖，不依赖文件 allowlist。`AW_PLUGIN_TEST` 的 `shard` 表示 CI 片号，`nodeShard` 表示 profile 生效后的 Node 片号；默认模式不增加后者。
  更新映射时按每个插件、每个目标的完整 runner 耗时测算，不能把共享 fixture 中的叶子测试位置当成入口文件。真实 runner 回归检查各片并集、互斥、平台与 backend 完整性和失败传播；所有三个 CI 分片均属于发布前的必要检查项。
- **分片 1 附加任务**：分片 1 额外承接真实文件占用与跨卷移动资格测试。
- **分片 1 打包任务**：插件测试完成后运行 Windows x64 的 `pnpm test:smoke:pack:cli`，保留当前 source-candidate helper 和 native context。
- **作业超时与诊断**：
  插件 Job 超时上限设置为 90 分钟（此为故障观察上限，非正常等待时长）。
  每个分片均启用命令阶段耗时、PowerShell 调用次数、累计耗时及最大耗时诊断。
  真实 30 分钟长时资格用例保持显式触发，不混入普通 CI 阻塞流水线。

---

## 3. 自动 Beta 验证复用与检查同步机制

为避免在发布自动 Beta 时无谓重复耗时极长的全量源码验证，系统支持安全的 CI 验证复用机制：

### 3.1 复用证据与门禁条件

自动 Beta 的源码 tag 是 annotated tag，message 以 `Automatic beta` 开头，并包含 `AW-CI: <run-id>/<attempt>` 标记：

1. **同仓库与同 SHA**：候选发布查询同一 main SHA 的该次运行，验证运行记录确属于同仓库 `ci.yml` 的 main push，且 SHA 等于已验证的候选 main 来源。
2. **精确 Attempt 与全部必要 Job 成功**：核验该次 attempt 的全部必要 CI jobs 均为 `completed` 且 `success`（此时 main 的 beta job 本身可以仍在运行）。
3. **跳过的耗时步骤**：仅在上述条件全部严格满足时，省去重复的 `release:verify:cli|catalog` 及 Go 可复现构建。
4. **保留的候选验证**：精确候选仍必须正式 build，并必须通过六种 OS/CPU 及最低 Node 版本的候选产物 smoke。
5. **回退至全量验证**：手动候选、稳定版、证据记录缺失、必要检查失败或缺失、以及 GitHub API 查询失败时，一律执行所选产品的完整 release verify。

### 3.2 检查清单同步与 API 容错

- **Job 名称硬性同步**：CI job 名称发生变更时，**必须同步更新 `scripts/release/actions-inspection.mjs` 中的必要检查列表**。两者名称若未同步，系统因无法确认全部检查均已成功而安全回退至完整验证。
- **历史快照 Transport 校验**：自动 Beta 比较 Catalog 时，当前候选执行完整校验；历史基线快照只执行 transport 校验（检查快照布局、摘要与 marketplace 投影），不按当前插件合同重新校验旧插件。历史快照无法读取或完整性校验失败时，按生产内容有变化选择新版本。

---

## 4. 发布候选验证与跨平台 Smoke

Linux Node 24 的 release verification 必须等待本次 Windows Job 候选及两架构资格成功，再运行 `release:verify:delivery`、`test:perf:gate`、`test:smoke:cli:after-delivery`、Catalog bootstrap 和 `release:verify:publish`：

- **单次正式构建**：`delivery` 负责一次正式 strict Catalog build、dist contract 和 build smoke，job 不再单独前置 build。CLI 的 fetch smoke 已包含 Catalog publish smoke。
- **跨平台 Smoke 消费同一候选**：六种 OS/CPU（Linux x64、Linux arm64、macOS x64、macOS arm64、Windows x64、Windows arm64）的 Node 24 smoke 和精确 Node 22.0.0 最低版本 smoke 消费同一恢复包，绝不重新编译源码。
- **安装入口版本校验**：通过已安装的 `aw` shim 执行 `--version --json`，核验输出协议版本、`command: version`、`status: success` 和 `data.version` 与候选包版本一致；不解析默认英文文本。
- **Fake 边界**：fake native runner 的 Catalog smoke 仅用于确定性参数接线测试，**绝不能冒充真实 Codex/Claude 已通过 qualification**。任一门禁未通过就不准许发布。

---

## 5. 门禁、生成物边界与测试诊断规范

### 5.1 严格要求门禁（Strict Requirements）

- 官方 CI 的 `pnpm build` 必须启用 `--strict-requirements` 语义，若插件声明了当前宿主不支持的 capability，立即阻断构建。`release:verify:catalog:core` 通过此官方 build 覆盖 strict 门禁。
- 第三方公开 `aw dev catalog build` 默认仅提供 advisory 建议，不作强阻断。

### 5.2 构建生成物与 Check-Only 源码合同测试

维护者必须严格区分**构建生成物**与**纳管源码合同**的生命周期边界：

- **构建生成物（`dist/` 与 `packages/cli/plugins-dist/`）**：
  - 这两个目录是工程构建产物，已在 `.gitignore` 中明确忽略，**绝对禁止手工修改，也绝对禁止提交到 Git 源码中**。
  - CI 在运行测试与验证前，通过 `pnpm build` 命令清理并重新生成这些目录。
- **Check-Only 纳管源码合同测试与准确命令**：
  - 项目中由脚本生成的 TypeScript 类型定义、JSON Schema 与交付规范属于纳管源码（如 `packages/plugin-core/scripts/generate-manifest-types.mjs` 生成的 manifest 类型）。
  - 这些文件必须通过 Check-Only 模式验证，确保提交的源码类型与生成器定义严格一致。
  - **准确执行上下文**：脚本 `generate:check` 仅定义在 `packages/plugin-core/package.json` 中，根 `package.json` 没有该 script。维护者执行时必须指定包上下文：
    ```bash
    # 从仓库根目录执行：
    pnpm --filter @lesliechan721/aw-plugin-core run generate:check

    # 或在包目录执行：
    cd packages/plugin-core && pnpm run generate:check
    ```
    底层执行命令为 `node scripts/generate-manifest-types.mjs --check`。
  - **CI 严禁自动改写受检源码文件**：若开发者修改了源定义但未在本地重新运行生成脚本并提交更新后的纳管代码，Check-Only 测试将直接失败报错。
- **Dist 契约测试真实命令**：
  验证构建后 dist 制品与对外公开契约一致性的正式测试命令是：
  ```bash
  pnpm test:dist:contracts
  ```
  该命令对 `@lesliechan721/agent-skill-eval`、`@lesliechan721/aw-plugin-core` 和 `@lesliechan721/aw` 分别运行 `test:dist`，并执行 `test:smoke:build`。

### 5.3 CI 诊断目录与脱敏收集

- Windows Job 的 x64/arm64 资格报告在资格步骤成功或失败后均上传，且上传先于 arm64 临时卷卸载。跨卷结果读取与导出使用独立错误码，日志只记录退出码、受限状态与错误码、正文匹配和消费结果，不保存原始 stdout/stderr、正文或路径。

- CI 为 Publisher 与外部 npm 安装诊断提供 `AW_TEST_DIAGNOSTICS_DIR`。
- 测试在删除临时现场前向该目录保存脱敏 JSON；失败 job 只上传 `publisher/` 和 `npm/` 下的 JSON，保留 7 天。诊断不包含完整环境变量或原始 npm debug 日志。

### 5.4 性能阶段与时序诊断

- 恢复性能诊断通过 debug logger 发出 `performance:stage`，记录 `recovery.plan`、`recovery.lock.wait`、`recovery.locked.demand`、`recovery.locked.recheck`、`recovery.child.plan`、`recovery.child.execute` 和 `recovery.status` 的开始、成功/失败及耗时。
- **时序诊断（`AW_TEST_TIMING`）**：
  CI 通过 `AW_TEST_TIMING` 记录 `commandSequence` 时序诊断。注意：嵌套 stage 的耗时不可直接简单相加（因为包含等待与并发阶段，累计值不等于实际 wall-clock 耗时）。
  独立 CLI 子用例另外记录 `AW_TEST_CHILD_TIMING` 的 spawn、进入子用例、CLI/renderer 阶段和 exit/close。父进程最多转发64条选定阶段元数据，标记父、子及实际执行进程 PID；不复制参数、路径、receipt 正文或错误正文。父级 `elapsedMs` 与子级 `childElapsedMs` 分别使用各自进程的单调时钟起点，不能直接相减；使用接收顺序和阶段耗时区分加载、执行及退出收尾。原 receipt 捕获、行为断言和测试截止保持。
  独立 CLI 夹具在 discovery 调用边界隔离宿主 App 查询，保留真实 PATH CLI 身份、版本探测、管理命令和进程审计。仅设置后备 query runner 不足以隔离该查询，因为 CLI 会显式传入 runner；child 的受控预检覆盖这个边界，不启动宿主系统查询。
- 双平台 TUI 并发用例在断言前输出 `AW_TEST_RESULT`，包含重新安装与配置保存双方的结果、错误码和脱敏诊断摘要，不输出原始 receipt 或完整异常。
- 精确依赖移除与配置运行时同步用例使用 `AW_TEST_TIMING` 分别记录 fixture、命令、renderer 及恢复阶段；测试结束时报告尚未完成的已跟踪阶段。精确移除及 provider 切换用例在 Windows 使用 60 秒预算，配置运行时同步用例使用 30 秒预算，其它平台分别保留 30 秒与 15 秒。预算覆盖用例中的完整准备与执行，不替代阶段计时或性能门禁。

## 6. 无认证 Native 客户端资格

[`native-platform-qualification.yml`](../../.github/workflows/native-platform-qualification.yml) 是独立手动工作流，不属于普通 PR 更新、自动 Beta 或发布通过门禁。可在 Actions 选择一个固定客户端或 `all`；首次工作流尚未进入默认分支时，也可手动给 PR 添加 `native-qualification` 标签运行全部客户端。只有本次添加该标签才触发，普通 PR 更新不触发；`native-qualification-copilot` 标签在相同六环境中只验证 Copilot，用于定向修复验证，不代表其他客户端重验。重跑使用 Actions 的 rerun 或重新添加对应标签。

每次运行都在自己的 runner 上构建 Windows helper，验证 x64 和 arm64，再上传供本次运行使用的制品。同一分支的全客户端验证和 Antigravity 专项可以同时执行这些步骤。候选制品和 Windows helper 的前置作业结束后，Linux、macOS、Windows 的 x64/arm64 在各自的托管 runner 上独立验证同一候选。所有选中的宿主均可并行，实际启动时间取决于 GitHub runner 可用量。各宿主的失败互不取消。只有实际运行成功的精确单元才构成证据，工作流文件存在不表示矩阵已通过。手动运行可用 `hosts=windows-x64-and-macos-x64` 选择 Windows x64 和 macOS x64，或用 `hosts=windows-x64-and-arm64` 复测两种 Windows 架构。默认 `all` 与原有 PR 标签按各自原矩阵执行。

常规 CI 和资格候选都运行 [shipped-catalog-user.mjs](../../scripts/qualification/shipped-catalog-user.mjs)，读取本次构建的官方 Catalog，逐插件核对九个个人目标的组件和实际投影。对 `git-toolkit`，三个 Skill 的正文和宿主调用字段都有独立断言。generic 另外走公开安装与更新，读回三个目录，检查手动技能的非阻断提示和成功退出码。矩阵使用固定的 CLI 发现数据，真正的宿主安装、调用入口、自动候选和已知限制由各自的原生探针记录。公开安装检查会读回正文，并核对当前宿主是否应提示明确的调用限制。Claude、Pi 和 OpenCode 的原生检查分别从 User 和 Project 的已安装技能读取调用行为。[实测记录](../../scripts/qualification/evidence/native-manual-skill-invocation-2026-11-20.json)

Linux 和 Windows 的 `all` 作业另传入 `--mixed-native-aw`。该场景复用当前作业获得的固定 Claude 和 Pi 入口，另建一份共用的临时 HOME、AW_HOME 和 Catalog。单条公开 `aw plugin install` 以两个 `--target` 执行同一个 User 插件，要求两个原生登记都在 v2 回执中确认应用。随后重新读取公开 status、两端在工作目录和 neutral 目录的原生登记与版本，并逐字节核对实际 Skill。资格沿用每条公开命令的 60 秒时限和已准备的 Windows Job helper。报告的 `mixedPublicAw` 记录检查、失败原因和清理，任一必需检查失败均影响作业结果。Managed trace 为两个客户端记录原生写入及有限清单查询样本，以在原上限内保留后发的写调用。`nativeInstallIntervals` 单列两个原生 `install` 托管调用的开始、进程启动、完成和开始至完成区间的交集。该区间包含后端处理及清理开销，原生清单、市场登记和启用各有独立事件，交集数值不影响资格通过。

原 Ubuntu x64 的 `all` 作业另运行 Cursor CLI `2026.11.05-86047df` 与 Antigravity CLI `1.3.4` 的无凭据接口观察，不新增 runner 或并发。固定官方归档经摘要核对后提取到临时目录，使用严格 `verified-observed` 执行帮助、版本及经帮助确认的 Antigravity 空清单。Cursor 的账户 marketplace 清单仍需认证。隔离白名单为 Antigravity 显式设置 `AGY_CLI_DISABLE_AUTO_UPDATE=true`；通用 `DISABLE_AUTOUPDATER` 不足以关闭其后台更新器，不能因此改变固定入口或放宽后代退出要求。Antigravity 两个新目录的初始清单均为空后，另用当前 AW 投影生成隔离普通 Skill 小包，观察 User 安装、版本更新、同版本正文刷新及移除，每次读取原生清单指向的实际 Skill 文件。Project 使用空模板 Git 仓库，按当前布局发布/撤销目录，并使用已明确批准的精确 `-p /skills --output-format json` 查询目标、neutral 与移除后状态。固定版本更新日志将该命令定义为本地只读，不启动 Agent 轮次或模型请求；不提交自然语言，不放宽严格进程合同，不使用 Agent canary 代替 Skill。原始输出在其实际结构和有效状态得到核对前不构成 scope 通过。这些结果单列为 candidate-only，不运行公开 AW 链，也不提升生产 profile；Project 安装清单与原始只读 Skill 输出分开记录，缺少有效插件或 Skill scope 仍阻断该候选。报告单独保存为 `native-interface-probes-ubuntu-24.04` artifact，记录失败和清理。可用 `interfaces_only` 手动输入或 PR 标签 `native-qualification-interfaces`，仅在原 Ubuntu x64 环境重验这些接口；此路径仍构建并绑定完整候选，不运行 Windows helper 或六客户端矩阵，独立作业失败正常传播。非阻塞接口观察保留进程审计失败，不归为认证未知。每个客户端另在自己的观察字段记录实际 scope 和证据边界。

Cursor 的 [固定 CLI 探针](../../scripts/qualification/native-platform-cursor-skills.py) 使用临时 HOME 和 Project，由真实 `workspaceOpen` 加载测试插件。原生 slash 菜单分别观察 User 与 Project 的首次加载、内容更新、撤销及 neutral 目录隔离。回环固定测试服务只返回启动所需的模型清单，然后通过 HTTP/2 请求本地 Skill 元数据，核对同一原生包内普通 Skill 的默认值和手动 Skill 的 `disableModelInvocation=true`。普通请求的初始数据不带手动 Skill 正文标记，显式 `/aw-manual-qual` 请求带有标记。探针用固定发布版的测试模式进入本地会话。服务不接真实账户、模型或工具，代理只允许连到当次回环端口。托管结果位于 `nativeSkillFixture`，复用普通 POSIX 进程观察。报告覆盖所执行产品和宿主，服务端执行既定策略仍未实测。macOS arm64 可用同版真实入口运行本地探针。

```bash
python3 scripts/qualification/native-platform-cursor-skills.py --node "$(command -v node)" --executable /absolute/path/to/cursor-agent
```

PR 标签 `native-qualification-antigravity-user` 在同一六环境矩阵内只补测 Antigravity CLI `1.3.4` 的 User 普通 Skill 直接 Native 管理，使用独立的 [`native-platform-antigravity-user.mjs`](../../scripts/qualification/native-platform-antigravity-user.mjs)。该入口复用本源候选、Windows helper 和原严格 `execute`，不进入 `all` 客户端字典，不运行 Cursor、接口初探、Project、`agents` 或公开 AW 场景。六份官方 GitHub release 归档及固定 SHA-256 由 [`native-platform-antigravity-distributions.mjs`](../../scripts/qualification/native-platform-antigravity-distributions.mjs) 统一选择；下载上限256MiB，tar/zip 只提取普通文件和目录，拒绝越界、link 和重复节点，展开上限768MiB／20000项。Windows ZIP 的入口为已核对归档内的 `antigravity.exe`；提取使用宿主 Python 3 标准库，并有60秒直接子进程时限。提取及下载不构成客户端进程树证据。

`native-qualification-antigravity-user-public` 标签复用同一六环境矩阵，唯一差异是显式向独立 User runner 传入 `--public-aw`；原标签及 runner 默认仍只做直接 Native。直接 User 场景通过且没有进程失败后，公开场景才通过既有 `runScope` 在新的独立临时 HOME 中执行，私有客户端 bin 位于本次 acquisition 根内。公开场景仍要求 Hosted、User、当前宿主的真实 production Skill profile 和精确 CLI `1.3.4` consumer；profile 未验证时，在公开 AW 写入前保留阻断，不注入候选 profile 或使用 force。直接 Native 保持原严格观察，公开 AW 使用现有普通观察及 Windows Job 路径，均保留原截止和实际回执。结果按主资格器的 `client.publicAw` 数组单列一个 User scope；只有直接 Native、所请求公开场景及全部清理通过，整份报告才通过。公开场景必须验证 v2 status、原生清单与已安装副本。普通 Skill 加载未知独立记录，进程、公开状态或清理失败会阻断资格。 同一 User runner 的 `native-qualification-antigravity-user-windows` 仅选择原矩阵内的 Windows x64/arm64，保持直接 Native 验证和原门槛；可用于修复 Windows 夹具后的有限补测，其他宿主仍沿用各自原始报告，不重绑为该次来源。 `native-qualification-antigravity-user-remaining` 选择原矩阵内的 macOS ARM64 与两个 Windows，最多三个作业，用于补齐已知剩余单元；不重复其他宿主或提升资格。

手动触发同一 [Native 资格工作流](../../.github/workflows/native-platform-qualification.yml) 时，`client=antigravity-user-public` 会在六个环境执行 Antigravity User 原生和公开安装检查。要与常规 `all` 矩阵比较同一版本，可以用同一个固定 tag 分别运行下列命令，再核对两个 Actions run 的 head SHA。

```sh
gh workflow run native-platform-qualification.yml --ref "$TAG" -f client=all -f hosts=all
gh workflow run native-platform-qualification.yml --ref "$TAG" -f client=antigravity-user-public -f hosts=all
```

独立 User 报告绑定 source、run attempt、candidate 摘要、实际入口摘要及 acquisition／scope 清理结果。Linux/macOS 管理命令保留严格 `verified-observed`；Windows 走既有 Job 路径，命令保留实际 `containmentMode`、grading 和后代清理字段，Job/helper 证据单列，不按 OS 改写命令模式。每条原生命令使用 EOF 和原30秒时限。临时 HOME/AW/Agent/XDG 根中，三轮分别验证安装、版本更新和同版本正文刷新；每轮从目标与 neutral 的新管理查询确认全局 enabled，并读取原生 `path` 指向的实际副本字节和完整 AW owner。内部判定使用原始 stdout，全部内容判定完成后才对报告脱敏。卸载后双侧缺席、进程及清理均为必需检查；Skill 加载／模型采用未知单列且不阻塞。该候选取证不新增或扩大 production profile，其他环境的支持仍须独立验收。

资格报告格式保持 schema 2。直接 Native 报告使用 `management-content-scope-v1`。启用公开 AW 场景后，`public-status-and-native-scope-v2` 要求 v2 公开状态在适用场景中与原生登记、有效启用、实际消费字节和作用域一致。Project 在外部目录禁用或不可见，User 在两处全局可见。普通 Skill 发现和加载单列 `observations`。必测场景的证据缺失、命令失败、进程审计失败或清理失败会使对应单元无法通过。报告标明候选源码、宿主、真实客户端版本、产品面、scope 和未覆盖场景。旧报告保留原判据与来源。

候选 job 正式构建一次，运行资格执行器测试，记录源 SHA、全部 dist、Core 运行时 schema 和资格脚本文件摘要。各系统恢复同一候选的 JavaScript 和 Core schema 并校验字节，不重新编译。Windows Job helper 由同一源 SHA 的既有 `windows-job.yml` 独立构建，完成固定工具链重建和两架构真实资格后，再从 `windows-job-qualified` 恢复。Windows runner 校验该候选及资格证据，使用现有 source test preparation 将适用 EXE 放入正常 optional 平台包，并先运行资格 harness；客户端报告记录实际 helper 字节摘要。客户端包名、精确版本和官方来源集中在 [`native-platform-runtime.mjs`](../../scripts/qualification/native-platform-runtime.mjs)；通过公共 npm 在临时前缀安装，禁用安装脚本，记录 lock 摘要和 package integrity，不使用浮动 latest。Codex、Claude 和 OpenCode 直接选择固定官方 optional 平台包的原生入口，校验包身份、精确版本并记录实际 binary 摘要；不运行复制 binary 的 postinstall，也不通过替换进程的 Node wrapper。Grok 在 macOS x64、Windows arm64 没有官方分发，明确标为 `excluded`、不计应验单元；不能称该平台通过。其他获取失败或依赖安装脚本的入口仍报告未验证/失败，不静默改用其他版本。 Copilot 固定版的本地插件与 Skill 命令显式使用 `COPILOT_OFFLINE=true`、`COPILOT_AUTO_UPDATE=false`，禁用网络和自动更新入口；该路径仍会查询客户端认证存储，不能将离线配置视为跳过认证读取。真实 Copilot 资格与追加取证使用全新无凭据 Hosted 环境。仅 Copilot Darwin 管理命令复用普通 CLI 的 observed marker/identity 观察：允许独立进程组，仍要求标记、PID/启动身份、原截止、确认清理及正常完成前已归属后代退出；该模式不是 Provider 评级或 OS 隔离证明。OpenCode 2.0.0 的隔离本地插件与 scope 查询在 POSIX 复用同一限定 observed 合同；Windows 保留实际 Job 合同，不照搬 POSIX 的模式声明。Antigravity 1.3.4 的 Linux x64 Hosted `agents` 清单查询按显式批准采用同一普通 observed 观察，保留原30秒截止、随机标记与PID/启动身份、正常完成前后代退出和确认清理；仅用于无凭据临时环境的清单观察，不认证、不发 prompt、不调用模型，不作为 Provider 或 OS 隔离评级。其余 Antigravity 管理命令及其他 Native 客户端与真正 Provider 的原合同保持。命令回执保存实际 containment、grading 与后代清理声明，旧严格合同下的离组失败保留原来源。

Hosted 工作流显式设置 `AW_NATIVE_QUALIFICATION_PROCESS_NAMES=1` 时，Copilot Darwin 管理命令及 Linux/macOS 公开 AW 观察启用私有进程名取证：对原 identity `ps` 查询同次附加 `ucomm` 列，再逐行投影回原五列。它消除二次查名的进程退出竞争，但读取全部行的有限进程名，并改变原查询输出量与失败面；timeout、maxBuffer、频率、信号和原错误保持，不增加查询或重试，无法可靠恢复 identity 行时查询失败，不能丢行后报告成功。完整扩展表只在内存中处理；仅缓存最近最多32个 root/后代身份，并在原离组或标记失败的 PID/启动身份交叉核对后附加最多8项 `processNames`。名称来自有限进程名，可能截断或变化，不是完整可执行身份；拒绝路径、控制字符或过长名称，不保存 argv、环境、marker 或原扩展表。名称不参与归属、信号、收尾或成功判定；停止后晚到回调仍恢复 identity，但不改变已保存的名称提示。未显式启用该 Hosted 开关的查询保持原样，Eval 的通用合同不变。

资格场景使用候选的真实 `projectPlatform` 和 Marketplace 投影生成普通 Skill 包，明确使用测试候选 profile，不改生产能力资格。真实客户端负责安装、更新、移除和只读发现；user/project 各有独立临时 HOME、AW/Agent/XDG 根及有效 Git 项目，neutral 工作目录位于其外。仅允许本地管理命令、Codex `skills/list`、显式项目 status 的 `config/read`、Pi `get_commands/get_state`，以及 OpenCode 隔离 loopback server 的插件激活等待、插件清单和可选 Skill 清单；OpenCode 使用每次新建的本地控制 nonce，不使用账号认证，等待激活会运行生成插件的 setup，不能称为纯清单读取。不提供凭据、不登录、不发送 prompt、不调用模型、不连接已有 server。下载阶段可访问公共 npm，并可沿用 HTTP(S) 下载代理；此类网络传输认证不会传给客户端。下载子进程禁用安装脚本并保留原180秒超时与输出上限；成功和失败均记录开始／结束时间、单调时钟耗时及固定时限。npm 显式启用 timing，仅从本次私有缓存中最后一份 timing JSON 有界读取最多256KiB加一个溢出字节；报告只投影固定 npm／install／idealTree／reify 阶段的非负有限耗时和未完成阶段名，不保留原日志、URL、路径或任意 timer 键。失败的 deadlineReached 只说明测得耗时达到固定时限，不单凭 SIGKILL 推定超时或网络原因。timing 会增加本次缓存 IO，不作无插桩性能证明；该阶段只使用有界的直接子进程管理，不声称已验证进程树。客户端阶段使用阻断代理，这不是 OS 网络防火墙。Linux/macOS 客户端进程默认使用既有 verified-observed 管理，Copilot Darwin 使用上述限定 observed 合同；Windows 从 Eval 自身依赖解析已准备的 helper，使用既有 Windows Job 管理后代进程，缺失 helper 时在启动前失败。两条路径均保留超时和输出上限，并在 finally 清理临时目录；这些机制不构成文件系统或网络容器隔离。

同一 Hosted 开关下，Linux 公开 AW 还在原 marker `ps` 回调中保存有限 negative 行的 PID/PPID/PGID/state/启动时间、查询序号及开始/回调时间，并将 command 仅分类为空、defunct、括号、方括号、方括号加 defunct 或其他。精确标记匹配和标记变量是否出现仅保留布尔；不保存原 command、环境、marker 或其摘要。行形态记录不增加进程、查询或 await，原 error/stdout/回调与截止不变；解析有少量 CPU 成本，不能作无插桩性能证据。无法解析的续行不留原文，只记录数量；最多缓存32行，原失败按 PID/启动身份及回调早于诊断筛选最多8行，注明缓存丢弃及输出省略数。同一身份可能对应多次查询，因此保留候选并明确关联歧义，不把最近一条当作原判定查询证明。该形态只作私有补证，不改变 unreadable、归属、失败或 cleanup 判定。 同一开关也为 Linux Grok 原生管理命令记录上述行形态，仅从 root 的唯一有效随机标记赋值学习本次标记。Linux 公开 AW 和上述原生命令重复出现的缺标记行，包括普通 command 形态，可异步读取该 PID 的 `/proc/PID/environ`，每条命令最多8个 PID/启动身份候选；每次读取共用原命令与该次查询截止的较早值，停止时取消，原 `ps` 回调不等待读取。环境物理读取最多64KiB加一个溢出字节，前后读取有限 `stat` 并比较 starttime；只保存固定状态、精确 NUL 项匹配布尔、字节数、时间及身份比较，不保存环境、标记、摘要或原始 ticks。空值、权限、截断、身份变化及截止仍为未知。这个身份比较只绑定该次文件读取，不能证明它与原 `ps` 属于同一次 exec 或原判定查询；原查询序号、关联歧义和失败均保留。读取结果不参与资格通过、归属或信号判定。 观察器在 Linux 运行期对单次 marker 复查后仍不可读的候选进行独立的新身份确认时，资格工具可在同一 Hosted 开关下记录 `markerIdentityConfirmations`：每命令最多8个候选的 PID/启动时间、查询开始/完成/原截止与 absent/present/unknown，以及省略数。事件来自观察器实际确认分支，和形态补证分开；不保留 argv、环境或标记，不进入原失败诊断首尾队列，回调错误不改变门禁，也不把 absent 写成过去 marker 成功。

Hosted 工作流显式设置 `AW_NATIVE_QUALIFICATION_MANAGED_TRACE=1` 时，仅 Linux/macOS/Windows 的 Codex/Pi/Claude/Copilot 公开 AW 进程通过 Node `--import` 加载私有托管调用取证。它复用既有 NativeCliRunner 接口并保留正式默认后端与 Windows helper 准备判定；只记录本次固定客户端入口匹配的逻辑命令、有限参数、操作序号、开始/结束、AW 父 PID、正式后端启动回调提供的子 PID、退出/错误类别、是否有清理错误和宿主公开标记是否提供；子 PID 不证明最终 marker 可读性。同一包装还在实际插件脚本 runner 的临时环境副本中补入当前公开 AW 随机管理标记，并记录固定 plugin-script 角色、操作序号、父子 PID 和开始/结束，不记录脚本参数或其他环境值。生产脚本环境白名单不变；这是资格 fixture 的显式环境前提，不是纯被动取证。脚本清理失败保留首末 ProcessTreeDiagnostic 的有限查询开始、原绝对截止、回调及完成状态和尝试次数，用于区分截止耗尽与查询失败；不增加查询、重试、等待或宽限。仅 Codex Marketplace 清单保留有限成功输出，失败保留有限 stderr；不记录环境，清除 marker 值与 UUID 形状。JSONL 只在本 scope 临时根新建，最多256条、256KiB，随后按原报告规则脱敏并随 scope 删除。记录错误不替代真实结果、对象或异常；这些调用仍受原截止，附加 IO/时间使其不构成无插桩性能证据。

Windows Codex 的共享 User 提供者场景在 Project 安装依赖时记录原 60 秒时限、外层 Job 调用开始至返回、AW 正常退出时刻和最多 64 个系统 PowerShell 完成样本。资格脚本从该命令的私有 debug 日志最多读取 256 KiB，报告仅保留固定的准备、写入及状态阶段与时间。超时后在还原配置前另读已选原生入口的插件清单和项目公开 status，命令回执保留原超时。

公开 AW 命令的原 stdout/stderr 预览仍受原长度限制；失败时先从完整 JSON 提取有限 target、receipt effect、diagnostic 和实际 native identity 摘要，再做同一脱敏与长度限制。无效 JSON 明确标记，不从截断预览猜测结果；摘要不改变命令退出码或场景失败。

在同一 Hosted 进程诊断开关下，Darwin 公开 AW 包装还记录既有 identity/marker `ps` 与内核启动参数补证的查询时序：只保留前8项和末16项、序号、固定查询类别、开始/回调时间、原 timeout、有限错误类别及有单位的封顶输出长度，附省略数。尚未回调保持 pending；不记录 argv、脚本、环境或 marker，不增加查询、重试、截止或宽限。成功和原异常均携带该独立字段，原首末失败诊断不被改写。这些插桩时序不是无插桩性能证明。同一开关也将原有查询计时用于 Darwin 的直接客户端与 RPC 包装，并在成功和失败的命令回执中保留；没有额外查询、重试或截止宽限。

报告区分 Skill 发现、组件 inventory 和 activation inventory；Claude details 只证明组件清单。Copilot 项目 fixture 按固定版公开帮助显式设置 `COPILOT_ALLOW_ALL=true`，让宿主信任临时 project 与 neutral 目录；该变量还授予工具自动批准，但本 fixture 只有普通 Skill，不创建会话、发送 prompt 或请求工具，且不传给真实用户环境。project 与 neutral 仍分别要求启用/发现和禁用/不可见，不能靠用户级全局启用代替项目隔离。Copilot 的 live 来源先通过 uninstall 验证停用，再注销本测试独占的 marketplace，最后验证插件和 Skill 消失；project 管理查询未观察到配置生效时保留失败，不能直接推断宿主无 project 支持。

每个 scope 记录断言、退出码、有限脱敏命令输出及清理结果，更新前另记录候选 revision 与投影摘要。直接客户端和 RPC 的进程审计失败也保留命令回执、已有输出及首次/末次 observer 元数据，不因 await 抛错而丢掉该命令。RPC 的 stderr 另包含最多32个单调时钟事件，记录请求/响应类型、是否收到结果、子进程 PID、信号、exit/close 及进程组等待顺序，不记录响应正文、命令文本、环境或 marker。组检查失败另给出有限分类：查询启动/返回、输出格式、PID、自身组/缺行或组内未知状态。仅保留允许的系统错误字段、数字 PID/PGID、行数及 helper/inspector/member 角色；不记录原始进程表或状态文本。事件仅用于归因，不改变原失败退出、RPC 响应、15秒请求截止、500ms SIGKILL 后备或完成前后代退出门槛。

POSIX RPC helper 在直接客户端关闭后、输出 JSON 前，等待初始进程组内的其他活进程自然退出，不向这些后代发送新信号。每次串行查询必须成功并已关闭，包含 helper 自身且确认其 PID 等于 PGID；只排除自身、该次查询进程及明确 zombie。缺失或无效快照、未知状态及查询失败都不能视为空组。macOS 可能在进程退出时短暂返回未知状态；helper 只允许一次新快照确认，并等待该查询关闭。只有新快照明确证明组内已无活成员才成功，持续未知或无效查询仍失败。确认共用原绝对截止。等待使用 helper 本次执行起22秒的绝对截止，保留原25秒外层时限和失败清理空间；到期不输出成功 JSON。此等待只处理 helper 内部收尾，外层仍持续核对 marker、启动身份和初始进程组，离组、已锁存的观察失败及最终清理失败均不能被空组覆盖。Windows 保持原 Job 路径。它证明的是 helper 管理下的会话完成，不证明客户端独立运行时自行等待后台任务，也不提供额外 OS containment。

断言失败终止该 scope 的后续步骤，另一 scope 和客户端仍继续。Grok Project 候选夹具只在临时 GROK_HOME 写精确目录授信状态（固定1.0.77既有实测格式），安装/更新后以新的 inspect 启用状态、原生路径指向副本字节及 neutral 隔离判定；这是显式测试前提，不是产品自动授信或已验证的公开授信命令；Grok 本地更新必须按实际行为判定，不因为是已知问题而算通过。核心失败和未验证均返回非零，非阻塞 observations 与 excluded 不使核心失败；报告通过 `always()` 上传并生成 job summary，保留14天；需要长期引用的通过证据另按固定资格归档规则保存。

托管入口另启用 `--public-aw`，使用正式 production profile 验证公开创建、构建、来源、安装、更新、status 和移除。Codex CLI `0.167.0`、Pi CLI `1.5.0`、Copilot CLI `1.0.95`、Claude CLI `2.1.317`、OpenCode CLI `2.0.0` 为记录六环境的 User/Project 普通 Skill，Grok CLI `1.0.77` 为四个有官方分发环境的 User/Project；各记录分别限定 scope，其他版本、产品面及组件不继承。缺资格或 scope 不可证明时仍 unverified，不注入候选 profile 或 force 绕过。Claude 依原生管理与有效启用状态记录开放有限资格，Skill 发现/加载仍未知，不能借此阻断已满足的新管理验收。

公开场景先检查固定入口身份。Windows npm 入口经正常包、bin、路径及 shim 校验。安装后核对目标与 neutral 的新原生结果、公开就绪状态和实际消费字节。版本更新后再次核对状态，然后保留插件版本 `0.1.1`，将同一 Skill 改为 v3 投影计划生成的正文。激活新来源后、同步前必须报告待同步并保留已确认的包和启用事实。同步后核对实际消费文件字节与公开就绪状态。User 两处消费位置均核对，Project 仍验证外部关闭。移除后的新管理查询必须证明两处的有效范围关闭：独占登记消失，精确成功回执证明共享保留时才允许已禁用登记继续存在。

macOS ARM64 Hosted runner 明确报告容量不足、从未取得 runner 或执行步骤时，可按已取得的本次授权用真实本机 macOS ARM64 补验。保留原 cancelled/无报告，不改写 Actions 结论；另记录原资源诊断、候选与客户端摘要、实际本机 OS/CPU/Node、scope 断言和清理。运行过但资格失败的 macOS 单元不能借不同架构本机结果替代。

Copilot Project 仅在无凭据 Hosted 临时环境使用 `COPILOT_ALLOW_ALL=true`，该开关同时批准工具，场景不发起工具或模型请求。Grok User 首装必须保留 AW 源包，在原生同意前返回精确的 partial，公开状态随后确认登记缺失。通过宿主显式同意后再同步，核对真实刷新及不同来源无法替换。Grok Project 使用临时目录及独立登记不适用语义，验证目标范围授权和拒绝。Pi 以真实 `list` 核对包登记，Project 被隐藏时公开状态保持未确认。没有可用 Agent 消费者时保留具体缺口。

Grok 同源 User 刷新的宿主拒绝仍未取得真实资格。无凭据的 macOS arm64 Grok `1.0.77` 在隔离 User 目录与 AW 同型临时查询目录中，即便写入精确目录拒绝，`inspect --json` 仍报告 `projectTrusted=true`，且 User 登记保持启用。加入独立 Project 插件在其自身目录复现了 `projectTrusted=false` 和 Project 禁用。AW 的 User 查询使用新建 neutral 目录，保留此拒绝场景为未验证。确定性测试仍覆盖同源登记收到原生拒绝时保留安装副本的行为。

Codex 普通状态依据两个作用域的原生清单。资格切换同一真实客户端的两个入口及顺序，并核对正常继承、项目独立启用、宿主拒绝项目配置与共享 User 提供者对依赖的影响。显式 Project 启用与 User 启用同时得到相同原生结果时，独立项目启用仍需证据。Claude 保留精确项目登记与 User 继承的区别。Codex User 专项以回环假 Responses 服务和假凭据运行真实 app-server，核对仅手动 Skill 的原生列表、隐式库存和显式正文，以及三个官方角色的声明名、实际生成引用和宿主加载的指令。该场景不使用外部模型。

OpenCode 普通 status 需要保持目录就绪和可选加载 warning。现有托管调用取证核对普通查询没有进入原生服务路径，显式 `--observe-native` 启动该观察并报告运行结果。

POSIX 公开 AW 命令会管理独立的原生命令进程组，不套用 custom provider 必须共享初始进程组的合同。该包装复用现有 lease、持续 marker/启动身份观察及收尾：检查失败立即中止，正常完成时必须已无活后代，marker 丢失、检查失败、清理或 lease 释放失败都不能变为成功；取消、超时和输出超限也失败。它明确报告 `observed`、`gradingEvidenceAccepted:false`、`descendantCleanupGuaranteed:false`，不是 provider grading 或 OS 强隔离资格。失败时保留首次和最后一次 observer 的有界进程元数据，不保存命令文本、环境变量或 marker；子命令已有输出仍只按原规则限量脱敏，不能由其退出码覆盖审计失败。Windows 公开 AW 保持原 Job 路径；直接客户端除上述 Copilot Darwin 和固定 OpenCode 本地管理/scope 查询的显式普通观察范围外，与 RPC 保持原 verified-observed 合同。公开入口比较先解析文件系统规范路径，不把 Windows 扩展名大小写差异当作另一个入口，也不将全路径小写。报告同时替换普通和 JSON 嵌套身份中的转义路径。

实际通过的 scope 以新报告为准。外部模型、MCP、Hook、Instructions、未覆盖的 Agent 执行、Codex App 和其他 Desktop、最低版本矩阵都保持未验证。Cursor 日常对话的认证由宿主负责。无凭据资格通过固定测试模式观察本地 Hook、slash 菜单与实际协议字段。Antigravity App、Project 目录候选及独立 User 公开入口各自报告。工作流使用无凭据 Hosted runner。

本地复现先运行 `pnpm build` 和 `pnpm test:qualification:native-platforms:harness`，再创建候选清单并显式选择已安装入口或临时下载：

```bash
node scripts/qualification/native-platforms.mjs --write-candidate /tmp/aw-native-candidate.json --source-sha "$(git rev-parse HEAD)"
pnpm qualification:native-platforms --candidate /tmp/aw-native-candidate.json --client codex --executable /absolute/path/to/codex --report /tmp/aw-native-report.json
# --install 替代 --executable：明确允许在临时目录下载固定公共 npm 包。
# --public-aw：另外验证公开 AW CLI，未取得生产资格的 scope 保持 unverified。
```

本地未提交源码的 SHA 仅标识 checkout 基线，实际候选字节由清单摘要标识；不能把本地报告称为该 Git commit 的干净构建。Actions 报告另绑定 run ID、attempt、runner image 和操作系统版本。远端执行要求工作流及对应源码已经存在于 GitHub。`workflow_dispatch` 入口要求工作流先存在于默认分支（[GitHub 事件规则](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch)）；显式 PR 标签入口允许合并前验证，并绑定该次 PR 合并候选 SHA。不通过该入口提交源码、发布产品或修改真实用户配置。
