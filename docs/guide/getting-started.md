# AW 用户快速入门指南

本指南面向使用 `aw` CLI 管理 Agent 插件的终端用户与开发者。涵盖从首次安装、平台配置、插件安装、设置修改到来源同步、版本升级及安全清理的完整日常闭环。

---

## 1. 安装与首次使用

### 环境要求

- **Node.js**：`>= 22.0.0`
- **支持平台**：Codex、Claude Code、Antigravity、Cursor、OpenCode、Pi、Generic

### 全局安装 CLI

```bash
npm install -g @lesliechan721/aw
```

### 首次获取来源

`plugin install` 会按需获取所选来源尚不存在的 Active 快照。已有 Active 保持当前版本；损坏快照需要显式恢复，不当作首次安装。推荐使用完整插件 ID，例如 `official/decision-kit`，避免多个来源的同名歧义。

查询来源不会联网或写入：

```bash
aw source status
# 显式检查远端候选，不写 store、Active 或 lastSync
aw source status official --remote
# 显式刷新并激活来源；不会自动升级已安装插件
aw source sync official
```

### 启动交互式界面 (TUI)

在任何支持 TTY 的终端中直接运行 `aw`（不带参数）即可进入全屏交互式控制台：

```bash
aw
```

TUI 包含四个主面板：
- **插件管理**：浏览官方与第三方来源插件、查看详情与安装状态。
- **项目插件**：查看并管理当前工作区声明的项目级插件。
- **来源管理**：管理 Catalog 订阅、手动同步来源（等效于执行 `source sync`）与检查候选版本。
- **Agent 管理**：配置本机偏好的平台目标（如 Codex、Claude Code 等）。

裸 `aw` 在非终端中显示帮助；`aw --help` 和 `aw --json` 显示帮助，不启动 TUI。普通 CLI 始终非交互，缺参数立即返回错误。配置编辑与 Review 确认继续在 TUI 中提供。

---

## 2. 配置平台目标与需求范围

### 选择平台目标 (Targets)

AW 不对所有可能平台无差别写入。安装插件前，需先配置本机要启用的平台：

```bash
# 设置本机启用的平台目标（例如 Codex 与 Claude Code）
aw target set codex claude

# 查看当前已启用的平台列表
aw target list
```

### 两种需求范围 (User vs Project)

AW 严格区分个人用户需求与项目级需求：

| 范围 | 参数 | 存储位置 | 适用场景 |
| --- | --- | --- | --- |
| **User Scope** | `--scope user` | `~/.aw/plugin-intents.json` | 个人跨项目全局通用插件（如通用的 Git 工具、设计参考等） |
| **Project Scope** | `--scope project` | `<repo-root>/.agent-workflows/plugin-intents.json` | 仓库专属插件，需求声明随 Git 仓库提交共享给团队协作 |

读取现场状态时，使用 `--context` 控制范围：
- `--context user`：仅查看当前用户层级的声明与输出。
- `--context project`：联合计算当前用户与当前项目的需求闭包（默认在仓库内联合处理）。

---

## 3. 添加与安装插件

使用公开的 `aw plugin install` 命令添加并安装插件：

```bash
# 为当前用户安装插件
aw plugin install official/decision-kit --scope user

# 为当前项目声明并安装插件
aw plugin install official/dev-workflow --scope project
```

### 安装过程与行为语义

1. **先校验再写入**：明确提供 `--scope user|project`。参数、目标和重要副作用确认通过后，AW 将插件需求（Intent v3）原子写入对应的 `plugin-intents.json`。没有启用平台时，普通安装返回 `noTargetsEnabled`；只保存需求使用 `--only requirements`。
2. **尽力恢复（Best-Effort Apply）**：根据已配置的本机平台目标，将插件投影并物化至宿主客户端目录。
3. **部分成功允许**：若其中一个平台物化失败，已成功的平台保持可用，不会整体回滚。
4. **验证现场状态**：
   ```bash
   aw plugin status --context user
   aw plugin status --context project
   ```
   统一结果的 `data.counts` 聚合为四大类：
   - `ready`：所有预期组件与依赖完全就绪；
   - `pending`：存在已保存但尚未同步物化的变动（需执行 `sync`）；
   - `blocked`：存在来源缺失、依赖阻断或不可读现场；
   - `unconfirmed`：目标目录不可达、存在观测缺口或放置凭证损坏导致现场未充分确认（严禁假设为“未安装”或“安全可写”；`status` 支持非交互只读执行，`unconfirmed` 并非由缺少 TTY 引起）。
   若存在 `blocked`、`pending` 或 `unconfirmed`，请查阅[排障指南](troubleshooting.md#3-现场状态异常blocked-pending-unconfirmed-或底层-needssync-orphaned)。

---

## 4. 插件配置：保存设置与应用生效

插件可声明配置项（如模型选择、推理深度或执行器类型）。

### 查看配置结构与当前值

```bash
# 查看插件配置 Schema 声明
aw plugin config schema agent-subagent

# 列出当前生效配置与来源层级
aw plugin config get agent-subagent

# 查看指定配置键的值
aw plugin config get agent-subagent generalTaskProfile
```

### 修改配置设置

```bash
# 修改通用公共配置（对所有启用的平台生效）
aw plugin config set agent-subagent generalTaskProfile --value-json '{"executor":"native"}'

# 修改特定平台的覆盖配置（例如仅针对 Codex 平台覆盖模型与推理级别）
aw plugin config set codex-enhance standardProfile --platform codex --value-json '{"model":"gpt-6-luna","reasoningEffort":"high"}'

# 在 TUI 中交互编辑插件配置
aw
```

### 核心解耦：保存成功不等于应用生效

AW 严格将配置持久化与客户端生效解耦：

1. **保存提交 (`aw plugin config set`)**：原子写入本地强配置存储（`~/.aw/plugin-config/<sourceId>/<pluginName>/config.json`），返回 `configWrite: succeeded`。**此时宿主平台中的已安装插件尚未改变。**
2. **应用生效 (`aw plugin config apply`)**：执行动态渲染（Renderer）并更新客户端物理产物。

```bash
# 将最新保存的配置应用至受影响的平台产物
aw plugin config apply agent-subagent
```

> [!IMPORTANT]
> 若应用阶段因前置脚本（preApply）失败、目录权限不足或宿主进程锁定而报错，**已保存的配置绝不回滚**。技术依据参见 [Manifest 与配置声明合同：保存与应用解耦](../reference/manifest-and-config.md#42-保存成功与应用失败解耦)。排查方法见 [排障：配置保存成功但应用失败](troubleshooting.md#1-配置保存成功但应用生效失败)。

---

## 5. 检查来源、候选与升级插件

### 三层版本状态分层

理解 AW 的更新机制必须分清三层独立状态：

```text
[ 远端/本地候选 (Candidate) ]
         ↓ aw source sync <id>
[ 已激活快照 (Active) ] (本地 catalog-store)
         ↓ aw plugin sync / aw plugin install
[ 物理安装产物 (Installed) ] (宿主客户端目录)
```

1. **Candidate（候选版本）**：远端 Git 仓库或本地开发源中探测到的最新版本。
2. **Active（已激活快照）**：本地已成功同步并激活的 Catalog snapshot，存放在 `~/.aw/catalog-store/` 中。
3. **Installed（物理安装版本）**：当前部署在 Codex、Claude Code 等宿主平台中的实际运行文件。

### 检查来源状态

`aw source status` 是**离线状态检查命令**，读取本地来源配置、当前 Active 快照指纹与宿主兼容性，不发起网络连接：

```bash
# 离线检查指定来源的本地配置与 Active 快照状态
aw source status official
```

### 刷新来源快照

要与远端同步或检查更新，使用 `aw source sync`：

```bash
# 在线探测远端更新并执行校验，不写入 store 也不改变 Active（不写 lastSync）
aw source status official --remote

# 拉取最新快照、校验并原子切换本地 Active 快照
aw source sync official
```

> [!NOTE]
> **刷新来源不会自动升级已安装插件**。`aw source sync` 仅更新本地 Active 快照，绝不擅自变动当前正在运行的物理安装产物。

### 升级已安装插件

在 Active 快照更新后，执行插件同步或重新安装命令以升级现场产物：

```bash
# 升级指定用户插件至当前 Active 的最新版本
aw plugin sync decision-kit --context user

# 重新生成动态产物并刷新全部当前项目插件
aw plugin sync --context project --rebuild
```

---

## 6. 同步、移除需求与安全清理

### 协调同步现场 (`sync`)

当您拉取了团队共享的 Git 仓库、新增了平台目标或修改了配置后，运行 `sync` 确保现场产物符合全部声明：

```bash
# 协调用户需求与现场输出
aw plugin sync --context user

# 协调项目需求与现场输出
aw plugin sync --context project
```

### 移除需求声明 (`remove`)

当不再需要某个插件时，使用 `aw plugin remove` 取消需求并安全清理。删除输出需要 `--yes`；可先不加该选项查看待确认影响：

```bash
# 从用户全局需求中移除
aw plugin remove official/decision-kit --scope user --yes

# 从当前项目需求中移除
aw plugin remove official/dev-workflow --scope project --yes
```

> [!NOTE]
> `aw plugin remove` 仅修改选定 scope 的 Intent 声明文件，并尝试清理其专属输出。取消项目需求不会删除其他项目或用户共享的物理文件。

### 只修改需求或只清理输出

若宿主目录中残留了未引用的插件产物，使用 `aw plugin remove --only outputs` 针对物理目标进行安全清理（注意：`--scope` 与 `--target` 均为必填选项）：

```bash
# 查看用户范围目标清理的待确认影响
aw plugin remove official/decision-kit --only outputs --scope user --target codex

# 确认清理特定平台上的项目残留输出
aw plugin remove official/decision-kit --only outputs --scope project --target codex --yes
```

### 安全所有权保护边界

AW 在执行清理时受到严格的安全限制：
- **仅清理可证明为 AW 拥有（AW-owned）的产物**：只有包含合法的 AW owner marker 且路径与声明完全一致的文件才允许被删除。
- **严格保护外部（foreign）与共享（shared）内容**：宿主平台自身的配置文件、用户其他插件或跨插件共享包体绝不删除。
- **弱状态损坏时的强行清理**：若本地状态损坏但确认需要清理专属残留，使用强制清理选项：`aw plugin remove <source/plugin> --only outputs --scope <scope> --target <target> --force --yes`（针对精确的单个 target 目标执行）。

---

## 7. 命令与自动化

| 任务 | 命令 |
| --- | --- |
| 浏览可用插件 | `aw plugin list` |
| 查看插件说明 | `aw plugin show official/decision-kit` |
| 只保存需求 | `aw plugin install official/decision-kit --scope user --only requirements` |
| 列出直接需求根 | `aw plugin list --requested --scope user` |
| 离线取消需求 | `aw plugin remove official/decision-kit --scope user --only requirements` |
| 清理所选输出并保留需求和配置 | `aw plugin remove official/decision-kit --scope user --only outputs --target codex --yes` |
| 创建作者工作区 | `aw dev catalog create --workspace-root ./catalog-workspace` |
| 查询完整命令帮助 | `aw --help` 或 `aw --json` |

普通 remove 要求可验证的 Active；来源不可用时不会先取消需求。使用两个独立 `--only` 模式恢复：requirements 只取消合法声明中的完整 ID，outputs 只清理有归属证据的输出。保留需求时，后续 sync 可以重新部署。`--delete-config` 额外删除该插件全部本机配置，不能与 `--only` 组合；`--force` 只用于 outputs-only 的受限恢复。install/remove 必须提供非空插件列表，不支持 `--all` 或 `--offline`。

默认文本与 JSON 使用同一事实。自动化显式增加 `--json`，根据 `status`、稳定诊断 code 和 `data` 判断结果，不解析英文句子。`success` 退出 0，参数错误 2，`blocked` 3，`partial` 4，其它执行失败 1。完整取得的 needsSync 查询可以成功；未知和覆盖缺口不能当作成功。完整字段和透传例外见 [CLI 合同](../reference/cli.md)。

---

## 8. 相关文档

- 遇到问题与异常现象：参见 [用户排障指南](troubleshooting.md)。
- 开发并分发你自己的插件：参见 [开发你的第一个插件](../authoring/first-plugin.md)。
- 创建并维护 Catalog：参见 [Catalog 作者指南](../authoring/catalog.md)。
- 底层配置与运行时规范：参见 [公开参考合同 (Reference)](../reference/)。
