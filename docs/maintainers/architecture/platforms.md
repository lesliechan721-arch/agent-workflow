# 平台边界与平台策略

本主题定义客户端发现、固定原生路由、物理部署、能力依据和平台安全边界。作者字段见[Manifest](../../reference/manifest-and-config.md)，动态组件见[运行时](../../reference/plugin-runtime.md)，维护编排见[生命周期](lifecycle.md)。Windows 辅助工具的执行与交付规则在本主题后半部分。

## 1. 客户端与可用性

target 为 codex、claude、antigravity、cursor、opencode、pi、gemini、copilot、grok、generic。具体 Agent 使用原生包或原生扩展，必要宿主资源由 AW 明确托管；generic 仅管理通用 Skills。Native 失败不改走散文件安装。

CLI/TUI 共用只读发现与 adapter 注册表。可用性分为 available、missing、unsupported、unknown、notApplicable（仅 generic）。它与用户选择、插件能力、实际安装、登录和模型可用性分开。同名可执行文件或配置目录不能证明身份；probe 有时限、输出限制和安全诊断，不下载、不登录、不调用模型。

一个 target 包含本机已识别且受支持的 CLI/App；Claude 与 Copilot 只识别 CLI。未安装的另一产品面不自动成为要求。某产品面可用即可选择 target，其他已发现面仍保留限制；没有基础可用路径时依事实报告 missing/unsupported/unknown。App 已存在但缺少可用入口不能报 missing。发现覆盖不足也不能报 missing。

### 1.1 宿主根与固定版本条件

Codex 使用 CODEX_HOME，缺省用户 .codex；Claude 使用 CLAUDE_CONFIG_DIR，缺省用户 .claude。家目录遵循 Node os.homedir 与当前 OS 规则，Windows 环境名不区分大小写。空、相对或 Windows 缺 drive 的路径拒绝。AW_CODEX_HOME/AW_CLAUDE_HOME 不参与生产解析。其余平台只采用该路由公开根，不推测私有 cache。

| 平台 | 接口最低条件 | 产品面与发现边界 |
| --- | --- | --- |
| Codex | CLI 及 App 内置 CLI 均 >=0.155.0 | PATH 与已确认 App 入口，macOS bundle ID com.openai.codex；Windows 已注册 Codex package；Linux 仅 CLI |
| Claude Code | CLI >=2.1.292 | 仅 CLI |
| Cursor | Desktop 3.29 发布线；CLI build >=2026.11.05-86047df | CLI 与 Desktop，分别按各自版本序列；workspaceOpen 路径 |
| Antigravity | CLI >=1.3.4；App 目录路由不套 CLI 数字门槛 | CLI 与已确认 App 的公开发现目录 |
| OpenCode | 实际本地 runtime >=2.0.0，V2 API | CLI 与 Desktop 本地 server；远程连接不代表本机包可加载 |
| Pi | 核心 >=1.0.0 | CLI；Agents 消费者身份/版本另验 |
| Gemini CLI | >=0.63.0 | CLI，preview/许可按组件判断 |
| Copilot CLI | >=1.0.95 | 仅 CLI，保留 managed/repo overlay |
| Grok Build | install/list JSON/enable/disable/update/uninstall 与 trust 接口合同 | CLI；没有已证明数字最低版本 |
| generic | 无客户端条件 | notApplicable，手动选择，不默认勾选 |

数字门槛是必要接口条件，不是完整运行资格。无需 CLI 且没有必要版本门槛的目录路由，身份和接口已确认时可 available，另显示版本未知；代码扩展仍检查实际 runtime API。未核验的 OS、产品面、消费者或子能力保持 unverified，不由相邻版本或文档推定运行成功。

Codex 发现复用安全 PATH/npm launcher 与 App 边界；App 内置入口须在合法 bundle/package 内，版本同样通过。macOS 检查 ~/Applications 与 /Applications；Windows 校验注册身份、架构、路径链和有界搜索。单候选失败保留安全诊断，继续独立候选。多个产品面在同一 target 下分别保留，不以最高版本结果覆盖另一个面。

### 1.2 身份与物理实例

逻辑需求、产品安装、包位置、render scope 和 activation scope 分开。产品 ID 绑定平台、产品面、规范入口和配置根；版本是可变证据。部署绑定 sourceIdentity/pluginId、平台、需求 scope 与真实 route/位置。

physicalKey 为 sha256: 加下列对象的规范序列化完整 SHA-256 小写 hex，规范序列化复用[命令身份](../../reference/managed-commands.md#a4-稳定-id-与物理实例)：

~~~ts
interface PhysicalIdentity {
  sourceIdentity: string;
  pluginId: string;
  platform: PlatformId;
  route: InstallRoute;
  namespaceRoot: string;
  resourceKey: string;
}
~~~

namespaceRoot 是稳定公开安装命名空间：CLI 注册使用实际配置根，目录路由使用公开发现根，补足使用 scope 的受管入口根，generic 使用通用输出根。已有路径 realpath；缺失目标从已存在祖先解析再拼接验证过的相对路径。Windows 不将全路径小写。resourceKey 是稳定原生包逻辑键，补足包含固定类别槽。版本化 cache、staging、Skill resourceRoot 和配置值不进入身份。

共享真实位置的 CLI/App 与多个 activation 复用同一 key，不同配置根/发现根分别生成。含不同 placement 命令记录的包必须分开物化，不能只分 key 却覆盖同一目录。AW 来源目录按固定平台和 namespace 分组，writer 对计算出的精确 AW 根验证，不接收作者路径。源别名重绑定不能认领旧 sourceIdentity 的包。

activationKey 另含启用位置与需求 scope。身份字符串、路径存在或需求记录本身均不授予删除权；归属和共享检查仍由现有公共管线执行。

### 1.3 固定 render scope

| 路由/输出 | render scope |
| --- | --- |
| Codex 原生包（Skills/MCP/Hooks/Instructions） | user |
| Codex Agent 角色补足 | 角色真实 user/project 位置 |
| Claude、Gemini、Copilot 共享包 | user；项目需求只改变 activation |
| Cursor 独占包 | 对应 user/project，同 scope 产品面共享 |
| Antigravity CLI | user |
| Antigravity directory、OpenCode、Pi | 真实 user/project 包位置 |
| Grok | CLI 为 user，项目目录为 project；包与规则分单元但同 scope |
| generic | 真实通用输出位置，只含 skill |

同物理单元只计算一次，使用全部已知实际消费者共同能力和 canonical 配置。project-only 后新增 user 或只同步一 scope 都不能改变共享包配置来源。artifacts.scopes 按 render scope 判断，不能借项目 activation 改写 user 包。若同 physicalKey 的 scope、类别布局、来源或最终集合冲突，返回 shared-projection-conflict，保留旧包，其他独立分组继续。

## 2. 原生包、正文与 lifecycle 路由

| 平台/route | 包与能力投影 | ensure/refresh 与撤销 |
| --- | --- | --- |
| Codex / codex-marketplace | .codex-plugin；包内 Skills/MCP/Hooks，Instructions 用 SessionStart/SubagentStart 直接 additionalContext；Agent 角色为对应 scope 的 agents TOML | Marketplace/add 与 scope activation；刷新按审核 remove/add；撤销先 activation，无引用才 native remove 与精确补足清理 |
| Claude / claude-marketplace | .claude-plugin；五类包内，Instructions 合并主/子代理 Hook 直接正文 | Marketplace install/update，user 或项目 local scope；卸载后清理无引用 AW 来源 |
| Cursor / cursor-workspace-hook | .cursor-plugin，rules 为 alwaysApply，宿主 workspaceOpen 返回 pluginPaths | 完整包发布后精确合并对应 scope Hook；撤销 Hook 贡献再清包 |
| Antigravity / antigravity-cli | .antigravity-plugin，Skills/MCP/Agents/Hooks/Rules | 本地 install/list JSON；更新先准备，再审核 uninstall/reinstall；disable/uninstall 后观测 |
| Antigravity / antigravity-directory | 同一格式，公开 App 用户目录或项目 .agents/plugins | 精确独占目录发布/更新/撤销，不修改 CLI 私有状态 |
| OpenCode / opencode-directory | V2 Plugin.define，skill/mcp/agent transform、tool/session hook；context hook 直接追加 system 正文 | 公开本地插件目录；更新后 reload/新会话，移除独占包；不写远程 server |
| Pi / pi-package | pi package Skills；MCP 与 Hook/Instructions extension；Agents 仅 Markdown 加 pi.subagents.agents 声明 | pi install 本地来源，项目 --local；对应 scope remove 后清理包，不安装/移除 Agents 消费者 |
| Gemini / gemini-extension | extension Skills/MCP/preview Agents/Hooks/contextFileName；AW Agent 组合自身 Instructions | 本地 install/update 与 user/workspace activation；先停用需求，无引用再 uninstall |
| Copilot / copilot-marketplace | 标准1.0包及 com.github.copilot Agents/Hooks/Rules；AW Agent 组合正文 | 本地 Marketplace/install；user 与 repo enabledPlugins 分开；目录更新由新会话/restart读取 |
| Grok / grok-cli、grok-directory | .grok-plugin 的四类包及同 scope AW rules，AW Agent 组合正文 | user 本地原生命令；project .grok/plugins 独占目录；启用/trust/实际来源单独观测 |
| generic / generic-skills | 通用 Skills writer | 精确 owner/digest 写入与清理，无原生注册/激活/加载承诺 |

所有路径按已核验 profile 开放，表格描述固定适配方式，不是各版本/OS 的全能力资格表。未知能力须在组件缺口中列明，不能复制资源后报告完整成功。

Codex Instructions 不写顶层 developer_instructions 或共享 AGENTS；角色本身的 prompt 仍属于 Agent。直接注入覆盖受支持的 Startup/Fork，接受子代理压缩后不再注入的限制。Hook 禁用、trust 或管理策略受限时保持未满足，不回退其他载体。Claude 主会话和子代理分别核验，不能用一条事件推定另一条。

Cursor Hook 必须在宿主，不在等待加载的包中。读取 workspace_roots 与现有 AW 需求、偏好和精确 owned 包证据，返回当前工作区有效绝对 pluginPaths，不建立另一启用表。用户/项目分别限定 scope；无工作区窗口、Cloud 不在路径承诺内，Remote/WSL 单独取证。不会切换到 local 插件目录或单次 --plugin-dir 作为普通安装。

Pi 核心存在不证明 Agents 消费者存在。inspect 只读返回候选身份、版本、有效 scope、enabled、trust、packageAccess、promptMode/loadExtensions 和配置 evidence。complete+空列表是缺失，unknown 是覆盖不足；停用不是缺失。多个消费者的实际共存规则未验证时保持 unverified，不代用户选执行器。声明文件使用带插件身份的角色名并拒绝覆盖冲突；AW 不注册子代理工具或生成进程管理代码。

Pi 1.5.0 的事实来自公开 settings、已安装包 manifest、资源过滤、trust.json 及消费者公开的 subagents.json。没有完成发现范围或无法证明配置含义时保留 unknown；包名和版本元数据本身不授予消费者协议资格。配置摘要进入 capability 和锁内 stale 检查。

Gemini/Copilot/Grok 的 Agent 正文组合只涉及同插件本次生成角色，不能修改用户或其他插件的 Agent。Grok project 接收同 binding、同 render scope 的完整组件集合；Instructions 单独改变也使相关 Agent 包重新投影、Review 和冻结。组合输入失败不得发布缺正文的包。Grok 的 Claude 兼容来源仅观测并报告，Grok 清理不删除 Claude 内容。

Grok 1.0.77 的 list 只证明可解析的登记，inspect.enabled 不能单独证明生效或加载。配置激活、信任、组件来源及兼容来源重叠分别报告；这些事实不扩大 ownership。已证实不能刷新的本地 update 在发布替换包前受阻，保留旧输出及恢复说明。

## 3. 适配器职责与执行证据

AgentPluginAdapter 提供 discover、resolve、inspect、capabilities、project 和 lifecycle.prepare/execute。discover/resolve/inspect 只读；capabilities 与 prepare 是纯函数；project 只写私有 staging。公共管线拥有 renderer、命令闭包、冻结、Review、写锁、owner/共享检查和结果汇总。execute 使用同一冻结字节、route、位置与动作，不重新渲染、换路由或运行未审核的卸载重装。

效果分类为 publish-package、register、refresh、activate、deactivate、unregister、write-supplement、remove-owned，用于 Review/回执关联，不是通用 shell 动作语言。每个回执效果对应审核 ID；未执行项显式 skipped。原生命令超时或异常后先有限只读观测，未知写入保留 unknown/possible，不盲目重试。安装成功但激活失败、卸载成功但补足清理失败分别保留事实。

后置观察确认登记成功，不能消除后续必需激活被跳过的事实；因失败跳过的必需 effect 仍使目标未完成。同一命令按真实物理范围复用共享 register/refresh 的结果，各 scope 分别激活；Claude 按 scope 独立的安装不合并。

包、注册、owner、各产品面的 activation/trust/load 和组件 presence 分开。load=observed 只表示取得宿主加载证据，不证明模型行为。status 不为补证调用模型。没有客户端时仍允许证据充分的 AW 独占补足清理，原生卸载受阻则保留来源与精确恢复入口，不猜注册已消失。

所有原生来源先准备完整新包、校验并冻结，再按路由执行。单平台或物理分组失败不回滚其他成功；共享配置只修改自身 entry，foreign/shared/unknown 继续保护。preApply 每逻辑 target 每命令最多一次，授权后与 preflight 通过后运行，失败不清旧输出。

真实资格分别固定版本、OS、产品面、scope 和格式，验证安装、列出、激活、更新、移除、新会话加载、冲突与所声称组件。确定性 fake 只验证编排和失败边界。现有资格脚本及证据范围见[测试指南](../testing.md)，不能把相邻版本、help、静态源码或文件写入当完整资格。

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
