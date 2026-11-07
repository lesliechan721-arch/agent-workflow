# 插件运行时与产物物化合同

本文件是面向插件作者与运行时自动化实现的公开精确合同，定义插件资源声明、运行时配置读取、构建与导入、动态 Renderer、`preApply` 生命周期脚本以及 Native 与 Portable 平台投影合同。内部管线与编排实现参见[插件生命周期架构说明](../maintainers/architecture/lifecycle.md)。

## 1. 资源声明与构建引入

插件源码通过 Manifest v3 的 `skills`、`scripts`、`buildConfig` 和资源声明向构建管线与运行时公开能力。

### 1.1 静态资源与可执行位

- **目录结构**：Manifest 的 `skills` 字段声明插件相对目录路径字符串，指向 Skill 集合所在的根目录，规范目录固定为 `"./skills"`。每个静态 Skill 子目录必须包含符合[插件与 Skill README 规范](../authoring/readme-standard.md)的 `README.md` 与 `SKILL.md`。
- **可执行文件清单**：包含可执行文件的 bundle 在生成时写入 `.agents-plugin/aw-executable-files.json`，按 Unicode code points 排序记录无重复的 bundle 相对路径。该清单自身模式为 `100644` 并计入 entry/snapshot digest。Windows 环境基于该清单还原可执行语义，Unix 继续核对实际执行位。
- **构建引入（buildConfig.buildImports）**：
  仅用于编译期打包，严禁将其作为替代运行时依赖的手段。`buildImports` 将 provider 导出的文件通过环境变量注入给构建脚本：
  ```json
  {
    "buildConfig": {
      "buildImports": [
        {
          "plugin": "provider",
          "export": "shared-file",
          "env": "AW_PLUGIN_IMPORT_SHARED_FILE"
        }
      ]
    }
  }
  ```
  - 环境变量注入的值为已验证的只读绝对文件路径，严禁拼接或遍历同级 sibling 源码目录。
  - 构建过程只向 CLI 提供的 staging 目录输出，仅读取声明的输入文件，绝不隐式安装外部工具或读取真实用户配置。
  - `buildImports` 仅在编译期生效，**绝不向下游传播 capability 依赖**。同一 Catalog 来源的运行时依赖必须在 Manifest `dependencies` 中显式声明。
  - Artifact 的 `runtimeImports` 是编译期复制到 bundle 内的本地输入。

### 1.2 运行时引入与文件复用（buildConfig.skillRuntimeFiles）

插件 Skill 的运行时依赖文件在 `buildConfig.skillRuntimeFiles` 数组中声明，每一项的合法结构为：

```ts
{
  skill: string;              // 目标静态 Skill key（必须匹配插件内声明的 Skill 名称，非相对目录路径）
  target: string;             // 目标相对路径（必须位于 references/、assets/ 或 scripts/ 下）
  platforms?: PlatformTarget[]; // 可选的目标平台过滤
  source?: string;            // 本地插件源码文件（与 import 二选一）
  import?: { plugin: string; export: string }; // 引用 provider 导出的 runtime export 对象（与 source 二选一）
}
```

示例声明：

```json
{
  "buildConfig": {
    "skillRuntimeFiles": [
      {
        "skill": "example",
        "target": "scripts/shared.mjs",
        "import": { "plugin": "provider", "export": "shared-file" }
      }
    ]
  }
}
```

- **没有 `.static` 分支**：本地文件直接使用 `source` 声明；跨插件共享文件使用 `import: { plugin, export }` 对象声明。`source` 与 `import` 必须且仅能二选一。`skill` 必须是静态 Skill key，不可写为 `skills/example` 等相对路径。
- **编译期导入边界**：`import` 是 Catalog build 时由构建器解析并复制到 consumer bundle 的 **typed edge**，绝非安装后动态搜索依赖的运行时 resolver。
- **生成文件目标（generatedSkillRuntimeFiles）**：
  - 声明格式为 `[{ skill, target, platforms? }]`。
  - 精确声明由 `scripts.node.build` 生成的 target 目标文件。该声明本身不复制文件，也不建立安装依赖。
  - 源码阶段允许依赖闭包暂准缺失，但在 build / materialization 完成后，每个选中的 surface **必须存在对应的普通实体文件**，并必须通过嵌套依赖闭包校验。
- **Export 源路径与 Skill 目标路径边界**：
  - **Runtime export 源路径（source）**：必须是 provider 插件根目录内的规范普通非符号链接文件。源路径并不限定在 `scripts/`、`references/`、`assets/` 目录（例如 `./README.md` 是合法的 export 源）；但除了全局排除 `.git` 与 `node_modules` 外，export 源路径中**严禁包含**名为 `.release`、`.tmp`、`build`、`dist`、`evals`、`node_modules`、`reports`、`skills` 或 `tmp` 的路径段（例如 `./scripts/reports/example.mjs` 会因 `reports/` 段被直接拒绝）。
  - **Skill 目标路径（target）**：target 路径则严格受限于目标 static Skill 的 `references/`、`assets/` 或 `scripts/` 子目录下。
  - 若目标已存在同名静态文件，严禁静默覆盖。
- **可缓存前提（`cacheable: true`）**：
  - 仅接受字面值 `true`（无需缓存时省略该键）。
  - 声明 `cacheable: true` **强制要求** 必须同时声明 `scripts.node.build`，否则 normalizer 直接报错（`Invalid buildConfig.cacheable: true requires scripts.node.build.`）。
  - 构建输入必须具备绝对确定性，不存在动态时间戳、非受控网络拉取或未声明的隐式输入。

### 1.3 编译期导出与 Capability 传播（buildConfig.runtimeExports）

- **作者显式声明**：每个 `buildConfig.runtimeExports[]` 必须使用 `{ name, source, requires: { aw: { capabilities: [] } } }` 结构。Provider 作者显式声明该 export 的完整 runtime capability 集合（空数组合法）。
- **确定性摘要**：Core 负责规范化、排序、去重并计算出稳定的 capability set digest，绝不通过动态扫描 export 内容推断 metadata。
- **依赖传播边界**：
  - `skillRuntimeFiles.import` 与 artifact 的 `runtimeImports` 将实际引用的 export capability 递归合并到 consumer 最终 bundle、Catalog entry 以及每个 Skill 的 receipt 中。
  - `buildImports` 仅用于编译打包，**绝不向下游传播 capability 依赖**。
  - Consumer 自身的 `skillRuntimeFiles.source` 与 `generatedSkillRuntimeFiles` 继续由顶层的 `requires.aw.capabilities` 声明。

---

## 2. 已安装配置读取合同

当 Skill 需要在运行时读取用户配置且不希望引入整个 AW 外部环境时，可声明安装态配置读取。

### 2.1 作者声明与能力门禁

- **仅限 Native Skill 目标**：在 Manifest 的 artifact targets 中，`runtimeConfig` **仅允许** 在 `codex.skill` 与 `claude.skill` 目标上声明，声明在其他任何 target（如动态命令、通用目标或 Portable 目标）上将被直接拒绝。
- 声明结构：目标 target 声明 `runtimeConfig: { keys: ["<field>"] }`。
- 必须在 Manifest 的 `requires.aw.capabilities` 声明 `aw.installed-runtime-config.v2`。
- `keys` 必须非空、无重复，且必须属于该 target 的 `refreshKeys` 子集。
- 严禁在 `runtimeConfig.keys` 中声明任何 `sensitive: true` 的字段或其校验依赖闭包。

### 2.2 生成的运行时文件

物化过程中，AW 在最终生成的 Skill 目录内注入以下两个保留文件（插件源码与 renderer 严禁提供同名文件）：
- `scripts/aw-runtime-config.mjs`：配置读取辅助模块。
- `.aw-runtime-config.json`：当前产物专用的安装态配置快照（schema 2）。

### 2.3 运行时调用接口

```javascript
import { readRuntimeConfig } from './aw-runtime-config.mjs';

const runtime = await readRuntimeConfig({
  from: import.meta.url,
  keys: ['fieldA', 'fieldB'],
});

console.log(runtime.installedIdentity); // 产物专属安装身份
console.log(runtime.effectiveValues);   // 获准字段的实际生效值
console.log(runtime.resourceRoot);      // 产物资源根路径
```

### 2.4 安全、隔离与弱状态边界

- **无环境依赖**：调用 `readRuntimeConfig` 无需提供 `AW_PLUGIN_CONTEXT` 环境变量。
- **产物自闭合**：直接从当前文件物理位置核验格式、来源、scope 和路径边界；不读取中央 Config Store，不遍历其他同名或不同名产物。
- **未应用配置隔离**：用户已保存但尚未通过 `apply` 刷新的配置，绝不改变现有生效产物的返回值。
- **独立性与弱状态**：每个产物独立工作，不声明跨 Skill 的一致性组；生效资源是可删除、可重建的弱状态现场证据，**不能升级为 ownership、status 或 cleanup 的真值判断**，也不负责核验 Skill 角色正文或资源树。
- **升级与不兼容拒绝**：
  - 旧版的 `resourceVersion`、`artifactIds`、v1 binding 与 `expectedRevision` 完全不兼容。
  - 升级路径：必须先交付支持 v2 的 CLI，再通过正常的 `build`、`sync` 或 `reinstall` 更新已安装产物内的 helper 模块。
  - 缺失或损坏的本产物配置、未知格式、越权 keys、不安全路径或可观察身份冲突时，reader 直接拒绝本次调用，并提示修正配置、`sync` 或 `reinstall` 恢复。

---

## 3. 动态 Renderer 与 ArtifactPlan 合同

动态插件可通过自定义脚本在安装与物化期间根据目标平台与生效配置生成定制产物。

### 3.1 声明与调用入口

Manifest 在 `scripts.artifacts.render` 中声明动态渲染入口：

```json
{
  "scripts": {
    "artifacts": {
      "render": {
        "runner": "node",
        "path": "./scripts/render-artifacts.mjs"
      }
    }
  }
}
```

AW 固定使用 Node 运行该脚本。Renderer 进程通过环境变量 `AW_PLUGIN_CONTEXT` 取得包含完整渲染上下文的 JSON 文件绝对路径。

### 3.2 渲染上下文（RendererContext）

渲染脚本通过 `AW_PLUGIN_CONTEXT` 文件接收上下文参数：
- `requestedArtifactIds`：本次请求必须返回的 target ID 列表（非空、无重复、按 Manifest 声明顺序规范化）。
  - **同次 ID 唯一性**：任两个在同一 platform/AW surface 和 scope 内可被同次请求的 target 不能使用相同 ID。
  - **Codex 共享投影全局唯一性**：Codex shared native projection 要求更为严格，所有 `codex-native` target 的 ID 与 Skill key 在整个 shared projection 内必须分别**全局唯一**，即使 scope 不重叠也不能复用。
- `previousArtifacts`：只读且不可变的上一版产物快照，用于增量比对。
- `config`：包含本次涉及 target 所声明 `refreshKeys` 的并集，提供 `schema`、`values`、`sources` 和 `issues`。配置 helper 仅消费已通过 Core 校验的 effective context。
- `changedConfigKeys`：相对于上一版发生变化的配置键列表。
- `artifactSources`：按 Manifest 顺序提供当前 surface/scope 下全部 Skill target 的真实 `sourceDirs`，即使该 Skill 未进入本次请求批次。Renderer 可据此复用静态模板资源，但不得借此读取额外配置或返回额外产物。
- `commandSources`：在所有上下文中存在（缺省 `[]`），提供本次命令 target 所涉及包的已核验只读 `sourceDir`。
- **托管命令 Surface**：托管命令 context 设置 `AW_PLUGIN_SURFACE=managed-commands`，不设置 `AW_PLUGIN_PLATFORM`。
- **隔离环境**：执行 renderer 时，`HOME`、`USERPROFILE`、`AW_HOME` 及临时目录均重定向至本次请求专用的临时目录。该输入隔离**不是 OS 沙箱**，严禁依赖宿主真实用户目录。

### 3.3 敏感配置分批规则

当同一 surface/scope 同时包含普通 Skill 和需要读取 `sensitive: true` 配置的非 Skill target 时，AW 将其切分为两次独立的上下文请求分别执行。两次请求读取相同的不可变 `previousArtifacts`，确保敏感信息不泄漏给普通静态技能。

### 3.4 响应输出（ArtifactPlan v2）

Renderer 必须向 stdout 输出符合规范的 JSON `ArtifactPlan`（结构化 stdout 输出上限为 16 MiB，独立诊断摘要上限为 64 KiB）。

以在 Manifest 中声明的动态 Skill 目标为例：

```json
{
  "id": "example-skill",
  "target": "codex.skill",
  "platform": "codex",
  "scopes": ["user"],
  "states": ["present"],
  "refreshKeys": [],
  "skillKey": "example"
}
```

当上下文请求 `requestedArtifactIds: ["example-skill"]` 时，Renderer 输出的 ArtifactPlan 必须完整匹配该 declaration 的静态元数据：

```json
{
  "version": 2,
  "artifacts": [
    {
      "id": "example-skill",
      "platform": "codex",
      "target": "codex.skill",
      "kind": "skill",
      "state": "present",
      "refreshKeys": [],
      "skillKey": "example",
      "content": {
        "files": {
          "SKILL.md": "---\nname: example\ndescription: Example skill.\n---\nRun the requested task.\n",
          "README.md": "# Example\n\nExample skill.\n"
        }
      }
    }
  ]
}
```

- **Skill 文件层级**：Skill 产物的文件必须放置在 `content.files` 对象中（顶层 `files` 仅适用于 `commandPackage` 产物类型）。
- **字段必需性**：上述 `state: "present"` 的 Skill 产物示例中包含 `id`、`platform`、`target`、`kind: "skill"`、`state: "present"`、`refreshKeys`、`skillKey` 以及 `content: { files }`。对于 Skill 产物，`state: "disabled"` 时不要求提供 `content`；其它 target 按各自 union 字段约束（如 `codex.developerInstructionsBlock` 的 `content` 为文本且严禁包含 `skillKey`，`commandPackage` 无 `platform`/`skillKey`/`content`）。
- 对 `requestedArtifactIds` 中的每一个 target ID，必须**精确返回一个** artifact 结果。
- 严禁遗漏请求的 ID，严禁返回未请求的额外产物，严禁产物 ID 重复。
- 产物计划中声明的文件写入路径必须严格限定在 target 专属根目录内。

---

<a id="preapply-contract"></a>
## 4. preApply 脚本合同

Manifest v3 允许在 `scripts.preApply` 中声明安装前环境准备与校验脚本：

```json
{
  "scripts": {
    "preApply": {
      "path": "./scripts/pre-apply.mjs",
      "timeoutMs": 300000
    }
  }
}
```

### 4.1 适用场景与边界

- **适用场景**：仅用于安装前的系统环境探针、依赖前置检查或外部系统工具初始化。
- **严禁替代依赖**：严禁将 `preApply` 用作替代 Manifest `dependencies` 或编译期构建的手段。AW 插件依赖仍由 Manifest `dependencies` 声明，Node 依赖仍在 build-time bundle 中闭包。
- **幂等性要求**：每个 target 每次命令最多运行一次，脚本必须具备严格幂等性，支持在任意中间状态下安全重试。

### 4.2 输入上下文（PreApplyContextV1）

AW 固定使用 bundle 内的 Node entry 执行脚本，**以 bundle plugin root 为工作目录（cwd）**，继承当前进程 `PATH`，并为脚本创建专用的临时隔离 `HOME`。

当脚本需要上下文时，AW 通过 stdin 传入 JSON 格式的 `PreApplyContextV1`：

```json
{
  "schemaVersion": 1,
  "plugin": {
    "pluginId": "official/example-plugin",
    "name": "example-plugin",
    "version": "0.1.0",
    "rootDir": "/path/to/plugin/bundle"
  },
  "target": {
    "platform": "codex",
    "scope": "user"
  },
  "config": {
    "values": {
      "fieldA": "value"
    }
  }
}
```

- **上下文排除项**：context **不包含** component outcome、平台 home、store path、artifact 内容或私有运行状态；顶层**没有** `action` 或 `targetDirectory` 字段。
- **target.projectRoot 字段条件性**：对于 `scope: "user"`，AW 完全省略 `projectRoot` 字段（**绝不写入 `null`**）；仅当 `scope: "project"` 时才包含指向项目根目录的规范绝对路径字符串（`projectRoot: string`）。
- **脱敏输出**：stdout 和 stderr 按生效的 sensitive 配置脱敏。
- **stdin 消费与 EPIPE 语义**：
  - AW 等待 stdin 写入完成或受控失败、脚本退出和进程树清理后才完成 target。
  - 若脚本无需上下文，可直接退出。只有脚本明确以 code 0 且无 signal 退出并确认清理成功时，脚本未读取 stdin 造成的 `EPIPE` 才不改变成功结果。
  - 其它 stdin 写入错误使用稳定脱敏的 `preApplyInputFailed` 诊断报错。

### 4.3 执行编排、授权与失败恢复边界

- **触发命令**：`install`、`sync`、`reinstall` 和 `config ... --apply` 运行 `preApply`；`cleanup`、`uninstall`、`status` 和 Review preparation 跳过执行。cleanup 为仍 desired 的 Codex target 执行内部 materialization reconcile 时也跳过 preApply。
- **显式授权门禁**：`preApply` 只能在 TUI Review 明确确认或直接 CLI `--yes` 后开始，JSON、noninteractive 或内部非 direct-CLI 调用不能绕过该门禁。普通的配置字段修改或整层删除确认不等于脚本授权。
- **Preflight 前置检查**：target 的 schema、config、artifact 和 ownership 只读 preflight 必须先成功。preApply 成功后才可为该 target 执行 stale cleanup、native/artifact write、postcheck 和 receipt。`reinstall` 也先运行 preApply，再执行 cleanup。
- **超时与配置门禁**：默认超时为 300 秒（`300000ms`），Manifest 和 CLI `--script-timeout` 的有效范围均为 1 秒至 30 分钟（`1000ms` ~ `1800000ms`）。
- **失败隔离边界**：
  - preApply 失败时，该 target **不执行任何 AW-owned cleanup 或 write**，receipt 记录稳定且脱敏的失败，并提供 `sync` 或 `reinstall` 恢复。
  - **其他 target 继续执行**，单个目标的脚本失败不阻断其他独立 target。
  - **外部副作用不回滚**：AW 不回滚脚本已成功完成的外部系统动作，也不增加外部副作用 ownership、journal、补偿或 cleanup 机制。
- **进程树治理与信号中断**：
  - 脚本退出前必须显式等待其产生的所有子进程退出，**严禁自行 daemonize 或残留后台孤儿进程**。
  - AW 在脚本正常退出、超时或中断后，先终止并确认清理本次脚本的整棵进程树，再完成该 target。进程树清理无法确认时，preApply 判定失败并阻止该 target 的 AW-owned 写入。身份无法证明属于本次脚本的 foreign 进程不会被误杀。
  - CLI 在 preApply 执行期间收到 `SIGINT` 或 `SIGTERM` 时，先清理脚本进程树和临时目录，再分别以标准信号退出码 `130` 或 `143` 退出，不继续其它 target；清理无法确认时以 `1` 退出。
- **环境隔离性**：请求级临时 `HOME` 是输入隔离，**不是 OS 沙箱**。

---

## 5. 平台投影合同：Native 与 Portable

物化产物分为面向特定客户端的 Native 投影与平台中立的 Portable 投影。

### 5.1 Native 平台投影（Codex 与 Claude）

- **投影归属与激活**：Codex 与 Claude 的静态和动态 Skill 固定投影为 Native。共享包体按用户物理身份物化，但分别读取各自平台的配置，项目的 activation 保持独立。
- **动态渲染回执**：
  - AW 为 Codex native 动态生成保留回执文件 `.agents-plugin/aw-codex-native-render.json`（schema 1）。源码与 renderer 严禁声明或生成该文件。
  - 回执记录规范化身份、`configDigest` 与 `renderInputDigest`，不记录原始 config。
  - **全局唯一性**：所有 `codex-native` target 的 ID 与 Skill key 在整个 shared projection 内必须分别**全局唯一**，即使 scopes 不重叠也不能复用。
- **敏感依赖禁止**：所有 Skill 的 `refreshKeys` 均严禁包含敏感配置依赖；平台 target 按该平台的编译配置校验。动态与静态 Skill 名字冲突直接拒绝。
- **闭包先行校验**：完整依赖闭包先于过滤进行校验；CLI 的 `--skill` 选项仅用于过滤最终输出的选择，不放宽闭包完整性要求。

### 5.2 Portable 平台投影

- **跨平台中立目标**：声明 `agent-skills.skill` 的目标作为 Portable 技能处理。
- **目标平台指定**：Portable 动态 target 必须显式指定五个 canonical platform 之一（`antigravity`、`cursor`、`opencode`、`pi`、`generic`）。Codex 与 Claude 的静态与动态 Skill 均固定走 Native 投影，严禁声明为 Portable target。
- **声明示例**：
  ```json
  {
    "id": "example-skill",
    "target": "agent-skills.skill",
    "platform": "cursor",
    "distribution": "agent-skills",
    "scopes": ["user"],
    "states": ["present"],
    "refreshKeys": [],
    "skillKey": "example"
  }
  ```
- **禁止降级**：Native 物化失败**绝不降级**为 Portable 投影。
- **目录与文档规范**：Portable 产物输出目录中的每个直接子目录必须是一个完整的标准 Skill，且必须保留生产级的 `README.md`。
- **Owner Marker 合同**：
  - Portable 技能写入时附带专属的 owner marker 文件，其 schema 固定为 **`schemaVersion: 1`**，所有者标识固定为 `owner: "agent-workflows"`，类型固定为 **`kind: "portable-skill"`**。
  - 核心属性包含：`pluginId`（如 `<sourceId>/<pluginName>`）、`logicalIdentity`（源工作区快照身份）、`platform`、`scope`、`skill`、`filesDigest` 以及 `configDigest`。
  - 注意：`schemaVersion: 3` 是另一类 AW-owned artifact owner marker 格式，与 Portable 独立的 schema 1 owner 绝不混用。
- **安全清理边界**：在离线 cleanup 或卸载阶段，若未找到合法匹配的 owner marker，或目录内容呈现 foreign/shared/unknown 状态，一律严禁删除。

### 5.3 敏感文本扫描合同

物化过程中，AW 对最终生成的文本产物执行敏感内容扫描：
- **扫描源与阈值**：扫描完整 user effective config 中所有连续长度 $\ge 8$ 个 Unicode code points 的敏感明文。该阈值仅用于减少短字符串误报，不代表密码强度；运行日志对所有长度的敏感值均进行脱敏。
- **双重编码表示**：同时扫描敏感字符串的**原文**与 **JSON 转义形态**（包括转义双引号、反斜杠与控制字符）。
- **排除规则**：保留的 runtime receipt 仅在由 AW 生成或经内容哈希校验后，才从**精确路径**中排除，严禁按 basename 进行全局通配排除。
- **阻断行为**：一旦在产物中发现敏感明文，立即阻断本次物化提交，**绝不修改 live marketplace、Codex registration 或 project activation**。
- **证据定位**：receipt 属于可删除、可重建的弱状态现场证据，绝不是作者维护的持久账本。
