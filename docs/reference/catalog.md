# 外部 Catalog 格式、来源身份与消费恢复合同

本文件是面向外部 Catalog 作者、自动化工具及第三方分发者的公开精确合同，定义 Catalog Workspace 权威结构、版本决策语法、Snapshot schema 7 快照格式、来源消费后果、以及发布计划、Journal 状态机与恢复门禁。官方 Catalog 发布流水线及编排参见[官方发布与失败恢复指南](../maintainers/release.md)；内部来源管理、写锁 CAS 校验、四种激活策略与快照缓存清理算法参见 [Catalog 来源架构说明](../maintainers/architecture/catalog-sources.md)。

---

## 1. Catalog Workspace 权威结构与标识

一个合法的 Catalog Workspace 目录必须包含以下权威文件与结构：

```text
<workspace>/
  .aw-workspace.json                        [Workspace 根标识，schema 1]
  plugins/
    marketplace-source.json                 [Marketplace 根元数据]
    <plugin-name>/.agents-plugin/plugin.json [各插件源码 Manifest v4]
            ↓ aw dev catalog build
  .aw/catalog/                              [生成开发快照 Snapshot schema 7]
```

### 1.1 Workspace 根标识（`.aw-workspace.json`）

- `schemaVersion: 1`
- `kind: "aw-catalog-workspace"`
- `workspaceIdentity`: 稳定的非空字符串，唯一标识该 Workspace 的逻辑身份。初始化命令（`aw dev catalog create`）默认写入 `sha256(crypto.randomUUID())` 十六进制字符串，校验仅要求非空字符串（不强制为 UUID 格式）。已有合法 identity 不因 metadata、插件或版本变化而替换。该 marker 本身不进入 snapshot digest，但快照中记录的 `workspaceIdentity` 必须与此严格相等。

使用 `aw dev catalog create --workspace-root <workspace>` 初始化 Workspace v1。每个 Catalog 命令自行从 `--workspace-root` 或当前工作目录（cwd）向上定位最近的合法 marker。

### 1.2 Marketplace 根元数据（`plugins/marketplace-source.json`）

- 保存 `owner`、`interface` 与精确的 `catalog.version`。
  - `owner.url`: 若 host 为 `example.invalid`，发布计划（`publish plan`）与应用（`publish apply`）将直接以 `catalogMetadataIncomplete` 错误阻断。
- 版本语法：`catalog.version` 严格只允许标准 SemVer 的稳定版 `x.y.z` 或精确预发布版 `x.y.z-beta.N`。
- 插件 inventory：仅来自规范的 `plugins/<name>/.agents-plugin/plugin.json`。
- 依赖图校验：同 source dependency 仅来自 manifest `dependencies`，且依赖图严禁出现缺失节点或循环依赖。
- 目录边界约束：所有插件源码必须位于 `plugins/<name>/` canonical 目录下，严禁包含符号链接，严禁包含进入 `.git/` 或 `node_modules/` 的路径。

### 1.3 静态状态检查与版本变更命令

- **静态状态检查**：
  ```bash
  aw dev catalog status --workspace-root "$workspace" --json
  ```
  该命令是严格只读的静态命令：读取 Workspace marker、metadata、inventory、依赖图、Git 状态和 snapshot evidence，不构建、不拉取远端、不运行插件代码。
- **公开版本变更（Version Mutation）**：
  ```bash
  aw dev catalog version 0.2.0 --workspace-root "$workspace"
  aw dev catalog version --bump patch --workspace-root "$workspace"
  ```
  单插件 `version` 是单个插件的 artifact identity；`catalog.version` 是整个 snapshot identity。Catalog version 只允许通过公开 mutation 命令设置或递增。

---

## 2. Catalog Snapshot schema 7 快照合同

执行 `aw dev catalog build` 会在 `<workspace>/.aw/catalog/` 生成 Snapshot schema 7 快照：

```bash
aw dev catalog build --workspace-root "$workspace" --json
aw dev catalog validate "$workspace/.aw/catalog" --json
```

第三方公开 `aw dev catalog build` 默认仅提供 advisory 建议，不使用 `--strict-requirements`；官方仓库构建必须使用 `--strict-requirements` 语义。

### 2.1 Release Metadata 与快照完整性

- Snapshot schema 7 的 release metadata 仅包含 `state` 和 `sourceHead`。
- 生成的 snapshot、manifest、digest 和 marketplace projection 均受摘要保护，严禁手工修改。

### 2.2 校验层级与 Transport Validation

系统定义了三级确定性校验：

1. **Transport Validation**：核验快照整体结构、路径合法性、快照摘要（snapshot digest）、插件项摘要（artifact/content digest）、Marketplace 投影与 release metadata。
2. **Complete Validation**：用于发布前候选核验、发布后验收以及破坏性卸载（destructive uninstall）。在提交 Intent 或删除现场内容前，必须完整核验所选 Active snapshot；若快照校验失败，严禁修改 Intent，严禁删除现场文件。
3. **Published Transport Validation**：读取历史发布分支状态与上一版快照时使用，仅核验已发布状态与快照完整性，不按最新插件规范重新校验历史旧插件。历史快照损坏时发布准备停止；自动 beta 的内容比较回退不能跳过此检查。

### 2.3 确定性摘要与跨平台可执行文件清单

- **插件条目摘要绑定**：插件条目的 artifact/content digest 严格绑定相对路径、节点类型、canonical Git 执行模式与文件内容。
- **跨平台可执行清单（`aw-executable-files.json`）**：
  包含可执行文件的插件 bundle 会生成 `.agents-plugin/aw-executable-files.json`，供 Windows 在 Unix 执行位丢失后验证同一 Catalog 摘要。该清单按 codepoint 排序无重复记录相对路径，受摘要保护，不手工维护。旧 Catalog 缺少清单且在 Windows 校验失败时，使用更新后的 CLI build 并发布新 Catalog 版本。

---

## 3. Plugin 历史版本决策与发布规则

Catalog beta 候选只读取 source metadata、`catalog-v<version>` tag 和 publication journal。

### 3.1 First-Parent 发布历史与 Baseline 提取

- Plugin beta 和 stable 使用每个当前 Plugin 在目标 branch 的 first-parent 发布历史中最近的 manifest entry。
- 若 tip 提交缺少该 Plugin，plan 按需回溯历史。
- 若没有历史基线，或 stable base 提高：beta 渠道使用 `beta.1`（`${sourceVersion}-beta.1`）；latest 渠道产出纯稳定版本（`${sourceVersion}`）。

### 3.2 第三方版本决策与拒绝条件

Core 针对上次历史发布 entry 的类型执行严格判定：

1. **上次 Entry 为 Beta 版本**：
   - `contentDigest` 相同：复用现有 beta 版本号。
   - `contentDigest` 改变：使用同一 base 的下一个 `beta.N`（`${previousBase}-beta.${N+1}`）。
2. **上次 Entry 为 Stable 版本**：
   - `contentDigest` 相同：**直接复用该 stable 完整版本**（而非复用或退回 beta）。
   - `contentDigest` 改变：第三方必须先在源码中显式提高 source stable base；若 base 相同且内容变化，Core 直接抛出错误拒绝（`Plugin <name> stable version <version> maps to different content. Increase the source plugin version.`），第三方不会自动分配 beta.N。
3. **Stable Base 降低**：直接拒绝。
4. **Stable 最终发布决策**：
   - 对最近历史 entry 检查 version 和 `contentDigest`。
   - `contentDigest` 改变但 version 没有提高：直接拒绝。
   - version 降低：直接拒绝。
5. **Plugin 移除后重新加入**：继续使用删除前的最近历史基线；同版本但内容不同的插件提交直接拒绝。
6. **历史快照完整性**：历史快照无法读取或完整性校验失败时，发布准备停止；自动 beta 的内容比较回退不能跳过此检查。

> 官方仓库支持双渠道合并历史（合并 `catalog/latest` 与 `catalog/beta`）、未变化插件跨渠道复用、稳定插件内容变化自动推进 patch 等官方扩展，由 Core 统一管理，完整定义参见 [官方发布与失败恢复指南：官方插件版本分配规则](../maintainers/release.md#43-版本目标文件与-catalog-version-cli)。

---

## 4. 发布计划、Journal 与失败恢复合同

<a id="publication-recovery"></a>

Catalog 远端发布通过 `publish plan` 与 `publish apply` 两阶段完成，严禁一次性隐式向远端推送。

### 4.1 发布命令接口与两阶段授权

```bash
# 阶段 1：生成并核对发布计划
aw dev catalog publish plan --workspace-root "$workspace" \
  --remote <remote> --branch <branch> --json

# 阶段 2：授权并应用发布计划
aw dev catalog publish apply --workspace-root "$workspace" \
  --remote <remote> --branch <branch> \
  --expected-plan-digest <planDigest> --yes --json
```

- **Remote 与 Branch 选择**：
  Remote 按显式参数、`origin`、唯一 remote 的顺序选择；存在多个且无 `origin` 时必须明确指定。Branch 使用显式参数或固定默认 `catalog`，不从当前 Git 工作分支推断。无论使用何种默认值，apply 都必须取得完整 `planDigest` 的显式授权。
- **Plan 阶段**：
  从已提交 source HEAD 的隔离 Git 仓库中验证插件、构建快照并核验 snapshot。返回规范化的 Workspace identity、source HEAD、remote identity、branch、parent、tag、snapshot digest 以及 `expectedCommit`。`planDigest` 授权 canonical `{ descriptor, expectedCommit }` 结构。快照中 `.aw-generated.json` 的 `workspaceIdentity` 必须与 descriptor 中的 identity 严格相等（因为 marker 自身不计入 snapshot digest）。
  若 `owner.url` 的 host 为 `example.invalid`，plan 与 apply 以 `catalogMetadataIncomplete` 错误直接阻断。
- **Apply 阶段**：
  仅使用授权的 `planDigest` 在 `.aw/publish/*/journal.json` 中唯一定位对应 journal，不需要 Catalog version 参数。它重新核验所选 Workspace identity、remote identity digest、branch、授权摘要、pending repo 以及远端 refs。**它不要求当前工作树的 source HEAD、clean 状态或 metadata version 仍等于 plan，也不重新 build 或 re-validate source**。remote alias 名称允许变化，但 remote identity digest 与 branch 必须完全一致。

### 4.2 远端 Refs 对账与推送状态机

发布保留 annotated `catalog-v<version>` tag、branch lease、atomic push 与 post-verify。发布应用根据远端当前 ref 状态执行四种精确对账逻辑：

1. **已发布成功（`already-remote`）**：
   远端 branch commit 与 tag commit 均已等于 `expectedCommit`，且 tag 确为 annotated tag。对账通过，无需重复推送。
2. **原子推送（`atomic`）**：
   远端 branch commit 等于 `descriptor.parent` 且远端 tag 不存在。执行原子推送：
   ```bash
   git push --atomic --force-with-lease=<branchRef>:<parent> <pushUrl> <expectedCommit>:<branchRef> <tagRef>:<tagRef>
   ```
3. **补发 Tag（`tag`）**：
   远端 branch commit 已推进至 `expectedCommit` 但远端 tag 缺失。仅补推 tag：
   ```bash
   git push <pushUrl> <tagRef>:<tagRef>
   ```
4. **补发 Branch（`branch`）**：
   远端 tag 已在 `expectedCommit` 且为 annotated tag，但 branch 仍停留在 `descriptor.parent`。使用 lease 推进 branch：
   ```bash
   git push --force-with-lease=<branchRef>:<parent> <pushUrl> <expectedCommit>:<branchRef>
   ```

若远端 ref 状态不符合上述四种合法对账组合中的任何一种（如 branch 已被其他提交推进、tag 冲突或指向错误提交），命令立即抛出冲突错误并停止，严禁覆盖远端，维护者必须提升 Catalog 版本。

### 4.3 Publication Journal schema 2 与暂存仓库

- **Journal 位置**：`.aw/publish/<version>/journal.json`（schema 2）。
- **状态集合**：`prepared | uncertain | published`。
- **暂存仓库（Pending Repo）**：同目录下的 `repository/` 目录，是同版本恢复不可或缺的暂存产物。
- **单次原子提交**：新 plan 在同父临时目录（`tmp/` 或 `.<version>.<uuid>.tmp/`）完整生成并核验 journal、repo 和授权绑定后，通过单次文件系统原子 `rename` 切换为正式版本目录。失败仅清理本次临时目录，不占用正式目录；并发等价 plan 幂等返回，不同 plan 必须提升 Catalog 版本。旧 `<version>.json` 和 `<version>.repo` 不进入 discovery。

### 4.4 发布恢复语义与版本占用门禁

必须严格遵循以下核心恢复门禁：

1. **同计划恢复 vs 改计划提升版本**：
   - 相同的 Journal Plan 支持对账或断点续跑。
   - 若源码、插件列表或配置发生任何变化形成不同 Plan，**必须提升 Catalog 版本号**，严禁覆盖或复用同一版本。
2. **缺失或损坏的暂存状态严禁盲目重建**：
   - 当 Journal 状态处于 `prepared` 或 `uncertain` 时，若 `journal.json` 或 `repository/` 目录任一缺失或损坏，**必须立即停止并提升 Catalog 版本**，绝对不得盲目重新生成或强行覆盖同版本。
3. **已发布 Tag 永久占用版本**：
   - 当 Journal 处于 `published` 状态，或远端 Git 已生成不可变的发布 tag 时，该版本已被永久占用。即使本地 Journal 丢失，也严禁再次使用该版本，必须提升版本。
4. **清理失败不推翻成功事实**：
   - 发布成功时，必须先原子写入 `published` 状态的 journal，再尽力删除 `repository/` 暂存目录。暂存目录清理失败仅产生稳定警告（warning），不推翻远端已成功的客观事实。
5. **JSON 失败与执行证据**：
   `plan --json` 与 `apply --json` 使用[公共 CLI 结果合同](cli.md)。诊断写入 `diagnostics`；`CatalogPublicationInspectionError` 保留原 typed code，其他 journal、repository 或 remote 失败使用 `catalogPublicationFailed`。输入错误、执行前阻断、执行失败和部分完成分别使用合同规定的状态与退出码。
   apply 已尝试远端写入但未确认最终结果时，返回 `partial`、退出码 `4`。`data` 保留已取得的 `state`、`journalState`、`planDigest`、`expectedCommit`、`remoteWriteAttempted` 与 `remoteVerified`，供调用方使用同一授权摘要恢复。无法确认的远端结果不得报告为成功，也不得报告为未发生写入。若远端已确认发布而本地收尾失败，保留已发布事实。
   Git transport 诊断保留退出 code 和脱敏、压缩及长度截断的 stderr。诊断不包含 Workspace、AW_HOME、发布仓库或临时目录的绝对路径，也不包含 remote 凭据、query 参数或哈希。调用方显式请求的规范化作者路径按公共 CLI 合同输出。

---

## 5. Catalog 来源消费层级与外部后果说明
<a id="5-catalog-来源消费层级与外部作者语义"></a>

本节定义本地消费端对 Catalog 来源的身份识别与使用后果。多来源管理完整内部架构、写锁内重新比对与 Stale 停止规则、Preflight Inventory 与 `primaryChange` 内部实现、四种激活策略的完整状态机、以及 Store Prune 两阶段安全 Claim 算法的**唯一权威定义**参见 [Catalog 来源架构说明](../maintainers/architecture/catalog-sources.md)。

### 5.1 逻辑身份与离线只读

- **逻辑身份（Logical Identity）**：
  Catalog snapshot 的 logical identity **唯一来自** `.aw-generated.json.workspaceIdentity`。source ID、Git URL、SSH/HTTPS 文本和本地 path 绝不是 logical identity。
- **普通命令离线只读**：查询只读 `<AW_HOME>/catalog-state.json` 中已记录的 Active store 快照，不自动取源。首次 install 可按需获取所选来源尚无的 Active；已有 Active 不隐式升级，损坏或 identity 变化保留原恢复门禁。

### 5.2 三层状态对外部消费者的后果

系统严格区分三层版本状态：
1. **Candidate（候选版本）**：后台 freshness 检查或探测拉取到的远端最新版本，仅保存在当前内存或 session overlay 中，**绝不自动改变 Active，绝不自动修改强配置**。
2. **Active（已激活版本）**：用户明确确认并成功切换的来源快照，决定本地解析依赖和安装插件的基线。
3. **Installed（已安装版本）**：各客户端现场实际已物化的插件版本，**来源刷新或 Active 切换绝不静默自动升级已安装插件**。

### 5.3 来源检查、同步与激活的公开行为

- **配置变更（Config-only）**：`source add/update` 仅修改 `catalog-sources.json` 强配置，不自动启用新来源的 Active 快照。
- **`source status --remote` 模式**：临时拉取并执行 Transport Validation，返回脱敏候选与影响；清理临时材料，不写 store、Active、lastSync 或其它持久状态。
- **普通 `sync` 操作入口与外部后果**：
  日常执行 `aw source sync <id>` 触发 `normal` 激活策略。成功同步更新本地 Active 指针并写入 store；若远端无变化则保持现有 Active 不变（正常 no-op）；若变更影响现场现有引用或清单不完整（unknown），需显式附加 `--yes`。Git 来源严格递增 SemVer 且拒绝逻辑身份变更等完整校验与拒绝分支参见 [Catalog 来源架构说明：四种激活策略定义](../maintainers/architecture/catalog-sources.md#52-四种激活策略定义)。
- **来源兼容性（Compatibility）**：
  `source status` 的 data 中各来源 `compatibility` 枚举为 `null`、`supported` 或带 required/missing capability 的 `unsupported`。unsupported 状态使来源处于 not ready 状态，且系统不公开 available capability 全集。

### 5.4 来源损坏恢复与 Store 清理接口

- **来源损坏恢复操作入口**：
  当 Active store 物理条目缺失或损坏时，CLI/TUI 提供精确修复（`exactRepair`）；若旧 commit 不可得或 Path 内容变更导致无法原地修复，需通过 `--replace-damaged --yes`（或 TUI 独立替换 Review）显式授权替换。四项身份绑定校验、CLI/TUI 终止差异与授权重验状态机参见 [Catalog 来源架构说明：四种激活策略定义](../maintainers/architecture/catalog-sources.md#52-四种激活策略定义)。
- **Store Prune 显式运维接口**：
  `cache prune` 是显式的人工运维与恢复命令，非后台自动 GC。默认 dry-run 预览；`--dry-run` 与 `--yes` 互斥，只有 `--yes` 执行删除。非 Active 弱快照被删除后可随时通过 `aw source sync` 重新拉取重建。
- **本地开发源（Development Source）**：
  通过 `aw dev source activate|status|deactivate` 管理。deactivate 安全停用受控来源，不删除 `.aw/catalog` 构建目录；检测到引用或 inventory 不完整时需要显式 `--yes` 确认。
