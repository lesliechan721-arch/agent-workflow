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

普通 remove 完整校验 Active 和联合依赖；插件已下架时，须由健康 Active 证明缺席。Active 不可验证时保留需求和输出。两个 only 模式分别支持离线取消合法声明中的完整 ID，以及依据现场 ownership 清理输出。foreign、shared 和未知归属内容保持不动，force 不扩大删除权限。完整领域门禁见[生命周期](../maintainers/architecture/lifecycle.md)。

首次 install 只获取所选来源确实缺少的 Active，以及同来源必要依赖；已有 Active 不隐式升级，损坏 Active 不当作首次安装。`sync --refresh` 显式刷新来源。查询不取源、不运行 renderer/preApply、不创建工作区或配置。`source status --remote` 只允许临时获取并清理材料，不写 store、Active、lastSync。作者缺少工作区时使用 `dev catalog create` 显式建立。

普通需求、平台策略和配置保存由命令表达写入意图。删除输出、配置重置、共享替换、重要来源变化、作者源码删除、远端发布及安装附带 preApply 要求 `--yes`。显式 run/build/test 与准备/导出所必需的构建渲染不重复要求执行确认。缺少确认不先提交需求或配置；必要来源候选可临时准备，确认前不启用。TUI 保留其 Review 确认。

`--yes` 不绕过 ownership、依赖、scope、stale、发布 digest 或宿主审批。执行开始后出现新影响不得扩大原授权；按真实变化报告 blocked 或 partial。cache prune preview 和 publication plan 分别保持 preview/prepared，不表示已经删除或发布。

`aw dev plugin validate` 默认保留当前共同来源的合法 frontmatter，由能力准备报告目标缺口；显式 `--claude-skill-profile minimum` 仅对声明的 Claude 目标要求 2.1.88 字段，`--strict-agent-skills` 优先使用严格 Portable 字段集，模板与普通源码适用同一规则。

### 1.1 本机 target 选择

`aw target list` 列出 codex、claude、antigravity、cursor、opencode、pi、gemini、copilot、grok、generic。每项保留显示名、已选状态、发现的产品面、安装入口、版本、可用性、原因码和恢复指引。可用性为 `available | missing | unsupported | unknown | notApplicable`；generic 为“通用输出，无需客户端”，可直接手动选择。

`aw target set ...` 在保存前检查新增选择。新增 missing、unsupported 或 unknown 且没有 `--force` 时，整体不保存，返回 blocked/3，并列出需强制选择的项及重试命令。非法 ID 始终为参数错误/2。保留已有选择、取消选择及 `--none` 不因可用性受阻；先取消再选择属于新增。

`--force` 只确认仍将不可用平台保存为 target，不安装客户端、不伪造可用性、不绕过写入接口、trust、ownership 或删除检查，也不代替 `--yes`。`--apply` 先准备候选偏好的维护影响，完成确认和输入重查后再保存；缺少确认或输入已变化时不保存候选。维护结果与偏好保存分开；保存成功后应用失败保留已保存值及其他平台结果。

探测只读、有时限、限制输出，不检查登录或调用模型。一项失败不丢其他结果；unknown 不能当 missing。Claude/Copilot 仅识别 CLI，其余纳入 App 的平台按真实身份和入口判断。版本、OS 与具体路径条件见[平台边界](../maintainers/architecture/platforms.md)。

## 2. 统一结果结构

所有 AW 自管、非 TUI、非子程序透传命令使用同一个结果外壳。JSON 是稳定机器合同；文本是同一结果的英文呈现。成功、部分完成、业务阻断和受控错误均走同一序列化出口。

```typescript
type CommandResult<T extends object> = {
  schemaVersion: 1;
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
- `diagnostics` 与 `nextActions` 始终存在，可为空。诊断使用稳定 code 和英文 message；自动化按 code/status/typed data 判断，不解析英文句子。
- 业务对象自身的 schemaVersion、Manifest schema 和配置定义版本位于相应 data 内，与顶层输出协议版本分别管理。
- data 使用显式投影，不直接 JSON.stringify 内部 backend、Error、renderer context 或整个服务对象。单次请求内部的锁、进程句柄和授权对象不属于输出协议。

**请求成立前后的边界：**先识别命令，再校验参数和互斥关系，并解析该命令所需的 scope/context/target 选择。这个阶段失败时保留已知的 `command`，`data` 为 `{}`，诊断说明具体缺口；不填入未经解析的 scope、默认 context 或空 targets。语法、取值和互斥错误退出 2；合法参数因环境前提无法解析时按 blocked/failed 的规则分类。任何业务写入都须等待请求归一化。请求已成立后，业务结果使用该命令的 typed data；partial 必须保留已完成、未完成及未知事实，不得退回 `{}`。下方 LifecycleData 的最低固定字段只适用于这一阶段。

**待确认影响的公共投影：**所有自管写命令在形成业务 data 后使用 `data.confirmation: Confirmation | null`。生命周期 data 明确包含该字段，其它写命令族复用同一类型；只读命令无须提供它。尚未完成影响准备时为 null，null 不表示无需确认，也不能据此进入写入。准备完成且无重要影响时为 `{ required: false, provided: <本次是否带 --yes>, effects: [] }`。需要确认时 required 为 true；provided 只记录本次是否显式提供 `--yes`，提供后 required 仍为 true，不抹掉动作本身的确认要求。

effects 只描述本次请求拟执行的重要影响，不表示已经发生。每项有稳定 code、英文 message、适用的 source/plugin/target/scope/field 身份和影响范围。`selected-scope` 表示所选范围内的影响，`user-wide` 表示整台机器的用户设置，`shared` 表示可能影响其它项目的共享内容，`unknown` 明确保留无法完整确定的影响；不能把 unknown 写成“没有影响”。适用的对象和 scope 必须给出，不能只依靠英文 message 定位。

协议 v1的重要影响使用稳定 code，例如 `removeOwnedOutput`、`deletePluginConfig`、`runPreApply`、`replaceSharedOutput`、`changeSource`、`deletePluginSource`、`publishRemote`。新增 code 与诊断 code 一样可兼容扩展，既有 code 和 impact 的含义不得静默改变。该视图从现有 `requiresConfirmation`、`sharedImpact` 及领域影响描述投影，不增加持久计划、令牌或可执行动作。无法取得必要证据时仍遵守相应领域阻断规则，`--yes` 不补造证据。

缺少确认时返回 `status: blocked`、`confirmationRequired`，并给出非空 effects；生命周期 `changes` 各项均为 none。传入 `--yes` 后重新按当前证据计算和校验，不能把上次 JSON 当作执行许可。成功或 partial 的 `changes` 继续报告实际结果，不能从 effects 推断已完成的变化。

## 3. 状态与进程退出码

| status / 情况 | 退出码 | 精确含义 |
| --- | --- | --- |
| success | 0 | 请求已完成；包括无须改变的 no-op，以及完整取得但显示 needsSync 的状态查询 |
| failed，参数或选项错误 | 2 | 请求无法合法解释；没有执行副作用 |
| blocked | 3 | 请求合法，但确认、环境、来源、所有权或 stale 条件阻止开始；没有提交所请求的业务变更 |
| failed，执行错误 | 1 | 执行失败，且没有已知或可能已提交的业务变更/有效部分结果需要作为 partial 保留 |
| partial | 4 | 只有部分请求完成，或开始执行后有已提交变更、有效部分结果或无法确认的副作用；未完成项必须保留 |
| 受控 SIGINT / SIGTERM | 130 / 143 | 尽力完成清理并返回真实结果；进程树清理无法确认时沿用现有失败退出 1 |

先判断输入错误，再判断执行是否开始及实际/可能的变更，不以 errors 数量机械决定结果。有结果不确定时明确标记 unknown，不把 partial 解释成所有修改都已确定成功。

多来源查询中，部分来源失败但其它来源有有效数据时返回 partial，保留有效数据。已知配置不足、来源缺失或未确认的写操作返回 blocked。仅有 warning 不自动使命令失败。不可捕获的进程终止、宿主强杀或 stdout 故障不能保证输出完整 JSON；文档不得承诺这种保证。

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
    // delivery、relation、requirementScope、providerScope、satisfaction
    // 按适用条件保留，公开类型有固定定义，不能以 backend: unknown 替代。
  }>;
  remainingTargets: Array<{ pluginId: string; target: string; scope: 'user' | 'project' }>;
  coverage: { scopes: Array<'user' | 'project'>; currentProject: boolean; otherProjects: 'unobserved' };
  // requirements / commandResults / nativeToolChanges 按当前公开领域合同提供。
};
```

生命周期数据中，`target` 表示目标平台，`requirements` 表示需求；state、roots、合法性和空值含义由对应领域定义。`blockerCodes` 关联顶层含同 subject 的完整诊断；适用的 delivery、依赖关系及需求/提供者 scope 不因简短样例而省略。

平台准备回执 deploymentPlans 保留 bindingId、physicalKey、products、expected 的组件身份/omitted/unmet、审核 effects 和 sharedReferences。unmet.requiredFeatures 保留具体 values，不能只剩 feature 名。deploymentExclusions 单列已识别但不能执行的产品面、原因及恢复指引；其他可用产品面的执行不会使这些限制消失。执行回执 deploymentReceipts 保留对应 effect ID 的 status/mutation、各产品面及 after 中的 package、registration、ownership、activation、trust、load、组件 presence、nativeIdentity，以及 unmet 和 reload。已取得的 nativeSources 只公开来源分类、版本、scope、生效组件、重叠和配置摘要，省略其内部路径。其余内部 prerequisite 证据及 renderer 正文不公开。物理组件存在不证明宿主已加载。

remainingTargets 只列本次请求选择中未完成的目标，不能把过滤掉的平台或未检查的其它项目加入自动重试。所有长期需求是否满足由已有 allSatisfied 与 coverage 事实表达，不能从本次 status=success 推断整个机器已同步。

`changes.outputs` 无法证明具体结果时为 unknown，不能从“执行器返回了”推断已改变或未改变。来源准备已经启用、需求已保存但部署受阻时，必须分别列出这些变化。没有物理操作的 requirements-only 返回空 targetResults，不伪造各平台安装成功。

## 5. 机器可用的下一步与可扩展性

下一步命令提供 argv 数组，不让调用者从 shell 字符串猜测引号。它是建议数据，不是执行授权。由 AW 根据可信业务事实构造，不接受插件 stderr 中嵌入的任意命令。不得自动加入 `--yes`；需要确认时用 requiresConfirmation 表达。不能安全生成命令时返回 manual 说明，不能给假定可安全重试的命令。

清理失败的 manual 说明保留该插件、平台和 scope 的实际隔离文件及残留位置，供用户定位恢复；不得借用其他目标的位置，也不能把隔离或保留写成已恢复、已删除。

自动化应忽略未知可选字段。新增命令、新的非必填字段和新的诊断 code 可作为兼容扩展；删除/改义字段、收窄有效值或改变 status 含义须提升输出 schemaVersion。输出协议版本与 CLI 包版本、持久文件格式分别管理。

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

1. `aw command run <id> -- <args...>` 保持 stdin/stdout/stderr、二进制/流式字节和子程序退出码透传，不加结果外壳。`--` 后参数完全属于子程序；AW 格式选项不得跨越该边界。启动前 AW 错误仍使用安全英文 stderr 与现有启动失败码；没有启动时不能生成子程序成功结果。
2. TUI 是单独的交互呈现，不把画面输出视为 CLI 机器协议。`aw tui --json` 是无效组合，不启动界面；TUI 继续直接使用共享领域服务和 Review 证据。
