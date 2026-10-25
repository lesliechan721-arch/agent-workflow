# Codex Enhance 外部适配器实现

本文件面向插件维护者和自定义适配器作者，拥有注册配置、Adapter v5、命令输出、运行生命周期及验证边界的长期合同。普通调用见 [外部委派](references/external-delegation.md)、[通信](references/communication.md) 和 [文件选择](references/file-selection.md)。本文定义要求；实际后端、调用工具和原生操作系统的支持范围仍须分别取得运行证据。

按需进入：[配置](#配置呈现与生效) · [文件选择](#文件选择与公共解析器) · [Adapter v5](#adapter-v5-完整合同) · [命令输出](#命令输出合同) · [生命周期](#停止失联与结果缓存) · [平台](#操作系统与安装闭包) · [验证](#升级与验证)。

## 职责与源码入口

`subagent.mjs` 固定安装配置和输入，启动一个长期 worker；worker 持续管理一个 v5 adapter、父侧队列、快照、停止及最终结果。adapter 拥有后端会话、子侧工具及收件调度。一个 run 不重连、重放、resume 或跨父会话续接。

| 入口 | 责任 |
| --- | --- |
| [subagent.mjs](scripts/subagent.mjs) | start/send/wait/result/stop 参数、安装 reader、英文文字输出和退出码。 |
| [worker.mjs](scripts/worker.mjs) | 本次持续执行和收尾；宿主须允许 start 返回后存活。 |
| [plan.mjs](scripts/runtime/plan.mjs) / [runner.mjs](scripts/runtime/runner.mjs) | 精确选择 executor、入口、模式、输入和环境。 |
| [protocol.mjs](scripts/runtime/protocol.mjs) | 严格 v5 JSONL、大小及状态合同。 |
| [adapter-channel.mjs](scripts/runtime/adapter-channel.mjs) | 子侧发送、显式收件和自动输入共用调度。 |
| [message.mjs](scripts/message.mjs) / [message-mcp.mjs](scripts/message-mcp.mjs) | 脚本与 MCP 工具包装，不拥有另一份队列。 |
| [processes.mjs](scripts/runtime/processes.mjs) / [platform.mjs](scripts/runtime/platform.mjs) | 本机安全启动、私有资源、进程归属和停止；Windows 使用同产物的 [windows-job.ps1](scripts/runtime/windows-job.ps1) 持有本次原生 Job。 |
| [resolve-files.mjs](scripts/resolve-files.mjs) | bundle 公共文件选择 v1；通用运行层不扫描材料。 |
| [contracts.mjs](scripts/runtime/contracts.mjs) / [files.mjs](scripts/runtime/files.mjs) | 限值、路径、原子文件及安全诊断。 |
| 内建 `adapters/*-v5.mjs` | Codex、Claude Code、Oracle 真实后端映射。 |

Guide 保留调用方角色和任务约束。调用方先选定 executor/model/reasoningEffort，运行层只消费传入值；省略指令文件时不猜测默认角色。原生 Advisor/Explore 角色的局部禁止重复同一委派段落不注入共享资源或外部 prompt。

## 配置、呈现与生效

配置声明由 [plugin manifest](https://github.com/lesliechan721-arch/agent-workflow/blob/main/plugins/codex-enhance/.agents-plugin/plugin.json) 拥有。subagentCommands 每项具有 key、adapter；key 大小写敏感、唯一，native 为保留值。配置中的 executor 精确引用 key；运行入口必须显式传入 executor。key 只在 Guide 自身的安装配置中查找，其他插件的调用不扩大注册表来源。

| adapter | mode | 用户配置入口 |
| --- | --- | --- |
| codex | 固定 workspace | args、env、envFrom；不配置 wrapper command/entrypoint。 |
| claude-code | 固定 workspace | args、env、envFrom；不配置 wrapper command/entrypoint。 |
| oracle | 固定 bundle | args、env、envFrom；不配置 wrapper command/entrypoint。 |
| custom | 必填 workspace 或 bundle | 绝对 command、可选绝对 entrypoint，加上相同的 args/env/envFrom。 |

内建 mode 可以在原值中省略，显式错误值必须拒绝。command/entrypoint 不属于内建分支，不仅在 TUI 隐藏，也由共享校验器拒绝。切换 adapter 只修改草稿；不适用字段的移除和固定 mode 的变化须在保存前可见，取消不改原配置。args 是实际服务 argv 数组，env 是普通字符串 KV，envFrom 是宿主变量引用 KV，不把容器塞成 JSON 字符串。

```json
{
  "generalTaskProfile": { "executor": "codex-local" },
  "advisorGeneralProfile": { "executor": "oracle-review" },
  "subagentCommands": [
    { "key": "codex-local", "adapter": "codex" },
    { "key": "claude-local", "adapter": "claude-code" },
    {
      "key": "oracle-review",
      "adapter": "oracle",
      "args": ["--engine", "api"],
      "envFrom": { "OPENAI_API_KEY": "REVIEW_OPENAI_API_KEY" }
    },
    {
      "key": "custom-review",
      "adapter": "custom",
      "mode": "bundle",
      "command": "/absolute/path/to/node",
      "entrypoint": "/absolute/path/to/custom-adapter.mjs",
      "args": ["--region", "example-region"]
    }
  ]
}
```

这是字段值示例，不是完整 store。外部 profile 的 model/effort 可省略，调用方按本次显式要求、已选配置、后端默认确定参数，再传给脚本；运行层不查找 profile 或继承其模型参数；省略不生成空参数。native 保持已有必填要求。非法配置或不可用执行器不触发换后端或近似模型替换。

Config Definition v4 的有限对象分支、标量 const 和叶级数组/KV 由 Core 统一实现，CLI、TUI、生效值与物化共用。Manifest v3、Store v5、Catalog v7 和 installed-runtime-config v2 不联动改号。正式字段合同见 [架构说明](https://github.com/lesliechan721-arch/agent-workflow/blob/main/docs/architecture.md)，作者维护入口见 [插件维护指南](https://github.com/lesliechan721-arch/agent-workflow/blob/main/docs/plugin-maintenance.md)。

renderer 只在 Guide 的 external-delegation 中生成执行器表，只显示 key、mode；不再展示能力布尔值，不把表塞进所有 Skill 或角色。profile 表对外部省略的 model/effort 显示“后端默认”；native 不补造这样的缺省配置。Guide 的档位表位于按需读取的 execution-profiles reference；Advisor 固定显示三个内建难度档位。

AW 在物化时注入安装态 JSON 和配置 reader（保留文件名 .aw-runtime-config.json、scripts/aw-runtime-config.mjs）；插件不伪造或覆盖保留资源。reader 从本产物返回 installedIdentity、获准的 effectiveValues（仅 subagentCommands）和 resourceRoot，不读最新 store 或同名 sibling。保存未 apply 时新调用继续用旧安装资源，活跃调用也不重读配置换后端。缺失或损坏通过正常 sync/reinstall 恢复。

## Prompt 与模式

CLI 只有 --executor 和 --prompt 必填。旧 --profile 参数按未知参数拒绝；native、未知 key、重复 key 和无效注册配置在后端启动前报错，通过 config、sync 或 reinstall 修复。任务可用 --prompt TEXT 或 --prompt -；stdin 读到 EOF，拒绝 TTY、空白、非法 UTF-8、重复 prompt 和超限。--instructions-file PATH 可选；相对路径相对调用 cwd，与 --workspace 的文件选择基准分开。

不传指令文件时，协议 prompt 保留任务原文，不添加默认指令或空标题。显式传入时要求非空、可读 UTF-8 文件，runner 读取一次后组合为“执行指令”和“本次任务”两个段落。保留原文本，不截断，不向 adapter 发送指令文件路径让它再次打开。显式坏文件不能当成省略。指令与任务各最多 256 KiB，组合结果不套用单份上限。

所有适配器都消费一个 prompt，不需要独立 instruction channel 能力声明。提示词拼接不提供 system/developer 权限，不代替业务授权或技术隔离。native 的角色通道不受影响。

workspace 只提供工作目录和任务，CLI 出现任何 --file 均在扫描和适配器启动前失败，code 为 filesNotAllowedInWorkspace，退出 2；包括 --file ''。关注文件写进 prompt，不能作为隐藏的材料参数传递。

bundle 提供 fileSelectors 原值数组和 fileResolver 命令描述。runner 只校验输入形状、NUL 与空选择项，不展开、不读取材料元数据或 ignore 文件。无 --file 则 []，不隐式增加材料。需要路径的适配器可调用公共解析器；原生消费必须符合相同的 AW 文件选择协议 v1。Oracle 在符合协议时直接消费原值，不调用 helper 或构建投影。完整协议与失败处理见 [文件选择与公共解析器](#文件选择与公共解析器)。

## 文件选择与公共解析器

本节面向适配器作者，维护所有 bundle 适配器共用的固定选择协议、公共命令输入输出及接入要求。调用模型填写参数时只需 [文件选择用法](references/file-selection.md)。

### 固定选择协议与两种实现路径

AW 文件选择协议 v1 适用于所有 Adapter v5 bundle 执行器，包括公共 helper、custom 和内建 Oracle。在同一平台、同一 workspace、相同原始选择式及同一稳定可读文件树上，各实现必须得到相同的规范化路径集合。调用方不选择后端专属语义；路径排序只约束 helper 的输出，不强制后端采用相同打包顺序。

runner 保留重复 --file 的原值并提供 fileResolver，不展开文件。适配器可调用公共 helper，也可使用符合本节规则的原生选择能力；这是实现自由，不是语义自由。Oracle 原值透传必须符合本协议，不能仅凭名称或版本自报兼容。文件格式、读取和上传限制可导致明确失败，不能让成功结果静默少选文件。

v1 固化既有 Oracle 0.21.4 选择阶段，并保留 AW 已有的空输入校验、字面路径输出和显式错误要求。Adapter v5 固定绑定该语义，helper 的 protocolVersion: 1 同时绑定本节选择规则与 JSON 形状；不新增解析策略字段、版本白名单、运行账本或每次调用的双解析。后端更新不自动改写 v1。

### 选择表达式与路径身份

--file 可重复。runner 不拆分后改写原值。消费方按逗号拆分每个值、去除片段外围空白并丢弃空片段；不执行 shell、环境变量或波浪号展开。一个原始值没有有效片段，或包含去掉前导 ! 后为空的排除项，均为无效输入。

前导 ! 分类为排除。其余输入按固定基线的动态模式分类：动态模式作为 glob，非动态输入通过 stat 分类为普通文件或目录，显式符号链接随 stat 访问目标；不存在或不属于文件/目录时失败。动态分类与匹配采用 fast-glob 3.3.3 的默认模式语义，包括 *、**、?、字符组及其转义；这里固定的是兼容行为，不要求生产使用同一库或宿主私有 import。

```bash
--file 'src/**/*.ts' --file '!**/*.test.ts' --file 'docs/architecture.md'
```

相对路径以 workspace 为基准；绝对动态模式先转成该目录的相对模式，匹配分隔符统一为 /，移除一个前导 ./。显式目录转换为其下 **/*，workspace 自身转换为 **/*。所有正向选择合并后应用全部排除，不按输入顺序重新纳入。只传排除不代表整个 workspace，最终为空时失败。

含逗号的 brace（如 src/*.{ts,js}）先被拆分，不能用作两种扩展名选择；改用两个 --file。含逗号的文件名可由足够精确的 glob 选中。helper 返回的文件名不再拆逗号、解释括号或重新当作 glob。Oracle 原生入口始终接收原选择式，不接收 helper 路径数组作第二次选择。

输出以 workspace 解析并规范化为字面绝对路径；同一规范化字符串去重，不依赖 realpath、inode、大小写折叠或 locale。helper 按字符串比较的稳定升序返回；同一目标经两个不同链接路径选中时保留两条路径。跨平台路径表示及文件系统行为不由 v1 伪造一致；声明支持的平台须分别验证。

### 固定的忽略、点文件和链接规则

以下算法是 v1 的规范，不是任意后端当前版本的偏好，也不是完整 Git ignore 规范。

1. 没有动态模式、目录或排除时，直接收集显式普通文件，不执行 glob 阶段的 .gitignore 与点文件过滤。否则，将正向模式、显式文件的相对路径和目录递归模式一起匹配：dot=true、onlyFiles=true、followSymbolicLinks=false，并同时应用所有排除。普通 glob 不沿发现的目录链接递归；显式链接文件/目录的处理保留基线行为。
2. glob 阶段收集 workspace 内不沿目录链接递归可达的 **/.gitignore。逐行 trim，忽略空行和 # 开头行。不读取 Git 全局 ignore。对每份文件，以其所在目录为基准匹配；基线按候选绝对路径是否以该目录字符串开头判断适用，再使用相对路径。以 / 结尾的规则匹配该相对目录本身及其子路径；其它规则全串匹配，** 匹配任意字符序列，* 匹配不含 / 的序列，其余字符按字面匹配，反斜杠先规范化为 /。规则之间为“任一匹配即排除”，! 不提供重新纳入语义，子目录规则不能撤销已经成立的排除。
3. glob 阶段默认过滤 basename 以点开头的文件，不过滤隐藏目录内的普通 basename。任一正向匹配模式含以点开头且长度大于 1 的路径段时，同次 glob 放行点文件；../ 路径也会触发该条件。排除项本身不触发放行；放行不撤销 .gitignore。
4. 默认过滤集合固定为 node_modules、dist、coverage、.git、.turbo、.next、build、tmp。按候选相对路径的段检查这些名字。显式普通文件免于该默认过滤；显式目录的 basename 属于该集合时，其子树也免于该默认过滤。对其余候选，每个命中默认名字的目录若自身有普通 .gitignore 文件，该目录解除默认过滤；另一个仍命中且未解除的目录仍可排除该文件。此步骤不恢复在第 2 步已经被 .gitignore 排除的文件。
5. 最终保留普通文件并按上节规范化去重。实际遇到的目录、元数据或 ignore 读取失败须明确失败，不能静默输出不完整成功清单。资源上限是失败条件，不是截断选材的理由。

默认目录里的 .gitignore 标记、显式点路径影响同次 glob、简化 ignore 匹配及链接路径身份都是保留的基线例外。换库时必须保持它们，不以“更合理”或“更安全”的猜测静默改变 v1。原始参考模块中的抑制扫描/ignore 读取错误不是 AW 的成功许可；原生 adapter 也须补足失败检测或说明不支持，不能把 helper 的强失败要求当作已由裸透传实现。

### 空输入、文件变化和失败

未提供 --file 时 fileSelectors: []；helper selectors: [] 返回空 files，不扫描或追加材料。后端读取自身配置或执行任务获准工具是另一项行为，不由空选择禁止。

runner 与 helper 共用无文件系统输入校验：类型、NUL、空白、只有逗号、空排除项；保持有效原值不变。workspace 的模式拒绝先于这些 bundle 校验，因此 --file '' 仍报 filesNotAllowedInWorkspace。非空且仅排除的选择在消费阶段按无结果处理。

显式路径不存在，或非空选择经过过滤后完全为空，必须失败。部分正向 glob 未匹配但其它项有结果时保留实际匹配，不扩大来源。文件读取、类型或上传失败不得无声忽略材料。helper 一次解析成功后按字面路径读取，不重新 glob、拆逗号、换 ignore 或重扫寻找替代文件；原生消费也不能在本次失败后静默切换解析策略。

选择和内容读取发生在真实执行时，清单不是内容快照。同一协议不保证不同时间的文件树相同，也不证明模型已经收到了全部材料。原生错误按实际提交和停止证据报告；无法确认时用 unknown，不只凭非零退出声称未提交。helper 提交前失败与 runner 输入错误的退出码分工见下文。

### 一致性与原生支持

所有声称支持 v1 的实现使用同一套可分发选择 fixture 比较规范化集合，并覆盖显式文件/目录、混合输入、排除顺序、重复、逗号、特殊名字、点文件、默认过滤例外、ignore、链接、父目录、空值、部分匹配与错误。helper 排序、资源和失败 JSON 另按公共命令合同验证。29 项历史参考观察仅是 fixture 来源，不是所有实现已通过的证据。

custom 可直接调用公共 helper，或用自己的实现通过同一标准；不再要求调用者理解其“原生差异”。Oracle 的实际选择路径也须验证；fake argv 透传只证明参数传递，不证明集合一致。已知原生能力不满足 v1 时，adapter 在模型提交前报告 fileSelectionUnsupported，或在后续实现中补足适配后重新验证；不得自动改用另一套语义、模型或后端。

当前 Windows 原生 Oracle 的 ignore 行为不符合 v1；内建 adapter 对非空 fileSelectors 在扫描和提交后端前返回 fileSelectionUnsupported。未指定文件的空数组请求仍可运行。公共 helper 与 custom 的 Windows 文件选择仍按完整 v1 验证，不接受漏排文件。

兼容性证据绑定实际测试的环境与实现；不增加精确 Oracle 版本白名单、每次调用 helper 对账或模型探测。新版本行为改变时修复适配器并重新验证，不修改调用 Skill 让用户规避差异。既有参考实现抑制部分 I/O 错误这一已知差异须有单独验收；尚未满足时不得把原生透传写成完整支持证明。

### 公共解析命令合同

公共入口为 Guide 内的 `scripts/resolve-files.mjs`。它是插件分发的解析能力，不要求安装 Oracle，也不依赖开发仓库。入口、依赖与下述合同必须随同一安装产物可用。

bundle 请求的命令描述示例：

```json
{
  "fileResolver": {
    "command": "/absolute/path/to/node",
    "args": ["/absolute/installed/guide/scripts/resolve-files.mjs"]
  }
}
```

runner 使用本次 Node 的绝对可执行路径，并从本产物 resourceRoot 构造脚本绝对路径。适配器将 command 与 args 直接用于 shell:false、detached:false 的子进程调用，不拼接成 shell 字符串，不从用户配置、PATH、其它来源的同名 Skill 或 Oracle 私有目录查找替代入口。

正常调用没有额外 CLI 参数。stdin 是一个 UTF-8 JSON 对象，发送后关闭；拒绝 TTY、非法编码、多个对象、未知字段、缺字段或错误类型：

```json
{
  "protocolVersion": 1,
  "workspace": "/absolute/project",
  "selectors": ["src/**/*.ts", "!**/*.test.ts"]
}
```

protocolVersion 必须为 1；workspace 必须为现存的真实绝对目录，不能使用缺省 cwd 替代缺失字段；selectors 必须为字符串数组，使用上述选择值校验。适配器传入本次请求的 workspace 与 fileSelectors，不自行改写成另一份选择。该 helper 的版本同时固定本节 v1 选择语义与命令输入输出；Adapter v5 已绑定该语义，不新增另一个请求字段，不改变 installed-runtime-config v2 或 Eval 协议。

成功时退出 0，stdout 只输出一个 JSON 对象及换行；stderr 无常规日志：

```json
{
  "protocolVersion": 1,
  "files": ["/absolute/project/src/main.ts", "/absolute/project/src/util.ts"]
}
```

结果必须满足本节的字面绝对路径、去重和排序规则。[] 只表示没有提供 selectors；非空选择完全没有结果是错误。不输出材料正文、摘要、token 数量、manifest 路径或后端能力声明。

失败时 stdout 为空，不输出部分路径清单。stderr 输出一个有界、脱敏的 JSON 错误对象：

```json
{
  "code": "fileSelectionEmpty",
  "message": "No files matched. Check the positive selectors and exclusions."
}
```

| 退出码 | code 与条件 |
| --- | --- |
| 2 | `fileSelectionInputInvalid`：参数、编码、JSON、版本、字段、workspace 或选择值无效；`fileSelectionPathMissing`：显式路径不存在；`fileSelectionEmpty`：非空选择没有结果。 |
| 1 | `fileSelectionReadFailed`：实际文件系统读取失败；`fileSelectionLimitExceeded`：输入、输出、扫描或时间资源超限；`fileSelectionFailed`：其它无法完成的解析错误。 |
| 0 | 正常成功，或单独调用 --help。 |

无法访问 workspace 的 I/O 失败归入读取错误；已确定目录不存在、不是目录或不是要求的绝对路径则是输入错误。错误 code 稳定，message 是可操作说明，不要求调用方匹配句子。进程被信号停止、无法得到完整结果或内部异常时，消费者不得把空 stdout 当成空文件集。

--help 是唯一例外：不读取 stdin，输出人读使用方法、协议、退出码以及该版本的实际输入/输出/扫描/时间上限，退出 0。各上限由实施者依据真实入口确定并公开，不恢复旧的通用 128 文件、1 MiB/文件或 8 MiB 材料限制。超限必须明确失败，不截断路径数组。不能只在文档声称有界而没有实现检查。

helper 不访问网络、模型、AW store 或后端配置，不创建材料副本、持久状态或新的锁。它使用调用进程的权限；“公共解析器”不是 OS 隔离或授权凭据。

### 适配器接入与恢复

需要路径的适配器在模型提交前启动 helper，等待进程结束并验证退出码、JSON 版本、结果形状及读取限值。成功后读取 files；helper 非零、非法结果、读取超限或入口缺失时，不启动模型，不切换原生选择作为回退。已确认未提交且本地收尾完成时写 Adapter v5 failed、generationStarted=false；外层 runner 退出 1，不把 helper 的退出 2 直接冒充 runner 输入错误。收尾不明仍按原协议使用 unknown。

helper 属于当前 adapter 的前台子进程，纳入已显式设置的 deadline、取消和进程归属处理。取消/超时后先确认停止，不遗留后台解析器；不增加 supervisor 或持久运行账本。入口或依赖缺失通过当前产物的 sync/reinstall 修复，不偷用其它安装来源。选择输入错误由调用方修正，新的模型提交仍需符合本次授权和预算。

内建 Oracle 不走 helper：直接将每个原始选择式传给一个 --file 选项；无选择式则不加文件参数。args 不能另加 --file/-f 或文件选择别名。特殊名称按固定 v1 规则处理，原生路径须有相应一致性证据；原始选择式过多或过长导致 argv 无法传递时明确失败，不生成投影、不截断、不拆成多次模型请求。

独立查看当前协议选择集合时可调用本节公共命令；它不冻结后续文件树，也不证明材料已送入模型。所有消费方仍须遵守相同选择规则。入口及依赖由同一安装产物提供，不引用宿主 Oracle 私有模块或开发仓库 node_modules。

## 参数和环境

args 中每项是一个真实后端 argv 值，不执行 shell split、变量插值或 shell。空字符串 argv 合法，NUL 非法。后端入口按最终 PATH 解析；不自动下载，不使用 Codex 专属 binary 环境变量替代通用配置。

内建 wrapper 拥有启动子命令、prompt stdin、工作目录、结构化输出、bundle 文件输入和等待参数。args 与这些控制项冲突时明确拒绝，包括公开别名；不得让 args 把调用变成帮助、预览、仅入队、续接其它会话或多次生成。Oracle 的 --file/-f 及文件选择别名也不能通过 args 在 fileSelectors 之外追加来源。

CLI 已传入 model 或 effort 时，args 不能再次设置同一后端控制项；没有解析值时，args 可以设置或沿用后端默认。检查只覆盖 wrapper 拥有的参数，不复制完整后端 parser 或建立通用功能黑名单。显式不支持的参数报告真实错误，不忽略或重试其它模型。

保留后端正常配置、权限、项目指令、hooks、插件、MCP 和工具。wrapper 不自动设置只读、关闭工具或绕过审批；用户显式 args 仍必须在本次授权内。后端自己的权限与任务授权不是一回事。

环境处理顺序：捕获原宿主环境，排除 AW 内部上下文和本次控制项；从原宿主快照解析 envFrom；合并 env 与 envFrom；最后注入 runner 控制值。同一目标键同时出现在 env 和 envFrom 时拒绝。来源不存在时报错，存在但为空保留空值；不支持链式引用或 ${...} 替换。

变量名为 `[A-Za-z_][A-Za-z0-9_]*`，值不得包含 NUL。env 只保存普通字面值，不能保存密钥。envFrom 只存来源名；解析后的秘密不进入安装资源、stdin JSON、执行器表。继承其余普通宿主环境及后端认证设置，最终环境通过 spawn.env 交给 adapter，再按实际后端接口使用。

`AW_PLUGIN_CONTEXT`、`AW_PLUGIN_*` 作者上下文、`AW_SUBAGENT_*` 运行控制项不能借 env/envFrom 注入。本次私有目录、工具绑定与进程归属标记由运行层设置；现有 Eval 进程标记按原合同继承但不可覆盖。诊断脱敏已解析 envFrom 值及可识别凭据，不输出完整 env 或请求。受信任适配器可能读取宿主凭据，环境过滤不构成隔离。

## 内建后端与配置保真

Codex 固定 workspace，优先通过 app-server 管理本次 thread/turn、正式输入和中断；Claude Code 固定 workspace，通过持续输入及已配置的 MCP 或已验证等价工具接入。两者仅在本次双向工具与调度可用时 ready(true)。普通父输入不隐含强制 interrupt；轮次边界和提交竞态由 adapter 处理。

迁移保留 cwd、模型、推理强度、配置、args、env/envFrom、认证、项目指令、hooks、插件、MCP、工具权限及审批。无法映射的显式配置在首次模型提交前报错；不复制 Eval 的权限配置，不自动关闭工具、提高 sandbox 权限或绕过审批。只在实际通信 true 时追加英文 [通信说明](assets/communication-instructions.md)，保留原任务与显式指令；false 不注入工具或说明。

当前 Codex app-server 对 `codexProfile`（`--profile` / `-p`）和额外目录 `addDirs`（`--add-dir`）没有等价的官方映射。配置仍可保存 `codexProfile`，但显式使用该字段或对应 args 时，内建 adapter 在提交后端前返回 `parameterUnavailable`；不会丢弃选项、扩大目录权限或改用其它执行方式。调用方须修正显式配置，不能把字段可配置解释为当前后端已支持。

Oracle 固定 bundle，使用公开 CLI 的 prompt、wait、私有输出和原始重复 --file 入口；API/browser 来自配置，不自动换引擎。effort 仅映射真实支持的引擎。Oracle 和 custom bundle 报告 communicationSupported=false。Oracle 对每个原始选择式传一个 --file，不预先展开、去重、拆逗号或调用 helper，不构建 AW 材料投影。原生选择必须符合下述 v1；已知不符合时在提交前拒绝。

后端缺失、必要接口不支持、认证或模型错误按真实结果报告。实际版本可供诊断，精确版本字符串不证明资格。所有首版支持路径须有本次独立后端进程的实际退出证据；不以 adapter 退出代替。

## Adapter v5 完整合同

### 1. 进程、通道及版本

worker 以 `shell:false`、`detached:false` 启动 adapter。custom 的 argv 只含已注册的可选 entrypoint；后端 args 放在 start 请求中。cwd 是本次绝对 workspace。stdin 持续打开用于控制，stdout 只输出本协议，stderr 是诊断。adapter 及后代继承本次受保护的进程归属 token；禁止重写该 token 或 AW 内部配置控制项。

本合同同时适用于 macOS、Linux 和 Windows。worker 的后台存活、进程身份、停止及私有文件保护按本文“操作系统与安装闭包”实现；`detached:false` 只描述 worker 与 adapter 的关系，不要求 worker 随短暂的 start 命令退出。Windows 的归属验证不能依赖 POSIX ps 或读取 Unix 进程环境；归属 token 不替代本机进程身份或受控进程边界。后端入口按本机安全启动方法解析，协议 args 保持 argv 数据，不拼为 shell 文本。

首版支持范围要求 adapter 能观察本次后端进程的实际退出码。完全在 adapter 进程内调用 SDK/HTTP、没有独立后端进程的形态不在首版支持承诺内；不能以 adapter 自己的退出码替代 backendExitCode。null 表示实际退出情况未知，不表示不适用；本轮不新增另一套完成证据。

每行是一个 UTF-8 JSON 对象，以 LF 结束；CRLF 可作为同一分隔，正文中的换行必须 JSON 转义。解析按字节缓冲，不假定一次 read 等于一行；可以一次收到半个对象、多个对象或拆开的多字节字符。拒绝 BOM、空行、非法 UTF-8、EOF 时残缺行、数组、null、顶层非对象。接收端使用标准 JSON 对象解析语义；发送端必须由对象序列化，不手工拼接重复 key。字段名、类型及必填规则严格检查；各对象拒绝未定义字段。

每条消息必须有 `protocolVersion:5` 和 `type`。双方串行写入完整行并处理写回压，不能并发拼接 JSON 字节。一个流上的顺序是发送顺序，两个流之间没有全局顺序；不使用时间戳推测消息已经交付。

每次连接的第一条 worker 输入必须是 start，而且只出现一次。adapter 的第一个事件是 ready，或第 4 节允许的初始化异常 result。有效 ready 之后才允许提交首次生成。ready 只出现一次；false 是明确不实现通讯，缺失或出错不是 false。

stdout 不得透传后端日志、原始服务事件或 MCP stdout。adapter 负责转成明确的协议事件；调试信息只写 stderr。版本不符、未知事件、未知字段和顺序错误按照第 6 节结束，不猜测旧 v4 含义。

字段名、枚举、错误码、程序生成的说明和诊断、MCP/脚本工具描述及共享 API 说明均使用英文。task/message/result.text 等数据保持原语言和原文，允许中文，不为满足输出语言而翻译。外部原始诊断若需要引用，必须与程序说明分开，向模型展示时进入 DIAGNOSTIC 块，不能拼到控制字段中。显示层的省略不改变本协议字段及内部结果证据。

### 2. 类型、大小和额度

除非明确标记可选，下面字段均必填。JSON 属性顺序不重要，缺省不等于 null。

| 类型 | 精确定义 |
| --- | --- |
| `Text` | 合法 Unicode 字符串，无 NUL；按 UTF-8 字节计大小。允许换行，不 trim 或规范化；需非空时还要求不是全空白 |
| `Label` | ASCII 名称，严格匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`；不 trim 或替换字符 |
| `Identifier` | 1–256 个 Unicode code point 的单行非空字符串，无控制字符；executor/model/effort 沿现有选择约束 |
| `RunId / MessageId` | 32 个小写十六进制字符，由运行层生成，只在本次连接或目录中使用；不是模型应填写的 ID |
| `Code` | 匹配 `^[A-Za-z][A-Za-z0-9]{0,63}$` 的安全错误码 |
| `AbsolutePath` | 非空 Text，在当前 OS 上是规范化绝对路径；用途对应的类型、归属、symlink 和存在性另外校验 |
| `EpochMs` | 非负安全整数，UTC Unix 毫秒；不能为 NaN、浮点数或字符串 |

| 数据 | 上限 |
| --- | --- |
| start 帧 | 8 MiB 编码后字节，不含 LF/CRLF |
| task / instructions 输入 | 各 256 KiB；沿用现有合成逻辑 |
| 合成 prompt | 524352 UTF-8 字节，非空 |
| message.text | 4096 UTF-8 字节（4 KiB），非空；两个方向和所有工具入口相同 |
| message 帧 | 32 KiB 编码后字节；容纳正文最坏 JSON 转义及封套 |
| ready / closing / stop 帧 | 各 4 KiB 编码后字节 |
| delivery 帧 | 16 KiB 编码后字节 |
| result.text | 4 MiB UTF-8 字节；非成功可为空 |
| result 帧 | 32 MiB 编码后字节；考虑正文的 JSON 转义开销 |
| 可选错误 message | 4096 UTF-8 字节 |
| 两个方向的消息 | 无累计条数或累计消息字节上限；每条仍须满足 message.text 和帧大小限制 |
| stderr 诊断 | 整个 run 最多 8 MiB；这是运行资源预算，超额触发第 6 节收尾，不能仅截断留存后继续报告 completed |

这些是单帧、单条正文及诊断的资源限制，不给整次 run 的通信设置累计额度。每方向只检查单条字节数，不维护累计消息额度账本。worker 另行保留的全部未解决投递摘要不属于 adapter result 帧，不受 result.text 或 result 帧大小上限限制；按本文运行生命周期 完整保留并支持流式导出。result.text 的 4 MiB 与 result 帧的 32 MiB 不是主代理显示额度；wait 与未加 --export 的 result 的 stdout+stderr 合计最多 8 KiB；result 一次读取全部未读消息及固定最终结果，result --export 将完整报告写到 stdout，不受显示上限限制，由主代理选择接收目的地和方式。单条过程消息和必要封套、诊断须能独立交付，精确显示和调用工具预算见本文命令输出合同；超限消息拒绝，不截断或自动拆分。

实现可以在大帧尚未完整时提前拒绝超限，不得无限缓冲。通道写入等待仍受已显式设置的 deadline 和停止请求约束，不能因回压停止读取控制输入。双方应使用独立读取循环与串行写队列，不在读取循环中等待整个模型 turn 或等待用户答复。

普通名字和路径不作为敏感证明。沿用当前环境脱敏规则，控制 token、envFrom 解析值和凭据不得进入日志、诊断或协议元数据。task/message/final 的权限与已有输入输出处理保持一致，不能因通讯新增一份敏感历史。

### 3. worker → adapter

##### start

```json
{
  "protocolVersion": 5,
  "type": "start",
  "run": {
    "id": "0123456789abcdef0123456789abcdef",
    "name": "api-review_2.1",
    "deadlineAt": null
  },
  "execution": {
    "executor": "codex-local",
    "model": "example-model",
    "reasoningEffort": "example-effort"
  },
  "mode": "workspace",
  "workspace": "/absolute/project",
  "prompt": "Review the selected module. Ask the parent if needed.",
  "args": [],
  "runtime": {
    "directory": "/absolute/private/run/adapter",
    "toolkit": {
      "module": "/installed/guide/scripts/runtime/adapter-channel.mjs",
      "command": "/absolute/path/to/node",
      "messageScript": "/installed/guide/scripts/message.mjs",
      "mcpScript": "/installed/guide/scripts/message-mcp.mjs"
    }
  }
}
```

示例中的模型和路径只是示例；deadlineAt 为 null 表示默认不设置执行期限。

| 字段 | 规则 |
| --- | --- |
| run | 只含 id、name、deadlineAt；id/name 在连接内固定。deadlineAt 必填，为 null 或 EpochMs；null 表示不设置执行期限。仅显式 start --deadline-ms N 时，由 worker 设为启动时刻加 N；任何消息、等待和轮次不得重置。不能把 null 转成 0、30 分钟或其他默认计时 |
| execution | executor 必填；model、reasoningEffort 可选且只在本次明确解析到值时出现；旧 execution.profile 字段必须拒绝。全部使用 Identifier；省略沿用后端默认，不生成空值 |
| mode | 只能为 workspace 或 bundle |
| workspace | 必须为已存在的绝对目录，是 adapter 和后端的工作目录；不赋予额外访问或写权限 |
| prompt | 非空 Text，保留任务及显式指令合成后的完整内容；不重新打开指令文件 |
| args | Text 数组，可为空；是后端的实际 argv，不经 shell，不当作 wrapper argv。整帧上限提供累计限制 |
| runtime.directory | worker 创建的本次专属私有目录；POSIX 为 0700，Windows 使用等效的实际访问控制。只供 adapter 及其工具临时使用，不包含父侧消费游标或最终结果缓存 |
| runtime.toolkit | 四个字段均为 AbsolutePath，由本安装 resourceRoot 解析。command 是 Node executable；其余是随本产物分发的 regular file。adapter 可选用共享工具方法，不在运行时下载依赖 |
| fileSelectors | 仅 bundle 必填，Text 数组，可以为 []；原样保留顺序、空格和重复，按 AW 文件选择协议 v1 校验选择表达式 |
| fileResolver | 仅 bundle 必填，严格对象 `{command: AbsolutePath, args: [AbsolutePath]}`，args 恰好一个安装内解析器入口；保持既有文件选择协议 v1 |

workspace 必须完全省略 fileSelectors/fileResolver，传空数组也非法。bundle 首版不支持消息，ready 必须 false。环境通过已解析进程环境传入，不增加 env 或 secret JSON 字段。adapter 不读取 AW store 或重新选择 executor。

runtime.directory 是 adapter 的可写临时边界；result 经 stdout 返回，adapter 不写 worker 的结果缓存。目录路径和 toolkit 只供程序使用，不进入主代理 start 展示。

##### message

只在已收到 ready(true)、任务仍开放时正常发送：

```json
{"protocolVersion":5,"type":"message","id":"11111111111111111111111111111111","text":"Check both callers."}
```

字段 id 为 MessageId，text 为非空 Text。同一连接内 id 不重复，不根据正文去重。每条输入应得到一次 delivery；它是适配器的提交结论，不是模型 ACK。

worker 只把每条本地待发消息写到连接一次。断线、超时、未知回执或进程重启都不重发。已经写入连接但没有 delivery 的消息在最终摘要中按 unknown 保留；尚未写入连接的按 notSubmitted 保留。

进入 closing 的事件与反向 message 可能交错。adapter 收到这类迟到消息时不得启动新 turn，应尽力回复 delivery(notSubmitted, runClosed)；连接已关闭时 worker 根据已有证据分类，不补开连接。

##### stop

```json
{"protocolVersion":5,"type":"stop","reason":"requested"}
```

reason 只能为 `requested`、`deadline`、`channelError`。在合法 start 之后任意非终态阶段都可发送，包括初始化中。重复 stop 等价于同一次停止，不能产生新生成；第一个原因用于主要诊断。

adapter 停止接受新任务输入，调用后端正式中断方法，结束子工具等待并核对停止。worker 同时保留已显式设置的 deadline 和进程归属观察。stop 不带任意 PID，不是跨任务信号接口。仅发送成功不证明后端已经停止。

### 4. adapter → worker

##### ready

```json
{"protocolVersion":5,"type":"ready","communicationSupported":true}
```

communicationSupported 是唯一布尔能力字段。必须在首次模型提交之前输出并完成本地写入；若选择 true，双向工具及收件调度已经配置并能服务本次任务。若选择 false，不加载通信工具，也不注入子侧通信说明；true 路径的说明只描述已配置可用的工具。

worker 验证后进入 running。协议不增加 ready 的反向 ACK；因此 ready 与模型提交之间的故障仍可能形成 unknown，不能据未收到 start 回执重复生成。启动调用的 10 秒只是观察窗口，不是 adapter 的完整执行期限。

worker 同时将布尔能力和这次更新的位置存入已有最新快照。若 start 已交付 pending，后续 wait 首次交付状态或终态（含 deferred）时必须补报该布尔值；快照合并不能吞掉尚未交付的能力，交付后无需重复。未有合法 ready 的初始化失败或失联保持 pending。父侧具体观察规则见本文命令输出合同，不新增 ready 事件队列或 ACK。

##### message：子代理发往父代理

```json
{"protocolVersion":5,"type":"message","text":"Does the first caller still need the old parameter?"}
```

只含 text；不接收模型填写的来源、目标或 id。worker 从连接绑定 run 身份，并生成私有消息文件名。只允许 ready(true) 之后、closing 之前发送。原始 stdout、阶段日志和最终正文都不能自动变成 message。

适配器的工具调用成功只说明消息已交给此输出通道，不证明父模型已经收到。worker 不为每条子消息增加接收 ACK，也不因重连重放它。通道失败时子工具明确失败，adapter 进入故障处理。

##### delivery

```json
{"protocolVersion":5,"type":"delivery","id":"11111111111111111111111111111111","status":"submitted"}
```

必填 id、status；可选 code 和 message。id 必须对应本连接已经收到的父消息。status 只能为：

| status | 证据与后续行为 |
| --- | --- |
| submitted | 后端正式输入接口已接受，或明确 receive 工具已产生本次返回；不证明模型已读或完成要求。worker 删除自己的父消息正文副本 |
| notSubmitted | 确认本次消息未提交到后端或收件工具；保留正文和原因通知父代理，不自动重发 |
| unknown | 接口调用或工具交接结果不明，无法证明是否提交；保留正文和原因，不重发 |

一次 delivery 是最终分类，不能再以第二次 delivery 把 unknown 改为 submitted。内部重试只允许在有明确未提交证据且仍在本次授权任务中时进行，并在结果确定后发出一次 delivery。其他 id、重复 delivery 或不一致分类为协议错误。

非 submitted 必须提供 code；可选 message 是有界安全说明。尚未分配的消息在关闭时为 notSubmitted；已经尝试的消息必须依据实际证据，不能一律改成 notSubmitted。

##### closing

```json
{"protocolVersion":5,"type":"closing","reason":"completed"}
```

reason 只能为 `completed`、`failed`、`cancelled`、`error`。它说明收尾原因，不是终态证明。ready 后正常结束必须恰好一次 closing，result 随后输出；worker 收到后拒绝新的 send。worker 因 stop 或故障也可先在本地进入 closing。

adapter 必须在 closing 前停止子侧新发送入口、完成已经进入串行输出队列的子消息，并决定不再开新 turn。closing 后仍可发出已有父消息的 delivery，但不得再发 ready 或子侧 message。控制循环仍需接收迟到父消息并拒绝。

##### result：唯一的最后结果

```json
{
  "protocolVersion": 5,
  "type": "result",
  "state": "completed",
  "generationStarted": true,
  "backendExitCode": 0,
  "text": "The complete final answer from this run."
}
```

| 字段 | 规则 |
| --- | --- |
| state | completed、failed、cancelled、unknown 之一 |
| generationStarted | true 表示已确认生成，false 仅表示有证据证明尚未提交，null 表示无法确认。启动后端进程本身不等于 true |
| backendExitCode | 实际后端进程退出整数，或未知时为 null；completed 必须为 0。会话型后端须先结束本次所属会话及客户端再取得真实退出证据，不伪造 0，也不使用 adapter 的退出码代替 |
| text | Text；completed 必须非空且完整，其他状态可为空或已标明的部分结果 |
| code | 可选 Code；failed/cancelled/unknown 时必填 |
| message | 可选有界 Text，解释故障与可用证据，不回显凭据 |
| sessionId / model | 可选 Identifier，只记录实际后端返回的信息；不能作为 resume 入口或投递目标 |
| remoteStopConfirmed | 可选 boolean；只有适用的真实后端停止证据才能写 true，缺失不等于 true |

result 只有一次且是最后一条事件。它代表整个 run，不代表其中一个 turn。除初始化失败/初始化中取消外，result 前必须已有 ready 和 closing。ready 前的 result 只能为 failed 或 cancelled、generationStarted=false；若适配器无法证明未提交，应使用 unknown、generationStarted=null，并说明 protocolInvalid 或实际故障。此异常 result 不报告通讯能力。

result 完整写入后 adapter 关闭自身子工具及输出，并退出 0；退出 0 只表示正常结束了协议，任务本身可能失败。无法形成合法结果的适配器退出非零。worker 不把 adapter 的 0 当作业务成功，也不把非零当作从未生成。

worker 读取 result 后仍等待 adapter 退出和本地所属进程收尾。只有结构、服务终态、完整正文、后端退出、adapter 退出及本地停止证据全部一致，才保存 completed。协议和停止冲突可把 result 降为 unknown，不能把 failed/unknown 升成 completed。

### 5. 生命周期与最小序列

| 当前阶段 | 合法输入 | 合法输出/下一阶段 |
| --- | --- | --- |
| 尚无 start | 仅 start | 不启动后端、不发事件 |
| 初始化中 | stop；不能 message | ready → running；或初始化失败/取消 result → 结束 |
| running，通讯 false | stop | closing → 收尾；不允许双方 message/delivery |
| running，通讯 true | message、stop | 子 message、父 delivery；closing → 收尾 |
| 收尾 | 重复 stop、交错的迟到 message | delivery，最后 result；不再 ready/子 message |
| result 已发出 | 不再接受任务输入；关闭管道 | 无后续事件，退出 |

不支持通讯的最小 adapter：读取 start、校验配置、ready(false)、执行任务、closing、result、退出。它仍须响应 stop、EOF 和已显式设置的 deadline；不需要实现 message、delivery、MCP 或接收工具。

支持通讯的典型时序：

```text
worker → adapter  start
adapter → worker ready(true)
adapter → worker message(child question)
worker → adapter  message(id=A, parent reply)
adapter → worker delivery(A, submitted)
adapter → worker closing(completed)
adapter → worker result(completed, final text)
```

父消息恰好跨越后端轮次边界时，adapter 持有自己的会话/turn ID。只有确定未提交，且 run 仍开放、原授权及已设置的执行期限允许时，才能安排同一会话的下一轮。提交结果不明时报告 unknown。普通消息不隐含 interrupt。

不要求 closing 与父发送形成跨进程事务。worker 保存未有结论的父消息，即使 result 为 completed，也可在结果旁报告投递缺口。最终回答不证明之后到达的追加要求已完成。

### 6. 停止、断线和错误

| 事件 | adapter / worker 的处理 |
| --- | --- |
| start 输入非法或协议版本不同 | adapter 不提交模型；若无法信任完整 start，只输出安全 stderr 并非零退出。worker 保留实际未提交证据；不能靠非零退出推断 |
| 合法 start 后初始化失败 | adapter 发出合法 failed result，generationStarted=false，退出 0；没有 ready 能力值 |
| running 协议错/通道错/超限 | 停止接受输入和新 turn，按已知提交阶段停止后端；可写时 closing(error) 和合法 result，写不了时 worker 归为 unknown |
| worker stdin EOF | adapter 将其视为父控制连接失联，停止本次任务和工具，不作为 prompt 结束继续无限运行 |
| adapter stdout EOF 或非零退出，无完整合法 result | worker 保存 unknown 及已有的有限内容；不得用日志替代最终结果，不重开 adapter |
| stop / 已设置的 deadline 到期 | adapter 调用正式中断并继续观察；显式期限存在时 worker 也设置对应截止计时，必要时只停止可证明归属的后代。deadlineAt 为 null 时不因运行时长触发停止 |
| result 后 adapter/后代仍活跃 | worker 有界收尾并保持 unknown，不能先报告 completed |
| 未得到 delivery | 已写入连接的父输入为 unknown；未写入的为 notSubmitted。不存在自动重放 |

deadlineAt 非 null 时，worker 和 adapter 的执行计时都由该固定时刻换算为本地剩余时间；新消息不能延长。deadlineAt 为 null 时，worker、adapter 和子工具桥接都不创建执行期限计时器；单次 receive/wait 的窗口仍有界。停止宽限最多 30000 ms，宽限消耗在本次收尾中，不能每次 stop 重置。未确认本地/远端停止时保存 unknown 和控制证据，而非伪造 cancelled。

cancelled 要求本次存在停止意图、本地执行已停止；已经提交时还需适用的真实远端停止证据。failed 要求确认输入/服务失败且没有仍可能活跃的冲突。unknown 表示证据不足，不授权重跑。

有限 stderr 用于诊断，不归档完整服务事件。8 MiB 限额用于停止异常高输出任务；累计超额时即使已有合法服务结果，也按资源超限收尾，不能通过停止留存或裁剪来保留 completed。该运行额度与每次对主代理显示最多 1 KiB stderr 分别执行，后者只控制显示，不单独改变任务终态。

正常服务 result 缓存由存活 worker 写入，不接受 adapter 指定任意输出路径。worker 已确认丢失且没有终态缓存时，本文“停止、失联与结果缓存”规定的父侧检查只可固化一次 unknown，并沿用首次确认失联时已固定的到期时间；它不能从后端或日志恢复一个成功 result，不建立第二条 Adapter 结果通道。消息、终态通知、最终缓存的消费和 1 小时过期规则以本文运行生命周期 为准。

### 7. 可复用的子侧工具桥接

v5 的 wire 合同只需要上述事件。为了让 Codex/Claude/custom 复用发送、显式收件及脚本/MCP，随安装产物提供 `runtime.toolkit.module`。这是可选接入方法，第三方可实现等价工具；不采用它不改变 v5 行为。

Node 适配器入口：

```ts
createChildBridge({
  directory,          // Private subdirectory of start.runtime.directory
  deadlineAt,         // EpochMs | null; null means no execution deadline
  toolkit,            // start.runtime.toolkit
  emitParentMessage,  // async (text) => void; write v5 messages in order
  submitInput,        // Optional async ({id, text}, {signal}) => Delivery
  canSubmitInput      // Optional synchronous () => boolean
}): Promise<ChildBridge>

type Delivery = {
  status: 'submitted' | 'notSubmitted' | 'unknown';
  code?: string;
  message?: string;
};

interface ChildBridge {
  mcpServer: { command: string; args: string[] };
  script: { command: string; args: string[] };
  acceptInput(message: { id: string; text: string }): Promise<Delivery>;
  hasPendingInput(): boolean;
  close(reason: 'completed' | 'failed' | 'cancelled' | 'error'): Promise<void>;
}
```

这些方法名和行为构成本次建议的共享 API；private 文件布局、随机绑定值和内部等待请求标识不构成作者合同。API 实现及其 MCP/脚本使用同一个版本和消息核心分发，不形成三套队列。

`emitParentMessage` 在本地 stdout 完整写入后 resolve，失败则 reject；工具显示提交到父侧通道，不声称父模型已收件。每次调用都形成一条消息，检查单条字节上限，不设置累计消息数量或字节额度。

`acceptInput` 接受来自 v5 的唯一父消息。桥接器串行分配：已有显式等待者则交给该等待；否则在配置了 submitInput 且当前允许自动提交时分配给它；否则保留给下一次显式收件。返回的 Promise 表示最终 delivery，可能等待实际收件，不得阻塞适配器的控制读取循环。adapter 在 Promise 结束时输出唯一 delivery。

`canSubmitInput` 是可选的同步 readiness 检查，省略时保留已有自动提交行为。返回 false 时输入留在共享队列，显式 receive 仍可领取；返回 true 才能分配给 submitInput。桥接器在现有工具请求扫描中重新检查，不要求额外通知 API。若后端须等待当前 turn 的正式 result 才能提交新输入，应让该检查返回 false，不能先占用输入再等待轮次边界。

`submitInput` 由适配器负责后端提交及明确未提交时的处理，不能阻塞 stop；桥接器通过 signal 取消等待。已经分配给后端的输入不能再交给 receive；后端回执不明时返回 unknown，不自动改道或重发。显式 receive 之后注册，也不能抢走已经提交或正在提交的同一输入。该 readiness 检查不改变 v5 wire 合同。

`hasPendingInput()` 包括未分配及提交结果尚未确定的输入，用于决定是否结束本次 run，不是跨进程新消息的事务性保证。`close()` 幂等：拒绝新发送/收件/输入，唤醒等待工具为 closed，未分配输入返回 notSubmitted，已尝试输入依证据返回结果。关闭期限受剩余收尾宽限限制；不能无限等待后端或 MCP。待处理投递 promise 均结束后，adapter 输出剩余 delivery，再输出 result。

共享桥接器使用 runtime.directory 中的私有临时文件服务跨进程工具请求；由适配器进程中的唯一调度器消费。文件完整写入后原子发布，单次工具返回后删除请求/响应，close 清理可安全删除的工具临时资源。它不保存工具历史、不接受任意目标，不设置第二个 run 状态或独立生命周期。stdio MCP 配置及脚本命令都由该实例生成，身份从本次实例绑定，不能让模型传入 from、父地址、run 目录或其他子代理目标。

对子代理公开的工具只有：

| 工具/脚本操作 | 输入 | 结果 |
| --- | --- | --- |
| `send_parent` / `send --text TEXT` | 非空正文；脚本支持 `--text -` | `submitted` or an explicit error; no implicit wait |
| `receive_parent` / `receive --timeout-ms N` | timeoutMs 可选，默认 600000，整数 0–1800000 | `received` with the assigned text, `timeout`, or `closed`; no cursor/history/replyTo |

receive 在一条输入可分配时提前返回；有多个显式 receive 时只允许一个活跃调用，其余返回 `receiveAlreadyPending`，避免额外多消费者合同。MCP 和脚本均使用以上语义和 4 KiB 单条正文上限。普通返回使用英文控制行和独立 MESSAGE 块，按本文命令输出合同生成短边界；正文保留原文。MCP 标准 envelope 只由包装处理，不把父输入混入工具状态或说明。工具成功状态使用 submitted/received，空结果使用 timeout/closed，错误使用明确的英文 code。

子代理应知道：父输入也可能已进入当前模型上下文，显式 receive 不重放已经自动提交的输入。收到新上下文后无需周期性拉取。需要问答才能继续时，应保持本次任务开放并采用默认 10 分钟长等待；收到输入或 closed 时提前返回，不强制等满。明确更短等待窗口或已设置的剩余 run 时限可以缩短窗口，显式 deadline 到期或 close 必须唤醒等待，不能因等待而延长执行。不能先返回 run 最终答案再等待重启。工具 schema/help 拥有具体参数规则，附加通信说明只补充这些生命周期和输入语义。

### 8. 最低合同验收

从真实 adapter 进程及公开 helper 入口验证，使用隔离目录及 fake backend。以下各风险只在最低足够真实的层级覆盖：

1. JSONL 的半帧、多帧、Unicode 分片、未知字段、非法 UTF-8、EOF 半帧及大小边界。
2. ready(true/false)、缺失/重复 ready、初始化失败、false 模式消息拒绝及不自动回退；start 超时后的能力由后续 wait 补报，快速收尾及终态合并不能吞掉它。
3. 双向正文完整且不翻译，4 KiB 边界有效；双向发送并消费超过 64 条仍可继续，未消费队列也不因固定条数被拒绝，未解决投递不因旧累计字节额度丢失；名称符合 ASCII 规则，程序输出为英文；重复正文两次、身份固定、内部 ID 关联、重复/未知 delivery 拒绝。
4. 慢输出回压下仍可接收 stop；deadlineAt 为 null 时跨过旧 30 分钟仍运行，显式 deadline、EOF、adapter 崩溃不重启任务。
5. 一个后端 turn 完成时不会误认 run 结束；closing 与父输入交错时分类可查。
6. result 唯一且必须最后；日志、非空正文、单一退出码不能替代服务和本地收尾证据；completed 使用实际后端进程退出码；stderr 超过 8 MiB 后不能仍报告 completed。
7. submitted 删除父正文；未提交/未知进入必要摘要；没有消息历史或自动重放。
8. MCP/脚本/自动输入共用调度，关闭唤醒等待，未等待的消息不被两个入口重复消费。
9. 不支持通讯的第三方只实现最小生命周期也可运行；bundle 文件选择与环境配置语义保留。
10. 从实际安装产物启动所有入口及工具；引用的模块/脚本闭包完整，不依赖开发源码路径。
11. 在原生 Windows 上验证 argv、UTF-8/CRLF 保真、后台存活、双向工具、真实后端退出证据、stop/显式 deadline/EOF、默认无期限及所属后代清理；覆盖私有访问控制、文件占用和 junction/重解析链接保护。共享进程与 foreign 资源不受影响。
12. wait/receive 的默认长等待和上下界有效；消息与关闭及时唤醒，较短的等待工具窗口只续等同一次工作，不重提。零等待排空不变成普通空轮询。

真实后端的输入、审批、会话停止和模型是否按期望回应仍需单独验证，fake 只验证本地协议及副作用。

## 命令输出合同

### 1. 英文控制信息与原文数据

程序生成的字段、枚举、错误码、提示、help、运行说明、工具描述和诊断使用英文。任务、父子消息、模型最终回答及必要的外部原始数据保留原语言；不翻译、不因含中文而拒绝。敏感值继续按现有规则脱敏，不新增原文副本。

每段模型正文、过程消息、未提交输入或引用的外部诊断都放在独立原文块内。不能把正文直接拼到状态行、错误码、工具说明或响应外部；模型回答中声称完成，不影响结构化 state。标记只是阅读边界，不是内容可信或执行授权的证明。

名称、句柄、状态、code 等受约束值可以直接放在单行控制字段中。路径等其他动态标量使用 JSON 字符串转义作为单行值，原始换行、引号和控制字符不能改变结构；这不使整个响应成为 JSON。第三方多行诊断进入 DIAGNOSTIC 块，不能混入控制字段。

### 2. 平铺控制字段与短正文边界

首行固定为 `<command>: <outcome>`。wait 仅在还有已观察到但未消费的事件时紧接一行 `more: true`；省略时为 false。没有目标记录时，响应只有命令结果行。故 `wait: timeout` 和 `wait: settled` 各只需一行。

有内容时，按 --run 输入顺序分目标组，组间空一行。每组先列 `agent`（即运行名称）、`run`、`state`，身份只声明一次；同组的状态、消息和最终结果均归属该句柄。无法验证目标时只列 run 和错误，不编造名称或状态。每个组内继续使用第 4 节的事件顺序，不按正文种类重排。两条相同正文仍分别成块。

控制字段不使用 RESPONSE 或 META 包装。原文块按用途使用以下标记，均独占一行并以 LF 结束：

```text
BEGIN_MESSAGE:TOKEN
<original process message>
END_MESSAGE:TOKEN
```

用途只有 `MESSAGE`（过程消息或子侧收件）、`INPUT`（未解决投递的父输入）、`FINAL`（最终正文）和 `DIAGNOSTIC`（外部原始诊断）。不同用途遵守相同分隔规则，不嵌套。每次呈现生成一个 **8 位小写十六进制 TOKEN**；格式化前检查它没有出现在本次实际输出的任何数据中，碰撞则换一个。TOKEN 只用于当前输出，不保存、不查找、不用于路由或鉴权。纯控制响应不需要 TOKEN；result --export 的完整 stdout 与独立 stderr 各自生成边界。

BEGIN 行后原样写入正文，再写一个属于封套的 LF，然后写对应 END 行。无论原文是否以换行结束，都不 trim 或修改原文；这个额外 LF 不属于正文。内部精确计数 UTF-8 字节，但默认不显示 body_bytes。正文中的假状态行、代码块或不同 TOKEN 的假标记不能关闭实际原文块。边界检查必须覆盖所有选中的正文、动态字段和诊断。

正常启动示例：

```text
start: ready
agent: api-review_2.1
run: <opaque-handle>
state: running
communication: true
```

短结果的首次 wait 示例；正文为 16 个 UTF-8 字节，句柄只是示例：

```text
wait: changed
agent: api-review
run: <opaque-handle>
state: completed
BEGIN_FINAL:8a731c0d
No issues found.
END_FINAL:8a731c0d
```

more 不表示任务仍运行，也不表示 deferred 正文会在下次 wait 重放。END 只分隔原文，不能证明调用工具没有裁掉中间内容；完整交付还须满足第 4 节的调用工具预算合同。

### 3. 必要字段、条件字段与结果内容

| 输出 | 必要控制信息 |
| --- | --- |
| start | agent、run、state、communication；能力为 true/false，尚无 ready 为 pending；结果词为 ready/notReady/error |
| send | agent、run、state、delivery；成功为 queued，关闭竞态不明为 unknown；结果词为 queued/unknown/error |
| wait | 结果词为 changed/timeout/settled/error；有事件的目标组包含 agent/run/state，失败目标带 code；more 及 communication 按条件出现 |
| result（含 --export） | 结果词为 read；agent/run/state、按序的全部未读消息/问题通知、固定最终结果；communication 按条件补报。--export 使用相同报告格式，无保存回执 |
| result 超限 | 结果词为 error，code 为 resultTooLarge；agent/run/state、result_bytes、output_limit_bytes、英文导出指引 |
| stop | agent/run/state、已确认的本地停止信息或明确缺口；结果词为 stopped/stopping/error；本地停止不等于业务 cancelled |
| 子侧发送/接收 | command 为 send_parent/receive_parent；结果词为 submitted/received/timeout/closed/error，接收原文独立放入 MESSAGE 块；不另暴露运行句柄 |
| 诊断/错误 | English code 及英文程序说明；外部原始诊断独立成块；独立 stderr 首行为 diagnostic: error |

**延迟能力通知。** start 总是显示当时已知的 communication。若 start 只交付 pending，随后合法 ready 将能力确定为 true 或 false，下一次 wait 交付该 run 的状态/终态记录，或 result 交付完整报告时必须附该布尔值。worker 在最新快照保留实际值和这次更新的位置；父侧沿用已有观察位置。能力信息在相应记录被选入且消费前保持未读，不能因快照合并、closing、快速终态或 deferred 而丢失。交付后不在无关响应中重复。start 已显示布尔值时不要求 wait 再补报；start 即使显示终态也只确认能力观察，不消费终态通知。stop 不推进能力观察位置；result 完整输出并成功消费时推进，超限或输出失败时不推进。没有合法 ready 的失败或失联保持 pending，不能填 false；首次交付这种终态时显式给出 pending。该规则不增加独立事件日志或 ACK，回执丢失仍遵守本文运行生命周期边界。

完整最终结果的内部数据仍包含名称、句柄、真实终态、有效期、生成阶段、实际后端退出码、适用的停止证据、故障和全部未解决投递。显示层只按下表省略已确定的正常值，不能删除缓存或程序合同中的证据。

| 信息 | 显示规则 |
| --- | --- |
| agent/run/state | 每个目标组一次；真实状态不省略 |
| more | 仅 true 显示；省略严格表示 false |
| result: included | 不显示；完整 FINAL 块和同组完整最终投递缺口共同表示结果已包含 |
| result: deferred | 必须显示，并附第 4 节的大小与读取指引 |
| text_status | completed 的完整正文可省略 complete；其他状态必须显示 partial 或 missing，不因非空改为 complete |
| generation_started/backend_exit_code | completed 时可省略 true/0；failed/cancelled/unknown 时显示真实值，未知显示 null |
| remote_stop_confirmed | 有停止意图或远端停止证据影响分类时显示 true/false/unknown；缺失证据不能显示 true；其他场景可省略 |
| expires_at | 不向主代理显示；完整结果、deferred、--export 报告均省略，也不以其他字段显示到期时间。内部保留缓存时间并执行固定 TTL |
| code、故障与未解决投递 | 实际存在时必须显示；必要父输入原文不能省略 |
| body_bytes | 仅内部精确计数，默认不显示 |

一个终态结果组先给出结果控制字段和必要故障。有投递缺口时，在最终正文前显示 `delivery_gaps: <count>`；随后逐条列 `delivery: notSubmitted/unknown`、code、必要原因及 INPUT 块，再给 FINAL 块。没有缺口时省略 delivery_gaps，含义为 0。运行中的投递问题也使用 delivery/code/INPUT，不能只显示正文。诊断与最终回答分块，缺失正文仍输出空 FINAL 块并标 missing。已在 wait 显示过的问题，若最终仍未解决，可以再次进入固定结果；这不是历史接口。

例如完成结果可以同时带有 unknown 投递缺口：

```text
wait: changed
agent: api-review
run: <opaque-handle>
state: completed
delivery_gaps: 1
delivery: unknown
code: inputDeliveryUnknown
BEGIN_INPUT:8a731c0d
Check both callers.
END_INPUT:8a731c0d
BEGIN_FINAL:8a731c0d
The first caller is valid.
END_FINAL:8a731c0d
```

这里 completed 只证明任务结果满足完成条件，不能证明追加输入已经提交。unknown 不等于明确失败，也不授权安全重跑。不得只输出最终正文而省略其投递缺口；不能容纳整个结果组时必须按第 4 节处理。

最终结果缓存固定后，重复读取的业务字段、正文和缺口不变；TOKEN 和首次按条件补报的 communication 可以不同。result 首次还包含全部未读过程消息和问题通知；成功消费后不再出现这些内容。固定最终结果中的未解决投递摘要不因通知已读而删除。读取允许重现最终结果，不要求整份报告或封套字节相同。

多目标 wait 某个目标失败时仍检查其他有效目标，并在预算内交付。存在已交付变化时结果词为 changed，仅错误时为 error；本次检查遇到任一目标读取失败则退出 1，即使该目标的完整错误记录因预算延后，也须给出有界命令级提示并保留该记录待取。无读取错误的 changed/timeout/settled 退出 0。deferred、more 和任务 failed/unknown 本身不使读取命令失败。

### 4. 8 KiB 显示预算、调用工具预算与 wait 选择

##### 脚本和单事件上限

wait 与未加 --export 的 result 每次调用的 stdout 与 stderr 合计最多 **8192 UTF-8 字节**。控制字段、标记、空行、分隔 LF 和诊断都计入。stderr 至多 **1024 字节**，仍占同一总预算；不得透传 adapter stderr。先确定有界诊断，再装入 stdout 事件，保留后续读取失败所需的错误提示空间。只允许缩短程序诊断摘要，不能截断消息、父输入或最终正文后声称完整。

两个方向的单条过程消息均最多 **4096 UTF-8 字节**。一个普通消息或投递问题的完整呈现最多 **7168 字节**，其中包含命令行、目标身份、实际状态、待补报能力、所有标记、必要错误 code 和指引；再加最坏 1024 字节 stderr，也必须可独立交付。实现必须按最大合法字段验证这个上界，不能把“实际能放下”作为消息入队后的附加条件。

为满足该上界，普通事件的控制字段及标记合计最多 1024 字节，附加可显示诊断合计最多 1024 字节，消息原文最多 4096 字节，余下 1024 字节留给响应级提示。Adapter 的可选错误 message 仍最多 4096 字节；显示层可以提炼有界英文诊断，code 和投递分类必须保留。引用的外部诊断如果无法完整容纳，可以省略原文并显示 `diagnostic_omitted: true`，不能裁改后伪装为完整引用。父输入和模型消息不是可省略的诊断。

#### 调用工具合同

本节面向调用工具集成的实施与验收，不作为 Skill 的原生工具教程。字节预算不等于调用工具 token 预算；实施者须为支持的实际调用链固定并验证预算。沿用 v6 的首版验收配置：Codex exec_command 与 write_stdin 的 `max_output_tokens: 16384`；存在 functions.exec/functions.wait 包装时，外层分别为 `max_output_tokens: 16384` / `max_tokens: 16384`。具体传参遵守实际工具 schema。每个验收样本只转交一条命令的原始 output，不以多命令汇总、摘要、head/tail 或额外 JSON 字符串化代替完整交付；覆盖启动、等待和续读。

这组参数是首版技术取值，不是对所有调用工具的无条件保证。实施验收必须经实际执行工具及全部中间包装，证明最大合法 8192 字节响应、最大单条消息及封套都完整进入模型上下文；覆盖高 token 密度文本、中文、换行、可合法出现的控制字符及序列化开销。不能只用平均字节/token 比例、stdout 文件完整、首尾标记仍在或没有报错证明完整。

支持声明须有真实链路证据，不能只因为设置了数值就认为通过。更低的固定工具上限必须先调整调用预算并验证；仍不能完整承载时，该工具调用路径不受支持，不能先消费再试。运行脚本不新增调用工具预算参数或探测协议。Guide 的运行正文保留选择边界和消费后果：使用能完整承载回执的工具调用路径，裁剪时标记交付不完整，已消费过程消息不保证重读。result --export 的完整 stdout 不受脚本显示上限限制，但调用工具仍可能裁剪，主代理须事先选择完整接收路径，见第 5 节。已有回执丢失边界继续有效，不增加 ACK、历史或恢复账本。

##### 完整事件选择

1. 检查全部目标后，按 --run 输入顺序处理可见变化；每个 run 先考虑合并后的最新状态，再按接收顺序考虑过程消息/投递问题。状态和每条消息是独立事件，组头及条件能力随对应状态或终态记录原子选入，不留下无归属正文。
2. 以完整事件为单位装入响应并精确计数。普通事件放不下时停止装入；该事件及后续事件保持未读，显示 more: true。单条合法普通事件必须满足上述空响应可交付上界。
3. 首次终态是一个结果组，包含最终正文和全部最终投递缺口。能放入剩余预算时完整交付；若可独立放入空响应（包括必要封套和已确定诊断），只是剩余空间不足，则整个终态保持未读并标 more。只有整个组连空响应都放不下时，才改为有界 deferred 通知；连通知都放不下时也保持未读。
4. included（由完整内容表达）或 deferred 终态通知均只消费一次，最终缓存不删除。同一终态 run 尚未输出的普通消息继续保持未读。more 只计算未消费事件，不计算已交付 deferred 的正文。
5. 消费前完成全部序列化、边界碰撞检查及字节计数，再按本文运行生命周期消费。本规则不引入事务式消费保证；工具调用前须已满足预算合同，回执丢失遵守原有边界。

deferred 至少包含 agent/run/state、尚未交付的 communication（若适用）、`result: deferred`、result_bytes、`deferred_reason: outputLimit` 以及读取指引；有最终投递缺口时还须给出 delivery_gaps 数量，避免误认为 completed 已包含全部追加输入。该通知最多 2048 字节。所有逐条分类、code 和原文由随后的完整 result 显示或导出，不用不完整 FINAL 组替代。

`result_bytes` 在 wait 的 deferred 记录中表示固定最终结果按单目标 result 呈现所需的 UTF-8 字节数（含封套，不含本次诊断及独立未读过程消息），不改变 wait 以完整终态组选择的规则。在 resultTooLarge 中，它表示本次 result 完整报告（全部未读消息和固定最终结果，含封套、不含本次诊断）的字节数；`output_limit_bytes` 为 8192。二者不是 token 数或 JSON 帧大小。

wait 的 deferred 固定结果大于 8192 字节时提示 `Use result --run <handle> --export with a destination that accepts the full output.`；否则提示 `Use result --run <handle>.`。后一种情况可由 wait 自身封套或诊断使单结果放不下引起；随后的 result 仍须计入所有未读消息及实际诊断，可能返回 resultTooLarge。resultTooLarge 始终指引使用 --export 并由调用者选择完整接收方式。指引使用真实句柄和安全引用，不接受或生成目的路径。

未加 --export 的 result 先检查全部未读事件与固定结果能否一起完整显示，不能复用 wait 的部分选择规则。超限时只输出有界错误及指引，不消费任何事件；报告能完整输出时，按第 5 节输出及消费。已交付的 deferred 不在后续 wait 自动展开；即使省略 more（即 false）也必须按指引取得完整结果。

### 5. result 全量报告、--export 与消费

`result --run <handle>` 和 `result --run <handle> --export` 都先按接收顺序列出全部未读过程消息及运行中问题通知，再列出固定最终结果。组头 agent/run/state 只出现一次；尚未交付的 communication 随组头补报。终态结果部分仍按第 3 节显示必要故障、最终投递缺口及 FINAL 块。问题通知和固定结果中的投递摘要是不同数据：前者只消费一次，后者作为最终判断证据允许重读。没有未读消息时只输出固定最终结果及适用的能力字段，不创造空消息块或 more 字段。

两种调用均用 `result: read` 和同一套字段、UTF-8 字节与原文边界。--export 是不带值的布尔标志，小报告也可使用；它只取消该次 stdout 的 8 KiB 显示上限，stderr 仍最多 1024 字节。最终正文仍最多 4 MiB，单条消息和诊断仍受各自限制；未读消息和投递摘要不设置累计条数或总输出字节上限。报告可流式校验、计数与输出，不能绕过接收端校验或读取任意 backend scratch。

`--output-file` 被删除并在副作用前拒绝；不再输出 exported、output_file、bytes_written，也不提供 outputFileExists/exportIncomplete 文件管理错误。脚本不接收目的地、不创建或管理文件、不执行重定向命令。主代理可用调用工具的能力把 stdout 写到文件、传给管道或其他接收端；目的地选择、覆盖规则、权限、下游完整保存和副本清理由主代理负责。run 过期不删除调用者保存的副本。

##### 输出与消费顺序

1. 确认 run 终态、归属和有效期；同一 run 的 wait/result（含 --export）由单逻辑父串行调用。确定本次全部未读内容和固定结果，检查内容可读性、边界碰撞；默认模式再核对 8192 字节总预算。前置失败不消费消息、终态通知或能力观察位置。
2. 将完整报告写入 stdout。未加 --export 时不允许部分显示；加 --export 时完整写出且处理背压，不因超过 8192 字节裁剪或停止。写入失败（包括 EPIPE）返回非零并尽力在有界 stderr 报告 `resultOutputFailed`；不开始消费。
3. 全部 stdout 写入完成后，删除本次未读消息和问题通知，最后推进终态及状态/能力观察位置；成功退出 0。最终缓存保留。wait 随后无未读事件时 settled；再次 result 只读固定最终结果。
4. 输出完成后的消费失败返回非零，stderr 报告 `resultConsumeFailed`；已删除内容不回滚，未删除内容和未完成的观察位置保留。stdout 的 `result: read` 不是整次成功的证明，调用者还须检查退出码和 stderr。进程异常中断可能发生于输出与消费之间；再次读取可出现已经输出但未删除的消息，不提供跨二者的 exactly-once 保证。

本顺序不增加 ACK、事务、已读集合、历史副本或重试队列。与 wait 的有界批次消费顺序分别定义，不能将 wait 的部分交付规则套到 result。工具回执丢失或裁剪发生在脚本成功消费之后时，已删除过程消息不能重读；只有固定最终结果仍可重读。

##### 调用工具的输出限制

--export 不取消调用工具的输出限制，也不要求任意大报告直接进入 Agent 上下文。主代理在调用前选择能完整接收 stdout 的方式；例如让执行工具直接保存到文件，再分段读取，或将输出转发给其他完整接收端。不能先经会裁剪的工具回执取得字符串，再将这个字符串保存并声称完整。完整接收不要求把全部正文一次放入模型上下文。

脚本可观察的 stdout 写入完成，只说明字节已交给接收端；不能证明下游写盘、管道消费者或工具返回给模型的内容完整。下游失败及工具裁剪由主代理根据所选工具的状态核对；若脚本已消费，不保证过程消息可恢复。验收需分别覆盖默认 8 KiB 报告完整进入工具回执，以及 --export 大报告经文件或非文件接收端完整保留；包括工具回执裁剪、管道断开和消费失败。第 4 节的固定 token 配置不构成 --export 任意大输出的承载保证。

## 停止、失联与结果缓存

### 3. start

1. start 固定本次安装配置、执行器和输入，创建私有运行目录及句柄。
2. worker 接管适配器、消息及收尾。默认不设置执行期限，内部 `deadlineAt` 为 null；仅显式提供 `--deadline-ms N` 时，从 worker 启动时刻加 N 毫秒得到本次固定期限。
3. adapter 在首次提交模型前发出一次合法 `ready`，其中只有一个 `communicationSupported` 布尔值。worker 保存它，start 返回。
4. start 最多等待 10 秒初始化。未取得 ready 时显示 `state: starting`、原句柄、`code: startupNotReady` 和 `communication: pending`，退出 1；不能伪造 false。调用者继续 wait/stop 同一任务。

`--deadline-ms` 是可选的本次执行时长，不写入配置。N 必须是正的安全整数，且与启动时刻相加后仍为合法 EpochMs；非法值在创建运行资源前拒绝。省略时不创建执行超时计时器，不默认填入 30 分钟，也不从 wait/receive 窗口或缓存 TTL 推导任务期限。明确期限不会被新消息、后端轮次或再次等待延长。默认无期限仍响应 stop、通道断开、协议错误和真实后端退出；后端或宿主的实际限制按真实错误报告。

`false` 是适配器明确选择不支持通讯。缺字段、协议错误、初始化失败和通讯配置故障不能折算为 false。支持路径的初始化失败应结束并报告实际错误；运行中通道故障进入收尾，不悄悄改为不支持。

`true` 说明本次双向入口可用，子代理已取得相应工具或说明。它不保证立即打断、模型已读或追加要求已完成。适配器可自动注入、在轮次边界提交，或提供主动收件；主代理无需选择具体方式。支持自动输入的内建路径不要求模型周期性检查信箱。

任务可能在 start 返回前已经结束，此时显示实际终态和原句柄；未有 ready 时能力仍为 pending。start 不返回最终正文，也不消费任何过程消息或终态通知。它显示的非终态可作为初始状态观察位置，但终态始终保留为未读，使随后第一次 wait 仍能取得结果。stop 不消费 wait 的事件；result 按第 4 节交付并消费全部未读事件。

start 只显示 pending 而 ready 稍后到达时，worker 保存该布尔值和已有更新序号；下一次 wait 交付状态/终态，或 result 交付完整报告时，必须附 communication。即使 ready 后立刻 closing 或终态，也不能在快照合并时丢掉尚未交付的能力。交付前保留，交付后无需重复；start 已显示布尔值时无需再补报。stop 不推进这个观察位置；result 成功消费时一并推进。没有合法 ready 的失败或失联仍保持 pending。

不提供 start 预览或替代的预览命令。help 只读；参数形状检查在创建运行资源前完成。bundle 正式启动时仍通过既有 fileResolver 解析选择式，不将删除 preview 扩大为删除文件选择能力。

### 4. wait 与单目标 result

##### wait：一个窗口观察全部目标

至少提供一个 `--run`，重复句柄合并，最多 16 个不同目标。`--timeout-ms` 默认 **600000**，允许整数 **0–1800000**。默认给任务至少 10 分钟的响应式等待窗口，有新事件立即返回，不强制等满。明确的更短用户等待窗口、已设置的剩余执行时限或即时检查可缩短本次窗口。超时或中断只结束这次 wait，不终止任务、不重新调用模型、不延长任务或缓存期限。

等待策略同时适用于 Guide 的原生与外部路径。等待工具单次上限不足 10 分钟时，使用允许的最长窗口续等同一任务；这个限制不把默认预算降成短轮询。执行工具的短期让出、脚本内部检查周期和 Agent 主动重新检查是不同层：内部检查可保持响应性，Agent 不应据此每几秒发起新 wait。只有 more: true 等明确的待取事件可以用零等待排空。start 的 10 秒初始化观察和 stop 的 30 秒收尾观察保持各自用途。

先检查全部目标；已有新消息、状态变化、投递缺口或需要处理的错误时立即返回。否则使用同一个截止时间观察全部目标，任意目标变化即返回。按目标输入顺序、各目标的待取事件顺序组织输出；同次可见的变化在预算内一起交付，不输出未变化目标的重复状态，不能先等完 A 再检查 B。

程序可使用短周期检查及文件通知。通知只是提示；订阅后再次检查，定时检查保底。各 run 的进度独立保存，更换等待集合不会重置 B 的状态位置。

| 情况 | 输出与行为 |
| --- | --- |
| 新过程消息/状态/故障 | 仅返回有变化的目标及本批完整事件；名称/句柄每组一次，原文逐条分块；有未交付的已确定能力时附 communication |
| 首次终态通知 | 能容纳时附完整最终正文和全部投递缺口，不另写 result: included；单个完整组本身放不下时标 result: deferred，附大小及读取/导出指引；只是本批空间不足时保留整个终态未读 |
| 窗口结束，无变化 | 只有 `wait: timeout`；没有目标旧状态或正文 |
| A 已返回终态，B 仍运行 | 后续 wait A B 不被旧 A 终态唤醒，不重放 A 的终态或正文；A 仍有未读过程消息时可以交付 |
| 全部目标终态且没有未读事件 | 立即返回 `wait: settled`；不重放各目标终态或正文 |
| 某目标过期 | 返回该目标 runExpired，不再返回缓存正文；同时保留其他可读目标的本批结果 |
| 目标已清理、丢失或不能证明归属 | 返回 runUnavailable，不创建或接管执行 |

状态更新可合并为最新快照，但内部更新序号必须能发现两次检查之间发生过变化，且不得吞掉尚未交付的能力。这个序号不是历史。每个 run 只有一个逻辑父接收者；对同一 run 的 wait/result（含 --export）应串行调用，首版不支持重叠的多消费者。

**消费边界。** 所支持的调用工具链须先满足输出预算合同；脚本再在字节预算内构造完整响应，消费本批事件并输出。过程消息取出即删；终态通知只消费一次，不删除最终缓存。未选入本批的消息、问题通知和状态保持未读，下次 wait 可立即取出，并标 more: true。没有剩余事件时省略 more，含义为 false；它不表示任务结束或 deferred 正文已交付。不会因报告终态而顺带删除尚未输出的过程消息。

删除失败则本次不交付受影响的消息并报告读取失败。正常路径不保留已读消息集合或历史副本；若消费后工具回执丢失，该批过程消息和终态通知不能由 wait 重放。最终结果仍可通过 result 读取。部分消费失败不引入事务式恢复、ACK 或重试队列。

每次 wait 的 stdout 与 stderr 合计至多 8 KiB；stderr 最多 1 KiB。单条消息最多 4 KiB，普通事件含封套和必要诊断最多 7 KiB，所以它必须可在空响应中与最坏 stderr 一起交付。批次放不下的事件保持未读。若单个结果可在空响应中完整显示，只是本批空间不足，则整个终态保留未读并标 more；只有单个完整结果本身放不下时，才交付 deferred 通知并消费该通知，缓存保留。详见本文命令本文命令输出合同的精确计数和选择规则。

调用工具预算的首版技术取值和实际链路验收保留在输出合同，作为实施与维护依据；Guide 不重复 exec、续读或外层编排工具的 schema 教程。验收仍须证明 8 KiB 最大响应经过实际调用工具全链路完整可见；字节/token 比例和首尾标记不能代替验证。不能满足时不得使用该工具调用路径消费消息。Guide 说明裁剪意味着交付不完整、过程消息无法重读及最终结果的导出路径；不为此增加 ACK、历史或自动重跑。

完整结果若有 notSubmitted/unknown 投递缺口，先显示缺口数量、逐条分类、code 和父输入原文，再显示最终正文。completed 仍可带投递缺口。正常 completed 可省略 generation_started: true、backend_exit_code: 0 和 text_status: complete；失败、未知和部分正文必须显式保留影响判断的证据。内部结果数据不按显示省略规则删减。

##### result：一次取完未读消息，并读取最终结果

`result --run <handle>` 必须且只能指定一个句柄；不接受多个 --run、超时或 history。只在终态且未过期时交付完整报告：先按接收顺序输出全部未读过程消息和运行中问题通知，再输出固定最终结果。最终结果包括名称、句柄、真实终态、最终正文、未解决投递摘要及必要故障证据。名称/句柄只声明一次；尚未交付的能力按第 3 节补报。

完整报告成功输出后，删除本次全部未读消息和问题通知，并消费终态通知及对应状态/能力观察位置。此后 wait 无其他未读事件时返回 settled。仅固定最终结果可在原定 1 小时内重复读取；后续 result 不重放已经删除的过程消息，不启动模型、不续期。最终结果内的未解决投递摘要仍随结果保留；问题通知的删除不会删除这份判断最终结果所必需的证据。这不构成过程消息历史。

未终态返回 resultNotReady 并立即退出 1，不借 result 提前排空过程消息；过期返回 runExpired，资源已删除/不可用返回 runUnavailable。未知/失败任务可以读取已固定的部分正文和缺口，不能将部分结果标为完整。所有读取在取内容前检查有效期；合法取得的本次报告可完成输出，不因输出耗时延长之后的可读期限。

**默认输出。** 未加 `--export` 时，全部未读消息、固定最终结果、封套及诊断合计能完整容纳在 8 KiB 预算内才输出。否则仅返回 `code: resultTooLarge`、完整报告字节数及 `--export` 指引，退出 1；不输出部分正文、不消费任何消息或通知、不改变观察位置。即使最终正文很短，只要未读消息使完整报告超限，也按此规则处理。

**完整输出。** `result --run <handle> --export` 中的 `--export` 是无参数布尔标志，小报告也可使用。它将相同的完整报告直接写入 stdout，取消该调用的 8 KiB 显示上限；不接受目的路径，不创建、覆盖或登记输出文件。删除 `--output-file` 及其文件回执；旧参数按无效输入拒绝，在扫描、读取或消费前退出 2。主代理自行选择文件重定向、管道、其他接收工具或直接显示。报告使用相同平铺字段、条件省略和原文边界，不输出到期时间。最终正文仍最多 4 MiB、单条消息仍最多 4 KiB、stderr 仍最多 1 KiB；完整报告不设置累计消息或总输出字节上限。

**消费和失败边界。** result 在输出前完成内容可读性、边界碰撞及默认模式大小检查；大报告允许多遍流式检查，不要求一次全部装入内存。完整 stdout 写入成功后才删除消息和推进观察位置；可观察到的读取或输出失败（包括管道断开）返回非零，尚未开始消费，不报告整次成功。消费期间删除失败则返回非零并报告 `resultConsumeFailed`，未删除消息和未完成的观察位置保留；已删除内容不回滚。正常路径不保留已读集合、ACK、事务、重试队列或历史副本。异常中断或部分消费失败后的再次读取可能包含已经输出但尚未删除的消息，不能承诺跨输出与删除的 exactly-once。

脚本写入成功不证明调用工具、下游文件或其他接收端已完整保存。调用工具可能限制或裁剪输出；`--export` 不提高工具上限。主代理须在调用前选择可完整接收的路径，必要时直接将 stdout 保存或转发，再按需读取。工具裁剪或回执丢失时，已消费的过程消息无法由 result/wait 重读，只有固定最终结果仍可重读；完整保存的副本由主代理管理。工具不管理这些副本的路径、覆盖、权限、清理或下游持久化，也不随 run 过期删除它们。

### 5. send、子侧问答和结束

过程消息限于合法 UTF-8 文本；空白正文、NUL、非法编码及超限拒绝。正常传输保持原文，不 trim、不按正文去重、不执行 shell。两次相同文本是两条消息。所有界面保留已有敏感值脱敏边界；脱敏与诊断都不增加原文副本。

send 对 starting 返回 `runNotReady`，对不支持通讯的 running 返回 `communicationUnsupported`，对 closing/终态返回 `runClosed`，对过期或不可用目标给出相应错误，不改换执行器。

成功 send 显示 `delivery: queued`。它只表示写入本次待发资源；不保证后端接受或模型已处理。发送前后检查当前状态，关闭竞态无法确认交付时显示 `delivery: unknown`，不能把文件写入当作送达证明。

worker 给待发消息分配内部标识，经 v5 提交。adapter 只报告 `submitted/notSubmitted/unknown`。明确提交后删除父侧正文副本；明确未提交或未知则在 wait 中显示正文和原因，或归入终态的投递缺口。实现不得把一个不明提交自动发往另一通道。

子代理通过 `send_parent(text)` 发送；需要答复时调用有界 `receive_parent(timeoutMs)` 或等价脚本。发送不隐含问答匹配或等待，不要求 Agent 填写 ACK、replyTo、消息 ID。自动注入与显式收件由适配器同一个调度器分配，已经提交的输入不能再交给显式收件工具。

一个后端 turn 完成不必然结束 run。已经接受且明确未提交的消息可在原授权及已设置的执行期限内进入同一会话下一轮；无待处理输入则收尾。进入 closing 后不再接受新输入；迟到消息明确归类，不重开会话。子代理不能先结束任务，再期待父回复自动启动下一轮。

### 6. 最小临时存储与过期

这里保留的是本次执行及结果缓存，不提供消息历史。数据范围和期限如下。

| 数据 | 保留与删除 |
| --- | --- |
| prompt、副本、后端临时输出、子工具请求 | 只在运行及收尾期间使用；本地执行停止后删除不再需要的内容 |
| 发往子代理的正文 | 只保留待提交/未确认消息；提交成功即删，失败或未知转为有界问题通知 |
| 子代理过程消息及运行中问题通知 | 只保留待取出的内容；wait 取出或 result 完整输出后删除，不提供 history |
| 最新运行快照、状态观察序号、归属和进程证据 | 支持 wait/stop/安全删除，不保留完整状态事件日志 |
| 最终正文、终态、未解决的投递摘要、必要故障诊断 | 正常终态首次通过 wait 或 result 交付，且在 `terminalAt + 3600000 ms` 前可通过 result 重复读取；worker 失联形成的 unknown 使用首次确认失联时固定的到期时间 |

正常终态的缓存有效期从 worker 提交最终结果的时刻开始，固定 1 小时；读取和重试不续期。任务运行中不设置缓存到期时间，显式执行期限也不直接决定缓存期限。未保存终态且原 worker 已确认不存在时，以首次确认失联的时刻固定 `terminalAt`，内部到期时间为 `terminalAt + 3600000 ms`；之后的观察、结果固化和读取均复用它。

起算信息原子保存于已有的小型归属/时间元数据，与正文解析分开，不新增账本。wait/result/stop 的失联检查和普通扫描共用这一判断；扫描不读消息或拼装结果，只可在确认原 worker 不存在且尚无终态起算信息时保存一次时间。先保存起算信息，再尝试写入 unknown 缓存；缓存写入失败、缺失或损坏都不重置期限。起算信息无法安全读取或保存时报告失败并保留资源，不猜测时间。没有后续调用时，未被发现的孤立资源可能继续留存。所有这些时间只供程序使用，主代理回执和导出报告不输出 `expires_at`，也不以另一名称显示到期时间。

不提供公开 cleanup。普通 `start/send/wait/result/stop` 在操作前执行一次有限的过期扫描；help 保持只读；无效参数不触发扫描。扫描只检查当前用户、当前协议命名空间内的直属运行目录，不扫描任意临时目录，不读取消息正文，不维护全局索引或 tombstone。

删除必须同时满足：已过期、资源归属可证明、本地所属执行已停止。仍活跃或无法证明停止时保留资源和最小控制信息；TTL 不授权杀进程。过期后仍可显式 stop 这些所属执行；停止证据更新后由普通过期扫描回收资源，但 wait/result/send 不再读取正文或发送输入。过期扫描不读取强配置、不取得额外 AW_HOME 写锁。

扫描失败或权限问题只报告安全摘要，不撤销当前命令的有效结果。只读取直属目录的小型归属/时间/进程信息，不解析缓存正文；不为扫描建立额外索引或调度状态。只有可证明归属且停止的目录可以删除，foreign/shared、symlink 和无法识别的目录一律保留。

**按需清理的已接受边界：**过期会立即影响该句柄的可读性，但物理删除发生在后续脚本调用中。之后没有调用、目录受权限阻碍或进程停止无法证明时，不承诺按时删除。用户已接受此边界以避免常驻清理器。缓存丢失也不授权重新生成。

两个方向都不限制整次 run 的发送或接受条数，也不设置累计消息字节额度。单条仍最多 4096 UTF-8 字节；检查在各方向的唯一接收者执行，超限明确拒绝，不静默截断或自动拆分。已消费/已提交正文及时删除，未处理消息及未解决投递摘要按实际需要保留；不为已消费消息建立累计额度计数或历史副本。

消息数量取消上限不改变文件 I/O、通道回压和停止处理。实现按事件读取和输出，避免一次把全部消息装入内存；完整结果的投递摘要可流式读取和导出。磁盘或通道实际失败须报告，不能静默丢弃已接受输入，不能用固定累计条数或总量阈值冒充资源故障。单条大小和输出合同共同保证普通事件可独立交付。Adapter 帧与 final 的限额见协议附件，它们不等于显示限额或完整投递摘要的总量上限。

### 7. stop 与任务状态

| 状态 | 含义 |
| --- | --- |
| starting | worker 存在，尚未确认 ready；可 wait/stop |
| running | 本次任务开放；按能力允许 send |
| closing | 已停止接受新输入，正在停止/提交结果并核对本地收尾 |
| completed/failed/cancelled/unknown | 本次结果已固定；result 可在缓存有效期内反复读取，不能重新发送或续接 |

stop 发出本次停止意图并有界等待，最多 30 秒。未能确认停止时返回真实 closing/unknown 及已有证据；不把等待超时说成 cancelled。重复 stop 不创建新工作。worker 失联时只按保存的 PID、启动身份和归属证据处理剩余所属进程，不按进程名或共享进程组停止。

资源释放统一由过期扫描负责，不提供公开 cleanup 或提前删除入口。损坏的消息或最终正文不阻止过期清理，删除依据与内容解析分开；归属证据无法读取时不猜测、不扩大删除范围。删除后的句柄不可恢复，不影响已复制到父对话的结果。stop 在完成本次停止处理后再检查该目录是否已过期；满足归属与停止条件时可立即回收，未过期时仍保留最后结果。

worker 消失、后端终态不明、输出超限、协议冲突或本地收尾不明均保留 unknown。只有真实服务完成、完整非空正文、后端与 adapter 的成功退出以及本地收尾证据成立，才报告 completed。服务完成与投递缺口分别展示。远端停止未知不因本地退出而变成已取消。

**worker 失联且未保存终态。** wait/result/stop 共用同一个轻量检查：先验证运行归属；已有到期信息时检查有效期，再按 PID 和启动身份确认原 worker 是否已经不存在。若已有合法最终缓存，直接复用。若 worker 仍存活，result 仍报 resultNotReady；无法检查进程身份时返回 `runObservationFailed`（退出 1），不凭超时固化终态。

确认 worker 已不存在、没有最终缓存且按第 6 节固定的期限尚未过期时，由当前单逻辑父调用原子保存一次 `unknown` 结果，code 为 `workerLost`。该分支不启动 worker/adapter、不接管其会话，不成为后台恢复机制。只保留已经原子保存且可验证的部分正文及投递证据；没有正文则为空，并显示 `Final text was not saved.`。不读取零散日志、后端 session 或 scratch 文件拼装答案；无法证明的生成阶段为 null。仍待处理的父消息按已写入连接的证据归为 unknown，否则 notSubmitted；若连写入阶段也无法证明，一律 unknown。

这份结果沿用首次确认失联时已固定的到期时间；扫描可能早于本次 result 读取确认失联，因此不能从写入缓存或读取结果的时刻重新起算 1 小时。读取统一优先使用合法最终缓存，所以原快照即使停在 running，也不能覆盖该 unknown。父调用的消费/固化操作串行执行，不增加恢复锁或账本；缓存写入失败返回 `runStateUnavailable`（退出 1），不假装已有可重复读取的终态。

终态通知尚未被 result 消费时，首次 wait 将这次 unknown 作为未读终态变化，按第 4 节包含完整可用结果或 deferred 摘要，并推进观察位置，后续 wait 不重放。result 成功输出这份已固定的 unknown、部分正文、缺口和全部未读消息后，按第 4 节消费消息与终态通知并退出 0；再次 result 只返回固定最终结果。stop 先采用同一失联结论，再按归属证据处理仍存活的 adapter/后代；本地停止信息可更新，但不把失联结果改成完成或重跑任务。过期后只允许已有停止/清理路径，不再生成缓存。


## 操作系统与安装闭包

Windows 支持指原生 Windows 进程和文件系统上的完整 start/send/wait/result/stop 闭环。不能用 WSL、交叉编译、mock 或仅通过文件选择测试替代运行证据。实现复用仓库已有平台能力时须核对其生命周期；当前 Eval 的 Windows Job helper 只提供可参考的既有机制，不自动证明适合本次后台 worker。

| 边界 | 必须保持的行为 |
| --- | --- |
| 启动与参数 | Node 入口、所选后端 executable 及受支持的包管理器 shim 在当前系统正确解析；通过 executable 与 argv 传参。不得把 prompt、消息、路径或配置拼成 shell 命令。无法安全解析的入口在模型提交前报错，不静默换后端 |
| 后台生命周期 | start 命令退出后，获准的 worker 继续运行；wait 调用结束也不回收 worker。若使用 Windows Job，所有者和句柄生命周期绑定本次长期执行，不能因短命令退出而关闭它。宿主不允许时在提交前报告限制，不申请 breakaway 来绕过宿主约束 |
| 进程归属与停止 | 按当前 OS 取得本次 root、后代和启动身份的可靠证据。Windows 不依赖 POSIX ps、负 PID 进程组或 Unix 信号含义。只停止可证明属于本次运行的进程；PID 复用、共享浏览器及归属未知都不能扩大范围。本地停止与远端取消分别取证 |
| 路径 | 使用当前 OS 的绝对路径及类型校验；覆盖盘符、空格、中文、安装目录移动及跨盘工作目录。UNC 等路径只有满足相同归属、访问控制和写入语义时才接受，不能用字符串前缀代替边界检查。文件选择语法继续以既有 v1 为准 |
| 文本与管道 | 任务、指令、消息和结果按 UTF-8 字节处理，保留正文原有 LF/CRLF、中文和非 BMP 字符。内部协议分隔遵守 v5，程序封套使用 LF；stdin、stdout、导出不经过控制台代码页或 shell 文本管道的隐式重编码 |
| 私有资源 | POSIX 目录/文件分别使用 0700/0600；Windows 用当前用户的受保护目录与实际访问控制取得等效保密边界，mode 数字或 chmod 成功本身不构成证据。身份校验使用当前 OS 的用户与归属事实，不能把 Unix uid 设为通用前提 |
| 文件提交与回收 | 私有状态仍完整写入后原子发布；Windows 的占用或访问拒绝须明确报告，不能先删除旧状态再写入。调用者保存 --export 输出的目标不由工具管理。扫描不跟随 symlink、junction 或其他重解析链接；无法证明归属或停止时保留资源，不能因为删除失败扩大清理范围 |
| 安装闭包 | worker、adapter、工具桥接及必要的平台 helper 来自当前安装 resourceRoot 和正式依赖。按目标架构分发并校验；不要求运行时访问开发 checkout、临时下载 helper 或增加系统服务 |

这些是实现和验收约束，不要求新增全局进程账本、常驻 supervisor、锁层级或跨会话恢复协议。具体平台 API 与可复用模块由实施者在同等行为边界内选择。Windows 的启动、持续收件、停止、导出和过期回收须在实际 Windows runner 上验证，并保留所用架构及后端范围。


## 升级与验证

开发阶段直接采用 v5，不保留旧 run/poll/v4 执行器、preview 参数或结果文件旁路。result 使用无参数 --export；不接收输出目的路径。Manifest v3、Config Definition v4、Store v5、Catalog v7、installed-runtime-config v2 和 Eval instruction-v2 不联动改号。通过正常 build/sync/reinstall 更新产物；旧运行由原工具完成或停止，不扫描、接管或删除旧协议资源。

确定性验证采用 `pnpm plugin:test codex-enhance` 和 [测试指南](https://github.com/lesliechan721-arch/agent-workflow/blob/main/docs/testing.md) 的最低足够真实层级。协议、helper 和 fake 后端保护本地合同及副作用；产物测试须从实际 build/materialization 的 resourceRoot 启动 worker、adapter、脚本和 MCP 工具，保留角色资源、四个模板注入点与原生角色局部边界。不得依赖开发 checkout、宿主 node_modules 或临时下载 helper。

上文最低合同验收、8 KiB 实际工具链完整交付和 --export 完整保存分别取得证据。fake 不能关闭 Codex 自动收件、Claude 会话输入、真实后端停止、模型效果或原生 OS 的证据缺口。Windows 须在真实 Windows runner 验证，macOS/Linux 证据不外推。文案和结构自检不证明模型理解或任务效果；真实模型与 Eval 遵守 [插件维护流程](https://github.com/lesliechan721-arch/agent-workflow/blob/main/docs/plugin-maintenance.md) 的独立审核和授权要求。
