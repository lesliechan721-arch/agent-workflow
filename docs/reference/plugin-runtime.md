# 插件运行时与产物物化合同

本文件是面向插件作者与运行时自动化实现的公开精确合同，定义插件资源声明、运行时配置读取、构建与导入、动态 Renderer、`preApply` 生命周期脚本以及原生平台与 generic 投影合同。内部管线与编排实现参见[插件生命周期架构说明](../maintainers/architecture/lifecycle.md)。

## 1. 资源声明与构建引入

插件源码通过 Manifest v4 的 `skills`、`scripts`、`buildConfig` 和资源声明向构建管线与运行时公开能力。

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

Catalog source bundle 保存 canonical 及各平台静态输入，不提前生成能力相关的 Hooks、Agents 或最终原生包。合法行为 metadata 保留到 prepare，由该 profile 的能力判定形成组件或 unmet；最终 generic 导出物仍须满足其能力与格式。

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

本节适用于最终 Skill 目录。共享命令脚本使用命令包自身的[按平台运行配置快照](managed-commands.md#运行配置快照)。

动态 Skill 的 runtimeConfig: { keys: string[] } 要求 aw.installed-runtime-config.v2。keys 必须非空、无重复，属于 artifacts.configKeys 的非敏感闭包，且本次平台 capability 支持该运行合同。具体 Native 平台的运行配置和命令闭包仍需独立资格。

AW 在最终 Skill 目录注入保留文件 scripts/aw-runtime-config.mjs 与 .aw-runtime-config.json（schema 2），作者和 renderer 不得覆盖：

~~~js
import { readRuntimeConfig } from './aw-runtime-config.mjs';
const runtime = await readRuntimeConfig({ from: import.meta.url, keys: ['fieldA'] });
// runtime.installedIdentity、runtime.effectiveValues、runtime.resourceRoot
~~~

reader 从当前物理产物核验来源、scope 和路径，只读取已应用配置，不依赖 AW_PLUGIN_CONTEXT、中央 Config Store 或其他产物。保存新配置不会改变旧产物返回值。缺失、损坏、未知格式、越权 keys 或身份冲突时拒绝并提示 sync/reinstall。此快照是可重建资源，不能授予 ownership、status 或 cleanup 权限。

schema 2 binding 通过 `originPath` 绑定独立的当前来源证据；旧 `nativeReceiptPath` 不作为兼容字段。固定保留文件 `.aw-runtime-native-receipt.json` 的当前内容为 `schemaVersion: 1`、`kind: 'aw-runtime-component-origin'`，包含 source 身份、platform、scope、configScope、`component: { id, kind: 'skill', name }` 和本次准备的 `inputDigest`。该文件不包含配置值、宿主绝对路径或旧 artifact targets。

reader 同时核对来源证据与 binding；原生产物所在包具有当前 nativeProjection owner 时，还须核对包身份、组件映射和实际相对输出路径。Review/Eval 的完整 Skill 快照携带相同的独立来源证据，因此可以复制后读取；只交换另一个 source 或 scope 的 binding 必须失败。来源快照仍不能作为删除或安装权限证明。

### 配置建议脚本

在 `scripts.config.suggestions` 声明 `{ "runner": "node", "path": "./scripts/config-suggestions.mjs", "timeoutMs": 10000 }`。入口及其依赖必须位于可分发的插件文件闭包内。AW 从 Active Catalog 取得提供方，插件安装前即可查询。在插件根目录以当前 Node 启动脚本，stdin 收一个 UTF-8 JSON 对象后关闭，stdout 只写一个响应对象，最多 1 MiB。

请求带 `schemaVersion: 2`、`kind`（`scalar` 或 `object`）、可选 `hint`、`provider`、`profile`、按名称和数字索引分段的 `fieldPath`、调用者 `cwd`、`consumer` 和 `providerPlugin`。两个插件身份均含 `pluginId`、`name`、`version`，提供方另含 `rootDir`。平台层请求带 `platform`，公共层省略。对象建议还带当前变体可编辑的 `targets`。已填的依赖属性位于 `dependencyValues`，提供方的非敏感有效配置位于 `providerConfigValues`。同插件查询叠加当前草稿，正在编辑的对象可包含部分有效属性，数组保留行的位置。跨插件查询使用提供方已保存的有效值。Store 损坏或无法读取时以空对象为基础，同插件仍叠加当前草稿。

`deadlineAt` 给出本次执行时限的 Unix 毫秒时间戳，供探针预留返回静态候选的时间。AW 还可在请求中提供 `commandHost: { schemaVersion: 1, nodeExecutable, cliEntry, awHome }`。这三个绝对路径指向当前 Node、当前 AW 的公开 CLI 入口和本次 AW home，供兼容的提供方查询已注册命令。此对象只提供路径。命令仍须通过公开 `command show` 和 `command run` 接口进行验证和调用。

响应为 `{ schemaVersion: 2, status, items, message?, diagnostics? }`。`ok` 返回可选项，`not-applicable` 表示已确认不支持，`no-probe` 表示没有探针，`unavailable` 表示运行失败。后三态的 `items` 为空。成功也可以带 `message`，例如说明正在使用离线预设。消息最多 256 个字符，诊断最多 8 条，各含 `code` 和 `message`。

- 标量项提供 `value` 和 `title`。候选标题长 1–128 个字符，可选 `description` 最多 256 个字符。`source` 可取 `dynamic`、`configured`、`merged` 或 `builtin`。顶层最多 128 项，标量按值去重。
- 对象项用 `set` 与 `unset` 原子更新目标属性。可直接选择叶项，也可用 `children: { title?, items }` 提供第二层选择，每组最多 32 项。同一项的设置键和清除键互斥，子项可覆盖父项的操作。合并后至少改变一个目标键，值须符合当前分支，且不能清除必填属性。仅含 `unset` 的叶项有效。无有效子项的容器会被移除。同级叶项按合并后的操作去重。
- 对象叶项可声明 `recommendedHints`。AW 保留最多八个格式有效、互异且通过脱敏检查的标识。字段投影优先匹配当前 `hint`，省略时匹配 `balanced`。有有效标识但无命中时无推荐；完全没有有效标识时采用静态 `recommended`。命中子项时也高亮父项。标量和容器上的 `recommendedHints` 会被忽略。会话可按来源、提供方版本、平台、目标属性、依赖和提供方配置复用带推荐标识的成功响应，逐字段重新校验。

脚本可用宿主 PATH 和工具登录环境，AW 清除内部控制环境变量，过滤敏感配置并清理输出。默认超时 10 秒，可指定 1000–30000 毫秒。在 macOS 和 Linux 上，脚本及其所有后代必须留在 AW 创建的进程组内。启动探针请使用默认的 `detached: false`，避免调用 `setsid` 或另建进程组。AW 在脚本结束、取消或超时时清理该组，主动离组的后代超出清理范围。Windows 使用外层 Job 收尾。输出超限、无效或执行失败时，编辑器仍允许手工填写。

## 3. 动态 Renderer 与 PlatformComponentPlan 合同

动态 renderer 按平台、实际资源 scope 和能力输入生成五类组件的完整期望集合。Manifest 不预先枚举动态 ID；静态入口可以与动态集合组合。

### 3.1 声明、单元与输入权限

~~~ts
interface PluginArtifactsConfig {
  configKeys: string[];
  sourceDirs?: string[];
  runtimeImports?: ArtifactRuntimeImportDefinition[];
  scopes?: Array<'user' | 'project'>;
}
// scripts.artifacts.render
interface RenderEntry { runner: 'node'; path: string; args?: string[] }
~~~

有 artifacts 必须有 render 入口。只有托管命令使用入口时可以没有 artifacts，并跳过五类组件请求。configKeys 必填、可为空，按编译后的 Config v5 profile 校验键及引用闭包。scopes 缺省两种，显式数组非空、无重复，匹配实际 **render scope**。共享包的 canonical scope 与项目 activation 分开，完整布局见[平台架构](../maintainers/architecture/platforms.md)。scope 不匹配表示该单元的动态组件有意不提供，不改变静态资源或共享 scope。

AW 在运行脚本前由固定平台布局确定 render units。每单元按权限调用同一入口：

| 批次 | 可见配置 | 可输出类别 |
| --- | --- | --- |
| Skill | configKeys 的非敏感键及非敏感校验依赖 | skill |
| 非 Skill | 获准键，可包含敏感字段 | mcp、agent、hook、instruction |

`allowedOutputKinds` 是单元布局分配的类别与批次类别的交集。交集为空不调用，否则每批最多一次，无输出也返回合法空数组。该字段限定脚本可返回的类别，具体组件能否交付还要经过下述映射判断。schema、values、sources、issues、changedConfigKeys 和历史身份同时裁剪，不通过其他字段把敏感信息带入 Skill 批次。changedConfigKeys 仅供优化，不能据此只返回变化项。配置、资源、renderer 权限或能力依据变化时重新准备完整集合，即使上次无组件。

sourceDirs 是 bundle 内已验证相对目录；runtimeImports 使用既有具名 runtime export 与依赖来源合同。引用须经 realpath 和内容闭包校验；绝对路径、..、逃逸 symlink、未知 import 或闭包外文件均拒绝。资源入口不是输出位置。脚本使用隔离 HOME/USERPROFILE/AW_HOME/XDG 与受控进程收尾；这是输入隔离，不是 OS 沙箱。

### 3.2 PlatformRenderContext v3

AW_PLUGIN_CONTEXT 指向本次隔离 JSON 文件的绝对路径：

~~~ts
interface PlatformRenderContextV3 {
  schemaVersion: 3;
  surface: 'agent-plugin';
  platform: PlatformId;
  scope: 'user' | 'project';
  plugin: { pluginId: string; name: string; version: string };
  config: {
    schema: PluginConfigDefinition;
    values: Record<string, PluginConfigValue>;
    sources: Record<string, 'default' | 'common' | 'platform' | 'missing'>;
    issues: PluginConfigValidationIssue[];
  };
  changedConfigKeys: string[];
  allowedOutputKinds: ComponentKind[];
  platformCapabilities: PlatformCapabilitiesV3;
  agentNaming: PlatformAgentNaming;
  resources: Array<{ kind: 'bundle' | 'runtime-import'; name: string;
    root: string; digest: string }>;
  previousComponents: Array<{ id: string; kind: ComponentKind; name: string }>;
}
~~~

缺值保留 missing，不填 null。previousComponents 仅含同类别批次的已验证身份，不含正文、配置或宿主路径，也不授予删除权。renderer 不能改变 platform、scope、支持结论或输出宿主位置。

AW 从 artifacts 声明派生 `aw.platform-components.v3` 和 `aw.platform-render-context.v3`。Core 包公开 `schemas/platform-render-context-v3.json` 和 `schemas/platform-capabilities-v3.json`。

`agentNaming` 是按当前平台及插件身份计算的实际 Agent 命名信息，和 `platformCapabilities.agentNamingMode` 一致：

~~~ts
type PlatformAgentNamingMode = 'host-plugin' | 'aw-prefix' | 'unsupported';
interface PlatformAgentNaming {
  mode: PlatformAgentNamingMode;
  filePrefix: string;
  invocationPrefix: string;
}
~~~

| 平台 | mode | filePrefix（例：official/demo） | invocationPrefix |
| --- | --- | --- | --- |
| Claude | host-plugin | 空字符串 | `demo:` |
| Codex、Pi、Antigravity、Cursor、Copilot、Grok | aw-prefix | `aw-official-demo-` | `aw-official-demo-` |
| OpenCode、generic | unsupported | 空字符串 | 空字符串 |

renderer 以逻辑角色名声明组件，不预先添加宿主前缀。需要构造实际调用名时使用 Core 的 `resolveAgentInvocationName(context.agentNaming, role)`，而非硬编码来源或插件名。文件名和文件内 name 由 AW 以 `filePrefix` 加归一化角色名生成；完整投影名须是安全路径段且不超过 128 字符。Skill 引用同包 Agent 可以改用下面的[受控占位符](#skill-agent-reference)。

### 3.3 平台能力与具体要求

~~~ts
type SupportV3 = 'supported' | 'unsupported';
interface CapabilityFact { status: SupportV3; reasonCodes: string[] }
interface PlatformCapabilitiesV3 {
  schemaVersion: 3;
  platform: PlatformId;
  scope: 'user' | 'project';
  basis: 'local' | 'profile';
  agentNamingMode: PlatformAgentNamingMode;
  kinds: Record<ComponentKind, CapabilityFact & {
    delivery: Array<'native-package' | 'native-extension' |
      'managed-host-resource' | 'generic-files'> }>;
  features: Record<string, CapabilityFact & { values?: string[]; maxBytes?: number }>;
}
~~~

AW 将交付方式、原因码和 feature 取值去重并排序。`profile` 用于离线作者准备，`local` 在同一确定性平台映射上检查现场客户端可用性。缺少可用入口时全部 kind 和 feature 为 unsupported；消费者 missing、unsupported、unknown 分别对应 `client-missing`、`version-unsupported`、`client-unknown`。入口未知不是可以静默跳过的交付缺口。

- `kinds[*].status` 和 `kinds[*].delivery` 描述类别能否按 AW 标准方式交付；`features` 描述可保真的平台特性。同类及跨类别要求使用同一份能力输入。`component.kind.<kind>` 要求对应 kind supported 且 delivery 非空。
- `agentNamingMode` 仅描述平台策略，不含具体插件身份。Pi 的角色及依赖角色的 Skill 按标准映射交付；消费扩展缺失或禁用等现场事实单独产生执行提示，不改变能力输入。
- supported 表示具有标准映射且没有已知接口限制，不代表特定宿主版本已取得会话执行证据。历史资格记录不参与能力判断。

作者可通过 `aw dev plugin capabilities --surface platform-capabilities --json` 查询字段合同和各平台事实。可移植导出未能保留原生调用控制时会将相应 feature 标为 unsupported；Codex 的 `agents/openai.yaml` 与 OpenCode 的 `metadata["opencode/autoinvoke"]` 保留其可移植调用控制。

feature registry 定义 ID、合法取值与默认 unsupported。至少覆盖：

| Feature | 必需语义或取值 |
| --- | --- |
| `component.kind.<kind>` | 五类组件的基础交付前提，无 values，状态与原因从 kinds 统一派生 |
| skill.invocation.manual、skill.invocation.model、skill.visibility | 当前 Skill metadata 的调用与可见性控制 |
| skill.runtime-config | AW 已安装配置合同版本 |
| skill.tools | allowlist、denylist、none；对应实际工具限制 |
| skill.model、skill.agent | 指定模型与角色的执行语义 |
| skill.execution | isolated-context；对应 fork 独立上下文 |
| skill.effort | low、medium、high、xhigh、max |
| skill.background | true、false |
| skill.hooks、skill.paths | Skill 局部 Hook 与路径条件 |
| skill.shell | bash、powershell |
| skill.invocation.hint、skill.arguments | when_to_use 的调用提示语义与 arguments 参数语义 |
| mcp.transport | stdio、http、sse |
| agent.execution | isolated-context 等宿主执行语义 |
| agent.model、agent.tools | 模型选择：supported 且没有 values 表示可接受任意非空模型名；有 values 则只接受白名单。tools 的 allowlist、none |
| agent.prompt-mode | host-default、append、replace |
| agent.declaration-protocol | Agent 声明协议 ID |
| `hook.common.<event>`、`hook.native.<event>` | 对应登记事件的 notify、context、block |
| hook.matcher | 已登记的 `<dialect>.<event>`，例如 `common.before_tool`、`native.PreToolUse`；仅表示该事件支持 matcher，不从 feedback 支持推定 |
| instruction.coverage | main、plugin-agents、other-agents |
| instruction.paths、instruction.after-compaction | 条件匹配与压缩后覆盖 |

FeatureRequirement={feature:string,values?:string[]} 的 feature 和 values 必须已登记。values 若有须非空、无重复。满足 feature 前提须 `status: supported` 且包括全部必需值。内容自动推导要求，作者的 `requires` 可追加要求。Skill 中的工具限制、模型、fork、角色、后台、Hook 等行为字段也参与交付判断，需有能保留语义的映射。Tools 的空数组要求 `none`，Hook 的 `feedback: block` 要求该事件支持阻断。未声明字段和纯展示字段不增加执行要求。合法但缺少映射的取值进入 `unmet`，未知 feature ID 或登记枚举外取值会使声明校验失败。Agent 的 content.model 若不在目标平台有限白名单中，则以 `{ feature: "agent.model" }` 报告缺口；动态 renderer 也可用此要求表达模型不适用，不需虚构全局模型枚举。

需要用户点名调用的 Skill 在 `SKILL.md` 中设置 `user-invocable: true` 和 `disable-model-invocation: true`。这组字段表示用户可见、可手动调用，以及模型不得自行选择。调用字段使用布尔值或其受支持的字符串写法时，AW 按同一规则投影。字符串会先去掉首尾空白并统一大小写。静态和动态 Skill 均交付完整正文和资源。`skill.invocation.manual`、`skill.invocation.model` 与 `skill.visibility` 标记调用和可见性能力。`requires` 追加的值也参与缺口提示，`SKILL.md` 中明确写出的字段决定实际原生开关。调用控制及可见性缺口不阻断交付；无绑定执行器、能力明确不支持或现场观测到策略降级时才提示。其他执行、权限或依赖要求仍按能力检查。[诊断合同](cli.md#4-业务-payload-的边界) · [各客户端实测范围](../maintainers/architecture/platforms.md#11-宿主根与接口最低条件)

公共 Hook 的合法 matcher 可以保留在声明中。准备时，声明 matcher 的组件自动要求对应的 `hook.matcher` 事件值。静态和动态组件在目标缺少安全映射时都报告具体 `unmet`，独立组件继续交付。显式 Native 声明仍须符合该宿主事件的合法语法。

稳定能力原因码为 `delivery-unavailable`、`client-missing`、`client-unknown`、`version-unsupported`、`interface-unsupported`、`scope-unsupported`。`delivery-unavailable` 表示当前 AW 写入器缺少所需映射。`requires.aw.capabilities` 使用独立的 AW 运行接口注册表。

### 3.4 PlatformComponentPlan v3 与资源

~~~ts
type ComponentKind = 'skill' | 'mcp' | 'agent' | 'hook' | 'instruction';
type SourceRef = { kind: 'bundle'; path: string } |
  { kind: 'runtime-import'; name: string; path: string };
type ResourceFile = { text: string } | { source: SourceRef };
type PluginComponent = { id: string; name: string;
  requires?: FeatureRequirement[] } & (
  | { kind: 'skill'; content: { files: Record<string, ResourceFile> };
      runtimeConfig?: { keys: string[] } }
  | { kind: 'mcp'; content: McpServerDefinition }
  | { kind: 'agent'; content: AgentContent }
  | { kind: 'hook'; content: HookContent }
  | { kind: 'instruction'; content: InstructionContent }
);
interface PlatformComponentPlanV3 {
  version: 3;
  components: PluginComponent[];
  omitted: Array<{ id: string; kind: ComponentKind; name?: string;
    reason: 'not-offered' | 'config-disabled' }>;
  unmet: Array<{ id: string; kind: ComponentKind; name?: string;
    componentId?: string; requiredFeatures: FeatureRequirement[]; reasonCode: string }>;
}
~~~

Agent、Instructions、MCP 和静态声明见[Manifest](manifest-and-config.md#23-五类组件与静态扩展)。动态 HookContent 为 {dialect:'common'|'native',event,feedback,matcher?,command}；common event 使用登记的公共三事件，native 使用当前平台已登记事件。其反馈、资源闭包与静态 Hook 相同。

Hook 的唯一公开 handler 真值可通过 aw dev plugin capabilities --surface hook-handlers --json 查询。getHookHandlerContract(platform,dialect,event) 同时返回 nativeEvent、matcherAllowed、qualification 与具体 protocol；protocol 规定 stdin-json 字段、来源、各 feedback 的 stdout/stderr/exitCode 及其他退出码行为。createHookHandlerResponse 按同一映射生成回应。nativeEvent 非 null 且 protocol=null 的已映射事件支持 `notify`（仅命令观察通知），不能声明 `context` 或 `block`。主动反馈必须有 protocol.responses 对应映射；matcher 须属于已支持事件且 matcherAllowed 为 true。协议定义与真实客户端资格分别判断，事件校验消费同一 registry。

三个数组必填且可为空，每批返回允许类别的完整集合。三组 ID 不得重叠，静态与动态身份共同唯一，动态 omitted 不能关闭静态组件。若省略的 Agent 逻辑名称与稳定 ID（或 agent: 前缀后的名称）不同，要在 omitted 中明确提供 name，避免同包 Skill 引用时将主动省略误判成能力缺口。ID 非空且无路径分隔符，并保留命令路由使用的 `command-routes`。Skill files 是组件根下相对路径，必须含有效 `SKILL.md`。AW 在投影前校验其 frontmatter 的 `name` 与组件 `name` 一致。静态组件以 Skill 目录名为准，动态组件的内联文档和来源引用适用同一规则。宿主名称映射后也查冲突。非法来源、无效文件、秘密原值、类别越界或未知 feature 及其取值会拒绝整批。renderer 可以完整返回合规的声明，AW 校验资源和能力后交付可保真的部分，并为其余部分生成 `unmet`。

unmet 的 requiredFeatures 保留具体缺失值及 componentId。例如 before_tool 只支持 notify 而要求 block，缺口为 {feature:'hook.common.before_tool',values:['block']}。Instructions 要求 main/plugin-agents 而只支持 main，则成功组件只含 main，关联缺口只含 plugin-agents。模型、工具限制与阻断不能静默删去。依赖或配置缺口可用空 requiredFeatures，能力缺口不能借此隐藏。reasonCode 必须与当前能力依据或登记的配置/依赖原因一致。

如果已发布的 renderer 只返回 `dependency-unmet` 和空的 `requiredFeatures`，AW 会保留它报告的依赖问题。该版本没有提供的角色，需要升级到包含角色正文的插件版本才能安装。

stdout 只输出一个 JSON 对象，上限 16 MiB，独立诊断摘要上限 64 KiB。非零、超时、非法 JSON 或任一校验失败均没有有效集合，不能解释为空并删除旧输出。

### 3.5 合并、命令闭包与冻结

AW 先准备相关单元的完整静态和动态组件集合，校验身份、宿主名、路径和运行资源，然后解析同包 Agent 引用，生成保留文件后投影并冻结。Skill 引用和宿主权限按这次部署采用的同一份共享路由表校验。动态命令使用无平台的独立 surface `managed-commands`，以 ArtifactPlan v2 返回完整路由表。精确合同见[动态路由渲染](managed-commands.md#动态路由渲染)。

<a id="skill-agent-reference"></a>

**Skill 引用同包 Agent。** 在 Markdown 中用双花括号包围 `aw.agent:<name>`，其中 name 是静态 Agent 的稳定公共名（平台改名不改变匹配键），或动态 Agent 的逻辑名。精确语法、扫描边界和 AW 能力声明见[Manifest](manifest-and-config.md#skill-agent-placeholder)。AW 在准备阶段根据完整 Agent 视图绑定实际名称：

| 引用目标 | 结果 |
| --- | --- |
| 可交付 | 替换全部引用为实际宿主调用名 |
| Agent unmet | Skill 整项 unmet，继承 Agent 的 requiredFeatures/reasonCode；合并多重缺口，配置/依赖失败或客户端缺失/未知优先于可跳过的能力限制，generic 原部分 runtime gap 归入整项缺口 |
| 作者有意省略 | 拒绝准备，报 agentReferenceInvalid |
| 不存在 | 报 agentReferenceInvalid；若当前平台不支持 Agent 且该平台与实际 render scope 有适用的动态 renderer，则引用它的 Skill（包括混合插件的静态 Skill）按 component.kind.agent / interface-unsupported 整项 unmet |

替换按目标单元的实际范围和能力，不受 allowedOutputKinds 裁剪；同包独立 Skill 仍可正常交付。Codex 固定 user 共享包引用 user 视图，Project-only 时必要的动态 Agent 批次只在内存评估，不写 User supplement；仅 Project 提供的角色不能被共享包引用。仅导出 Skill 时也可在支持 Agent 的 profile 下补评同 render scope 的动态 Agent，而不输出 Agent 文件。纯静态校验提前拒绝无效引用，混合插件的静态 Skill 可引用同包动态 Agent；只读状态不运行 renderer，未知动态引用留待准备及已记录的交付证据核对。不会发布未替换的占位符。

Hook/MCP 命令引用的本地文件须来自已允许的来源。准备阶段冻结显式文件及可静态解析的 Node imports，保留字节和执行位；投影绑定实际包位置，Pi/OpenCode 使用模块自身的位置，不依赖宿主 cwd。非 JavaScript 文件按显式资源交付，作者仍须声明其运行所需文件；AW 不承诺推导任意脚本或运行时文件读取。未知包根变量、来源逃逸及未声明的 runtime import 在写入前拒绝。

Copilot 和 Grok 将无路径条件、覆盖 `plugin-agents` 的 Instructions 写入同一目标和 render scope 中实际可交付的同包角色正文。没有适用角色时，AW 提示 `plugin-agents` 的交付缺口。如果同一条指令还覆盖 `main`，AW 继续将正文写入主会话的规则文件。

Grok User 和 Project 的包投影从同一 binding、同一 render scope 的完整集合组合 Agent Instructions 正文。修改或关闭 Instructions 时，同 scope 受影响的 Agent 包和规则补足一起重投影、Review 与冻结。组合输入失败阻止相关 Agent 包发布。

| 合并结果 | 维护语义 |
| --- | --- |
| 无组件且无 unmet | 有意空；新目标成功 no-op，旧输出的撤销须进 Review 并受归属/共享约束 |
| 只有平台能力缺口 | 完成当前可执行的交付，可以安装 0 项。已有入口按声明完整性和归属处理，见[生命周期](../maintainers/architecture/lifecycle.md#平台执行入口与结果) |
| 有配置、依赖或其他真实未满足项 | 保留未完成项及恢复证据，继续处理独立的可用组件 |
| 渲染失败 | 没有有效集合，不执行集合差异写入或清理，其他独立平台继续 |

Review 冻结实际组件、资源字节、输出位置、删除候选、能力及输入证据。Execute 在唯一写锁内重查来源、配置、能力、入口和现场归属，变化返回 stale，重新准备和确认，不在确认后生成另一集合。status/list/inspect 不运行 renderer；有匹配的可重建物化证据时才显示当前配置不产生组件，否则显示动态期望待确认。物化证据和 previousComponents 均不授予删除权。

安装记录按实际生成范围保存输入摘要。动态生成绑定 V3 能力视图、该批声明的配置、生成器和资源。静态投影跟踪实际组件、使用的能力和资源。含 Skill 的单元还纳入 Agent 命名及对应 Agent 交付输入。Codex 共享包的摘要始终基于其 user 渲染视图，详见[固定 render scope](../maintainers/architecture/platforms.md#13-固定-render-scope)。客户端现场观察只有造成实际能力变化才进入持久摘要。

---

<a id="preapply-contract"></a>
## 4. preApply 脚本合同

Manifest v4 允许在 `scripts.preApply` 中声明安装前环境准备与校验脚本：

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

## 5. 平台投影与内容保护

### 5.1 原生包与宿主补足

具体 Agent 使用固定原生包或原生扩展，必要的 AW 宿主补足在计划中明确显示。安装失败不改用散文件 Skills 路径。包格式、真实产品面、scope、固定版本和路由由[平台架构](../maintainers/architecture/platforms.md)定义，作者只能提供组件与能力要求。

物理包、原生注册、scope 激活、组件观测与会话加载是独立事实。CLI/App 共用实际位置时只生成一次，并使用共同能力；不同位置分别准备。共享包固定 canonical render scope，项目激活不能用项目配置覆盖用户包。Instructions 直接注入正文，不能输出要求模型另读文件的指针。

### 5.2 generic 与通用 Skills 导出

generic 安装根据作者声明的 Skill 名称校验并写入通用目录，writer 核对 owner 和内容，保留 foreign/shared/unknown。每个直接子目录必须完整，保留生产 README.md。每个 Skill 都可保留作者的调用意图。通用文件的自动发现及实际调用取决于以后读取它的客户端，AW 安装结果会提示这一限制。实际请求的非 Skill 声明按能力缺口报告。作者可提供通用 Skill 正文，使其工作流程适合通用环境。

明确选择 profile 的通用 Skills 导出独立于安装机制；profile 准备不依赖本机客户端，不构成真实加载资格。不得以导出成功声明该 Agent 支持其余组件或本机命令运行。

### 5.3 敏感文本扫描合同

物化过程中，AW 对最终生成的文本产物执行敏感内容扫描：
- **扫描源与阈值**：扫描完整 user effective config 中所有连续长度 $\ge 8$ 个 Unicode code points 的敏感明文。该阈值仅用于减少短字符串误报，不代表密码强度；运行日志对所有长度的敏感值均进行脱敏。
- **双重编码表示**：同时扫描敏感字符串的**原文**与 **JSON 转义形态**（包括转义双引号、反斜杠与控制字符）。
- **排除规则**：保留的 runtime receipt 仅在由 AW 生成或经内容哈希校验后，才从**精确路径**中排除，严禁按 basename 进行全局通配排除。
- **阻断行为**：一旦在产物中发现敏感明文，立即阻断本次物化提交，**绝不修改 live marketplace、Codex registration 或 project activation**。
- **证据定位**：receipt 属于可删除、可重建的弱状态现场证据，绝不是作者维护的持久账本。
