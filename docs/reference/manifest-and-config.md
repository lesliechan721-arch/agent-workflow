# Plugin Manifest 与配置声明合同

本文件是面向插件作者与自动化消费者的公开精确合同，定义 Plugin Manifest v3、Config Definition v5、Config Store v6 的规范、校验规则、引用模型与版本语义。内部状态持久化与物理 Envelope 完整定义参见[状态与配置架构说明](../maintainers/architecture/config-and-status.md#31-命名空间与-envelope-存储)。

## 1. 独立版本体系与查询入口

AW 各模块采用独立版本演进，不要将不同合同的版本号混淆或联动升级：

| 合同对象 | 当前版本 | 作用 |
| --- | --- | --- |
| Plugin Manifest | `schemaVersion: 3` | 插件源码元数据与声明入口结构 |
| Config Definition | `schemaVersion: 5` | Manifest 内的配置声明、引用、校验与展示定义 |
| Config Store | `schemaVersion: 6` | 用户配置持久化存储 Envelope 格式 |
| Runtime Config | `schemaVersion: 2` | 运行时产物内生效配置注入与读取合同 |
| Catalog Snapshot | `schemaVersion: 7` | Catalog 聚合与分发快照格式 |

CLI 结果使用[统一外壳](cli.md)，业务字段位于 `data`。字段定义、约束和接受值可通过已安装的 CLI 查询获取，无需缓存静态字段表：

```bash
aw dev plugin capabilities --surface manifest --json
aw dev plugin capabilities --surface config --json
```

仓库内完整的公开 JSON Schema 位于 `packages/plugin-core/schemas/plugin-manifest-v3.json`。Manifest 顶层严格设定了 `additionalProperties: false`，**严禁在 Manifest 中书写 `$schema` 键**，否则会被当前 schema 校验器直接拒绝。

---

## 2. Plugin Manifest v3 合同

插件权威源码根目录为 `<workspace>/plugins/<plugin-name>/`，其源码真值必须位于 `.agents-plugin/plugin.json`。

### 2.1 顶级字段与基本结构

```json
{
  "schemaVersion": 3,
  "name": "example-plugin",
  "version": "0.1.0",
  "description": "插件功能简述",
  "platforms": ["codex", "claude"],
  "marketplace": {
    "category": "workflow",
    "tags": ["example"],
    "strict": true,
    "policy": {
      "installation": "AVAILABLE",
      "authentication": "ON_INSTALL"
    }
  },
  "skills": "./skills",
  "requires": {
    "aw": {
      "capabilities": [
        "aw.plugin-recovery.v2",
        "aw.plugin-config.v5"
      ]
    }
  },
  "dependencies": ["other-plugin"],
  "config": {
    "schemaVersion": 5,
    "fields": {}
  }
}
```

可选的顶级字段还包括：
- `scripts`：构建、测试与渲染脚本配置。
- `managedCommands`：托管命令声明，详见[托管命令合同](managed-commands.md)。
- `nativeTools`：原生协议需求（必须包含 `definitions` 与 `consumers`），详见[原生工具合同](native-tools.md)。
- `extensions`：扩展钩子与平台权限声明。

- `schemaVersion`：必须显式为整数 `3`。CLI 拒绝 v2 及更早版本。
- `name`：插件名称，符合 `^[a-z0-9]+(?:-[a-z0-9]+)*$` 规范。
- `version`：单插件稳定语义版本（SemVer）。由作者或发布流程维护，仅标识 artifact 版本，不代表 AW capability。
- `description`：插件功能简要描述文本。
- `platforms`：支持的目标平台数组。受支持的合法平台为：`codex`、`claude`、`antigravity`、`cursor`、`opencode`、`pi`、`generic`。省略或为空数组表示七个平台全部支持。
- `marketplace`：必填对象，声明市场分类、标签与策略：
  - `category`：市场分类标识（非空字符串）。
  - `tags`：标签字符串数组。
  - `strict`：布尔值，是否启用严格策略模式。
  - `policy`：包含 `installation` 与 `authentication` 枚举。
- `skills`：插件相对目录路径字符串，指向 Skill 集合所在的目录，规范目录固定为 `"./skills"`（不是可任选目录）。注意 `skills` 是路径字符串，严禁书写为对象。
- `requires.aw.capabilities`：声明插件生产行为所必需的 AW 能力标识集合。仅声明实际依赖的能力，不要用 CLI 版本字符串替代：
  - `aw.plugin-recovery.v2`：插件生产内容实际调用当前 User/Project 生命周期入口时声明。
  - `aw.cli-output.v1`：脚本读取统一 CLI JSON 外壳时声明。
  - `aw.plugin-config.v5`：使用 Config Definition v5 时声明。
  - `aw.plugin-config-unique-by.v1`：使用对象数组唯一键声明时派生要求。
  - `aw.plugin-config-value-ref.v1`：使用本地值引用时派生要求。
  - `aw.plugin-config-cross-plugin-value-ref.v1`：使用跨插件值引用时派生要求。
  - `aw.plugin-config-summary.v1`：使用配置摘要展示时派生要求。
  - `aw.plugin-config-array.v1`：使用数组配置字段时派生要求。
  - `aw.installed-runtime-config.v2`：使用运行时配置读取时声明。
- `dependencies`：同 Catalog 来源内的运行时依赖插件名称数组（仅写裸插件名，不得包含来源前缀）。依赖图必须无环，且依赖的平台支持集合必须覆盖当前插件。

### 2.2 路径与节点安全约束

- 所有 source 路径必须位于插件源码根目录内，严禁以相对路径或符号链接逃逸到插件根外。
- 严禁源码文件或依赖路径进入任意深度的 `.git/` 或 `node_modules/` 目录。
- 源码树内不得包含符号链接或特殊文件节点。

### 2.3 扩展能力声明

- `extensions.hooks` 与 `extensions.nativeHooks`：声明平台钩子脚本。可执行入口仅限合法受控脚本或命令。
- MCP 服务：声明 stdio MCP server 配置。
- `managedCommands`：声明托管命令包与集合，详见[托管命令合同](managed-commands.md)。
- `nativeTools`：声明原生协议需求，详见[原生工具合同](native-tools.md)。

---

## 3. Config Definition v5 合同

在 Manifest 的 `config` 块中声明，必须指定 `schemaVersion: 5`。

### 3.1 组织模型、顶层公共定义与平台覆盖

必须明确区分**Manifest 中的公共配置声明**与**Store 中的 `common` 值 Profile**：
- 在 Manifest 的 `config` 声明中，公共定义位于 `config` 顶层（即 `config.definitions`、`config.fields`、`config.presentation`），**没有 `common` 容器键**；平台特定分支位于 `config.platforms.<target>`。
- 在用户持久存储的 Store v6 Envelope 中，`common` 是跨平台共享配置值的键名，二者层级不同，不得混淆。

```json
{
  "schemaVersion": 5,
  "definitions": {
    "profile": {
      "type": "object",
      "properties": {
        "model": { "type": "string", "required": true }
      },
      "additionalProperties": false
    }
  },
  "fields": {
    "agent": {
      "$ref": "#/config/definitions/profile",
      "default": { "model": "local" }
    }
  },
  "presentation": {
    "summaries": {
      "model": {
        "kind": "join",
        "parts": [{ "path": "/model" }],
        "separator": "/",
        "missing": "未设置"
      }
    },
    "fieldViews": {
      "agent": {
        "summary": "model"
      }
    }
  },
  "platforms": {
    "codex": {
      "fields": {
        "agent": {
          "$ref": "#/config/definitions/profile",
          "default": { "model": "gpt-5-codex" }
        }
      }
    }
  }
}
```

- **编译与展开顺序**：平台分支按名称替换公共的完整 `definitions`、顶层 `fields`，并可选替换整份 `presentation`，最后统一展开 `$ref`。平台覆盖不能通过预先规范化公共定义来绕过限制。
- **默认值继承规则**：平台分支中替换的字段若未显式声明 `default`，**绝不继承**公共字段声明的 `default`。
- **安全约束不可削弱**：平台分支只能强化而不能削弱安全限制（例如不得将公共声明的 sensitive 字段在平台分支降级为非敏感字段）。
- **有效值解析顺序（Effective Value Resolution）**：
  - 生效配置解析顺序固定为：`defaults(compileSchema(P)) < common < platforms[P]`，严格按顶层键的存在性整体覆盖。
  - `false`、`0`、空字符串 `""` 以及空数组 `[]` 是**实际有效值**，不能视为空或未设置。
  - 项目目录仅提供读取与 apply 的上下文，AW 不存在项目级配置持久化层（所有配置均持久化在用户 Store v6 中）。
  - 无效的高层覆盖不能降级运行；若删除或 unset 平台覆盖后暴露了无效的公共 `common` 配置，系统判定为配置无效（`invalidConfig`），**严禁用 schema 默认值静默替代**。
  - 结构损坏的 Store 必须进行整层 reset。

### 3.2 定义复用与本地 `$ref`

- `definitions`：用于复用对象或字段形状。
- `$ref` 语法：仅允许使用指向本地定义的 JSON Pointer，格式固定为 `#/config/definitions/<Name>`。
- 安全命名：定义名称必须符合合法标识符规范，严格拒绝 `__proto__`、`constructor`、`prototype`。
- 引用覆盖规则：引用处仅允许覆盖 `title`、`description`、`default`、`required`。覆盖后的 default 必须通过目标定义的完整类型与约束校验。
- 子属性约束：子属性可引用非敏感标量定义，但不能声明 `default`；动态 KV 子属性不能声明 `required`。
- 限制指标：
  - 最多声明 64 个 definitions。
  - 最多声明 256 个顶层 fields。
  - 最多允许 8 次引用跳转（包含嵌套对象属性内的引用计数）。
  - 未使用的坏定义、循环引用或未知引用均直接拒绝。
  - 编译后删除 definitions 和引用，保留 schemaVersion 与 presentation，值校验和消费展开后的字段。

### 3.3 支持的字段类型与约束

支持以下基础类型：`string`、`number`、`boolean`、固定结构 `object`、动态 `KV object`（带 `additionalProperties`）、以及受约束的一维 `array`。

#### 对象类型（Object）规范

`object` 必须在两种互斥模式中选择一种，严禁混用：
- **固定结构对象（Fixed Object）**：必须声明 `properties`，且 `additionalProperties` 省略或必须为 `false`。固定子属性使用 `required: true` 表示必填；所有子属性均不能声明 `default`。
- **键值字典对象（KV Object）**：严禁声明 `properties`，且必须用一个标量子 schema 声明 `additionalProperties`。KV 子属性严禁声明 `required`，也不能声明 `default`。
- **对象校验规则**：`validation` 支持 `minProperties`、`maxProperties`（非负整数，最大 32）以及用于校验字典键名的 `key`（复用 string 校验规则）。固定与 KV 对象最多均仅允许 32 个属性。

#### 数组类型（Array）规范

- `type: "array"` 必须给出单一 `items` schema，元素类型允许为 `string`、`number`、`boolean`、固定结构 `object` 或 `KV object`。
- `items` 可以引用本地 definitions，展开后遵守容器边界。`items` 自身严禁声明 `default`、`required`、`sensitive`。固定结构对象元素内的属性允许声明 `required`。
- **数组校验与容量限制**：`validation.minItems` 与 `maxItems` 是非负整数，数组最多包含 128 项（未显式声明 max 也受此硬限制）。每个数组完整值的规范化紧凑 JSON UTF-8 编码最多为 262144 字节（256 KiB）。对象元素仍最多 32 个属性。
- **唯一性**：`uniqueItems` 默认为 `false`；设为 `true` 时发现重复值报错，绝不静默去重。

#### 预设选项（`choices`）与候选规则

非敏感标量、对象、对象子属性及数组字段可声明 `choices: { allowCustom, presets }`：
- 每个 preset 使用稳定 `id`、显示 `title`、可选 `description` 以及实际完整 `value`。
- 同一字段最多允许一个 preset 设置 `recommended: true`。
- 严禁声明语义重复的 `value`。
- **自定义限制**：当 `allowCustom: false` 时，字段声明的 `default` 以及用户写入的值必须与某个 preset 的实际完整值严格相等。
- **整体性原则**：对象 preset 是完整 object 值而非 patch；数组 preset 是完整 array 选择，`allowCustom: false` 时禁止自定义增删改排。
- **等价性判断**：相等判断忽略对象键的声明与书写顺序，但严格保留数组元素的顺序。
- **空值边界**：空数组 `[]`、未设置（unconfigured）和显式 unset 彼此不等价；`required: true` 仅约束键必须存在，不代表非空（例如 `[]` 或 `""` 均可满足 required）。

#### 数组内唯一键（`uniqueBy`）与值引用（`valueRef`）

- **对象数组唯一键（`validation.uniqueBy`）**：指定对象元素中已声明的一个标量属性作为唯一键。候选值若有重复属性则拒绝整个候选列表，属性值保留原类型与大小写。要求 capability `aw.plugin-config-unique-by.v1`。
- **本地值引用（`valueRef`）**：非敏感标量可声明 `valueRef: { field, key, label?, include? }`。
  - `field` 必须指向另一顶层固定对象数组，且该数组必须声明了匹配的 `uniqueBy`。
  - `key` 为引用的同类型标量属性，`label` 为展示属性。
  - `include` 为允许的静态内置值列表。静态值作为保留字处理，源数组中严禁使用与 `include` 相同值的 key。
  - 要求 capability `aw.plugin-config-value-ref.v1`。
- **跨插件值引用（Cross-Plugin `valueRef`）**：`valueRef` 中可指定 `plugin` 字段，格式为 `{ "plugin": "provider-plugin", "field": "subagentCommands", "key": "key", "include": ["native"] }`。
  - 要求 capability `aw.plugin-config-cross-plugin-value-ref.v1`。
  - **Provider 门禁**：provider 必须是本插件在 Manifest `dependencies` 中显式声明的直接依赖，且必须位于**同一 Catalog source** 中；仅接受裸插件名，拒绝 `source/plugin`、相对路径或自引用。
- **闭包与完整关系校验**：
  - 保存、有效配置读取和 apply 均强制校验依赖闭包；若候选列表失效，系统直接报错，严禁返回残缺的部分列表。
  - 删除仍被 consumer 引用的 key 会直接失败（正确流程为：先新增目标 key，切换 consumer 引用，最后删除旧 key）。
  - 跨插件引用按相同平台与 common profile 配对核验。
  - 普通保存操作不仅检查当前插件，还会保护授权来源视图中此前有效、且可能尚未安装的 consumer。
  - 显式恢复例外：`aw plugin config reset` 作为恢复通道，允许清除当前 profile 覆盖并报告可能因此失效的下游引用。

#### 条件对象（`variants`）与常量（`const`）

声明 `config.schemaVersion: 5`（要求 `aw.plugin-config.v5`）后，固定对象支持有限分支选择，标量支持常量声明：
- **条件分支（`variants`）**：
  - `variants.discriminator`：必须指向当前对象公共 `properties` 中已声明的 own string 属性。
  - `cases`：将判定字符串映射到对应的 `{ properties }` 分支结构；分支内部不能覆盖公共已有的属性。
  - `missing`：可选，指定判别属性缺失时生效的备用 case 名称。
  - `otherwise`：可选，为其他未匹配的合法枚举值提供通用的 `{ properties }` 分支。
  - 所有分支在 schema 编译读取时必须全部合法，不存在匹配分支时拒绝候选，严禁猜测默认值。
- **常量（`const`）**：标量可声明 `const`。显式传入的值若不匹配直接报错；配置中省略时界面可呈现该固定常量，但不将其强制写入底层强配置。`required` 约束仍独立生效。

#### 敏感字段（`sensitive: true`）规则

敏感值保护适用于公共与所有平台 profile：
- **仅限顶层 string**：仅允许顶层 `type: "string"` 的字段声明 `sensitive: true`。
- **严禁默认值与枚举**：敏感字段严禁声明 `default` 或 `choices`。
- **禁止复合类型声明**：`object`、对象子属性、KV child、`number`、`boolean`、`array` 严禁声明 sensitive。
- 交互与写入保护：`aw plugin config set` 严禁通过 argv `--value-json` 或 `--preset` 提交敏感值；必须使用 `--value-stdin`（读取原始 UTF-8 直至 EOF，不自动 trim）或交互式 TTY 隐藏输入。

#### 正则模式与长度校验（RE2-WASM）

- 正则匹配使用 RE2-WASM Unicode 引擎（固定绑定 `re2-wasm@1.0.2`）。
- 必须伴随最大长度：声明 `pattern` 时，必须同时声明 `maxLength`。
- 参数边界：`maxLength` 范围为 `0..4096`，`pattern` 最多允许 512 个 Unicode code points。
- 匹配行为：默认为非锚定匹配。若需全字符串匹配，作者必须显式书写 `^` 和 `$`。
- 字符串键与值共用同一套校验器与安全边界。

### 3.4 摘要展示（`presentation.summaries` 与 `presentation.fieldViews`）

用于在 TUI 清单和紧凑视图中展示配置摘要：
- `presentation.summaries.<name>` 结构：`{ kind: "join", parts: [{ path, format? }], separator, missing }`。
- 字段关联：固定对象字段使用 `fieldViews.<field>.summary` 关联本地摘要；固定对象数组元素使用 `fieldViews.<field>.itemSummary` 关联元素摘要。
- `path`：已声明固定标量属性的 JSON Pointer token，支持 `~0` 和 `~1` 转义，不遍历原型、其他字段或外部引用。
- `format`：默认为 `raw`；可选 `choiceTitle`（优先显示预设 title，无匹配显示原标量值）。
- **空标量与缺失处理**：可选属性缺失时显示 `missing`；空字符串 `""`、`0` 与 `false` 保留明确文本显示；必填属性缺失或属性值无效时统一显示“需修正”。
- **适用边界**：摘要不适用于 KV 字典对象或敏感字段。过长或未选中的属性将使 `ValuePresentation.complete` 标记为 `false`，界面回退至完整读取入口。
- **容量上限**：Core 的 `PLUGIN_CONFIG_SUMMARY_MAX_*` 常量公开限制：最多 4 个 parts，`separator` 最多 8 个 Unicode code points，`path` 最多 128 字符，渲染后总摘要最多 256 个 Unicode code points。清除 ANSI/OSC 控制符与危险双向字符。
- **计算独立性**：摘要纯粹用于界面展示，**绝对不参与** dirty 变更检测、preset 匹配、Review diff 计算或配置 hash 计算。
- **元数据身份**：呈现元数据变化仍属于 schema identity 的一部分，会改变 manifest/bundle digest 并需要重新采集 Review 证据。

---

## 4. Config Store v6 持久化合同

用户配置按命名空间独立持久化在 `<AW_HOME>/plugin-config/<sourceId>/<pluginName>/config.json`。Store v6 的底层物理文件 Envelope 结构、顶层白名单校验及并发写锁管道的完整定义参见[状态与配置架构说明](../maintainers/architecture/config-and-status.md#31-命名空间与-envelope-存储)。本节仅说明作者与用户配置交互所需的值模型与变更行为。

### 4.1 值模型与 Profile 层次

Store v6 内部隔离维护两类配置值容器：
- `common`：跨平台通用的用户配置键值映射（`Record<string, PluginConfigValue>`）。
- `platforms.<target>`：针对特定平台（如 `codex`、`claude`）的用户配置覆盖映射。

核心语义：
- **顶层整体覆盖**：平台覆盖按顶层字段整体覆盖，不做深度合并（deep merge）。
- **原始类型保留**：读取和保存严格保留 JSON 原始类型（string、number、boolean、object、array），严禁隐式类型转换（coercion，例如不将 `"123"` 转换为 `123`）。
- **展示标识解耦**：展示用的 `pluginId`（如 `<sourceId>/<pluginName>`）仅用于运行时解析与界面投影，绝对不作为字段保存在持久 Envelope 中。

### 4.2 保存成功与应用失败解耦

在 `Config Mutation Receipt v7` 中，配置保存与实际应用完全解耦：
1. **保存提交（configWrite）**：进行 schema 预检与依赖闭包校验，验证通过后原子提交用户文档。一旦写入成功，回执标记 `configWrite: "succeeded"`。
2. **应用刷新（apply）**：刷新已安装现场产物（重新物化受影响的 Native、Portable 或命令包）。
3. **失败保留原则**：若保存成功后应用阶段失败（例如目标平台缺少依赖、preApply 异常或现场被占用），**已保存的强配置绝不回滚**。回执与 CLI 状态将状态报告为部分完成（`status: "partial"`）并附带明确的安全恢复入口（如 `aw plugin sync`），不得判定为“配置未修改”。

### 4.3 配置变更命令行为

- `aw plugin config set`：基于编译后的字段定义校验输入并原子提交。
- `aw plugin config unset`：仅移除当前 profile 中已存在的键，清理过期字段，不虚构未变化的生效状态。
- `aw plugin config reset`：显式恢复通道。清除选定的 common 或指定平台层后，若仍有其它非空值层保留则回执标记 `clearedLayer`；若健康普通文件的最后一个值层被清空，或执行整文档重置与损坏文件恢复，文件被删除并返回 `deletedFile`。其它节点按实际类型处置：不存在为 `absent`、符号链接解除为 `unlinkedSymlink`、仅目录节点执行同父隔离并返回 `quarantinedDirectory`。具体底层物理存储恢复语义参见[状态与配置架构说明](../maintainers/architecture/config-and-status.md#31-命名空间与-envelope-存储)。
