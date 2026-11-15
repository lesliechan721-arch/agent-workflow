# 开发你的第一个 AW 插件

本教程引导第三方与仓内作者从零创建、验证、测试并构建一个合法的 AW 插件（Plugin Source）。

> [!TIP]
> **仓外作者无需检出本 monorepo**。您只需要机器上安装有 **Node.js 22+** 和全局 `@lesliechan721/aw` CLI 即可独立完成开发。

---

## 1. 前提条件与目录边界

### 前置要求

插件必须放置在一个合法的 **Catalog Workspace** 目录下。若您还没有工作区，请先按 [Catalog 作者指南](catalog.md#2-catalog-workspace-结构与初始化) 初始化：

```bash
aw dev catalog create --workspace-root /path/to/my-workspace
```

### Plugin Source 目录规范

每个插件必须作为独立子目录存在于 `<workspace>/plugins/<plugin-name>/` 下：

```text
<workspace>/plugins/<plugin-name>/
  ├── .agents-plugin/
  │   └── plugin.json          # 插件核心描述文件（Manifest v4）
  ├── README.md                # 面向人类用户的说明（符合规范）
  ├── skills/                  # 静态 Skill 集合目录
  │   └── <skill-name>/
  │       ├── SKILL.md         # 面向 Agent 的指令
  │       └── README.md        # 面向用户的该 Skill 简要说明
  └── scripts/                 # 可选测试、验证或辅助脚本
```

> [!IMPORTANT]
> - 所有插件源码文件必须限定在插件根目录内，严禁通过相对路径引用上层或外部任意深度的 `.git` 与 `node_modules`。
> - 只维护源码文件。`.aw/`、生成包体（bundles）和平台映射（marketplace projection）均为弱状态生成物，不要手动修改。

---

## 2. 从零创建最小合法插件

使用公开的 `aw dev plugin create` 命令初始化确定性脚手架：

```bash
workspace=/path/to/my-workspace
plugin=my-first-plugin

# 初始化插件骨架与首个 Skill
# 注意：--skill-short-description 必须为 25-64 个字符
aw dev plugin create "$plugin" \
  --description "我的首个可组合 Agent 工作流插件" \
  --skill-name "$plugin" \
  --skill-description "提供工作区文件完整性检查与依赖配置核验能力" \
  --skill-short-description "用于检查工作区文件完整性与依赖配置项的辅助开发技能示例" \
  --workspace-root "$workspace"
```

### 真实 Manifest v4 结构解析 (`.agents-plugin/plugin.json`)

`aw dev plugin create` 生成的 `plugin.json` 采用合法的 **Plugin Manifest v4** 格式：

```json
{
  "schemaVersion": 4,
  "platforms": [
    "codex",
    "claude"
  ],
  "name": "my-first-plugin",
  "version": "0.1.0",
  "description": "我的首个可组合 Agent 工作流插件",
  "skills": "./skills",
  "marketplace": {
    "category": "workflow",
    "strict": true,
    "policy": {
      "installation": "AVAILABLE",
      "authentication": "ON_INSTALL"
    }
  },
  "interface": {
    "displayName": "My First Plugin",
    "shortDescription": "我的首个可组合 Agent 工作流插件",
    "capabilities": [
      "Skills"
    ]
  },
  "extensions": {
    "instructions": [],
    "permissions": [],
    "hooks": [],
    "agents": []
  }
}
```

- `schemaVersion: 4`：Manifest 协议版本，当前工具拒绝其他版本。
- `name`：插件名称（全小写连字符命名）。
- `version`：单插件产物版本（严格的语义化版本号）。
- `platforms`：支持的平台列表。缺省或空数组表示支持全部十个平台；显式声明时仅允许从 `codex`、`claude`、`antigravity`、`cursor`、`opencode`、`pi`、`gemini`、`copilot`、`grok`、`generic` 中选择。
- `skills: "./skills"`：指向包含静态 Skill 树的相对目录路径（注意：此处是目录路径字符串，非对象映射）。
- `extensions`：声明指令、权限、Hook 与 Agent 角色等扩展数组。

### 编写 Skill 正文并消除 TODO 占位符

`aw dev plugin create` 会在 `skills/<plugin-name>/` 目录下生成 `SKILL.md`、`README.md`、`agents/` 及 `evals/` 目录。

> [!IMPORTANT]
> **消除 TODO 占位符是验证通过的前提**：
> 生成的 `SKILL.md` 模板包含 `[TODO: ...]` 占位符（例如目标、前置判断、工作流与 Gotchas 提示）。若脚手架生成后未经编辑直接执行 `aw dev plugin validate`，验证器会因存在未完成项而明确报错阻断：
> ```text
> "errors": [
>   "skills/my-first-plugin/SKILL.md still contains TODO placeholders"
> ]
> ```
> 作者必须打开 `skills/<plugin-name>/SKILL.md`，将各项 `[TODO: ...]` 替换为真实的 Agent 执行指令、输入判断、操作步骤与边界约束。完成正文编写后，`validate` 才能顺利通过。

### 添加更多静态 Skill

使用 `aw dev skill create --plugin` 向现有插件追加新的静态 Skill（同样须提供 25-64 字符的简述）：

```bash
aw dev skill create --plugin "$plugin" \
  --skill-name second-skill \
  --skill-description "执行辅助代码格式化与规范检查任务" \
  --skill-short-description "提供自动化代码排版格式化与项目静态规范核验辅助功能" \
  --workspace-root "$workspace"
```

同样地，追加的 Skill 也须编辑其 `SKILL.md` 并消除全部 TODO 占位符。

### 编写规范的 README

插件根目录下的 `README.md` 与每个 Skill 的 `README.md` 必须符合规范：
- 说明用户价值、安装命令与可观察边界。
- 严禁将内部执行细节或评测用例堆砌在 README 中。
- 完整编写规范见 [插件与 Skill README 规范](readme-standard.md)。

---

## 3. 作者验证、测试与构建闭环

在消除全部 TODO 占位符并完成源码编辑后，依次运行以下标准校验流程：

```bash
# 1. 验证源码合同与 Schema 合法性（可能会运行 renderer fixture 测试动态产物）
aw dev plugin validate "$workspace/plugins/$plugin" --workspace-root "$workspace" --json

# 2. 运行插件声明的确定性 Node 自动化测试
aw dev plugin test "$workspace/plugins/$plugin" --workspace-root "$workspace" --json

# 3. 构建本地插件 Bundle
aw dev plugin build "$workspace/plugins/$plugin" --workspace-root "$workspace" --json

# 4. 检查插件状态事实与变更差异（在需要时可能会准备 bundle）
aw dev plugin status "$plugin" --workspace-root "$workspace" --json
```

### 验证行为与取证边界

- `validate`：检查 Manifest 字段合法性与引用路径，**若插件声明了动态渲染器，`validate` 可能会执行 renderer fixture 测试动态产物生成**。
- `test`：执行在 Manifest `scripts.tests.node` 中声明的确定性 Node 自动化测试。
- `build`：在本地生成打包后的确定性产物，验证 bundle digest 计算。
- `status`：静态读取 Workspace 元数据与依赖事实，在需要时可能会准备 bundle。
- **纯只读取证 (`aw dev review inspect`)**：
  ```bash
  aw dev review inspect "$workspace/plugins/$plugin" --workspace-root "$workspace" --json
  ```
  **`review inspect` 是唯一纯只读的静态取证命令**。它仅读取源码、已有快照与物化凭据，返回源码事实与证据缺口，**绝不执行被审插件的任何生产或渲染代码**。详细规范见 [Review 与 Eval 参考合同](../reference/review-and-eval.md)。

---

## 4. 按需扩展能力

AW 允许插件按需声明配置、运行时资源、托管命令与原生工具。精确扩展语法已在独立公开合同中定义，教程按场景说明并提供入口：

### 扩展 1：声明插件配置（Config Definition v5）

- **适用场景**：插件需要接受用户或平台定制参数（如模型名、推理深度或执行器类型）。
- **机制**：在 Manifest 中声明 `config`（`schemaVersion: 5`），支持顶层公共定义与字段（`definitions`、`fields`、`presentation`）与平台特定覆盖（`platforms.<target>`），支持本地 `$ref` 复用与敏感字段标记（`sensitive: true`）。（注：`common` 属于持久化 Store v6 Envelope 结构，Manifest 源码中使用顶层 `definitions` 与 `fields`）。
- **完整合同**：详细字段类型、校验规则与 Store v6 持久化规范见 [Plugin Manifest 与配置声明合同](../reference/manifest-and-config.md)。

### 扩展 2：动态产物渲染与运行时配置（readRuntimeConfig & Renderer）

- **适用场景**：插件需要根据用户配置在安装时动态生成针对特定宿主平台的 Skill 或规则，或脚本需要在运行时读取已生效配置。
- **机制**：
  - 在 Manifest 中通过 `scripts.artifacts.render`（配置 `{ runner: "node", path: "./scripts/render.mjs" }`）声明渲染脚本，并用 `artifacts.configKeys` 声明所需配置，按需声明 `sourceDirs`、`runtimeImports` 与 `scopes`。
  - renderer 按当前平台、render scope 和 kinds 返回完整组件集合 v3；Skill 需要安装态配置时，在组件中声明 runtimeConfig，运行脚本再按生成的模块路径读取。
- **完整合同**：详细隔离上下文、16 MiB 限制、组件集合 v3 结构与 `preApply` 脚本生命周期见 [插件运行时合同](../reference/plugin-runtime.md)。

### 扩展 3：声明托管命令（Managed Commands）

- **适用场景**：插件需要向宿主平台或外部 Agent 暴露确定性的包装命令，或在 Claude Code 中突破沙箱安全执行受信任工具。
- **机制**：在 Manifest 中声明 `managedCommands.packages` 与 `managedCommands.sets`。AW 会为每个命令生成带 `cmdp_` 前缀的全局稳定 ID；可在权限扩展中为宿主平台声明可选的 `argsPrefix` 前缀匹配投影（运行时 AW 核验绑定后直接传递 argv，不设命令级内部参数 ACL）。
- **完整合同**：详细命令声明、权限映射与 Claude Code 沙箱排除见 [托管命令参考合同](../reference/managed-commands.md)。

### 扩展 4：依赖原生工具（Native Tools）

- **适用场景**：插件在特定操作系统（如 Windows）需要底层二进制进程树治理（Windows Job Helper）等原生支持。
- **机制**：在 Manifest 的 `nativeTools.definitions` 中声明依赖协议（如 `aw.windows-job.v1`）。插件源码**绝不携带二进制可执行文件**，由 AW 在安装消费端自动解析对应平台包。
- **完整合同**：详细原生工具声明与依赖解析见 [原生工具参考合同](../reference/native-tools.md)。

---

## 5. 安全删除插件

当需要从 Catalog Workspace 中废弃或移除一个插件时，使用公开的带保护删除命令：

```bash
aw dev plugin remove "$plugin" --workspace-root "$workspace" --yes --json
```

### 删除保护机制与前提

1. **Git 工作树与目标树范围保护**：
   - Workspace 必须位于具备有效 HEAD 的 Git worktree 中（也可以是仓库的子目录）。
   - 命令只接受规范的 `<workspace>/plugins/<plugin-name>` 目标。
   - **保护范围严格限定于目标插件树**：目标插件必须已提交至 HEAD，且当前目标树在清单（inventory）、文件字节（bytes）与可执行位（executable mode）上必须与 HEAD 精确一致。
   - **拒绝条件**：目标插件目录内的任何已暂存（staged）、未暂存（unstaged）、未跟踪（untracked）、被忽略（ignored）、额外多余或符号链接节点都会阻止删除。
   - **无关变更例外**：Workspace 其它位置的无关修改**不会**阻止删除命令，无需为满足门禁而清理或提交无关变更。
2. **反向依赖检查**：
   - 若当前 Workspace 中其它插件的 Manifest `dependencies` 声明了对该目标的依赖，命令会列出反向依赖者并安全停止。
3. **无 `--force` 绕过与 I/O 失败恢复**：
   - 该命令**没有 `--force` 绕过选项**，所有安全检查均在物理删除前完成；缺少 `--yes` 时绝不修改文件。
   - 若在删除阶段发生 I/O 失败，CLI 诊断会明确输出从已核验 HEAD 恢复目标的 Git 命令（例如 `git checkout HEAD -- plugins/<plugin-name>`）。
4. **只删源码不自动发版**：
   - 删除成功仅物理删除 `plugins/<plugin-name>` 源码目录；**绝不修改 `catalog.version`、不自动 git commit、不自动构建或发布**。成功后重新读取 inventory 并仅验证剩余受影响插件。

---

## 6. 下一步

- **发布到 Catalog**：将插件纳入 Catalog 统一构建与分发，参见 [Catalog 作者指南](catalog.md)。
- **查阅精确规范**：
  - [Plugin Manifest 与配置声明合同](../reference/manifest-and-config.md)
  - [插件运行时合同](../reference/plugin-runtime.md)
  - [托管命令参考合同](../reference/managed-commands.md)
  - [原生工具参考合同](../reference/native-tools.md)
