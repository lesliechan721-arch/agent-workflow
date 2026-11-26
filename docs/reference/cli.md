# AW CLI 命令与输出合同

本文件供脚本和 Agent 调用 AW，定义非交互边界、统一输出、退出码与生命周期数据。命令参数和示例从实际注册生成：`aw --help`、`aw plugin install --help --json`。日常操作见[快速入门](../guide/getting-started.md)，TUI 交互见[维护者 TUI 说明](../maintainers/architecture/tui.md)。

## 1. 入口、请求与确认

日常管理按对象分组：`plugin`、`source`、`target`、`cache`、`command`、`self`。作者操作统一在 `dev plugin/catalog/skill/source/review/eval` 下。裸 `aw` 在交互终端进入 TUI，在非终端显示帮助。`--help`、`--version` 和裸 `--json` 优先返回明确请求的结果；`aw tui --json` 是参数错误。

普通 CLI 不选择、输入、询问密码或弹出确认。参数不完整时返回错误；stdin 仅用于显式 `--value-stdin` 或子程序透传。敏感配置只通过 `--value-stdin` 输入，读取 UTF-8 到 EOF，不 trim。原始配置、路径和插件内容不翻译。

`plugin install/remove` 要求非空插件列表及 `--scope user|project`。没有 `--all` 或 `--offline`。`--context` 控制读取 User 或 User/当前 Project 联合需求，不能将 `--scope project` 与 `--context user` 组合。`--target` 只过滤本次执行，不修改本机偏好。未指定 context 时保留项目发现规则，结果报告实际 coverage。

| 模式 | 需求 | 输出 | 配置 |
| --- | --- | --- | --- |
| install | 加入直接根 | 尝试部署 | 保留 |
| install --only requirements | 加入直接根 | 不部署 | 保留 |
| remove | 取消直接根 | 安全移除 | 保留 |
| remove --only requirements | 取消直接根 | 保留 | 保留 |
| remove --only outputs | 保留 | 清理所选物理 scope/target | 保留 |
| remove --delete-config | 取消直接根 | 安全移除 | 删除全部本机 common/平台覆盖 |

`--only` 只接受一个值。install 不支持 outputs-only。requirements-only 不接受 `--target` 或 `--script-timeout`。普通 remove 不接受 `--target`；outputs-only 必须提供至少一个 target，可清理已从本机策略关闭的平台。`--delete-config` 不能与 `--only` 组合。普通 remove 默认清理本次请求释放、没有独立声明或其他消费者且归属可确认的依赖；`--keep-dependencies` 保留它们，不能与 `--only` 组合。普通 remove 的 `--force` 绕过仍被其他插件依赖的阻断，但保留消费者并继续执行所有删除安全检查；outputs-only 的 `--force` 仅用于受限损坏输出恢复，requirements-only 不接受它。保留需求时，后续 sync 可重新部署。普通 install 在保存需求前检查有效平台集合，空集合返回 `noTargetsEnabled`。

普通 install 若所有实际候选目标（不含已排除、不受支持或预检已确认不适用的目标）均因缺少或无效配置受阻，则在保存需求、启用首次安装的来源候选和部署前返回 `blocked`（退出码 3）。修复配置后重新执行原 install；若来源尚无 Active，先用 `aw source sync` 显式启用来源。`install --only requirements` 不受此部署配置门禁限制。部分目标已就绪时仍保存全局需求并处理独立就绪目标；有已完成部分或业务变更时返回 `partial`（退出码 4）。

普通 remove 完整校验 Active 和联合依赖；插件已下架时，须由健康 Active 证明缺席。Active 不可验证时保留需求和输出。两个 only 模式分别支持离线取消合法声明中的完整 ID，以及依据现场 ownership 清理输出。foreign、shared 和未知归属内容保持不动，force 不扩大删除权限。完整领域门禁见[生命周期](../maintainers/architecture/lifecycle.md)。

首次 install 只获取所选来源确实缺少的 Active，以及同来源必要依赖；已有 Active 不隐式升级，损坏 Active 不当作首次安装。`sync --refresh` 显式刷新来源。查询不取源、不运行 renderer/preApply、不创建工作区或配置。`source status --remote` 只允许临时获取并清理材料，不写 store、Active、lastSync。作者缺少工作区时使用 `dev catalog create` 显式建立。

`aw plugin status [plugins...] --observe-native` 显式允许对所选的 OpenCode 目标启动一次满足 V2 接口最低条件的私有本地服务，观察插件加载。OpenCode 使用 `--standalone`，缺少加载证据时保留未知。启动可加载插件代码，创建日志、状态和缓存，读取既有认证并按现有配置访问外部服务。进入 OpenCode 原生观察路径时，文本与 JSON 诊断均包含 `nativeObservationSideEffects`。普通 status 和 TUI 保持只读，使用已有证据判断安装状态。精确证据边界见[状态与配置](../maintainers/architecture/config-and-status.md#22-平台产品面与组件事实)。

普通需求、平台策略和配置保存由命令表达写入意图。删除输出、配置重置、共享替换、重要来源变化、作者源码删除、远端发布及安装附带 preApply 要求 `--yes`。显式 run/build/test 与准备/导出所必需的构建渲染不重复要求执行确认。缺少确认不先提交需求或配置；必要来源候选可临时准备，确认前不启用。待确认的 install 或 sync 保留原插件、位置、目标与行为选项。回执的 `requiresConfirmation: true` 提示用户审阅影响后显式加 `--yes`。TUI 保留其 Review 确认。

`--yes` 不绕过 ownership、依赖、scope、stale、发布 digest 或宿主审批。执行开始后出现新影响不得扩大原授权；按真实变化报告 blocked 或 partial。cache prune preview 和 publication plan 分别保持 preview/prepared，不表示已经删除或发布。

`aw dev plugin validate` 默认保留当前共同来源的合法 frontmatter，由能力准备报告目标缺口。显式 `--claude-skill-profile minimum` 仅对声明的 Claude 目标要求 2.1.88 字段，`--strict-agent-skills` 优先使用严格 Portable 字段集，模板与普通源码适用同一规则。同时声明 Node 构建和动态 renderer 时，源码校验提示组件仍需构建验证，`aw dev catalog publish plan` 按发布合同校验构建后的组件。 [Catalog 发布计划](catalog.md#41-发布命令接口与两阶段授权)

组件校验使用各平台的有效配置 Schema 构造隔离测试输入：保留声明的默认值；没有默认值的必填对象或数组，仅在空对象或空数组通过完整配置值及引用校验时作为已配置的测试值。可选字段及其他无法确定合法值的字段保持未配置。测试值不成为 manifest 默认值，也不读写用户配置；renderer 与组件闭包的校验失败仍阻止发布。

### 1.1 本机 target 选择

`aw target list` 列出 codex、claude、antigravity、cursor、opencode、pi、copilot、grok、generic。每项保留显示名、已选状态、发现的产品面、安装入口、版本、可用性、原因码和恢复指引。可用性为 `available | missing | unsupported | unknown | notApplicable`；generic 为“通用输出，无需客户端”，可直接手动选择。

`aw target set ...` 在保存前检查新增选择。新增 missing、unsupported 或 unknown 且没有 `--force` 时，整体不保存，返回 blocked/3，并列出需强制选择的项及重试命令。非法 ID 始终为参数错误/2。保留已有选择、取消选择及 `--none` 不因可用性受阻；先取消再选择属于新增。

`--force` 只确认仍将不可用平台保存为 target，不安装客户端、不伪造可用性、不绕过写入接口、trust、ownership 或删除检查，也不代替 `--yes`。`--apply` 先准备候选偏好的维护影响，完成确认和输入重查后再保存；缺少确认或输入已变化时不保存候选。维护结果与偏好保存分开；保存成功后应用失败保留已保存值及其他平台结果。

探测只读、有时限、限制输出，不检查登录或调用模型。一项失败不丢其他结果；unknown 不能当 missing。Claude/Copilot 仅识别 CLI，其余纳入 App 的平台按真实身份和入口判断。版本、OS 与具体路径条件见[平台边界](../maintainers/architecture/platforms.md)。

## 2. 统一结果结构

所有 AW 自管、非 TUI、非子程序透传命令使用同一个结果外壳。脚本以 `schemaVersion: 2` 读取 JSON，可通过 `aw self describe --json` 核对 `aw.cli-output.v2` 能力。文本是同一结果的英文呈现。成功、部分完成、业务阻断和受控错误均走同一序列化出口。

```typescript
type CommandResult<T extends object> = {
  schemaVersion: 2;
  command: string | null;
  status: 'success' | 'partial' | 'blocked' | 'failed';
  data: T | Record<string, never>;
  diagnostics: Diagnostic[];
  nextActions: NextAction[];
};

type Diagnostic = {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  detail?: {
    reasonCode: string;
    path?: string;
    configKey?: string;
    fieldKeys?: string[];
    skippedPermissionActions?: Array<'allow' | 'ask' | 'deny' | 'sandbox'>;
    skillInvocationControls?: Array<{
      feature: 'skill.invocation.manual' | 'skill.invocation.model' | 'skill.visibility';
      values?: Array<'true' | 'false' | 'visible' | 'hidden'>;
      reasonCode: 'noBoundExecutor' | 'invocationControlUnsupported' | 'invocationControlDegraded';
      product?: 'cli' | 'app';
    }>;
  };
  subject?: {
    pluginId?: string;
    sourceId?: string;
    target?: string;
    scope?: 'user' | 'project';
    field?: string;
  };
};

type NextAction =
  | { kind: 'command'; argv: string[]; reason: string; requiresConfirmation: boolean }
  | { kind: 'manual'; message: string };

type Confirmation = {
  required: boolean;
  provided: boolean;
  effects: Array<{
    code: string;
    message: string;
    subject?: Diagnostic['subject'];
    impact: 'selected-scope' | 'user-wide' | 'shared' | 'unknown';
  }>;
};
```

- `command` 是已解析的稳定命令 ID，例如 `plugin.install`、`source.sync`、`dev.catalog.publish.apply`；无法识别命令时为 null，不把任意输入回显成命令 ID。
- `data` 始终是对象。不同业务有明确的类型；列表通常使用 `items`。请求尚未完成归一化、且未执行业务变更时，允许使用严格的空对象 `{}`，即使命令 ID 已经识别。已完成的空列表才输出 `[]`，不能用它替代尚未取得的事实。
- `status` 描述这次调用是否完成；`data` 描述插件、来源、配置等业务事实。插件尚未就绪不等于 status 查询执行失败。
- `diagnostics` 与 `nextActions` 始终存在，可为空。诊断使用稳定 code 和英文 message；自动化按 code/status/typed data 判断，不解析英文句子。可选 detail 包含可信细分 reasonCode 以及适用的安全文件位置 path、配置键 configKey、该平台缺失或无效的字段列表 fieldKeys、Skill 调用控制或跳过的命令权限动作。调用控制来自固定 feature 和取值，其中两个 invocation feature 使用 `true` 或 `false`，visibility 使用 `visible` 或 `hidden`。诊断不回显配置值、凭据、原生 stderr 或异常栈。subject 承载相关插件、来源、target、scope 与字段。
- 业务对象自身的 schemaVersion、Manifest schema 和配置定义版本位于相应 data 内，与顶层输出协议版本分别管理。
- data 使用显式投影，不直接 JSON.stringify 内部 backend、Error、renderer context 或整个服务对象。单次请求内部的锁、进程句柄和授权对象不属于输出协议。

**请求成立前后的边界：**先识别命令，再校验参数和互斥关系，并解析该命令所需的 scope/context/target 选择。这个阶段失败时保留已知的 `command`，`data` 为 `{}`，诊断说明具体缺口；不填入未经解析的 scope、默认 context 或空 targets。语法、取值和互斥错误退出 2；合法参数因环境前提无法解析时按 blocked/failed 的规则分类。任何业务写入都须等待请求归一化。请求已成立后，业务结果使用该命令的 typed data；partial 必须保留已完成、未完成及未知事实，不得退回 `{}`。下方 LifecycleData 的最低固定字段只适用于这一阶段。

**待确认影响的公共投影：**所有自管写命令在形成业务 data 后使用 `data.confirmation: Confirmation | null`。生命周期 data 明确包含该字段，其它写命令族复用同一类型；只读命令无须提供它。尚未完成影响准备时为 null，null 不表示无需确认，也不能据此进入写入。准备完成且无重要影响时为 `{ required: false, provided: <本次是否带 --yes>, effects: [] }`。需要确认时 required 为 true；provided 只记录本次是否显式提供 `--yes`，提供后 required 仍为 true，不抹掉动作本身的确认要求。

effects 只描述本次请求拟执行的重要影响，不表示已经发生。每项有稳定 code、英文 message、适用的 source/plugin/target/scope/field 身份和影响范围。`selected-scope` 表示所选范围内的影响，`user-wide` 表示整台机器的用户设置，`shared` 表示可能影响其它项目的共享内容，`unknown` 明确保留无法完整确定的影响；不能把 unknown 写成“没有影响”。适用的对象和 scope 必须给出，不能只依靠英文 message 定位。

重要影响使用稳定 code，例如 `removeOwnedOutput`、`deletePluginConfig`、`runPreApply`、`replaceSharedOutput`、`changeSource`、`deletePluginSource`、`publishRemote`。新增 code 与诊断 code 一样可兼容扩展，既有 code 和 impact 的含义不得静默改变。该视图从现有 `requiresConfirmation`、`sharedImpact` 及领域影响描述投影，不增加持久计划、令牌或可执行动作。无法取得必要证据时仍遵守相应领域阻断规则，`--yes` 不补造证据。

缺少确认时返回 `status: blocked`、`confirmationRequired`，并给出非空 effects；生命周期 `changes` 各项均为 none。传入 `--yes` 后重新按当前证据计算和校验，不能把上次 JSON 当作执行许可。成功或 partial 的 `changes` 继续报告实际结果，不能从 effects 推断已完成的变化。

## 3. 状态与进程退出码

| status / 情况 | 退出码 | 精确含义 |
| --- | --- | --- |
| success | 0 | 请求已完成，包括无须改变的 no-op，以及完整确认目标已禁用、缺失或待同步的状态查询 |
| failed，参数或选项错误 | 2 | 请求无法合法解释；没有执行副作用 |
| blocked | 3 | 请求合法，但确认、环境、来源、所有权或 stale 条件阻止开始；没有提交所请求的业务变更 |
| failed，执行错误 | 1 | 执行失败，且没有已知或可能已提交的业务变更/有效部分结果需要作为 partial 保留 |
| partial | 4 | 只有部分请求完成，或开始执行后有已提交变更、有效部分结果或无法确认的副作用；未完成项必须保留 |
| 受控 SIGINT / SIGTERM | 130 / 143 | 尽力完成清理并返回真实结果；进程树清理无法确认时沿用现有失败退出 1 |

macOS 和 Linux 上，默认处理 `SIGINT` 或 `SIGTERM` 时，CLI 先清理当前命令仍在运行的独立原生进程组，再按原信号退出。无法重现默认信号退出时使用等效退出码 130 或 143。原生进程清理无法确认时报告 `processCleanupUnconfirmed` 并退出 1。

先判断输入错误，再判断执行是否开始及实际/可能的变更，不以 errors 数量机械决定结果。有结果不确定时明确标记 unknown，不把 partial 解释成所有修改都已确定成功。

多来源查询中，部分来源失败但其它来源有有效数据时返回 partial，保留有效数据。配置不足、来源缺失或未确认的写操作在没有已完成部分或业务变更时返回 blocked。仅有 warning 不自动使命令失败。不可捕获的进程终止、宿主强杀或 stdout 故障不能保证输出完整 JSON；文档不得承诺这种保证。

## 4. 业务 payload 的边界

各命令共用结果外壳。每个命令的 data 类型、业务事实及其精确值由对应领域定义。

| 命令族 | data 必须保留的业务事实 |
| --- | --- |
| plugin install/remove/sync | 请求根、解析 scope/context/targets、需求结果、实际或未知的变化、逐目标执行/观察/内容三轴、依赖提供者、未完成目标与 coverage |
| plugin status | 需求、目标策略、inventory、额外残留、coverage、counts、allSatisfied；未观察或未知保持 null/unknown，不用空数组假装没有数据 |
| plugin list/show | 来源限定身份、可用版本、插件公开元数据；requested 模式明确只列直接需求 |
| plugin config | 读取层、字段定义、有效值来源、脱敏后的值状态；写入结果与输出 apply 结果分开 |
| source/cache | 配置与 Active 的区别、版本/健康/影响、检查是否完整、逐项保留/删除结果；缓存大小未知不写成 0 |
| dev | source/final/profile 身份、验证结果、必要产物与 source-binding 路径；发布计划和发布事实分开 |
| command 管理 | 命令与 package 身份、可用性、实际变化、诊断；不把 run 子程序输出包入 data |
| self/help | 当前 executable 能力、实际参数与结果 schema 信息；使用当前注册事实，不维护另一份手写命令真值 |

要在命令行查询配置字段的动态候选，可运行下例。命令使用本机 Active Catalog 和已保存的配置，无需先安装插件。

```sh
aw plugin config suggestions official/agent-subagent generalTaskProfile --platform codex --dep executor=native --json
```

字段路径按点分段，数组路径可省略数字索引。省略任一数组索引时，建议只使用 `--dep` 提供的依赖值。`--platform` 缺省为 common，`--context` 默认为 user。`--dep key=value` 可重复，按第一个等号分割并按声明类型解析。路径定位到已有配置对象时，未覆盖的依赖取该对象中的有效值。`--timeout-ms` 接受由 `0` 到 `9` 组成的十进制整数，取值范围为 1000 至 30000 毫秒。结果的 `data` 含 `kind`、`pluginId`、`fieldPath`、`profile`、`provider`、`providerPluginId`、`status` 与 `items`。直接查询固定对象或对象数组项返回复合候选，查询标量属性返回单值候选。`ok`、`not-applicable` 和 `no-probe` 退出 0，后两种带警告；`unavailable` 退出 1。无效参数或字段路径退出 2。

`set`、`edit`、`suggestions` 及显式选择平台的 `apply` 使用插件支持、本机已启用且未被该插件排除的目标。不可配置平台返回 `configPlatformNotEnabled`，缺少公共字段时写入或请求公共建议返回 `configCommonLayerUnavailable`，均为 `blocked`、退出 3。可用 `get`、`schema` 查看历史层，用 `unset` 清除指定旧键，或用 `reset --platform <target>` 清除停用平台保存的整层值。重新启用目标会重新检查保留的配置。安装或同步全部候选目标因缺少或无效配置受阻且没有业务变更时退出 3；有完成部分或业务变更（例如 `sync --refresh` 已启用新的 Active）时退出 4。

`plugin.status` 和生命周期的 `deploymentObservations`、`deploymentReceipts` 分别保留原生 `registration`、`consumers.activation`、`consumers.load` 以及 AW 包、归属和组件内容。原生接口给出安装 scope 时，`after.scopeRegistration` 报告当前 scope 的独立登记（present/absent/unknown）。Codex 的 `after.scopeActivation` 报告独立 Project 启用，`consumers.activation` 保留原生有效启用。`after.nativePackage` 报告 Grok 或 Antigravity 的客户端消费副本，`after.workspaceOpen` 报告 Cursor 当前 scope 的受管 Hook 入口。可选的 `after.configuration` 补充当前 scope 的显式 activation（enabled/disabled/absent/unknown）、可选 marketplace 和 reasonCodes。项目可复用 User 已登记的包。原生生效状态由原生证据决定。完整定义见[状态与配置](../maintainers/architecture/config-and-status.md#22-平台产品面与组件事实)。

八个原生目标的 User 和 Project 安装会交付当前入口可保真表达的组件，并报告其余能力缺口。`generic` 只交付作者提供的通用 Skill 和资源。适用组件全部交付后，仅有能力提示的目标仍正常完成。所有请求项都因能力缺口跳过时，目标为 `satisfaction: "not-applicable"`、`installedComponentCount: 0`。需求仍保留，安装或同步可以返回 `success`、退出码 0。真实依赖缺失、无效声明、写入失败或冲突继续按实际结果报告。

plugin.show 的 components 只报告五类静态声明事实；权限在 invocationPolicy.declarations 计数。dynamicComponents 保留 declared、state（unprepared/not-declared）、configKeys 与 scopes：未准备时 kinds/names/count 为 null；没有动态 renderer 时为 []/[]/0。普通查询不运行脚本，不把 null 当空集合。

生命周期公开 payload 的最低固定字段为：

```typescript
type LifecycleData = {
  request: {
    plugins: string[];
    scope: 'user' | 'project' | null;
    context: 'user' | 'project';
    targets: string[];
    targetOrigin: 'argument' | 'preference' | 'none';
    mode: 'apply' | 'requirements-only' | 'outputs-only';
  };
  confirmation: Confirmation | null;
  changes: {
    requirements: 'none' | 'changed' | 'unknown';
    preferences: 'none' | 'changed' | 'unknown';
    config: 'none' | 'changed' | 'unknown';
    sources: 'none' | 'changed' | 'unknown';
    outputs: 'none' | 'changed' | 'unknown';
  };
  targetResults: Array<{
    pluginId: string;
    target: string;
    scope: 'user' | 'project';
    execution: 'not-run' | 'no-op' | 'applied' | 'partial' | 'failed';
    observation: 'verified' | 'missing' | 'unknown';
    content: 'absent' | 'satisfied' | 'drifted' | 'conflict' | 'unknown';
    requiredBy: string[];
    blockerCodes: string[];
    // deploymentPlans、deploymentReceipts 按本次准备与执行事实提供。
    // delivery、relation、requirementScope、providerScope、satisfaction、
    // installedComponentCount、installedComponentIds、componentGaps
    // 按适用条件保留，公开类型有固定定义，不能以 backend: unknown 替代。
  }>;
  remainingTargets: Array<{ pluginId: string; target: string; scope: 'user' | 'project' }>;
  coverage: { scopes: Array<'user' | 'project'>; currentProject: boolean; otherProjects: 'unobserved' };
  // requirements / commandResults / nativeToolChanges 按当前公开领域合同提供。
};
```

安装、同步、重建或配置应用交付 Skill 后，`diagnostics` 按实际插件、Skill、平台和范围最多给出一次 `skillInvocationPolicyNotGuaranteed`。`subject.field` 形如 `skill.<name>`。`detail.skillInvocationControls` 列出受影响的显式调用、模型自动调用或可见性控制及声明值、原因和适用产品。只有三类明确情况生成提示：generic 目录无绑定执行器（`noBoundExecutor`）、平台能力不支持所请求的特性或取值（`invocationControlUnsupported`）、现场观测策略实际降级（`invocationControlDegraded`）。Antigravity User/Project、Codex、Cursor、OpenCode 和 Pi 没有原生隐藏 Skill 开关，对 `user-invocable: false` 统一报告不支持。仅 Antigravity 按实际读者在相关控制项携带 `product: 'cli' | 'app'`；同一控制项既不支持又被观测降级时优先报告降级。未登录、未取证或查询失败本身不产生提示。CLI 文本、JSON、TUI、历史和导出表达同一结果。警告不影响成功退出码或重试范围。

命令规则部分或全部未施加时，`invocationPolicyNotApplied` 通过 `detail.skippedPermissionActions` 列出具体动作。`sandbox` 指沙箱排除。`subject.field` 形如 `permissions.<name>`，`detail.reasonCode` 标明跳过原因。不可达的命令路由使用 `command-route-unreachable`。CLI 文本、JSON、TUI、历史和导出均报告这些动作。`plugin.status` 在有适用证据时也保留提示。诊断使用安全标识和固定动作，省略作者命令及参数。OpenCode 已知 Project 的手工规则与本次 User 限制冲突时，`detail.path` 标明该 Project 权限配置。其他适用动作照常交付，提示不影响成功退出码或重试范围。

| `invocationPolicyNotApplied` 的 `detail.reasonCode` | 含义 |
| --- | --- |
| `permission-prefix-unrepresentable` | AW 未能验证当前宿主或运行环境对该命令前缀的精确匹配。 |
| `grok-project-trust-required` | 当前 Grok 项目没有可核验的授权。请在 Grok 中核对项目授权后重试。 |
| `grok-shell-prefix-normalized` | Grok 匹配 `allow` 时无法从该前置环境赋值或包装形式中确定内部命令。 |
| `grok-wrapper-target-not-covered` | Grok 保留未指定内部命令时的 `allow`。附加参数指定的内部命令由 Grok 单独审核。 |
| `grok-shell-pattern-unrepresentable` | 该声明包含 Grok Bash 文本规则无法按当前形式施加的词。 |
| `permission-rule-conflict` | 已有规则与请求重叠，或另一条无法施加的限制与请求的允许规则重叠，相关动作无法完整施加。 |
| `permission-config-path-unconfirmed` | OpenCode 不能核实相对 `OPENCODE_CONFIG_DIR` 对应的宿主配置位置。 |
| `config-disabled` | 例如当前 OpenCode 环境关闭了 Project 配置加载。 |
| `opencode-windows-command-syntax` | 前缀包含 Windows Shell 的扩展、转义或其他特殊语法，例如 `--%` 或 `%NAME%`。 |
| `antigravity-cli-global-only` | 目标超出可写的 Antigravity CLI Global 设置范围，例如 Project 或仅 Desktop。 |
| `antigravity-command-matching-unverified` | Antigravity 可能解开命令包装或按完整命令匹配，无法保持该字面前缀的语义。 |
| `antigravity-config-path-unconfirmed` | 无法从用户主目录确定 Antigravity CLI Global 设置位置。 |
| `antigravity-strict-mode` | 已识别 Antigravity Global 的 `strict` 模式时，为跳过的 `allow` 单独报告。 |

宿主权限归属和写入使用独立的诊断。位置已确认时，相关诊断通过 `detail.path` 标明宿主配置文件。配置交付的回执和真实客户端审批的证据范围见[宿主审批验证范围](managed-commands.md#宿主审批验证范围)。

| 诊断 code | 含义 |
| --- | --- |
| `permissionOwnershipDegraded` | 无法核验规则的归属或配置路径，保留相关现有规则。 |
| `permissionConfigurationConflict` | 宿主配置位置或内容无法安全更新，或 Review 后的规则证据发生变化。 |
| `permissionOwnershipWriteFailed` | 宿主配置已变化，归属记录未保存成功。 |
| `permissionRelatedProjectUpdated` | OpenCode Project 配置中已写入的变更。`detail.path` 指向配置，`detail.permissionChanges` 记录实际增删的动作、规则效果和公开匹配范围。归属记录未保存时，同一路径也会报告待恢复。 |
| `permissionRelatedProjectUpdateIncomplete` | OpenCode 权限更新未完成。`detail.path` 指向一个未完成的项目配置。因中断暂停时，`detail.reasonCode` 为 `operationInterrupted`。 |
| `hostPermissionRestored` | 卸载后另一 owner 的有效规则得以恢复，回执保留受影响的插件和范围。 |

`hostPermissionAdditionalImpact` 表示宿主权限的匹配范围或配置来源可能影响审批。需要更改权限时，`data.confirmation.effects` 以该 code 展示相关配置和影响。User 规则的 `impact` 为 `user-wide`。执行结果的同名 warning 用 `subject` 标识插件、平台和作用域。规则级提示还附带 `permissions.<name>`，用 `detail.reasonCode`、`detail.path`、`detail.permissionResource` 和 `detail.permissionAction` 标明原因、宿主配置、原生匹配项和动作。Grok 的 `grok-additional-rules-unverified` 是文件级提示，`detail.path` 指向无法读取的附加配置。Grok 的 `grok-manual-restriction-preserved` 提示授权范围中可能仍受哪些已有规则限制。跳过的动作另见 `invocationPolicyNotApplied`。

若调整 OpenCode User 限制还会改动 AW 已知的 Project 权限，`data.confirmation.effects` 中的 `changeRelatedProjectPermissions` 列出每个受影响配置的路径、待增删规则及 Project 作用域。`plugin config apply` 和 `plugin config set/unset/reset --apply` 也使用此确认。配置写入已经提交而应用失败时，已保存设置仍保留。

核对宿主规则和恢复步骤见[宿主权限恢复](../maintainers/architecture/lifecycle.md#宿主权限恢复)。

独立运行 `plugin config apply` 时，`configWrite` 为 `notStarted`。中断回执保留当时已解析的请求、已完成的确认以及已有的应用结果。收到 SIGINT 或 SIGTERM 后等待清理并分别退出 130 或 143，清理无法确认时退出 1。如果所有目标已完成并通过核验，收尾时收到信号仍保留成功回执和已交付 Skill 的警告。

配置应用的文本回执按插件、平台和范围列出每个位置的状态和已有错误码，也列出共享命令包的选择器、动作和可用状态。命令包回执字段见[命令管理与 JSON](managed-commands.md#命令管理与-json)。同一目标若有部分输出已读回、其余输出仍失败，`data.apply.targetResults[]` 保留 `state: "failed"` 和失败原因，并附 `partialDelivery: true`。已交付 Skill 的提示保留在对应的 `diagnostics` 中。此时回执引导用户检查未完成的输出。仅需恢复项目位置、公开同步命令会重跑已完成的个人位置时，回执指向 TUI 中的项目选择。

生命周期数据中，`target` 表示目标平台，`requirements` 表示需求；state、roots、合法性和空值含义由对应领域定义。`blockerCodes` 关联顶层含同 subject 的完整诊断；适用的 delivery、依赖关系及需求/提供者 scope 不因简短样例而省略。

平台准备回执 deploymentPlans 保留 bindingId、physicalKey、products、expected 的组件身份/omitted/unmet、审核 effects 和 sharedReferences。unmet.requiredFeatures 保留具体 values，不能只剩 feature 名。deploymentExclusions 单列已识别但不能执行的产品面、原因及恢复指引；其他可用产品面的执行不会使这些限制消失。执行回执 deploymentReceipts 保留对应 effect ID 的 status/mutation、各产品面及 after 中的 package、registration、ownership、activation、load、组件 presence、nativeIdentity，以及 unmet 和 reload。已取得的 nativeSources 只公开来源分类、版本、scope、生效组件、重叠和配置摘要，省略其内部路径。其余内部 prerequisite 证据及 renderer 正文不公开。物理组件存在不证明宿主已加载。

生命周期、配置应用和 `plugin.status` 在有相应证据时保留实际安装项数、组件身份及 `componentGaps`。`componentGaps` 带有提供插件 `providerPluginId`、平台 `agent`、`renderScope`、组件 kind、ID、原因及具体 feature/value。`renderScope` 对应组件实际准备的范围。例如 Codex 的 Project 目标中，共享包里的 Hook 缺口标为 `user`，独立角色的缺口标为 `project`。部分交付的组件仍可通过 `componentId` 关联已交付身份。Pi 已交付的角色可另有 `piAgentConsumerUnavailable` 提示，说明已证实的执行扩展缺口或实际配置读取失败（`detail.reasonCode: piConfigurationUnconfirmed`，执行可用性仍为未知）。仍可能生效的旧输出可见于 `previousDeploymentRetained` 诊断。状态与恢复依据见[生命周期](../maintainers/architecture/lifecycle.md#平台执行入口与结果)。

`plugin.status` 按每条部署路由所需的包、原生登记、启用和当前组件产物判定安装状态。已明确禁用或需要同步时，目标为 `content: drifted` 并计入 `counts.pending`，正常返回 `success`。已确认缺少必需的包或登记时，目标为 `content: absent`，同样计入 `pending`。已知漂移提供针对具体插件、目标和 scope 的同步指引。仅缺少任选的加载证据时，已确认满足全部安装条件的目标仍为 `content: satisfied` 并计入 `counts.ready`。真实归属冲突及必需门禁拒绝继续报告具体 blocker。 OpenCode、Grok 和 Antigravity CLI Global 也核对当前插件的 AW 权限归属和上次交付的原生规则。规则缺失会提示同步，归属受损或无法可信地读取已交付规则时显示未确认。宿主当前会话的批准仍由宿主决定。

无法确认安装所需证据时，目标为 `content: unknown` 并计入 `counts.unconfirmed`。显式目标没有可以独立完成的已知结果时返回 `blocked`（3），同时有可独立完成的已知结果时返回 `partial`（4）。各宿主的必需启用、权限和可选加载观察由实际部署路由决定。

plugin.status 的 selection 保留 plugins/targets 数组及 targetOrigin。指定依赖插件时，inventory 返回其真实目标、requiredBy 和提供者关系，不把它加入直接需求。counts 仅统计可见目标。allSatisfied/inSync 描述整个授权读取上下文，明确不满足为 false，未完整观察为 null。对于只有能力缺口的零产物位置，`counts.pending` 不增加。完整观察且没有其他问题时，`allSatisfied` 和 `inSync` 都为 true，表示当前可执行的安装工作已完成。可选 coverage.requestComplete 描述本次选择及必要依赖、共享与碰撞检查是否完整。本次请求可完成而全局汇总仍未知，未选目标未观察不独自使请求失败。

remainingTargets 只列本次请求选择中未完成的目标，不能把过滤掉的平台或未检查的其它项目加入自动重试。所有长期需求是否满足由已有 allSatisfied 与 coverage 事实表达，不能从本次 status=success 推断整个机器已同步。

安装或同步收到进程中断信号时，回执保留已保存的声明、偏好以及各目标的执行结果。已验证目标继续显示 `applied/verified` 或 `no-op/verified`，尚未派发的目标显示 `not-run`，已启动但效果无法确认的目标保留不确定影响。等待写锁时也可以中断。`remainingTargets` 和重试命令仅列出本次尚未完成的位置。进程树清理无法确认时，诊断包含 `processCleanupUnconfirmed`，退出码为 1。

安装或同步在首次写入前发现整批确认依据已改变时，回执按原顺序列出目标和依赖，标记各个待执行位置为 `not-run`。恢复提示要求按原插件、范围、平台和选项重新准备。声明或偏好已保存但读回不符时，回执保留已提交的事实与待观察位置，先提示在原检查范围查看状态。部分执行后，已经核实无需修改的目标也算有效结果。依赖的恢复命令使用当初声明它的根和所需平台。同一根和平台在 User、Project 都待恢复时，一条 Project 同步命令涵盖两处。如果只有 Project 待恢复，且普通同步还会执行 User 声明，回执提示在 TUI 选择该插件的项目位置。

联合安装已完成写入，但最终读取本次目标状态失败时，回执返回 `partial` 和 `statusUnavailable`，保留已确认的变更。若全部目标已写完，`remainingTargets` 为空。`nextActions` 提供 `aw plugin status --context <user|project> --json` 供调用方只读复查。

`changes.outputs` 无法证明具体结果时为 unknown，不能从“执行器返回了”推断已改变或未改变。来源准备已经启用、需求已保存但部署受阻时，必须分别列出这些变化。没有物理操作的 requirements-only 返回空 targetResults，不伪造各平台安装成功。

## 5. 机器可用的下一步与可扩展性

下一步命令提供 argv 数组，不让调用者从 shell 字符串猜测引号。它是建议数据，不是执行授权。由 AW 根据可信业务事实构造，不接受插件 stderr 中嵌入的任意命令。不得自动加入 `--yes`；需要确认时用 requiresConfirmation 表达。不能安全生成命令时返回 manual 说明，不能给假定可安全重试的命令。

清理失败的 manual 说明保留该插件、平台和 scope 的实际隔离文件及残留位置，供用户定位恢复；不得借用其他目标的位置，也不能把隔离或保留写成已恢复、已删除。无法安全认领的旧产物须指出具体原因、备份对象、需核对的精确配置引用、移到宿主扫描目录之外的方法及同范围 status 重查。配置引用不确定时要求人工核对，不断言可以删除；不删除整个宿主目录或共享 store，也不把已失败的同一 force 命令作为唯一下一步。

自动化应忽略未知可选字段。新增命令、新的非必填字段和新的诊断 code 可作为兼容扩展；删除/改义字段、收窄有效值或改变 status 含义须提升输出 schemaVersion。输出协议版本与 CLI 包版本、持久文件格式分别管理。

CLI 升级后，使用 v1 的已安装插件脚本须重新部署。先运行 `aw source sync <来源 ID>` 激活包含 v2 插件的 Catalog，再运行 `aw plugin sync <来源 ID>/<插件名>`。旧 Active 仍可提供已独立确认的安装事实，生成或同步需要与当前 CLI 兼容的插件声明和脚本。

命令帮助和 JSON 帮助都来自实际命令注册。`aw plugin install --help --json` 返回同一外壳，command 为 help，data 指明所查询命令、参数、选项、互斥规则、重要副作用及示例；`aw --version --json` 返回结构化版本结果。help/version 明确请求优先于 TUI 默认入口。

## 6. stdout、stderr 与英文文本

- 默认纯文本；`--json` / `-j` 固定 JSON 格式。格式不因 TTY、管道或 CI 变化。
- JSON 模式 stdout 在受控结束时只有一个完整 JSON 文档和结尾换行。进度、提示、第三方构建日志和调试信息不得混入 stdout。
- 人工进度与受控诊断写 stderr，使用英文并脱敏；不以 stderr 是否为空判断成功。JSON 内始终保留完成判断必需的诊断。
- `--verbose` 可增加文本细节和 stderr 诊断，不能改变 JSON 业务字段是否存在；`--debug`/`--log-file` 沿用诊断用途并继续脱敏。
- 默认文本按“结果 → 作用范围 → 实际变化/逐项结果 → 需要用户做什么”的顺序。详细组件在 verbose 中展开，不用内部对象 dump 代替友好文本。
- AW 生成的帮助、摘要、错误、进度、状态标签与枚举说明均为英文。配置原值、插件原始内容、路径和子程序字节保持原样；不为界面语言改写用户数据。
- 对公开字段使用领域既有路径和敏感信息边界。作者明确请求的产物路径可以返回；内部 AW_HOME、marketplace、临时执行上下文、credential、原始异常栈不得顺带暴露。

**两个必要的协议边界：**

1. 有运行配置的插件使用 `来源/插件/平台`，其他插件使用 `来源/插件`。`aw command run <调用选择器> [--no-fallback] -- [args...]` 与 `aw command run <cmdu-id> -- [args...]` 透传 stdin/stdout/stderr、二进制或流式字节和子程序退出码。AW 根据 `--` 后的首词匹配插件子命令，剩余参数按原 argv 传入业务入口。启动前错误使用安全英文 stderr，语法和路由错误退出码为 2，其他启动错误退出码为 1。[调用与路由](managed-commands.md#调用与路由)
2. TUI 是单独的交互呈现，不把画面输出视为 CLI 机器协议。`aw tui --json` 是无效组合，不启动界面；TUI 继续直接使用共享领域服务和 Review 证据。
