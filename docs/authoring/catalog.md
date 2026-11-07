# AW Catalog Workspace 作者指南

本指南面向创建、维护与分发自定义 Catalog（插件市场）的作者。当前支持的合同为 **Plugin Manifest v3**、**Catalog snapshot schema 7** 与 **Catalog Sources Config schema 2**。

> [!TIP]
> **第三方 Catalog 作者无需检出本 monorepo，无需执行官方 CI 或五包发布流程**。使用标准安装的 `aw` CLI 即可完成独立 Catalog 的初始化、聚合构建、本地调试与远端发布。本仓库官方发版请参阅 [官方发布与失败恢复指南](../maintainers/release.md)。

---

## 1. 核心概念与分工

- **Plugin Source**：单插件源代码，位于 `plugins/<plugin-name>/`。
- **Catalog Workspace**：聚合多个插件的根工作区，定义市场整体版本、提供依赖图校验并生成分发快照。
- **Catalog Snapshot**：构建生成的确定性静态快照（Schema 7），包含 `catalog-manifest.json` 与已打包的插件 bundle。
- **两阶段远端发布**：先通过 `publish plan` 在隔离环境中审查计划并生成授权摘要 `planDigest`，再通过 `publish apply` 显式授权推送至远端。

---

## 2. Catalog Workspace 结构与初始化

### 初始化新工作区

使用公开的 `aw catalog init` 命令初始化合法工作区：

```bash
workspace=/path/to/my-catalog

aw catalog init --workspace-root "$workspace" \
  --owner-name "My Team" \
  --owner-url "https://github.com/my-org" \
  --display-name "My Team Agent Catalog"
```

### 目录与核心配置文件

```text
<workspace>/
  ├── .aw-workspace.json             # 工作区标记（schemaVersion: 1, 稳定非空标识字符串，默认 SHA-256 哈希）
  ├── plugins/
  │   ├── marketplace-source.json    # 市场元数据（owner、interface 与 catalog.version）
  │   ├── plugin-a/                  # 插件 A 源码目录
  │   └── plugin-b/                  # 插件 B 源码目录
  └── .aw/catalog/                   # 生成的本地开发快照（生成物，不手工维护）
```

> [!IMPORTANT]
> - `.aw-workspace.json` 中的 `workspaceIdentity` 是 Catalog 永久唯一的非空身份标识（默认由 CLI 自动生成 `sha256(randomUUID())` 字符串），一经生成绝不可手动修改或在不同仓库间复制。
> - `plugins/marketplace-source.json` 中的 `catalog.version` 是整份市场快照的版本号，必须是严格的语义化版本（如 `1.0.0` 或 `1.0.0-beta.1`）。

---

## 3. 聚合验证与快照构建

在添加或修改了插件源码后，执行聚合检查与快照构建：

```bash
# 1. 查看工作区当前静态状态（不联网、不执行插件代码）
aw catalog status --workspace-root "$workspace" --json

# 2. 提升或设置 Catalog 快照版本号
aw catalog version 1.1.0 --workspace-root "$workspace"
# 或者使用语义化递增
aw catalog version --bump minor --workspace-root "$workspace"

# 3. 聚合构建开发快照
aw catalog build --workspace-root "$workspace" --json

# 4. 验证生成的快照是否符合 Schema 7 规范
aw catalog validate "$workspace/.aw/catalog" --json
```

- **单插件版本 vs Catalog 版本**：单个插件 Manifest 中的 `version` 代表插件 bundle 的产物版本；`catalog.version` 代表整份快照的版本。
- **依赖闭环校验**：`catalog build` 会严格校验同来源插件之间的依赖关系，依赖图出现缺失节点或循环依赖时会阻断构建。
- **执行文件保护**：含可执行文件的插件会自动生成受摘要保护的 `.agents-plugin/aw-executable-files.json`，确保在跨操作系统分发时校验通过。

---

## 4. 本地开发源调试（Development Source）

在将 Catalog 推送至远端 Git 仓库之前，可以在本地开发环境中将其作为开发源激活，供本地直接安装和测试：

```bash
# 1. 激活本地开发源（自动构建快照、校验并注册 managed Path source）
aw catalog dev activate --workspace-root "$workspace" --yes --json

# 2. 检查开发源状态与兼容性
aw catalog dev status --workspace-root "$workspace" --json
```

> [!IMPORTANT]
> **开发源不等于裸名默认解析**：
> `aw catalog dev activate` 注册的是一个受管理的 Path 来源（其 `primary` 默认保持为 `false`）。**激活开发源绝不会让裸插件名自动优先解析到该开发源**。
> 若直接运行裸名 `aw plugin install my-plugin`，AW 会扫描所有已配置来源；若默认官方来源尚未取得 Active 快照，安装会因 `sourceActiveUnavailable` 被阻断；若其他来源也存在同名插件，则会报错 `pluginSelectorAmbiguous`。
> **正确调试做法**：从 `dev activate` 或 `dev status` 的 JSON 回执中取得实际分配的来源标识（位于 `source.id`，例如 `dev-my-catalog`），并使用来源限定名安装：
> ```bash
> # 3. 使用精确来源限定名安装本地开发源中的插件进行测试
> aw plugin install <sourceId>/my-plugin --scope user
> ```

测试完成后，安全停用本地开发源：

```bash
# 4. 停用本地开发源（安全移除该 managed Path source，不删除 .aw/catalog）
aw catalog dev deactivate --workspace-root "$workspace" --yes --json
```

---

## 5. 远端发布计划、授权与应用

外部 Catalog 分发采用严格的**两阶段发布与授权机制**：

```text
[ Git 前置准备 ] ──> [ 审查计划 (Plan) ] ──> 生成 planDigest 与 Journal (prepared) ──> [ 人工授权核对 ] ──> [ 应用发布 (Apply) ] ──> 原子推送至远端 Git
```

### 发布前置条件（Git 准备）

`aw catalog init` 仅初始化工作区脚手架与标记，**不会自动创建 Git 仓库或提交**。在生成发布计划之前，必须先将工作区纳入 Git 管理并满足发布门禁：

1. **进入工作区并确认 Git 仓库**：
   ```bash
   cd "$workspace"
   ```
   - **若为独立新建工作区**：初始化 Git 并绑定远端仓库：
     ```bash
     git init
     git remote add origin https://github.com/my-org/my-catalog.git
     ```
   - **若工作区复用既有 Git 仓库（如仓库子目录）**：直接使用既有仓库与既有 remote（例如已有的 `origin`），无需重复执行 `git init` 或添加 remote。
2. **完整提交源码文件**：将工作区内的所有插件源码与市场元数据提交到 HEAD：
   ```bash
   git add .
   git commit -m "feat: initial catalog release"
   ```
3. **工作树干净检查**：Git 工作树必须保持完全干净（无未暂存、未提交或未跟踪文件）。`catalog publish` 的前置检查会对 dirty 现场严格阻断。

### 步骤 1：生成并审查发布计划 (Plan)

```bash
aw catalog publish plan --workspace-root "$workspace" \
  --remote origin --branch catalog --json
```

- **行为**：在已提交 source HEAD 的隔离 Git 仓库中构建快照，验证所有插件并计算唯一的 `planDigest`。
- **发布记录在首次远端写入前保存**：Plan 阶段会在本地隐藏临时目录完成核验，并原子生成 Publication Journal（schema v2，位于 `.aw/publish/<version>/journal.json`，初始状态为 `prepared`）以及隔离暂存仓库（`.aw/publish/<version>/repository/`）。**这些恢复材料在任何远端网络写入之前即已安全存盘**。
- **输出**：返回包含 Workspace identity、source HEAD、remote identity、branch、parent commit、tag、snapshot digest 以及 `planDigest` 的结构化描述。
- **职责**：作者必须仔细审查该计划内容是否符合发布预期。

### 步骤 2：授权并应用发布 (Apply)

```bash
aw catalog publish apply --workspace-root "$workspace" \
  --remote origin --branch catalog \
  --expected-plan-digest <planDigest> --yes --json
```

- **行为**：`apply` 使用授权的 `--expected-plan-digest` 唯一定位对应的 Journal，核验远端状态与 refs 后执行原子推送（推送分支与 annotated `catalog-v<version>` tag）。
- **成功后的暂存清理**：发布成功后，CLI 会将 Journal 原子标记为 `published`，并尽力删除隔离的暂存仓库 `repository/`（保留 JSON Journal 记录）。

---

## 6. 发布中断与任务选择

发布过程中若遭遇网络中断或异常退出，所有恢复材料在远端写入前已在本地存盘。作者根据后续意图在两个路径中选择：

1. **继续原发布计划（续跑）**：
   - 若目标仍是完成该次已审查的发布，直接使用相同的 `planDigest` 重新运行 `publish apply`：
     ```bash
     aw catalog publish apply --workspace-root "$workspace" \
       --remote origin --branch catalog \
       --expected-plan-digest <planDigest> --yes --json
     ```
   - **本地代码变动不影响原计划续跑**：`apply` 仅依据授权摘要定位已存盘的 Journal，不要求当前工作树的 HEAD 或文件状态与 plan 完全一致，也不重新构建源码。
2. **改发新计划（放弃原计划并发布新修改）**：
   - 若作者决定放弃未完成的原计划，改为发布包含新修改或修复后的源码，**严禁在同一版本号上盲目重跑**。必须先递增 Catalog 快照版本号：
     ```bash
     aw catalog version --bump patch --workspace-root "$workspace"
     ```
   - **审阅并提交新源码与版本元数据至 HEAD，恢复工作树干净**：
     `catalog version` 仅在本地磁盘原子修改 `plugins/marketplace-source.json` 元数据文件，不会自动执行 Git 提交。而 `publish plan` 严格要求整个 Git 工作树干净（clean）且所有变更均已纳入 HEAD，否则会因检测到未提交变更报错 `sourceDirty` 阻断。
     因此在生成新计划前，必须按照 [发布前置条件（Git 准备）](#发布前置条件git-准备) 完成先决步骤：先审查变更，按实际路径暂存并提交拟发布的插件源码及更新后的市场元数据至工作区所属仓库的 HEAD，并确保整个工作树完全恢复干净（无未暂存、未提交或未跟踪文件）。
   - **为新版本生成发布计划**：
     在工作树确认干净且变更已进入 HEAD 后，再为新版本生成发布计划：
     ```bash
     aw catalog publish plan --workspace-root "$workspace" \
       --remote origin --branch catalog --json
     ```

> [!NOTE]
> 完整的 Publication Journal 状态机（`prepared` / `uncertain` / `published`）、暂存仓库维护、同版本缺失/损坏停机门禁与远端 Tag 永久占号规则，参见唯一权威定义：[外部 Catalog 参考合同：发布计划与恢复门禁](../reference/catalog.md#publication-recovery)。

---

## 7. 客户端消费与订阅

发布完成后，终端用户可以通过以下命令添加并使用您的 Catalog：

```bash
# 添加 Git 来源订阅（使用当前 CLI 支持的 --git 与 --ref 选项）
aw catalog source add my-catalog --git "https://github.com/my-org/my-catalog.git" --ref catalog

# 同步并激活最新快照
aw catalog source sync my-catalog

# 安装该 Catalog 中的插件
aw plugin install my-catalog/hello-workflow --scope user
```

---

## 8. 相关文档

- 创建单个插件源码：参见 [开发你的第一个插件](first-plugin.md)。
- 插件 README 编写标准：参见 [插件与 Skill README 规范](readme-standard.md)。
- 外部 Catalog 格式与存储协议规范：参见 [外部 Catalog 参考合同](../reference/catalog.md)。
- 官方 monorepo 内部发版与 CI 指南：参见 [官方发布与失败恢复指南](../maintainers/release.md)。
