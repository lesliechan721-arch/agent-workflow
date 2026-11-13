# 持续集成（CI）规范

本文件面向仓库维护者，定义官方 GitHub Actions 持续集成管线的职责、触发机制、矩阵配置、Windows 两套独立三路分片规则、自动 Beta 验证复用与产物验证边界。本地测试执行参见 [测试指南](testing.md)，发版流水线参见 [官方发布与失败恢复指南](release.md)。

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
- **Linux 插件环境**：Linux 插件测试执行独立的构建，并将构建出的 CLI 严格配置到 `PATH` 中。
- **矩阵复合 Action**：插件测试由普通矩阵 job 调用共享的 `.github/actions/plugin-tests` 复合 action，与其他测试平铺显示，覆盖 Linux x64、macOS arm64 和 Windows x64。

### 2.2 Windows 独立测试分片与长时任务（CI1）

为应对 Windows 上文件系统与子进程创建耗时较高的特点，Windows CI 分别为**普通集成测试**与**插件测试**设计了两套完全独立的 Runner、分片算法与超时配置：

#### 2.2.1 Windows 普通集成测试三路分片（Vitest Runner）

- **Job 名称**：`win32 x64 / Node 24 / integration 1 of 3`、`2 of 3`、`3 of 3`。
- **工作目录**：`packages/cli`。
- **执行命令**：
  ```bash
  node ../../scripts/test/run-vitest.mjs run --project integration tests/integration --shard "<index>/3"
  ```
- **并发与 Runner**：采用三个独立的 Vitest runner，默认使用 1 worker（并发解析遵循优先级：串行约束优先，其次显式参数，再环境变量 `AW_TEST_WORKERS`；CI 环境变量默认配置为 1）。
- **完整互斥校验入口**：
  为验证各分片在测试文件分配上的严格互斥与完整性，在 `packages/cli` 目录下执行：
  ```bash
  node ../../scripts/test/run-vitest.mjs list --project integration tests/integration --shard <index>/3 --json
  ```
  **必须使用 `list --shard --json` 检查，严禁使用 `list --filesOnly`**。
- **分片 3 附加任务**：
  除集成测试外，分片 3 额外承接串行 `process-lifecycle` 测试（`node ../../scripts/test/run-vitest.mjs run --project process-lifecycle --pool=forks --maxWorkers=1 --no-file-parallelism tests/integration tests/unit/test-command-diagnostics.test.ts`）、诊断回归以及 `pnpm test:smoke:pack:cli`。
- **作业超时**：该集成测试 Job 超时上限设置为 60 分钟。

#### 2.2.2 Windows 插件测试三路分片（Node File Shard）

- **Job 名称**：`Windows x64 / Node 24 / plugins 1 of 3`、`2 of 3`、`3 of 3`。
- **复合 Action**：调用 `.github/actions/plugin-tests/action.yml`。
- **执行命令**：
  ```bash
  pnpm plugin:test --all --test-concurrency 1 --test-shard "$env:TEST_SHARD" --native-mode source-candidate --native-context "$env:RUNNER_TEMP/aw-native-context.json"
  ```
- **分片分配算法**：
  Node 启动脚本按测试文件相对路径的字母顺序排序后轮流分配。分片绝不拆分单个测试文件。每个插件及其所选目标平台使用同一分片编号。
  新增或重命名的测试文件必须根据真实耗时测算平衡分配到各分片中；所有三个分片均属于发布前的必要检查项。
- **分片 1 附加任务**：分片 1 额外承接真实文件占用与跨卷移动资格测试。
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

[`native-platform-qualification.yml`](../../.github/workflows/native-platform-qualification.yml) 是独立手动工作流，不属于普通 PR 更新、自动 Beta 或发布通过门禁。可在 Actions 选择一个固定客户端或 `all`；首次工作流尚未进入默认分支时，也可手动给 PR 添加 `native-qualification` 标签运行全部客户端。只有本次添加该标签才触发，普通 PR 更新不触发；重跑使用 Actions 的 rerun 或重新添加标签。随后，使用 Linux、macOS、Windows 的 x64/arm64 托管 runner；矩阵失败互不取消，最多同时执行三个资格 job。只有实际运行成功的精确单元才构成证据，工作流文件存在不表示矩阵已通过。

候选 job 正式构建一次，运行资格执行器测试，记录源 SHA、全部 dist 和资格脚本文件摘要。各系统下载同一 JavaScript 候选并校验字节，不重新编译。Windows Job helper 由同一源 SHA 的既有 `windows-job.yml` 独立构建，完成固定工具链重建和两架构真实资格后，再从 `windows-job-qualified` 恢复。Windows runner 校验该候选及资格证据，使用现有 source test preparation 将适用 EXE 放入正常 optional 平台包，并先运行资格 harness；客户端报告记录实际 helper 字节摘要。客户端包名、精确版本和官方来源集中在 [`native-platform-runtime.mjs`](../../scripts/qualification/native-platform-runtime.mjs)；通过公共 npm 在临时前缀安装，禁用安装脚本，记录 lock 摘要和 package integrity，不使用浮动 latest。Codex 和 Claude 直接选择固定官方 optional 平台包的原生入口，校验包身份、精确版本并记录实际 binary 摘要；不运行复制 binary 的 postinstall，也不通过替换进程的 Node wrapper。缺少对应客户端分发或依赖安装脚本的入口须报告未验证/失败，不静默改用其他版本。 Copilot 固定版的本地插件与 Skill 命令显式使用 `COPILOT_OFFLINE=true`、`COPILOT_AUTO_UPDATE=false`，禁用网络和自动更新入口；该路径仍会查询客户端认证存储，不能将离线配置视为跳过认证读取。真实 Copilot 资格与追加取证使用全新无凭据 Hosted 环境。仅 Copilot Darwin 管理命令复用普通 CLI 的 observed marker/identity 观察：允许独立进程组，仍要求标记、PID/启动身份、原截止、确认清理及正常完成前已归属后代退出；该模式不是 Provider 评级或 OS 隔离证明。其他 Native 客户端与真正 Provider 的原合同保持。命令回执保存实际 containment、grading 与后代清理声明，旧严格合同下的离组失败保留原来源。

Hosted 工作流显式设置 `AW_NATIVE_QUALIFICATION_PROCESS_NAMES=1` 时，Copilot Darwin 管理命令及 Linux/macOS 公开 AW 观察启用私有进程名取证：对原 identity `ps` 查询同次附加 `ucomm` 列，再逐行投影回原五列。它消除二次查名的进程退出竞争，但读取全部行的有限进程名，并改变原查询输出量与失败面；timeout、maxBuffer、频率、信号和原错误保持，不增加查询或重试，无法可靠恢复 identity 行时查询失败，不能丢行后报告成功。完整扩展表只在内存中处理；仅缓存最近最多32个 root/后代身份，并在原离组或标记失败的 PID/启动身份交叉核对后附加最多8项 `processNames`。名称来自有限进程名，可能截断或变化，不是完整可执行身份；拒绝路径、控制字符或过长名称，不保存 argv、环境、marker 或原扩展表。名称不参与归属、信号、收尾或成功判定；停止后晚到回调仍恢复 identity，但不改变已保存的名称提示。未显式启用该 Hosted 开关的查询保持原样，Eval 的通用合同不变。

资格场景使用候选的真实 `projectPlatform` 和 Marketplace 投影生成普通 Skill 包，明确使用测试候选 profile，不改生产能力资格。真实客户端负责安装、更新、移除和只读发现；user/project 各有独立临时 HOME、AW/Agent/XDG 根及有效 Git 项目，neutral 工作目录位于其外。仅允许本地管理命令、Codex `skills/list`、显式项目 status 的 `config/read`，以及 Pi `get_commands/get_state`；不提供凭据、不登录、不发送 prompt、不调用模型、不连接已有 server。下载阶段可访问公共 npm，并可沿用 HTTP(S) 下载代理；此类网络传输认证不会传给客户端。下载子进程禁用安装脚本并有超时与输出上限；该阶段只使用有界的直接子进程管理，不声称已验证进程树。客户端阶段使用阻断代理，这不是 OS 网络防火墙。Linux/macOS 客户端进程默认使用既有 verified-observed 管理，Copilot Darwin 使用上述限定 observed 合同；Windows 从 Eval 自身依赖解析已准备的 helper，使用既有 Windows Job 管理后代进程，缺失 helper 时在启动前失败。两条路径均保留超时和输出上限，并在 finally 清理临时目录；这些机制不构成文件系统或网络容器隔离。

同一 Hosted 开关下，Linux 公开 AW 还在原 marker `ps` 回调中保存有限 negative 行的 PID/PPID/PGID/state/启动时间、查询序号及开始/回调时间，并将 command 仅分类为空、defunct、括号、方括号、方括号加 defunct 或其他。精确标记匹配和标记变量是否出现仅保留布尔；不保存原 command、环境、marker 或其摘要。不增加进程、查询、文件读取或 await，原 error/stdout/回调与截止不变；解析有少量 CPU 成本，不能作无插桩性能证据。无法解析的续行不留原文，只记录数量；最多缓存32行，原失败按 PID/启动身份及回调早于诊断筛选最多8行，注明缓存丢弃及输出省略数。同一身份可能对应多次查询，因此保留候选并明确关联歧义，不把最近一条当作原判定查询证明。该形态只作私有补证，不改变 unreadable、归属、失败或 cleanup 判定。 同一开关也为 Linux Gemini 原生管理命令记录上述行形态，仅从 root 的唯一有效随机标记赋值学习本次标记。重复出现的不可读行可异步读取该 PID 的 `/proc/PID/environ`，每条命令最多8个 PID/启动身份候选；每次读取共用原命令与该次查询截止的较早值，停止时取消，原 `ps` 回调不等待读取。环境物理读取最多64KiB加一个溢出字节，前后读取有限 `stat` 并比较 starttime；只保存固定状态、精确 NUL 项匹配布尔、字节数、时间及身份比较，不保存环境、标记、摘要或原始 ticks。空值、权限、截断、身份变化及截止仍为未知。这个身份比较只绑定该次文件读取，不能证明它与原 `ps` 属于同一次 exec 或原判定查询；原查询序号、关联歧义和失败均保留。读取结果不参与资格通过、归属或信号判定。

Hosted 工作流显式设置 `AW_NATIVE_QUALIFICATION_MANAGED_TRACE=1` 时，仅 Linux/Windows 的 Codex/Pi 公开 AW 进程通过 Node `--import` 加载私有托管调用取证。它复用既有 NativeCliRunner 接口并保留正式默认后端与 Windows helper 准备判定；只记录本次固定客户端入口匹配的逻辑命令、有限参数、开始/结束、AW 父 PID、退出/错误类别、是否有清理错误和宿主公开标记是否提供，不推断子 PID 或最终 marker 可读性。仅 Codex Marketplace 清单保留有限成功输出，失败保留有限 stderr；不记录环境，清除 marker 值与 UUID 形状。JSONL 只在本 scope 临时根新建，最多96条、256KiB，随后按原报告规则脱敏并随 scope 删除。记录错误不替代真实结果、对象或异常；这些调用仍受原截止，附加 IO/时间使其不构成无插桩性能证据。

公开 AW 命令的原 stdout/stderr 预览仍受原长度限制；失败时先从完整 JSON 提取有限 target、receipt effect、diagnostic 和实际 native identity 摘要，再做同一脱敏与长度限制。无效 JSON 明确标记，不从截断预览猜测结果；摘要不改变命令退出码或场景失败。

报告区分 Skill 发现、组件 inventory 和 activation inventory；Claude details 只证明组件清单。Copilot 项目 fixture 按固定版公开帮助显式设置 `COPILOT_ALLOW_ALL=true`，让宿主信任临时 project 与 neutral 目录；该变量还授予工具自动批准，但本 fixture 只有普通 Skill，不创建会话、发送 prompt 或请求工具，且不传给真实用户环境。project 与 neutral 仍分别要求启用/发现和禁用/不可见，不能靠用户级全局启用代替项目隔离。Copilot 的 live 来源先通过 uninstall 验证停用，再注销本测试独占的 marketplace，最后验证插件和 Skill 消失；project 管理查询未观察到配置生效时保留失败，不能直接推断宿主无 project 支持。

Gemini `0.67.0` 的项目 fixture 在原生 User disable/Workspace enable 后，只给目标扩展的 `extension-enablement.json` 条目前置一次 `!*`，保留后续项目规则及其他扩展条目。该固定格式按最后匹配规则决定启用；默认禁用使有效 HOME 外的 neutral 也不加载该扩展的 Skill。报告单独记录激活配置前后像，安装后和更新后均检查两处库存仍存在、Skill 仅在项目中发现，移除后两处均消失。结果覆盖显式原生配置前提下的生命周期；AW 项目生命周期保护、生产 profile 和跨版本承诺保持原状态。

每个 scope 记录断言、退出码、有限脱敏命令输出及清理结果，更新前另记录候选 revision 与投影摘要。直接客户端和 RPC 的进程审计失败也保留命令回执、已有输出及首次/末次 observer 元数据，不因 await 抛错而丢掉该命令。RPC 的 stderr 另包含最多32个单调时钟事件，记录请求/响应类型、是否收到结果、子进程 PID、信号、exit/close 及进程组等待顺序，不记录响应正文、命令文本、环境或 marker。组检查失败另给出有限分类：查询启动/返回、输出格式、PID、自身组/缺行或组内未知状态。仅保留允许的系统错误字段、数字 PID/PGID、行数及 helper/inspector/member 角色；不记录原始进程表或状态文本。事件仅用于归因，不改变原失败退出、RPC 响应、15秒请求截止、500ms SIGKILL 后备或完成前后代退出门槛。

POSIX RPC helper 在直接客户端关闭后、输出 JSON 前，等待初始进程组内的其他活进程自然退出，不向这些后代发送新信号。每次串行查询必须成功并已关闭，包含 helper 自身且确认其 PID 等于 PGID；只排除自身、该次查询进程及明确 zombie。缺失或无效快照、未知状态及查询失败都不能视为空组。macOS 可能在进程退出时短暂返回未知状态；helper 只允许一次新快照确认，并等待该查询关闭。只有新快照明确证明组内已无活成员才成功，持续未知或无效查询仍失败。确认共用原绝对截止。等待使用 helper 本次执行起22秒的绝对截止，保留原25秒外层时限和失败清理空间；到期不输出成功 JSON。此等待只处理 helper 内部收尾，外层仍持续核对 marker、启动身份和初始进程组，离组、已锁存的观察失败及最终清理失败均不能被空组覆盖。Windows 保持原 Job 路径。它证明的是 helper 管理下的会话完成，不证明客户端独立运行时自行等待后台任务，也不提供额外 OS containment。

断言失败终止该 scope 的后续步骤，另一 scope 和客户端仍继续。Grok 项目目录仅观察 inventory，没有已验证的公开启用/信任流程；Gemini 项目 neutral 隔离和 Grok 本地更新必须按实际行为判定，不因为是已知问题而算通过。失败和未验证均返回非零，报告通过 `always()` 上传并生成 job summary，保留14天；需要长期引用的通过证据另按固定资格归档规则保存。

托管入口另启用 `--public-aw`，为 Codex/Pi 以及已开放的 Grok User 添加独立的公开 CLI 场景；Copilot 已接入同一原生/公开 `skill list --json` 读取器，CLI `1.0.95` 在六个记录环境的 User/Project 普通 Skill profile 已按原生记录开放；公开链是否通过仍由对应新报告单独证明，其他版本、环境、组件和产品面不继承。Copilot 原生命令的有效字段与返回形状保持，匹配 Skill 缺少明确布尔启用状态时失败；公开观察使用实际公开修订的描述，并区分 neutral 中禁用与 remove 后完全消失。公开 Project 场景在 profile 满足后，才于无凭据 Hosted 临时环境沿用显式 `COPILOT_ALLOW_ALL=true` 前提，记录其工具批准副作用但不发送工具或模型请求；不手工补 activation 来替代 AW 生命周期。各客户端实际运行的结果位于各客户端的 `publicAw`，与候选投影的 `scopes` 分开。它只在临时前缀暴露本次固定入口，使用公开 `target set` 验证身份；Windows npm 入口仍经过正常包身份、bin、路径及 shim 校验。生产普通 Skill profile 尚未开放时，该 scope 返回 unverified，不用候选 profile 或 force 绕过。已开放时，通过公开 Catalog/plugin 创建、构建及 path source 准备，执行 plugin install、来源及插件更新、status、remove，再用每次新启动的只读 RPC 或 CLI 清单（Grok 为 `inspect --json`，Copilot 为 `skill list --json`）检查正文 revision、作用域及移除后消失。项目 trust 是显式临时宿主配置，独立于 AW `--yes`。Codex 项目公开 status 显式使用 `--observe-native` 并要求副作用 warning；只在本次无凭据、网络阻断的临时 HOME 读取有效信任，普通 status 的只读默认不变。发现的其他产品面仍保留限制，status 受阻也不能算通过。Grok User 首次公开 install 必须精确返回已保存需求、完整 AW 自有 source 和仅 `nativeTrustRequired` 的预期 partial；校验来源与完整字节后只对该自建 source 显式授信，再由公开 sync 完成。其他 partial 仍失败，Grok Project 写前保持 unverified。Claude/Gemini 尚未接入该公开观察，明确返回 unverified；Copilot 只有满足精确有限 profile 的单元才进入公开链，其他单元继续 unverified，原 Native 场景照常运行。客户端及整体状态同时计入两个场景，任一失败或未验证不会被另一场景的通过覆盖。

POSIX 公开 AW 命令会管理独立的原生命令进程组，不套用 custom provider 必须共享初始进程组的合同。该包装复用现有 lease、持续 marker/启动身份观察及收尾：检查失败立即中止，正常完成时必须已无活后代，marker 丢失、检查失败、清理或 lease 释放失败都不能变为成功；取消、超时和输出超限也失败。它明确报告 `observed`、`gradingEvidenceAccepted:false`、`descendantCleanupGuaranteed:false`，不是 provider grading 或 OS 强隔离资格。失败时保留首次和最后一次 observer 的有界进程元数据，不保存命令文本、环境变量或 marker；子命令已有输出仍只按原规则限量脱敏，不能由其退出码覆盖审计失败。Windows 公开 AW 保持原 Job 路径；直接客户端除上述 Copilot Darwin 例外外，与 RPC 保持原 verified-observed 合同。公开入口比较先解析文件系统规范路径，不把 Windows 扩展名大小写差异当作另一个入口，也不将全路径小写。报告同时替换普通和 JSON 嵌套身份中的转义路径。

本入口仍不覆盖全部平台的完整公开 AW install 编排、独立 tarball 到真实模型消费、模型/调用控制、MCP/Hooks/Agents/Instructions 执行、普通对话会话、Desktop、最低版本矩阵，以及尚未接入的 Antigravity/Cursor/OpenCode。OpenCode 2.2.6 standalone 在 Unix 分离进程组，不满足当前收尾合同，其冷启动清单也未等待插件激活，因此该探针未纳入可执行矩阵；这些观察不能据以判定生产能力不支持。Cursor 目标 Hook 已观察到需要登录；Antigravity 固定版本分发与无认证管理入口仍缺少验证。它不申请 Secrets，也不使用自托管 runner。取得报告后仍需核对具体资格范围，不能自动将 production profile 提升为 supported。

本地复现先运行 `pnpm build` 和 `pnpm test:qualification:native-platforms:harness`，再创建候选清单并显式选择已安装入口或临时下载：

```bash
node scripts/qualification/native-platforms.mjs --write-candidate /tmp/aw-native-candidate.json --source-sha "$(git rev-parse HEAD)"
pnpm qualification:native-platforms --candidate /tmp/aw-native-candidate.json --client codex --executable /absolute/path/to/codex --report /tmp/aw-native-report.json
# --install 替代 --executable：明确允许在临时目录下载固定公共 npm 包。
# --public-aw：另外验证公开 AW CLI，未取得生产资格的 scope 保持 unverified。
```

本地未提交源码的 SHA 仅标识 checkout 基线，实际候选字节由清单摘要标识；不能把本地报告称为该 Git commit 的干净构建。Actions 报告另绑定 run ID、attempt、runner image 和操作系统版本。远端执行要求工作流及对应源码已经存在于 GitHub。`workflow_dispatch` 入口要求工作流先存在于默认分支（[GitHub 事件规则](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch)）；显式 PR 标签入口允许合并前验证，并绑定该次 PR 合并候选 SHA。不通过该入口提交源码、发布产品或修改真实用户配置。
