# AW 用户排障指南

本指南按**用户可观察的症状**组织故障诊断与恢复方案。每个故障均清晰说明：
- **可观察症状**：命令行输出或 TUI 中看到的具体现象与错误码。
- **保留状态**：哪些数据或配置已安全持久化且未受损。
- **未完成影响**：哪些操作尚未生效或哪些组件暂不可用。
- **恢复条件与下一步**：明确的可恢复命令与操作步骤。

---

## 排障快速导引

| 可观察症状 | 主要原因 | 恢复入口 |
| --- | --- | --- |
| `configWrite: succeeded` 但功能未变，或 `apply: partial` | 配置已存盘，但客户端物化渲染未完成 | [1. 配置保存成功但应用失败](#1-配置保存成功但应用生效失败) |
| `aw source sync` 网络超时或报错 `replace-required` | 远端不可达或本地快照存储损坏 | [2. 来源同步失败或快照损坏](#2-来源刷新失败或-active-快照损坏) |
| `aw plugin status` 显示 `needsSync`、`orphaned` 或 `blocked` | 意图与现场产物不一致、依赖缺失或权限受阻 | [3. 现场状态异常](#3-现场状态异常blocked-pending-unconfirmed-或底层-needssync-orphaned) |
| `aw plugin remove --only outputs` 跳过部分文件未删除 | 严格保护外部 (foreign) 或共享 (shared) 文件 | [4. 清理输出被跳过或失败](#4-清理输出跳过部分文件或清理失败) |
| 报错 `codexSystemCliUnsupported` 或 `claudeCliNotFound` | 本机 Codex CLI 版本低于 0.155.0 或 PATH 缺失 | [5. 平台 CLI 缺失或版本不支持](#5-平台-cli-缺失或版本不满足要求) |
| `aw command run` 权限被拒或 Claude 沙箱拦截 | 命令未声明沙箱排除或权限前缀不匹配 | [6. 托管命令执行失败或沙箱拦截](#6-托管命令执行失败或沙箱拦截) |

---

## 1. 配置保存成功但应用生效失败

### 可观察症状

- 执行 `aw plugin config set <plugin> <key>` 显示成功，JSON 的 data 包含 `configWrite: succeeded`。
- 但随后执行 `aw plugin config apply` 或 `aw plugin sync` 时报错：
  - 提示前置脚本超时（`preApplyTimedOut`）；
  - 提示宿主目录写权限受阻（`eacces`）或客户端进程锁占用；
  - 命令行状态输出 `apply: partial` 或 `apply: failed`。
- 宿主平台中观察不到新配置的行为变化。

### 保留状态

- **强配置已原子存盘**：修改后的配置值已完整写入本地配置存储（`~/.aw/plugin-config/<sourceId>/<pluginName>/config.json`），绝不回滚。
- **允许逐目标部分成功，不承诺全局回滚**：AW 按平台 target 逐一更新输出；若其中某个平台失败或超时，已更新成功的平台输出保留，失败或中断的目标不承诺全局原子回滚，以避免破坏正常运行的可用环境。

### 未完成影响

- 物理产物可能处于部分更新、需同步或未确认状态；报错的宿主平台尚未完成最新配置的渲染物化。

### 恢复条件与下一步

1. **查阅错误日志定位具体阻塞项**：
   ```bash
   aw plugin config apply <plugin> --verbose
   ```
2. **排除现场障碍**：
   - 若因脚本超时：覆写超时限制后重试（默认超时为 300000 毫秒 / 5 分钟；例如延长至 600000 毫秒）：
     ```bash
     aw plugin config apply <plugin> --script-timeout 600000
     ```
   - 若因目录被占用：关闭正在运行的宿主客户端（如 Codex 或 Claude），确保文件未被锁定。
3. **重新触发应用生效**：
   ```bash
   aw plugin config apply <plugin>
   # 或者执行联合同步
   aw plugin sync <plugin> --rebuild
   ```
4. **若需恢复或重置配置**：
   - **恢复指定字段到已知原值**：使用 `aw plugin config set <plugin> <key> --value-json '<previous-value>'`，或使用 `unset` 移除自定义项；
   - **重置整个 Profile（注意：不是单次编辑撤销）**：若需彻底放弃自定义配置并回退到 Schema 默认值或继承值，执行：
     ```bash
     # 清除整个 common profile（或指定 --platform profile）并回退默认值
     aw plugin config reset <plugin> --yes
     aw plugin config apply <plugin>
     ```
     > [!WARNING]
     > `config reset` 将选定层级提交为空对象 `{}`，会清除该 profile 下的**所有**自定义字段，不是撤销上次编辑操作。

> [!NOTE]
> **技术依据**：[Manifest 与配置声明合同：保存与应用解耦](../reference/manifest-and-config.md#42-保存成功与应用失败解耦) 与 [配置与状态架构说明](../maintainers/architecture/config-and-status.md#32-保存提交save与应用生效apply的解耦架构)。

---

## 2. 来源刷新失败或 Active 快照损坏

### 可观察症状

- 执行 `aw source sync <id>` 报告网络超时（默认 Git 探测上限 30 秒，拉取上限 180 秒）。
- 或报告本地快照内容损坏，提示 `replace-required`。

### 保留状态

- **健康旧快照继续生效**：刷新失败时，原有的本地 Active 快照指针绝不漂移，继续受保护。
- **现场已安装插件不受影响**：已安装在客户端中的插件完全离线运行，不受远端网络中断影响。
- **损坏快照安全隔离**：若检测到本地存储 key 校验不一致，该损坏目录会被隔离至 `.quarantine-*`，不污染健康快照。

### 未完成影响

- 本机无法获取远端最新的插件候选版本，暂无法升级插件。

### 恢复条件与下一步

1. **若因网络超时或代理问题**：
   - 检查网络连通性，或调整网络超时环境变量（支持 `100..300000` 毫秒，`0` 表示无限制）：
     ```bash
     export AW_CATALOG_REMOTE_TIMEOUT_MS=120000
     aw source sync official
     ```
   - 探测远端更新并执行校验（不写 store、不切换 Active，不写 lastSync 或其它持久状态）：
     ```bash
     aw source status official --remote
     ```
2. **若本地 Active 快照损坏且历史 Commit 可达**：
   - Git 来源会自动按 Active 的精确 Commit 修复旧 store key：
     ```bash
     aw source sync official
     ```
3. **若历史 Commit 无法取得或 Path 来源内容已漂移**：
   - 显式授权使用当前候选覆盖替换损坏的 Active 快照：
     ```bash
     aw source sync official --replace-damaged --yes
     ```
4. **检查并清理存储残留**：
   ```bash
   aw cache status
   aw cache prune --yes
   ```

> [!NOTE]
> **技术依据**：[外部 Catalog 参考合同：来源消费层级](../reference/catalog.md#5-catalog-来源消费层级与外部后果说明) 与 [Catalog 来源架构说明：四种激活策略](../maintainers/architecture/catalog-sources.md#52-四种激活策略定义)。

---

## 3. 现场状态异常：blocked, pending, unconfirmed 或底层 needsSync, orphaned

### 可观察症状

运行 `aw plugin status` 时，回执中的聚合状态未完全呈现 `ready`：

```text
PARTIAL  Plugin status checked
  - counts: { ready: 1, pending: 1, blocked: 1, unconfirmed: 0 }
  - decision-kit: needsSync (意图已保存但产物待物化刷新)
  - old-tool: orphaned (需求声明已移除但物理目录仍有残留)
  - advanced-kit: blocked (缺少依赖或宿主 CLI 不满足)
  - custom-tool: unconfirmed / unknown (目标目录不可达或观测证据不足)
```

### 保留状态与分层状态模型

AW 严格区分**公开恢复状态回执**与**底层放置事实**两层模型，不把未知或部分就绪粗暴等同于“未安装”：

#### 1. 统一结果的状态数据（data）

联合状态按可见目标统计 counts；同一插件可在不同平台进入不同计数，有 blocker 的 unknown 目标可同时计入 blocked 与 unconfirmed。不要用计数之和推算插件数。各字段含义见[状态与配置](../maintainers/architecture/config-and-status.md#21-公开恢复状态合同public-recovery-status-contract)。

状态排查关注以下事实：
- **`ready`**：所有预期组件与依赖完全就绪，无需修复动作。
- **`pending`**：存在已保存但尚未同步物化的变动（即底层 `needsSync`），声明完好，需执行 `sync`。
- **`blocked`**：存在来源缺失、依赖不满足或物理冲突等阻断项，声明与配置完好，等待修复前置条件。
- **`unconfirmed`**：目标目录不可达、存在观测缺口或放置凭证损坏导致现场无法完全观测，**严禁假设为“未安装”或“安全可写”**（`status` 是纯只读命令且支持非交互执行与 JSON 输出，`unconfirmed` 并非由缺少 TTY 引起）。

#### 2. 底层目标放置互斥五态（Internal StatusV8State）

在每个插件和具体平台 placement 维度判定的底层互斥状态：
- `ready`：所需能力与依赖均可用。
- `needsSync`：desired 意图已保存，但物理组件缺失、不完整或配置待刷新。
- `orphaned`：没有当前 scope 的 desired 意图，但实际激活或 AW-owned 扩展仍残留。
- `blocked`：来源不可用、外部占用或配置非法阻碍收敛。
- `absent`：无意图且无残留。

### 未完成影响

- `pending` / `needsSync`：插件可能无法使用最新配置或新增功能。
- `orphaned`：虽然已无当前 scope 的需求意图，但实际激活或 AW-owned 残留扩展可能仍留在宿主平台中生效，可能对其他插件产生非预期的行为冲突，并非无害的磁盘占用。
- `blocked`：宿主平台可能因缺少依赖而无法加载该插件。
- `unconfirmed` / `unknown`：状态不确定，防止盲目覆盖或删除。

### 恢复条件与下一步

1. **针对 `pending` / `needsSync`**：
   ```bash
   aw plugin sync --context user
   aw plugin sync --context project
   ```
2. **针对 `orphaned`**：
   ```bash
   aw plugin remove official/decision-kit --only outputs --scope user --target codex --yes
   ```
3. **针对 `blocked`**：
   - 查看详细阻塞原因与 diagnostics：
     ```bash
     aw plugin status --context project --verbose
     ```
   - 若因缺少 capability 依赖：检查是否需升级 AW CLI。
   - 若因配置值非法：根据报错修正配置（`aw plugin config set`）。
4. **针对 `unconfirmed` / `unknown`**：
   - 检查现场详细诊断输出：
     ```bash
     aw plugin status --context project --verbose
     ```
   - 检查当前用户对宿主平台目录的读写权限，以及来源快照是否完整健康。

> [!NOTE]
> **技术依据**：[配置与状态架构说明：平台与组件事实](../maintainers/architecture/config-and-status.md#22-平台产品面与组件事实)。

---

## 4. 清理输出跳过部分文件或清理失败

### 可观察症状

执行 `aw plugin remove --only outputs` 后，终端提示某些文件或目录被跳过，磁盘上依然残留部分文件。

### 保留状态

- **外部文件（Foreign）绝对保护**：用户自建的文件、平台自身配置或其他管理工具的文件原封不动。
- **共享包体（Shared）受保护**：跨插件共享的 Native 包体不会因单个插件清理而被误删。
- **符号链接受保护**：指向外部真实目录的符号链接安全保留。

### 未完成影响

- 残留了少量未受 AW 拥有权标记（AW owner marker）保护的孤儿文件。

### 恢复条件与下一步

1. **理解保护机制**：
   AW 绝不会对宿主目录执行盲目的递归删除。只有在文件头部包含合法 AW owner marker 且路径与声明完全一致时才会被判定为 AW-owned。
2. **确认是否为共享 Native 包**：
   Codex 与 Claude Code 的静态与动态 Skill 会进入用户层级的共享 Native 包。只要还有任何一个已安装插件引用该包，该共享包就必须保留。
3. **使用 `--force` 强行清理已损坏的弱状态**：
   若确认某专属目录确系 AW 产物，但因元数据损坏导致普通清理无法确认，使用强行清理（注意：`--scope` 与 `--target` 为必填项，强制清理限定于单一明确的 target 目标）：
   ```bash
   # 仅清理明确由 AW 拥有的专属残留，限定单一 target，仍受合法 root 与非符号链接门禁限制
   aw plugin remove <source/plugin> --only outputs --scope user --target codex --force --yes
   ```

> [!NOTE]
> **技术依据**：[插件生命周期架构说明：受限 force cleanup](../maintainers/architecture/lifecycle.md#受限-force-cleanup)。

---

## 5. 平台 CLI 缺失或版本不满足要求

### 可观察症状

- 在 Codex 平台上执行安装或同步时报错：
  `codexSystemCliUnsupported: Codex CLI version 0.145.0 is unsupported (minimum: 0.155.0)`
- 在 Claude 平台上报错：`claudeCliNotFound`。

先运行 aw target list，区分 missing、unsupported 与 unknown。接口最低版本通过仍不代表该组件已取得运行资格；具体 unmet 会保留必需 feature 与值。

### 保留状态

- **需求声明与配置完全保留**：Intent 文件与 Store 配置未受影响。

### 未完成影响

- 无法完成 Codex 或 Claude Code 的 Native 插件包注册与激活。

### 恢复条件与下一步

1. **针对 Codex 平台**：
   - AW 分别检查系统 PATH 与已确认的 Codex App 入口；多个产品面分别保留版本、可用性与限制。
   - 最低版本要求为 **`0.155.0`**。
   - 请更新您的 Codex 客户端或在终端中升级 Codex CLI：
     ```bash
     npm install -g @openai/codex
     codex --version
     ```
   - 修复完成后重新同步：
     ```bash
     aw plugin sync --target codex
     ```
2. **针对 Claude Code 平台**：
   - 确保 `claude` 命令在系统 PATH 中可执行且版本至少为 2.1.292。
   - 确认命令可用后重试：
     ```bash
     aw plugin sync --target claude
     ```

> [!NOTE]
> **技术依据**：[平台策略架构说明：平台环境与 Native 边界](../maintainers/architecture/platforms.md#1-客户端与可用性)。

---

## 6. 托管命令执行失败或沙箱拦截

### 可观察症状

- 运行 `aw command run <cmdp-id> -- <args...>` 时报错 `commandNotFound`、参数语法错误或执行失败。
- 在 Claude Code 终端执行托管工具时被平台沙箱拦截，提示缺少授权。

### 保留状态

- 托管命令的持久注册定义（位于 `~/.aw/commands/`）完好无损。

### 未完成影响

- 依赖该托管命令的 Skill 或自动化脚本无法顺利调用子进程。

### 恢复条件与下一步

1. **检查命令注册状态与语法**：
   - 托管命令调用**必须包含字面分隔符 `--`**：
     ```bash
     # 列出本机所有已注册的托管命令
     aw command list
     # 查看特定命令的执行入口与 runner
     aw command show <command-id>
     # 正确调用语法：必须带有 -- 分隔符
     aw command run <command-id> -- <args...>
     ```
2. **理解参数传递与宿主权限投影边界**：
   - AW `command run` 运行时在核验注册绑定后直接传递调用参数 argv；插件 Manifest 声明的 `argsPrefix` 属于宿主平台的权限投影与沙箱排除匹配规则，并非 AW 内部的调用 ACL。
3. **Claude Code 沙箱排除配置**：
   - 若插件在 Claude Code 环境下需要突破 Bash 沙箱执行特定命令，插件 Manifest 必须在 `requires.aw.capabilities` 声明 `aw.claude.sandbox-exclusions.v1`，并在 `extensions.permissions` 内部使用结构化对象声明排除（严禁使用字符串数组或顶层声明）：
     ```json
     {
       "requires": {
         "aw": {
           "capabilities": ["aw.claude.sandbox-exclusions.v1"]
         }
       },
       "extensions": {
         "permissions": [
           {
             "name": "my-tools",
             "allow": [],
             "agentOverrides": {
               "claude": {
                 "sandbox": {
                   "excludedCommands": [
                     {
                       "command": {
                         "set": "my-tools",
                         "key": "run"
                       }
                     }
                   ]
                 }
               }
             }
           }
         ]
       }
     }
     ```
   - 完整声明结构与规则见 [托管命令参考合同：引用与权限](../reference/managed-commands.md#a5-引用与权限)。更新 Manifest 后需重新构建并升级插件。

> [!NOTE]
> **技术依据**：[托管命令参考合同](../reference/managed-commands.md)。

---

## 7. 相关技术合同

- [插件生命周期架构说明（安装、同步与清理）](../maintainers/architecture/lifecycle.md)
- [配置与状态架构说明](../maintainers/architecture/config-and-status.md)
- [平台策略与原生边界架构说明](../maintainers/architecture/platforms.md)
- [Manifest 与配置声明合同](../reference/manifest-and-config.md)
- [外部 Catalog 参考合同](../reference/catalog.md)
