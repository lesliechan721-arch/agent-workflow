# AW 用户快速入门指南

本指南面向使用 `aw` CLI 管理 Agent 插件的终端用户与开发者。涵盖从首次安装、平台配置、插件安装、设置修改到来源同步、版本升级及安全清理的完整日常闭环。

---

## 1. 安装与初始化

### 环境要求

- **Node.js**：`>= 22.0.0`
- **支持平台**：Codex、Claude Code、Antigravity、Cursor、OpenCode、Pi、Generic

### 全局安装 CLI

```bash
npm install -g @lesliechan721/aw
```

### 首次同步并激活官方快照

在首次安装任何插件之前，本地必须至少具备一个健康可用的 Active Catalog 快照。运行 `aw catalog source sync` 同步并激活官方来源：

```bash
aw catalog source sync official
```

该命令会通过网络拉取官方 Catalog 候选快照、执行校验并在本地激活。若未执行此同步而直接运行 `aw plugin install`，命令会因缺少可用 Active 快照而以 `sourceActiveUnavailable` 错误阻断，并提示先同步来源。

### 离线环境就绪检查 (`aw init`)

`aw init` 是**纯离线只读的环境就绪检查命令**，不会联网，也不会在磁盘上生成或写入配置文件（当配置文件缺失时仅在内存中使用内置默认配置，状态为未物化 `materialized: false`）：

```bash
aw init
```

> [!NOTE]
> 在尚未执行 `source sync` 激活快照的新环境中，`aw init` 检查会因缺少 Active 快照返回非零退出码并报告未就绪，这属于冷启动阶段的预期现象；完成上述 `aw catalog source sync official` 后再次运行即可通过检查。

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

若在 CI 环境或自动化脚本中运行，请使用以下非交互命令行。

---

## 2. 配置平台目标与需求范围

### 选择平台目标 (Targets)

AW 不对所有可能平台无差别写入。安装插件前，需先配置本机要启用的平台：

```bash
# 设置本机启用的平台目标（例如 Codex 与 Claude Code）
aw plugin targets set codex claude

# 查看当前已启用的平台列表
aw plugin targets list
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
aw plugin install decision-kit --scope user

# 为当前项目声明并安装插件
aw plugin install dev-workflow --scope project
```

### 安装过程与行为语义

1. **原子写入需求声明**：AW 先将插件需求（Intent v3）原子写入对应的 `plugin-intents.json`。
2. **尽力恢复（Best-Effort Apply）**：根据已配置的本机平台目标，将插件投影并物化至宿主客户端目录。
3. **部分成功允许**：若其中一个平台物化失败，已成功的平台保持可用，不会整体回滚。
4. **验证现场状态**：
   ```bash
   aw plugin status --context user
   aw plugin status --context project
   ```
   公开恢复状态回执（`schemaVersion: 1`, `kind: 'aw-recovery-status'`）聚合为四大类：
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
aw plugin config list agent-subagent

# 查看指定配置键的值
aw plugin config get agent-subagent generalTaskProfile
```

### 修改配置设置

```bash
# 修改通用公共配置（对所有启用的平台生效）
aw plugin config set agent-subagent generalTaskProfile --value-json '{"executor":"native"}'

# 修改特定平台的覆盖配置（例如仅针对 Codex 平台覆盖模型与推理级别）
aw plugin config set codex-enhance standardProfile --platform codex --value-json '{"model":"gpt-6-luna","reasoningEffort":"high"}'

# 启动终端交互式向导修改配置（通过终端选择与输入交互完成）
aw plugin config edit agent-subagent
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
         ↓ aw catalog source sync <id>
[ 已激活快照 (Active) ] (本地 catalog-store)
         ↓ aw plugin sync / aw plugin install
[ 物理安装产物 (Installed) ] (宿主客户端目录)
```

1. **Candidate（候选版本）**：远端 Git 仓库或本地开发源中探测到的最新版本。
2. **Active（已激活快照）**：本地已成功同步并激活的 Catalog snapshot，存放在 `~/.aw/catalog-store/` 中。
3. **Installed（物理安装版本）**：当前部署在 Codex、Claude Code 等宿主平台中的实际运行文件。

### 检查来源状态

`aw catalog source status` 是**离线状态检查命令**，读取本地来源配置、当前 Active 快照指纹与宿主兼容性，不发起网络连接：

```bash
# 离线检查指定来源的本地配置与 Active 快照状态
aw catalog source status official
```

### 刷新来源快照

要与远端同步或检查更新，使用 `aw catalog source sync`：

```bash
# 在线探测远端更新并执行校验，不写入 store 也不改变 Active（但可更新 lastSync）
aw catalog source sync official --check

# 拉取最新快照、校验并原子切换本地 Active 快照
aw catalog source sync official
```

> [!NOTE]
> **刷新来源不会自动升级已安装插件**。`aw catalog source sync` 仅更新本地 Active 快照，绝不擅自变动当前正在运行的物理安装产物。

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

当不再需要某个插件时，使用 `aw plugin remove` 从声明文件中注销：

```bash
# 从用户全局需求中移除
aw plugin remove decision-kit --scope user

# 从当前项目需求中移除
aw plugin remove dev-workflow --scope project
```

> [!NOTE]
> `aw plugin remove` 仅修改选定 scope 的 Intent 声明文件，并尝试清理其专属输出。取消项目需求不会删除其他项目或用户共享的物理文件。

### 清理可证明归属的输出 (`cleanup`)

若宿主目录中残留了未引用的插件产物，使用 `aw plugin cleanup` 针对物理目标进行安全清理（注意：`--scope` 与 `--target` 均为必填选项）：

```bash
# 针对特定平台的目标清理用户层级下的残留输出
aw plugin cleanup --scope user --target codex

# 确认清理特定平台上的项目残留输出
aw plugin cleanup --scope project --target codex --yes
```

### 安全所有权保护边界

AW 在执行清理时受到严格的安全限制：
- **仅清理可证明为 AW 拥有（AW-owned）的产物**：只有包含合法的 AW owner marker 且路径与声明完全一致的文件才允许被删除。
- **严格保护外部（foreign）与共享（shared）内容**：宿主平台自身的配置文件、用户其他插件或跨插件共享包体绝不删除。
- **弱状态损坏时的强行清理**：若本地状态损坏但确认需要清理专属残留，使用强制清理选项：`aw plugin cleanup <plugin> --scope <scope> --target <target> --force --yes`（针对精确的单个 target 目标执行）。

---

## 7. 常用命令速查

| 任务 | 推荐命令 | 说明 |
| --- | --- | --- |
| 启动交互终端 | `aw` | 打开全功能 TUI 控制台 |
| 离线环境就绪检查 | `aw init` | 离线检查本地来源与 Active 快照就绪状态（只读检查，不写磁盘） |
| 同步来源快照 | `aw catalog source sync <id>` | 拉取最新快照并激活 Active（首次安装前必须同步） |
| 配置平台目标 | `aw plugin targets set <targets...>` | 设置本机偏好的宿主平台 |
| 安装插件 | `aw plugin install <plugin> --scope <user\|project>` | 声明并安装插件 |
| 查看现场状态 | `aw plugin status --context <user\|project>` | 检查公开恢复状态回执与聚合计数 |
| 修改配置项 | `aw plugin config set <plugin> <key>` | 保存配置至 Store（不自动生效） |
| 交互式配置向导 | `aw plugin config edit <plugin>` | 终端选择与交互修改配置项 |
| 应用生效配置 | `aw plugin config apply <plugin>` | 重新渲染并应用配置至平台 |
| 检查来源状态 | `aw catalog source status [id]` | 离线查看指定或全部来源的本地配置与 Active 状态 |
| 探测远端更新 | `aw catalog source sync <id> --check` | 在线探测远端更新与校验，不写 store |
| 升级/同步插件 | `aw plugin sync [plugins...] --context <scope>` | 升级或协调现场安装产物 |
| 移除需求声明 | `aw plugin remove <plugin> --scope <scope>` | 取消插件需求声明 |
| 清理残留输出 | `aw plugin cleanup --scope <scope> --target <target> --yes` | 清理指定平台的孤儿产物（保护 foreign/shared） |

---

## 8. 相关文档

- 遇到问题与异常现象：参见 [用户排障指南](troubleshooting.md)。
- 开发并分发你自己的插件：参见 [开发你的第一个插件](../authoring/first-plugin.md)。
- 创建并维护 Catalog：参见 [Catalog 作者指南](../authoring/catalog.md)。
- 底层配置与运行时规范：参见 [公开参考合同 (Reference)](../reference/)。
