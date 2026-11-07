# 平台边界与平台策略架构说明

本文件面向仓库维护者，定义目标客户端环境解析、Codex 原生 Marketplace 投影与 Project Activation、Claude Code 边界与未绑定记录保护、Portable 跨平台技能分发、以及 Windows 原生辅助工具的内部架构与安全策略。面向插件作者的运行时与命令合同参见[插件运行时合同](../../reference/plugin-runtime.md)、[托管命令合同](../../reference/managed-commands.md)与[原生工具合同](../../reference/native-tools.md)。

---

## 1. 宿主目录与环境边界

<a id="11-生产-agent-目录解析"></a>
### 1.1 生产 Agent 目录与家目录解析

生产环境只使用以下权威环境变量定位客户端目录，严禁硬编码或跨平台猜测：
- **Codex**：使用 `CODEX_HOME`；缺省时回退至用户家目录下的 `.codex`。
- **Claude Code**：使用 `CLAUDE_CONFIG_DIR`；缺省时回退至用户家目录下的 `.claude`。
- **家目录解析**：依据 Node `os.homedir()` 合同：Windows 使用 `USERPROFILE`，POSIX 使用 `HOME`，缺失时回退系统用户目录。
- **Windows 环境变量特性**：Windows 环境变量名不区分大小写，重复键按 Node 子进程的排序选择规则解析。
- **非法安装路径拒绝**：空值、相对路径及 Windows 缺少 drive 的根相对路径直接拒绝，不能成为安装目标。
- **测试隔离保证**：`AW_CODEX_HOME` 与 `AW_CLAUDE_HOME` 仅为测试资产，**绝对不参与生产路径解析**。
- **输入隔离与 OS 沙箱区别**：在执行 renderer、Review 物化和插件脚本时，显式使用临时正式 Agent homes、HOME/USERPROFILE 与 XDG，不继承真实路径。该输入隔离是路径与配置层面的上下文隔离，**不是操作系统级别的强制沙箱（OS sandbox）**。
- **命名空间市场根路径检查（isSafeCodexMarketplaceRoot）**：
  - 规范 Marketplace root 必须严格为 `<AW_HOME>/marketplaces/<sourceId>`（`packages/cli/src/utils/codex-marketplace-path.ts`），读写两端统一复用该检查；
  - `awHome` 必须已存在且为无符号链接的普通目录（`lstat.isDirectory() && !lstat.isSymbolicLink()`）；
  - `marketplacesRoot`（`<AW_HOME>/marketplaces`）与目标 `expectedRoot` 允许尚不存在（初次物化或未投影时不要求用户预建）；存在时须为无符号链接的普通目录；存在的 `marketplacesRoot` 的 `realpath` 须等于规范物理 `canonicalAwHome` 下的 `marketplaces`，存在的 `expectedRoot` 的 `realpath` 须等于该 `canonicalMarketplacesRoot` 下的 `sourceId`；
  - 严禁任何路径逃逸、重解析点或符号链接欺骗；若安全检查未通过，立即触发 `marketplacePathUnsafe` 阻断（fail closed）。

### 1.2 Project Home Alias 例外

当 Codex project config 的规范路径与 Codex user home 相同时（即用户直接在自己家目录作为项目工作区）：
- `status` 不重复读取或投影 project activation；未发现 project owner 的默认 status 不生成 project placement；显式 project status 报告路径别名（path alias）。
- `install`、`sync` 和 `reinstall` 不向这个 project placement 写入，用户必须进入独立项目目录。
- `cleanup` 和 `uninstall` 仍可正常处理已有的 project owner。

---

<a id="2-codex-原生-marketplace-投影"></a>
## 2. Codex 原生集成、Rollout 门禁与 Project Activation

### 2.1 Codex 最低版本门禁与发现规则

- **最低版本要求**：Codex 最低版本必须满足 `>=0.151.0`。低于该版本直接返回稳定错误，**绝不把其它版本的行为外推到 rollout allowlist**。
- **PATH 遍历与 App 发现算法**：
  1. 遍历 PATH 的各目录，再发现 App 内置 CLI；合并所有候选并按真实入口去重。
  2. 对每个可执行文件执行带超时和输出上限的 `--version`，沿用 strict SemVer 解析与版本比较。
  3. 选择版本最高者；版本相同时 PATH 优先，再按稳定发现次序选择；Windows 查询结果先做规范排序。
  4. **安全启动入口**：保留 POSIX 可执行入口和 Windows 官方 npm launcher 的安全解析边界，严禁执行 shell alias 或 shell function。
  5. **macOS 校验**：检查 `~/Applications` 与 `/Applications` 中的 `Codex.app`、`ChatGPT.app`，要求 bundle ID 必须为 `com.openai.codex`，且 `Contents/Resources/codex` 的真实物理路径仍位于 bundle 内部。
  6. **Windows 校验**：从已注册 `OpenAI.Codex_*` 的当前架构或 Neutral 主包发现 `codex.exe`，严格检查 reparse/symlink 与包内边界，遍历深度最多 16、检查项最多 50000。
  7. **Linux 规则**：仅使用 PATH 发现。
  8. **产品版本解耦**：App 界面产品版本不参与 CLI 版本比较。

### 2.2 Native Kind Rollout Allowlist 与真实资格验证

- **显式资格验证门禁**：每种 native kind 必须先通过显式真实资格验证（Rollout Qualification）才能进入 rollout allowlist。未被实际行为证据证明的 kind 必须返回 `unsupported`，**严禁从帮助文本、源码字符串或相邻 kind 猜测推断支持**。
- **当前资格状态**：在当前 `0.151.0` qualification 证据下，证明支持：`Skill`、`MCP`、`Hook` 和 `App`；而 `slash command` 因缺少可用的离线运行时证据，继续保持 `unsupported`。
- **资格验证工具（Qualification Scripts）**：
  - `pnpm qualification:codex-project-native`：专用于 `0.151.0` rollout qualification。
  - `pnpm qualification:codex-native-performance`：按 `CODEX_QUALIFICATION_VERSION` 和 `CODEX_QUALIFICATION_CLI` 显式验证 `0.151.0` 或 `0.153.0`。两个版本都必须接受 `plugin list --marketplace <name> --json`；`0.153.0` 的本地 marketplace scoped list 还必须在阻断 proxy 的隔离环境中成功，不得依赖远程 Catalog。代表性本地 native plugin 安装运行五次，安装耗时中位数必须严格低于 15 秒（`INSTALL_MEDIAN_BUDGET_MS = 15000`），无任何相对改善替代分支；具体执行与门禁要求参见[测试指南](../testing.md#coverage-and-smoke-commands)。精确 binary 缺失时报告 `missing`，绝不自动下载或把 fixture 结果作为真实性能证据。
  - 资格验证环境完全基于临时目录，不修改真实用户配置，不作为安装账本或运行中 App 自动刷新的证明。

### 2.3 Project Activation 最低行为合同

Codex 项目激活行为严格遵守以下最低合同：
- `native add` 默认创建 user enabled。
- `user=false, project=true`：仅在受信任的精确 project cwd 加载。
- neutral cwd 不加载 project activation。
- `user=true, project=true`：在用户和项目两处加载同一 shared native plugin。
- project trust 未生效时，project-only activation 绝不加载。

<a id="23-状态观测与私有缓存保护"></a>
### 2.4 静态与动态 Shared Package 区分与维护

- **Static Package（静态包）**：
  - 静态包由整个插件统一物化，**没有逐 Skill 的 AW-owned 独立组件**；
  - 不按逐 Skill 独立执行预检、写入或清理，缺失逐 Skill marker **绝不阻断重建或清理流程**；用户手动修改文件可能导致覆盖。
- **Dynamic Receipt 与平台诊断**：
  - 动态包由 AW 生成 `.agents-plugin/aw-codex-native-render.json` 记录规范化 identity 和 digest，该 receipt 仅作为可重建的现场诊断证据，不是持久 ledger。
- **五态判定唯一收敛**：
  - 共享 Native 的五态分类（`usable` / `missing` / `replaceable: outdated | damaged | renderDrift` / `blocked: foreign | unreadable` / `unobserved`）与完整判定规则统一收敛于[状态与配置架构说明 §2.2.2 共享 Native 五态与诊断判定](config-and-status.md#shared-native-classification)。
- **Native 安装与移除的精确 Postcheck**：在执行原生安装或移除（install / remove）后，必须通过官方 scoped list（`codex plugin list --marketplace <name> --json`）执行精确后置检查，确认插件处于预期的 `installed`（且版本匹配）或 `absent` 状态，后置校验失败如实报告阻断，不伪造成功。
- **私有缓存保护**：Codex private cache 不驱动 replace 或 remove，AW 绝不主动删除或修改其私有缓存。
- **旧环境清理**：旧 Codex direct MCP/Hook residue 不由新 CLI 扫描、重建或删除；保留旧环境时需使用旧 CLI 执行 cleanup。

---

## 3. 原生分组物化、Claude 边界与 Portable 跨平台技能

<a id="21-分组物化与原子更新"></a>
### 3.1 原生 Marketplace 物化分组与提交顺序

一次写操作按 `sourceId + sourceIdentity + marketplaceName + normalized marketplaceRoot + platform` 分组执行原生 Marketplace 物化：
1. 汇总全部涉及 target 的动态 native overlay。
2. 仅执行一次目录复制、staging 完整验证、原子切换（atomic swap）与提交。
3. **同源根与依赖单轮生成**：同 source 的 root plugin 和所有依赖只执行一轮 Catalog copy、staging generation、atomic swap 和 commit，不受插件数量影响。

### 3.2 底层生命周期清理与 Native Remove 的显式顺序例外

通常情况下，共享投影提交必须早于针对该分组的 plugin add/remove/activation。然而，**实际需要原生移除（native remove）的底层生命周期清理存在显式例外，不进入普通重建顺序**：
- 在实际执行 native remove 时，必须**保留目标插件的 marketplace 投影与归属证据，先完成原生卸载及 absent 后置检查，再移除该插件投影并保持其他插件有效**；
- 若原生卸载或后置检查失败，必须**完整保留重试所需的 marketplace 与 ownership 证据**，如实报告失败或部分完成；
- 其他常规 native materialization 的共享投影 commit 必须先于该组的 plugin add/remove/activation；
- 分组 materialization 失败时，该组不启动 native mutation；commit 后逐 target 执行平台 mutation；单 target 失败不回滚共享投影，也不回滚其它 target 已成功的物理结果。

<a id="22-市场命名规则"></a>
### 3.3 市场命名与冲突 Fail Closed

- primary 来源默认使用 `aw` marketplace。
- 若用户级 Codex 或 Claude 的 `aw` 名称已被旧版或外部（foreign）来源占用，首次安装自动切换为带来源绑定的 `aw-<sourceId>`；两个平台使用同一名称。
- 已有 canonical 注册决定命名；若候选名称被 foreign 来源占用，立即安全失败（fail closed）。

<a id="3-claude-code-边界与未绑定记录保护"></a>
### 3.4 Claude Code 边界与未绑定记录保护

- **未绑定裸记录（Bare-key Records）保护**：
  Claude 合法的未绑定默认安装记录不属于任何 marketplace。来源 inventory 必须完整保留并忽略它们，**严禁将其推断为 canonical 或 foreign**。
- **重名安全门禁**：在执行原生安装前，若任意 scope 存在与目标原生插件名称相同的未绑定 bare-key 记录，写命令必须在任何清理、镜像或 native CLI 调用前安全失败（fail closed）；不同名记录继续保留并忽略。
- **清理与卸载限制**：`cleanup` 和 `uninstall` 绝不删除、迁移或重命名未绑定记录。
- **沙箱排除语法**：通过在 permissions 中输出带 ` *` 结尾的前缀与 `Bash(...)` 包装，精确适配 Claude 沙箱排除规则。

<a id="4-portable-跨平台技能分发与进程收尾"></a><a id="41-跨平台适配器skills-adapter"></a><a id="42-有限进程收尾与-cwd-释放"></a>
### 3.5 Portable 跨平台技能分发与有限进程收尾

- **不受实测架构限制**：Portable 跨平台技能从统一 skills 来源生成，支持不受实测 OS/架构范围限制。
- **当前 AW Portable Writer 架构**：
  - 当前实现（`packages/cli/src/portable/recovery.ts:365–370`、`recovery-layout.ts`、`writer.ts`）由 AW 直接拥有并执行，CLI 展示标识为明确的 `AW Portable writer`（`portable/commands.ts:20`）；
  - 通过 `publishPortableSkill` 与 `removePortableSkill` 直接向受支持 Agent 的固定物理消费目录（`portableRecoveryLayout`，如 Antigravity 的 `.gemini/config/skills`、Cursor 的 `.cursor/skills`、通用 Agent 的 `.agents/skills` 等）物化或清理 Skill 目录；
  - 写入与清理前执行严格的目录、归属（`identity: target.ownerIdentity`，`ownership: 'aw'`）与内容哈希校验（`expectedDigest`、`configDigest`），完整归属与恢复合同参见[插件运行时合同](../../reference/plugin-runtime.md)与[插件生命周期](lifecycle.md#ownership-与删除权限)；
  - 真实验证按实际平台分别记录，未实跑平台明确为待验证。
- **历史 Skills Adapter 范围限定**：
  - 早期通过第三方 Skills CLI adapter 解析 provider 源码路径、在 Windows 上核验 npm/pnpm shim 与 package bin、以及 `portableSkillsCliCleanupFailed` 错误码的执行逻辑，**已明确限定为历史 provider 范围**；
  - 现有产品与运行时已全面改由 AW Portable writer 负责，不再维护该外部 adapter；测试套件中的 `qualification:project-skills-provider` 仅作为历史 provider 资格记录，不代表当前 AW writer 的运行证明。
- **禁止降级**：原生失败绝不自动降级为 Portable。
- **资格报告边界**：Qualification 报告不作为安装账本或运行中 App 重新加载的证明。

---

<a id="5-windows-原生辅助程序windows-job-helper"></a>
## 4. Windows 原生辅助程序：文件与进程安全

权威实现位于 `native-tools/windows-job/`（Go 实现），拥有文件安全、进程观察和 Job 管理的唯一 Go 源、固定工具链和候选制品，版本与 CLI 产品完全保持一致。`aw-windows-job.exe` 仅使用固定操作集合和有界 UTF-8 JSON，**绝对不接收脚本文本**。

### 4.1 独立进程模型与生命周期

- **短命进程与专有监护**：文件和进程操作每批启动一个短命子进程；每次执行的 Job 仍由专有独占监护进程持有，**绝不使用共享后台服务、跨进程权限缓存或新增锁**。

<a id="52-安全对象管理acl-与-job"></a>
### 4.2 文件与目录安全操作门禁

- **拒绝重解析点**：文件与目录操作严格拒绝路径链和树中的重解析点（reparse points/junctions）与错误节点类型。
- **独占资源安全 ACL 初始化**：
  - 安全 ACL 初始化**只用于调用方本次成功独占创建的资源**。
  - Windows 新对象可能默认归属于 token 中的组，初始化将 owner 设置为当前用户，并使用同一已打开句柄回读 owner 和受保护 DACL。
  - **已有资源只验证，绝不重新初始化**；每个目标单独验证。
  - NULL、空、foreign、inherited、deny 和不支持的 ACE 均不能作为私有访问的证明。
  - 祖先检查仅在当前批次复用，下一次读取和删除前必须重新验证。
- **根目录无覆盖移动发布**：
  - 运行根目录使用**无覆盖移动发布**（move-without-overwrite），与 JSON 文件的替换发布明确区分。
  - 若已有文件或目录占据目标根目录，保留现场并验证现有根，仅清理本次产生的空临时 staging 目录。

### 4.3 进程快照与高精度时间戳比较

- **PID/PPID 观察属性**：进程快照中的 PID/PPID 只是瞬态观察结果。已有归属链或待确认 PID 无法读取时，清理保持未确认。
- **高分辨率时间戳精度**：
  - CLI 锁保留完整 100 ns 精度的 `win32:<.NET ticks>`；
  - 插件和 Eval 保留 CIM 的微秒精度，时间以十进制字符串传输。
  - 旧 `instance:<token>` 与启动时间身份不可比较，活跃 PID 不因两者字符串格式不同而失去锁。
- **安全停止与句柄校验**：停止进程时，必须在同一个打开句柄上严格核对创建时间戳和 token SID，核验一致后再终止并等待退出。
- **单进程 SID 缓存**：`whoami.exe` 读取当前用户 SID，并仅在单进程内存生命周期内缓存成功结果。

---

## 5. Windows 原生辅助程序：Job 管理与交付流水线

### 5.1 Windows Job 隔离与执行合同

- **接口合同分工**：
  - Eval 模块调用保留 `--config`、stdio、argv 和退出码合同。
  - 插件模块调用使用独立的私有命名 Job、owner SID、受保护 DACL、名称碰撞拒绝和 ready 通道。
- **挂起启动与强行绑定（`KILL_ON_JOB_CLOSE`）**：
  - 无论是 Eval 还是插件，均先以挂起（suspended）状态创建 root 子进程；
  - 成功将 root 进程分配加入配置有 `KILL_ON_JOB_CLOSE` 的专有 Windows Job 对象后，方才恢复（resume）子进程执行；
  - 若加入 Job 失败，立即终止子进程，**绝对不得降级为仅按 PID/PPID 执行**。
- **后代收敛与 Job 审计**：
  - 当父进程退出、超时中断、主动取消或 root 正常退出后，Windows 内核自动清理并终止 Job 内所有后代进程。
  - 停止后必须通过 Job accounting 确认 Job 内进程计数已归零。
- **环境与模块路径继承**：插件后端完整继承原环境、工作目录和 stdio，包括 PowerShell 模块路径（`PSModulePath`）的有值和缺失状态。

<a id="51-架构与产品包交付"></a>
### 5.2 原生工具构建与交付边界

- **双架构独立交付**：
  - 显式原生构建生成两架构 EXE：`win32-x64` 与 `win32-arm64`，并连同平台 archive 和构建证据输出至 ignored staging。
  - EXE 仅打包发布至对应的 `os/cpu` 专属 npm 平台包中。
  - **干净源码与纯净主包**：源码树、Catalog 仓库及三个通用 npm 包（`@lesliechan721/aw` 等）**严禁包含 EXE 二进制文件**。正常安装不编译 Go，也不运行下载或复制 EXE 的 postinstall 脚本。
- **发布准备与资格验证**：
  - CLI 发布准备构建本次工具，并以同一组五包通过固定工具链重建、在真实 Windows x64 与 arm64 上完成资格验证，并执行六平台候选 smoke 测试。
  - Catalog-only 流程使用固定的已完成渠道 CLI，不编译 Go。
  - 升级 CLI 配套工具不改变插件声明，无须插件重新发布、重装或单独 Review；插件改变协议或消费者时仍走现有 Review。

### 5.3 低频 PowerShell 查询例外

为避免不必要的子进程开销，系统对 PowerShell 的调用施加严格限制：
- **受保护的低频例外**：仅低频 Codex App 注册包发现（通过 Get-AppxPackage）和用户剪贴板操作允许使用固定的单行 PowerShell 查询。
- **CI 与测试隔离**：CI 外层的 `pwsh` 运行、独立 ACL 核验、文件占用与跨卷资格验证属于构建与测试基础设施，不属于产品运行时重复启动 PowerShell 的替换范围。
