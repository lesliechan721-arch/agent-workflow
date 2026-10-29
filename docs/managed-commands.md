# 托管命令合同 v1

本文件定义 Plugin Manifest v3 的托管命令声明、ArtifactPlan v2 扩展、稳定身份、权限引用、管理接口和运行边界。字段与校验的机器真值由 Core schema/types、canonical capability registry 和当前 CLI 提供；使用 `aw plugin capabilities --surface managed-commands --json` 查询作者合同。

Guide 的参数、输出、文件与消费合同由 [Guide 运行生命周期](../plugins/codex-enhance/skills/codex-subagent-guide/docs/runtime.md) 维护，Adapter v5 由 [适配器协议](../plugins/codex-enhance/skills/codex-subagent-guide/docs/protocol.md) 维护。Manifest、Config、ArtifactPlan、命令主机与 Adapter 的版本互相独立。

## A1. 版本与通用校验

新增 capability 固定为 `aw.managed-commands.v1`。声明 `managedCommands`、结构化命令权限或命令占位符均要求此能力。Claude 沙箱排除另外要求 `aw.claude.sandbox-exclusions.v1`，不从普通 allow 推导。Core registry、结构派生和 CLI implemented set 同步支持；公开作者 registry 增加 `managed-commands` surface，`extensions` 和 `artifacts` surface 同步列出相关字段与输出类型。

Manifest 保持 `schemaVersion: 3`；Config Definition 保持 v4；ArtifactPlan 保持 `version: 2`，增加本合同定义的两个 artifact 分支。旧 AW 在 capability 检查时拒绝不支持的插件，不静默忽略新字段。Guide 的 Adapter v5 保留帧版本；enabled 通信对象不接受主动接收可选能力字段，精确定义及旧 custom adapter 更新要求见 [Guide 运行合同](../plugins/codex-enhance/skills/codex-subagent-guide/docs/runtime.md)。命令主机描述和用户命令定义各自使用 schema 1，定义见 [本文件运行合同](#b1-命令管理-cli-与机器输出)。

本合同中的对象均拒绝未知字段；`?` 表示可省略，`null` 不等于省略，除显式列出外均拒绝。所有字符串须为合法 Unicode，不能含 NUL。缺省值只在规范化时补齐；不 trim 标识符、argv 或环境值。JSON 文本解析沿用现有项目合同，不新增重复 member name 检测器。表中 `Name` 为 `[A-Za-z][A-Za-z0-9_.-]{0,63}`，区分大小写；`Platform` 为 `codex | claude`，`Scope` 为 `user | project`。

`RelativeFile` 是用 `/` 分隔的非空相对文件路径：不以 `/`、`./`、盘符或 UNC 起始，不含空段、`.`、`..`、反斜杠或控制字符。解析后须是 producer 内普通文件，路径链不得有 symlink 或特殊节点。插件 `sourceDir` 继续使用现有 `./` plugin-relative 目录语法和 bundle closure 规则；不因命令包放宽受保护目录、作者资料或依赖 symlink 的限制。

## A2. Manifest 的唯一声明入口

Manifest v3 新增顶层 `managedCommands`：

```ts
type ManagedCommands = {
  packages?: ManagedPackage[]; // 缺省 []，key 在本插件内唯一
  sets?: CommandSet[];         // 缺省 []，set 在本插件内唯一
};
type ManagedPackage = {
  key: Name;
  scope: Scope;
  platforms: Platform[];      // 非空、无重复：哪些平台操作纳入此包
  sourceDir: string;
  render?: true;              // 缺省不渲染；不接受 false
  refreshKeys?: string[];     // 缺省 []，无重复
};
type ProducerRef =
  | { kind: "artifact"; artifactId: string }
  | { kind: "static-skill"; platform: Platform; skillKey: string }
  | { kind: "package"; packageKey: Name };
type CommandSet =
  | { set: Name; producer: ProducerRef; mode: "static";
      entries: CommandDefinition[] }
  | { set: Name; producer: ProducerRef; mode: "dynamic";
      refreshKeys: string[] };
type CommandDefinition = {
  key: Name;
  variant?: Name;             // default
  runner: "node" | "executable";
  entry: RelativeFile;
  args?: string[];            // []
  env?: Record<string, string>;     // {}
  envFrom?: Record<string, string>; // {}
  cwd?: "caller" | "resource";    // caller
};
```

声明位置只保留这一处。不再让作者在 `artifacts.targets` 重复声明相同 command set/package target，也不在 package 中维护第二份 commandSet 列表。一个包可拥有多个 set，关联只由 `set.producer.packageKey` 确定。空 entries 合法，表示本集合没有可运行条目。一个集合中规范化后的 `(key, variant)` 不得重复；不同集合可以使用相同 key。

`artifact` 引用同插件中唯一可定位的动态 `codex.skill` 或 `claude.skill` declaration，并使用其完整最终 Skill 目录；不接受没有目录资源的 instruction/role target。若现有 artifact ID 在平台或 scope 间重复而不能唯一定位，拒绝该引用，要求作者为被引用 target 使用唯一 ID。`static-skill` 引用所选平台静态 Skill 的声明 key，不能指向动态 Skill 或任意磁盘路径。其它独立工具用 package 承载。Portable Skill 不成为本机 producer。

artifact set 继承其 producer 的平台、合法 scope、delivery 和配置作用域；Codex shared native 固定为实际 `user` 物化。Codex 和 Claude 的 static-skill producer 均为共享原生资源，固定 `scope: "user"`、`projectRoot: null`，集合仅使用 user 配置并投影为 user renderer target。project 安装或启用不会生成项目资源身份，也不能用 project 配置覆盖共享启动定义。AW-owned 动态 Skill 仍使用各自实际物化 scope。package set 继承包的固定 scope，使用 AW-owned surface，不受调用平台选择改变。user/shared-user 消费者不得引用 project 包；project 消费者可以引用明确声明的 user 包。被引用包必须将该消费者平台列入 `platforms`。

每个 `refreshKeys` 必须来自现有 Config v4 顶层字段，字段及校验依赖闭包均不得敏感。动态 set 即使不读取配置也必须写 `refreshKeys: []`。package 的 refreshKeys 仅控制它生成的普通文件；没有 `render: true` 时只能省略或为 `[]`。包的文件生成和各 set 的 refreshKeys 分别拥有自己的输入；一次 producer 刷新使用所需 target 的并集，不把另一平台配置混入。

`args` 最多 128 项，每项最多 4096 个 Unicode code point，允许空串。环境名遵守 `[A-Za-z_][A-Za-z0-9_]*`；env 值最多 4096 个 code point。envFrom 的值是环境名，不是表达式。禁止项、继承与优先级见 B3，安装及执行都校验。

## A3. Renderer 请求与响应

### 规范化 target

Core 从上述声明生成下列 target，供现有请求、作者工具与 planner 共用；这是声明的确定性投影，不是另一个持久注册表。

| 条件 | id | target / kind | surface / scope | states / refreshKeys |
| --- | --- | --- | --- | --- |
| 动态 set | `command-set.<set>` | `aw.command-set` / `commandSet` | 从 producer 取得 | `present, disabled` / set 声明值 |
| `render: true` 包 | `command-package.<key>` | `aw.command-package` / `commandPackage` | `{kind:"aw",name:"managed-commands"}` / 包固定 scope | 仅 `present` / package 声明值 |

`command-set.` 与 `command-package.` 是本插件 artifact ID 的保留前缀，作者手写 `artifacts.targets[].id` 不得占用。静态 set 和静态包没有 renderer target，但仍进入同一候选校验和发布过程。存在任何动态命令 target 时，必须有现有 `scripts.artifacts.render` 声明。

ArtifactSurface union 新增 `{kind:"aw", name:"managed-commands"}`。此 context 不带 `platform` 或 `distribution`，进程设置 `AW_PLUGIN_SURFACE=managed-commands`，不设置 `AW_PLUGIN_PLATFORM` 或 `AW_PLUGIN_DISTRIBUTION`。原 platform/distribution surface 保持原行为。共享包的同一 target 只请求一次，不能以 Codex 和 Claude 两份 context 分别渲染。

context 的 `event/plugin/config/changedConfigKeys/requestedArtifactIds/previousArtifacts/artifactSources/runtimeImports/paths/renderer` 沿用现有字段和临时 home 合同。新增字段固定为：

```ts
commandSources: Array<{
  packageKey: Name;
  sourceDir: string; // 固定 bundle 中已核验的绝对目录，只读
}>;
```

`commandSources` 在所有新旧 surface 中均存在，缺省 `[]`；仅列出本次所请求 command target 涉及的包。`artifactSources` 继续列 Skill 来源，二者不扩大配置读取范围。`previousArtifacts` 是当前 surface/scope 中已知的上次规范化输出，无历史时为 `[]`；同批拆分的请求共用不可变副本。它不能授权访问别的 producer，也不能替代实际安装证据。

`requestedArtifactIds` 仍要求非空、唯一且精确。AW 先按 surface/scope 和敏感配置隔离拆批；所有命令 target 均进入非敏感批。绑定 Skill 的 producer 与 set 在同一次局部操作中协调：变更任一者时取得完整候选；已健康且不需重新渲染的 producer 可复用。含引用的相关消费者须与集合一起校验，不能在新集合移除命令后发布悬空 Skill。

### 输出类型

仍返回单个 `{ "version": 2, "artifacts": [...] }`。新增两个分支：

```ts
type CommandSetArtifact = {
  id: string;                 // 必须等于 command-set.<set>
  target: "aw.command-set";
  kind: "commandSet";
  platform?: Platform;       // 仅平台 producer：必填且等于请求
  state: "present" | "disabled";
  refreshKeys: string[];     // 与规范化 declaration 完全一致
  entries: CommandDefinition[];
  disabledReason?: string;   // 仅 disabled 可用，非空
};
type CommandPackageArtifact = {
  id: string;                 // 必须等于 command-package.<key>
  target: "aw.command-package";
  kind: "commandPackage";
  state: "present";
  refreshKeys: string[];
  files: Record<RelativeFile, string>;
};
```

package surface 的输出禁止 `platform` 和 `distribution`；平台 command set 禁止 `distribution`。scope、producer、set/key 归属从请求和声明取得，输出不能携带 `owner`、`commandId`、`resourceRoot`、producer 或 scope 覆盖。`disabled` 必须 `entries: []`；`present` 的空 entries 同样撤销条目，但 list/show 将集合显示为正常空集合。每个请求 ID 返回恰好一次，不接受额外 ID、缺失项或重复项。

`files` 必须显式提供，允许 `{}`。它是本次完整生成文件集；从本次 bundle 的 `sourceDir` 重新准备候选，再以 files 覆盖同路径普通文本文件。上次生成但本次未返回的文件不保留，bundle 本身的原文件仍按本次 sourceDir 存在。拒绝目录/文件冲突、链接、保留 owner/runtime receipt 路径及命令声明 entry 路径的覆盖；生成文件用于配置，不改写可执行代码。编码为 UTF-8，新增文件为非可执行普通文件。二进制资源由 sourceDir 提供。

既有 renderer timeout、总输出限值、敏感值扫描、普通文件校验及错误脱敏完整适用；不为命令包另设较宽限值。files 和 entries 均须通过最终闭包检查；失败不发布本次 producer。

## A4. 稳定 ID 的精确定义

来源字段取安装器已核验元数据，不能由 renderer 传入。`sourceIdentity` 使用现有 `sha256:<64位小写hex>` 字符串；sourceId 和 pluginName 使用现有规范值。producer 的逻辑身份为：

```ts
type ProducerIdentity = {
  sourceId: string;
  sourceIdentity: string;
  pluginName: string;
  kind: "artifact" | "static-skill" | "package";
  key: string;               // artifactId / skillKey / packageKey
  platform: Platform | null; // package 必须 null
  scope: Scope;              // 实际物化 scope；shared native 为 user
  projectRoot: string | null; // user 为 null
};
type CommandIdentity = {
  schemaVersion: 1;
  producer: ProducerIdentity;
  set: Name;
  key: Name;
  variant: Name;             // 省略输入已归一为 default
};
```

projectRoot 使用现有项目根定位器确定项目，再 `realpath` 并按本机 `path.normalize` 规范化，去掉非文件系统根的尾部分隔符。Windows 仅将盘符字母转大写，不把整个路径转小写；不做 Unicode normalization。项目不存在时报错，不以 caller cwd 替代。跨 OS 或移动目录不保证原 project producer 身份保留；user 身份不包含 home 路径。

规范序列化 C：object keys 按 ECMAScript 默认字符串排序；数组保持顺序；primitive 用 `JSON.stringify`；递归拼接，不含空白或末尾换行。对象中所有列出的 identity 字段必填，不允许 undefined/额外字段。插件命令 ID 精确为：

```text
cmdp_ + lowercaseHex(SHA256(UTF8(C(CommandIdentity))))[0:16]
```

取摘要前 64 位，编码为 16 位小写 hex；完整命令 ID 共 21 个字符。不加第二次摘要，不把版本、config digest、resourceRoot、安装路径或包 revision 放入 identity。sourceId 改名也形成新身份；相同别名替换 sourceIdentity 必须形成新身份。规范化前后的键大小写不互换。绑定仍核对完整 identity；若遇同 ID 不同 identity，不覆盖，返回 `commandIdentityConflict`。

用户命令 ID 为 `cmdu_` 加标准小写带连字符 UUID v4，例如 `cmdu_4ba70354-0867-4ecb-a927-120c1933f514`。首次 install 生成，update 不变，remove 后重新 install 重新生成。两种 ID 都不接受大小写修正或人类名称路由。

## A5. 引用与权限

逻辑引用唯一结构为 `{set: Name, key: Name, variant?: Name}`，variant 缺省 default。正文占位符唯一语法为 `{{aw.command:<set>/<key>}}` 或 `{{aw.command:<set>/<key>/<variant>}}`，展开为 `aw command run <id> --`，不加引号或换行。其它以 `{{aw.command:` 开始但不合法的形式拒绝。它只在最终 Skill 树的 `.md` 文本文件中展开，包括静态和动态 Skill；不改二进制、脚本、JSON/TOML 配置或普通环境值。代码块中也展开。首版不提供“只返回 ID”的第二种模板。

AW 先建立本次候选与未请求健康绑定的集合视图，再在消费者的 owner、平台、实际物化 scope 下解析。producer 声明明确决定 user/project，不能按调用 cwd 猜测；同一逻辑引用在不同合法消费者中可能展开为不同物理 producer 的 ID。引用不存在、disabled、跨插件或跨来源、scope 不合法、缺少可核验 producer 时均返回 `commandReferenceInvalid`，不发布该消费者。Portable 输出包含本机命令占位符时返回 `managedCommandPortableUnsupported`；作者须提供独立 Portable 内容。review prepare/作者验证只在隔离主机中计算候选，不注册真实命令。

现有 `extensions.permissions[].allow/ask/deny` 的 item 从 string 扩展为下列 union；原 string parser 和含义不变：

```ts
type PermissionCommand = string | {
  command: { set: Name; key: Name; variant?: Name };
  argsPrefix?: string[]; // 缺省 []，即此 ID 的全部调用
};
```

`argsPrefix` 每项必须是非空安全 token，匹配 `[A-Za-z0-9_./:@%+=,-]+`；不含空白、引号、反斜杠、通配符和 shell 控制字符。AW 不接受任意 shell 模板。它与 run 的完整 argv 能力不同：不能精确表达的权限前缀须由作者改为窄的安全子命令，不自动扩大。

Claude 专属配置固定在 `extensions.permissions[].agentOverrides.claude.sandbox.excludedCommands`，元素只接受上述结构化对象，不接受普通字符串。不在 permission 顶层增加含糊的 sandbox 字段；Codex override 声明 sandbox 为错误。claude override 为 null 的现有禁用语义保留；正常 allow/ask/deny 的 override 合并规则不变。排除项独立于 allow，也不能推导 allow。

解析 token 数组固定为 `["aw","command","run",id,"--",...argsPrefix]`。Codex 按原 prefix_rule 输出；Claude 将安全 token 用一个 ASCII 空格连接，尾部附加 ` *`，allow/ask/deny 再包 `Bash(...)`，excludedCommands 不包 Bash。排序和去重在解析后的同 decision、同 owner 内进行；跨 owner 的相同值仍保留各自 ownership。撤销一项时仅在没有用户或其它已知 owner 责任时移除物理值，不删除既有未知配置。

Claude 当前官方合同说明尾部 ` *` 覆盖有/无参数的该前缀，沙箱排除与 permission 独立，组合命令仍受额外条件约束。这里只生成直接调用所需规则；实际宿主匹配继续单独验收。[权限语法](https://code.claude.com/docs/en/permissions)、[沙箱排除](https://code.claude.com/docs/en/sandboxing#run-commands-outside-the-sandbox-with-excludedcommands)。

Guide 的 allow 与 Claude exclusion 均固定为 start/send/wait/result/stop 五项；不生成整个 ID 的宽前缀。管理入口与其它 ID 不匹配。

## A6. 可交接示例

以下是 Manifest v3 的字段片段；加入插件现有基础 metadata 和 render script 后使用：

```json
{
  "requires": {"aw": {"capabilities": [
    "aw.managed-commands.v1", "aw.claude.sandbox-exclusions.v1"
  ]}},
  "managedCommands": {
    "packages": [{
      "key": "review-tools", "scope": "user", "platforms": ["codex", "claude"],
      "sourceDir": "./tools/review", "render": true, "refreshKeys": ["reviewMode"]
    }],
    "sets": [{
      "set": "review-tools", "producer": {"kind": "package", "packageKey": "review-tools"},
      "mode": "dynamic", "refreshKeys": ["reviewMode"]
    }]
  },
  "extensions": {"permissions": [{
    "name": "review-tools",
    "allow": [{"command": {"set": "review-tools", "key": "review"}, "argsPrefix": ["check"]}],
    "agentOverrides": {"claude": {"sandbox": {"excludedCommands": [
      {"command": {"set": "review-tools", "key": "review"}, "argsPrefix": ["check"]}
    ]}}}
  }]}
}
```

在 user scope 同批请求 `command-package.review-tools` 和 `command-set.review-tools` 时，对应输出：

```json
{
  "version": 2,
  "artifacts": [
    {
      "id": "command-package.review-tools", "target": "aw.command-package",
      "kind": "commandPackage", "state": "present", "refreshKeys": ["reviewMode"],
      "files": {"settings.json": "{\"mode\":\"strict\"}\n"}
    },
    {
      "id": "command-set.review-tools", "target": "aw.command-set",
      "kind": "commandSet", "state": "present", "refreshKeys": ["reviewMode"],
      "entries": [{"key": "review", "runner": "node", "entry": "adapter.mjs", "cwd": "caller"}]
    }
  ]
}
```

Skill 使用 `{{aw.command:review-tools/review}} check`。同一例子改为静态时删除 package 的 render/refreshKeys，并把 set 的 mode 改为 static、refreshKeys 换为 entries；没有别的动态 target 时不运行 renderer。


## B1. 命令管理 CLI 与机器输出

公开参数如下。方括号表示可选；JSON 参数接受一个完整 JSON 值，不进行 shell 或环境展开。所有管理命令支持 `--json`；写命令支持现有 `--yes` 确认语义。非交互写操作缺少必要确认时，在写入前报错。

```text
aw command install <directory> --name <name> --runner node|executable --entry <relative-file>
  [--args-json <string[]>] [--env-json <object>] [--env-from-json <object>]
  [--cwd caller|resource] [--yes] [--json]
aw command update <cmdu-id> --from <directory>
  [--name <name>] [--runner node|executable] [--entry <relative-file>]
  [--args-json <string[]>] [--env-json <object>] [--env-from-json <object>]
  [--cwd caller|resource] [--yes] [--json]
aw command remove <cmdu-id> [--force] [--yes] [--json]
aw command list [--json]
aw command show <command-id> [--json]
aw command run <command-id> -- <args...>
aw command package sync <source/plugin> <package-key> --scope user|project [--yes] [--json]
aw command package remove <source/plugin> <package-key> --scope user|project
  [--force] [--yes] [--json]
aw command package remove <pkg-id> [--force] [--yes] [--json]
```

name 为 1–128 个 Unicode code point 的非空白展示名，不含控制字符，允许重名。install 的启动定义使用 A2 相同规则但没有 key/variant。update 未提供的字段保留旧值；提供的数组/对象整体替换，`[]`/`{}` 显式清空，不接受 null。`--from` 必填；旧强配置损坏时 update 拒绝，用户可以按 ID 安全 remove 后重新 install，不能猜旧定义。install/update 的 directory 按 caller cwd 解析并复制全部合法普通节点，源目录只读；拒绝包含 AW_HOME、安装目标、仓库 `.git` 或其它受保护树的复制范围。

run 必须有字面分隔符 `--`，即使目标参数为空。其前只接受规范 ID 与 help；不接受 `--json`、runner/env/entry/cwd 覆盖。其后不再解析 AW 参数。插件 ID 不能用 update/remove 修改；返回 `commandOwnerMismatch`，并提示 producer 的正常维护入口。

list 只扫描本 AW_HOME 命令目录、索引与其明确指向的资源，不扫描所有项目。它可列出以前已绑定但当前不在 cwd 的 project producer；不按 cwd 改写绑定。包含用户命令、插件命令和包；空集合/损坏包也有 package 项。show 的输入仍是 command ID，不把 package key 当命令 ID；包信息通过 list 或命令的 producer 字段读取。

管理输出用下列 schema 1。所有字段必填，空集合为 `[]`；JSON 单对象加 LF 写 stdout，诊断不混入 JSON。人读输出可以排版，但必须保留同样的成功、部分成功与恢复信息。

```ts
type Diagnostic = { code: string; message: string; subject?: string };
type Launch = { runner: "node" | "executable"; entry: string;
  args: string[]; env: Record<string,string>; envFrom: Record<string,string>;
  cwd: "caller" | "resource" };
type CommandView = {
  id: string;
  name: string; // 用户 name，或插件的 set/key/variant
  owner: { kind: "user" } | { kind: "plugin"; producer: ProducerIdentity };
  availability: "ready" | "unavailable";
  resourceRoot: string | null;
  launch: Launch | null; // 损坏而无法安全解析时为 null
  errors: Diagnostic[];
  recoveryActions: string[];
};
type PackageView = {
  id: string; // pkg-id，供精确 remove 使用
  producer: ProducerIdentity;
  resourceRoot: string;
  availability: "ready" | "empty" | "unavailable";
  sets: Array<{ set: string; state: "present" | "disabled"; commandIds: string[] }>;
  errors: Diagnostic[];
  recoveryActions: string[];
};
type CommandManagementResult = {
  schemaVersion: 1;
  command: "command.install" | "command.update" | "command.remove" |
    "command.list" | "command.show" | "command.package.sync" | "command.package.remove";
  ok: boolean;
  overallState: "completed" | "partial" | "failed";
  commands: CommandView[];
  packages: PackageView[];
  changes: Array<{ kind: "command" | "package"; id: string;
    action: "created" | "updated" | "removed" | "retained" }>;
  errors: Diagnostic[];
  recoveryActions: string[];
};
```

`ProducerIdentity` 见 A4；package change 的 id 为 `pkg_` 加 `SHA256(UTF8(C(ProducerIdentity)))` 的小写完整 hex，用于展示、目录定位和精确 package remove，不作为 run ID。用户写操作成功返回受影响命令；remove 后 commands 可为空，changes 保留被删除 ID；package 操作返回受影响包/命令，删除后以 changes 保留身份。list 返回全部可观察项，show 最多返回一个命令及其所属独立包。秘密的解析值从不进入 Launch 或 errors。

`package remove <pkg-id>` 是精确现场选择分支，与 source/plugin + package-key + scope 分支互斥，不接受 `--scope`。它读取本 AW_HOME 中该 pkg-id 的独立 owner marker，校验目录、完整 ProducerIdentity 与重算 pkg-id 一致，再按既有边界删除这个专属包。它不读取当前 Catalog、不要求旧项目根仍存在、不用当前 sourceIdentity 替换 marker 的来源；Review 展示旧来源身份、旧项目根及全部命令失效影响。删除范围仍仅为 AW_HOME 内该包与其派生绑定，不删除旧项目目录或平台设置。原选择器分支要求当前 scope/project 和可核验来源唯一匹配；有歧义时报告候选 pkg-id，用户可用精确分支移除。marker 损坏或冲突时两个分支都不能绕过 ownership。

管理命令退出 0 表示完整完成，1 表示 failed/partial，2 表示参数错误；`ok` 仅在 completed 为 true。list/show 发现资源不可用时仍返回可读记录，同时 overallState=partial、exit=1；无命令的健康 list 为 completed。记录连身份也无法解析时只放 errors，subject 使用安全的本 AW_HOME 相对定位，不伪造 PackageView。show 找不到 ID 为 `commandNotFound`。

既有插件写命令继续使用 Receipt v6，在其顶层增加可选 `commandResults`，无相关动作时省略；TUI 使用同一投影，不新增第三个平台：

```ts
commandResults?: Array<{
  producer: ProducerIdentity;
  state: "completed" | "partial" | "failed";
  commandIds: string[];
  removedCommandIds: string[];
  errors: Diagnostic[];
  recoveryActions: string[];
}>;
```

producer 写入或绑定失败参与整体 failed/partial 计算；权限写入仍计入其真实平台结果。Review 展示 package 的共享影响、固定参数和权限变化，不能因为没有平台枚举值就漏掉 AW-owned 包。

Config Mutation Receipt v7 的 `apply` 对象增加可选 `commandResults`，元素与上述 Receipt v6 的 commandResults 完全相同；它与 `apply.targetResults` 并列，不向 ConfigApplyTargetIdentity 填入假平台。所有 apply union 分支都接受此字段：没有命令目标时省略，skipped 时只能省略或为空；其它分支保留已经取得的实际结果。TUI 配置 Review、Progress 和 Result 同时消费这两组结果。

配置 apply 的发现范围固定为：本次 sourceId + sourceIdentity + pluginName 下，独立 owner marker 可核验的已安装包，加上本次既有平台 apply 计划明确引用的 package producer，按完整 ProducerIdentity 去重。user 配置 apply 检查 user 包和当前规范项目的 project 包；project 配置 apply 只检查当前项目的 project 包。它只扫描 AW_HOME 的包 marker，不扫描其它项目，也不刷新其它 projectRoot 的包。旧来源身份的包保留并提示精确 remove/sync，不按当前配置接管。

是否刷新使用该 producer 的有效配置与其 package/动态 set refreshKeys 的并集，沿用现有值、来源和校验依赖的变更判定。已保留包即使没有平台 activation/placement，也可因匹配配置变化而刷新；仅有 manifest 声明且尚未安装/不在平台计划中的包不会被配置 apply 隐式安装。producer 已从当前 manifest 删除时只报告残留与 pkg-id remove 指引。

`noVisibleTarget` 仅在平台目标和包目标都为空时成立。`apply.state=succeeded` 要求两组中所有实际目标成功；任一包失败、部分完成或发现错误时，保存成功的配置仍保留，`apply.state=partial` 并带 commandResults/现有 stage 错误，Config Mutation Receipt 整体为 partial、ok=false、exit=1。前置 source/schema/effectiveConfig 不可用继续使用既有 unavailable 分支，并保留其已知目标证据。`notRequested`、`noConfigChange`、`noEffectiveConfigChange` 仍按现有合同判断，但不得只看平台目标而漏掉包。一次平台/配置操作内，同一 producer 最多刷新一次，不增加持久 claim。


## B2. 持久定义、派生绑定与独立 owner 证据

必须固定的持久格式只有用户定义及安装产物内的命令记录；派生索引文件的数量和组织保留实现自由。所有新增 schema 1 对象拒绝未知字段。弱文件损坏报告错误，不建立自动迁移或恢复日志。

用户强配置固定在 `<AW_HOME>/commands/users/<cmdu-id>/definition.json`：

```ts
type UserCommandDefinition = {
  schemaVersion: 1;
  id: string;             // 与目录名相同的 cmdu-id
  name: string;
  packageRevision: string; // 小写 UUID v4，仅用于选择实际复制目录
  launch: Launch;
};
```

资源根由 AW 计算为同目录 `packages/<packageRevision>/`，强配置不接受任意绝对 resourceRoot。install/update 先完整准备新 revision，再原子替换 definition；切换后才清理旧自有 revision。没有版本保留承诺；revision 是避免破坏旧包的局部暂存名，不进入命令 ID。

同一用户 ID 目录中的 `owner.json` 与 definition 分开，结构为 `{schemaVersion:1,owner:"agent-workflows",kind:"user-command",id}`。它只证明这个专属目录的归属，不能授权删除其它位置，也不描述安装成功或当前版本。definition 损坏时 remove/--force 仍可按该 marker 和路径边界清理；marker 缺失/冲突时保留内容并报告，不能凭用户提供的 ID 删除任意目录。

独立插件包固定在 `<AW_HOME>/commands/packages/<pkg-id>/`，包含 `owner.json` 与 `resource/`。owner 格式为 `{schemaVersion:1,owner:"agent-workflows",kind:"plugin-command-package",producer:ProducerIdentity}`；pkg-id 算法见 B1。实际资源根为 resource。marker 原子写入，位于运行内容之外；内容/索引损坏不影响安全 remove 的身份判定。包变化可用同父临时目录准备；失败恢复沿用 sync/remove，不增加 journal。

每个插件 producer 的实际资源根保存 `.aw-command-producer.json`：

```ts
type InstalledCommandProducer = {
  schemaVersion: 1;
  producer: ProducerIdentity;
  sets: Array<{ set: string; state: "present" | "disabled";
    entries: CommandDefinition[] }>;
};
```

这里的 entries 已补齐缺省值，不能含命令 ID 或解析后的秘密。它保存这个实际产物的生效启动定义，供派生索引校验/重建；不保存最新 store 配置、平台 claim、历史或安装阶段。这个记录不代替 artifact 的已有 owner/native receipt；package 则另用目录外的 owner marker。新保留文件必须进入最终产物校验，作者不得覆盖。

派生绑定的逻辑字段固定为 `{schemaVersion:1,id,identity,resourceRoot}`。identity 是 A4 CommandIdentity，id 必须重算一致。run 用它定位实际产物，再核验 `.aw-command-producer.json`、相应 owner/native evidence、入口和必要生效资源；启动定义从该产物记录取得。不能把索引中另一份 Launch 当作真值。索引缺失时 run 不自行重建；由 sync/reinstall/package sync 修复。绑定发布只发生于对应 producer 的成功边界；未请求集合的 entries 从已验证旧记录保留，不能被局部请求误删。

读取旧 ID 不要求最新 Catalog 在线，也不以当前 store 值改写已安装记录。当前来源身份发生冲突时不能接管旧资源。弱内容损坏时 artifact cleanup 使用既有独立 ownership，package remove 使用目录外 marker；identity 仍不能核实时保留现场并报告具体路径，由用户处理归属冲突，不能猜测。

上述记录是当前资源内容与目录 owner 证据，不是新安装 ledger。只要旧资源不能保持完整，写入前撤下相关派生绑定；普通失败允许 producer 不可用，由现有恢复入口重建。

Codex/Claude 静态原生 Skill 的共享 producer 固定为 user 身份。平台的安装、启用及权限 scope 与资源身份分开：单个 scope 的 uninstall/cleanup 不撤销仍存在的共享资源绑定，真正移除或替换该资源时才撤销受影响绑定。run 使用已安装的 AW namespaced 原生产物及其来源、平台 manifest、精确 Skill 路径和 producer 记录核验证据，不以当前项目重新选择身份；资源缺失或冲突时拒绝并保留 reinstall 恢复入口。user 配置 apply 更新共享产物，project 保存不能覆盖共享生效定义。不得为此增加项目引用计数、全局扫描或安装 ledger。


## B3. 运行参数、环境与主机描述

Node runner 精确启动 `[process.execPath, absoluteEntry, ...fixedArgs, ...callArgs]`。executable runner 精确启动 `[absoluteEntry, ...fixedArgs, ...callArgs]`，shell=false。Unix 核验可执行位；Windows 只接受可直接启动的原生 executable，`.cmd/.bat/.ps1` 不隐式交给 shell，需作者提供 Node 或原生包装入口。空 argv、Unicode 和换行参数按数组保留。

环境按以下顺序处理：

1. 在本次 run 开始时快照宿主环境。去除 `AW_PLUGIN_*` 作者临时上下文以及继承的旧 `AW_COMMAND_*`；不把 AW_SUBAGENT 的本次 worker 控制变量清掉，否则托管 adapter 无法使用既有通讯协议。
2. envFrom 从这份原宿主快照取值，来源缺失报 `commandEnvironmentSourceMissing`，空值保留。没有递归引用、模板替换或从 env 字面值取源。
3. 合并普通宿主环境与绑定 env/envFrom。一个绑定的两个 map 不能有相同目标键，Windows 按大小写不敏感比较；其它系统按精确名称比较。绑定显式值覆盖普通宿主值。
4. AW 注入当前受保护主机描述和已固定 AW_HOME。不能用配置覆盖控制变量。

env 与 envFrom 的目标名、envFrom 的来源名均禁止 `AW_PLUGIN_*`、`AW_SUBAGENT_*`、`AW_COMMAND_*`、`AW_AGENT_SKILL_EVAL_PROCESS_MARKER`，以及 `AW_HOME`、`AW_CODEX_HOME`、`AW_CLAUDE_HOME`。这些新增保护规则适用于命令绑定和新 custom-managed 分支；原绝对路径 custom 继续执行既有环境校验，不能因此拒绝原本合法的旧配置。校验禁止名时跨 OS 按 ASCII 大小写不敏感处理，避免 Windows 绕过。普通 PATH、HOME 等宿主配置保持既有工具语义。

`AW_COMMAND_HOST` 是单个 JSON 环境值：

```ts
type CommandHost = {
  schemaVersion: 1;
  nodeExecutable: string; // 当前 process.execPath 的绝对入口
  cliEntry: string;       // 当前 AW 的真实 JS CLI 入口绝对路径
  awHome: string;         // 本次已解析的绝对 AW_HOME
};
```

CLI 启动时固定自身入口，不读取 npm shim 字符串、不解析 shell command、不继承 process.execArgv，也不以 PATH 找另一个 AW。描述仅是同一进程链的启动上下文，不是授权凭据或对任意父进程的身份认证。Guide 校验 schema、绝对路径、普通可读 CLI 文件、Node 可执行入口及 awHome；缺失为 `managedCommandHostMissing`，不合法为 `managedCommandHostInvalid`。awHome 与本次受保护的 AW_HOME 必须一致。

Guide 的 custom-managed 配置、worker argv 与环境覆盖顺序由 [配置与接入](../plugins/codex-enhance/skills/codex-subagent-guide/docs/configuration.md#托管-custom-adapter) 定义。它用校验后的同一 CommandHost 启动嵌套 AW，不按 PATH 或另一 AW_HOME 回退；业务 executor args 与命令 binding args 的职责分别保留。

stdin/stdout/stderr 全部透传，AW 自身错误只写 stderr。正常目标数值退出码原样返回。POSIX 收到 SIGINT/SIGTERM/SIGHUP 时转发给直接 child；child 被信号结束时，转发器以同一信号结束；无法自发同信号时采用 `128 + signalNumber`。Windows 沿用实际数值退出；显式收到的可支持 INT/TERM 转发尽力执行，转发器对应退出 130/143，不声称完成后代或远端取消。不会因前台正常退出清理整个进程树，也不新增超时或自动重启。

AW 启动失败为 exit=1，并以 `aw: <stableCode>: <safeMessage>\n` 写 stderr；AW 参数错误为 2。只有执行层诊断能区分 AW 失败与目标相同数值的退出，不新增 stdout 控制封套。


## 通用错误与恢复


| code | 触发点与恢复 |
| --- | --- |
| commandNotFound | 合法 ID 没有记录；检查 ID，或 sync/reinstall/install |
| commandDefinitionInvalid | 用户强配置或声明形状不合法；修复声明，损坏用户配置可安全 remove 后重装 |
| commandBindingInvalid | 索引/实际产物记录缺失、损坏或不相等；sync/reinstall/package sync |
| commandIdentityConflict / commandOwnerMismatch | ID、来源、scope 或独立 owner 证据冲突；停止接管并报告现场 |
| commandResourceInvalid | 入口/必要资源缺失，链接/特殊节点或越界；修复包并 update/sync |
| commandRunnerUnsupported | 当前 OS 不能直接启动该 executable；提供可运行入口后更新 |
| commandEnvironmentInvalid / commandEnvironmentSourceMissing | 环境键冲突、禁止项或缺少引用来源；修复定义/宿主环境 |
| commandSpawnFailed | OS 启动失败；保留安全错误，不自动重试 |
| commandReferenceInvalid / managedCommandPortableUnsupported | 引用不能在当前消费者解析；修复作者声明/Portable 内容 |


参数错误沿用 CLI 参数诊断，Catalog、Review stale、I/O 和权限错误沿用各自稳定 code。错误不回显 envFrom 解析值、协议 prompt 或完整环境。

## Producer 的发布与生命周期

用户定义是强配置，复制的完整工具目录只在显式 update/remove 时修改。插件绑定索引和 producer 资源属于可重建输出；平台许可沿现有平台 ownership 维护。所有管理、物化和绑定变更共用现有单一 AW_HOME 写锁；run/list/show 不隐式安装、下载或执行 renderer，长运行子进程不持锁。

发布顺序是核验完整候选与身份，准备资源及生效配置，在 producer 成功边界发布对应绑定，再协调平台权限，最后按实际结果复核。完整旧产物仍在时失败可保留旧绑定；若原地改写会破坏完整性，改写前先撤下绑定，失败后通过 sync/reinstall/package sync 恢复。路径存在不表示绑定可用，不回退其它来源、scope 或最新 Catalog。

独立包在 install/sync/reinstall 的所选平台声明引用它时进入同次计划；同一 producer 只处理一次，健康且符合本次目标时复用，共享更新在 Review 中展示影响。保存配置不改变运行值；匹配 refreshKeys 的 apply 按 B1 发现范围刷新一次。独立包没有平台激活时仍可被配置 apply 刷新，未安装包不会仅因 manifest 声明而隐式安装。

平台 uninstall/cleanup 仅撤下自己的引用与权限，保留独立共享包。完整卸载 Review 和结果列出保留包及显式 package remove 入口，不推断最后一个使用者。producer 从 manifest 删除时报告残留与精确 pkg-id，不自动删除共享内容。显式 package sync 不激活平台；集合移除命令时报告旧引用可能失效，由对应平台普通 sync 更新生成内容。显式 package remove 删除该 producer 的自有资源和绑定，保留插件强配置及平台自己的引用/权限，并说明所有引用将不可用。

损坏弱正文或索引不能永久阻止按独立 owner 证据移除。--force 只处理可证明为该 producer 专属的损坏目录/索引，保留 foreign、shared config 和无法核验的 marker。包不可用可用 package sync 重建；来源暂不可用先 source sync。相同 producer 可恢复相同 ID，不能接管其它 owner。这里不维护引用计数、全局项目扫描、持久平台 claim、额外锁、安装 ledger 或补偿事务。

升级、重装或删除 Guide 及其托管 adapter 前，先完成或 stop 活跃外部任务。相同命令 ID 不表示旧 run 与新控制端协议兼容。Review 说明该前置条件；AW 不建立 run registry，也不声称已自动证明没有活跃任务。
