# Codex Enhance 外部适配器实现

本文件面向插件维护者和自定义适配器作者，定义外部执行配置、Adapter v4 和验证边界。普通调用见 [外部委派说明](references/external-delegation.md) 和 [文件选择用法](references/file-selection.md)，无需读取本文。本文不证明任何后端、模型或操作系统已经完成真实运行验证。

按需进入：[配置](#配置呈现与生效) · [Adapter 输入](#adapter-v4-输入) · [文件选择与公共解析器](#文件选择与公共解析器) · [结果](#adapter-v4-结果) · [验证](#升级与验证)。

## 职责与源码入口

```text
调用方选择 profile，提供 prompt、可选指令及 bundle 选择
  → subagent.mjs 读取当前安装生效配置
  → selectExecution 解析精确执行器与 mode
  → workspace 拒绝 --file；bundle 保留 fileSelectors 并提供 fileResolver
  → prepareRun 形成单个 prompt 和模式正确的请求
  → runForeground 启动一个前台 adapter
  → adapter 按需调用公共解析器，或使用后端原生选择，再组织输入、取得终态、写私有结果
  → runner 核对结果与本地收尾，输出文字并清理自有资源
```

| 入口 | 责任 |
| --- | --- |
| [subagent.mjs](scripts/subagent.mjs) | 参数、安装 reader、文字输出与退出码。 |
| [plan.mjs](scripts/runtime/plan.mjs) | 精确 profile 选择、内建/custom 入口、模式及参数解析；不按咨询或调查名称写业务分支。 |
| [files.mjs](scripts/runtime/files.mjs) | 有界 UTF-8、文件路径和私有结果读取；材料正文不由通用 runner 预读。 |
| 公共 `scripts/resolve-files.mjs` | 供 bundle 适配器按需调用，输入明确 workspace/selectors，返回字面绝对 files；完整接口见 [公共解析命令合同](#公共解析命令合同)，不由 runner 自动执行。 |
| [runner.mjs](scripts/runtime/runner.mjs) | 本次输入、环境、前台调用、分类和临时资源。 |
| [processes.mjs](scripts/runtime/processes.mjs) | 本次可证明归属的进程观察和停止。 |
| [contracts.mjs](scripts/runtime/contracts.mjs) | 有界输入/输出、结果、错误和脱敏。 |
| 内建后端入口 | Codex、Claude Code、Oracle 的最小调用及真实结果映射；路径由安装资源解析。 |

Guide 不拥有上游业务角色。profile 只选择 executor、model 和 reasoningEffort；角色与任务约束来自本次 prompt 或明确提供的指令文件。调用方没有提供指令文件时，不根据 profile 名称、文件名或执行器补读默认角色。

## 配置、呈现与生效

配置声明由 [plugin manifest](../../.agents-plugin/plugin.json) 拥有。subagentCommands 每项具有 key、title、adapter；key 大小写敏感、唯一，native 为保留值。profile.executor 精确引用 key，省略 executor 仍按 native 解释。

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
  "advisorProfile": { "executor": "oracle-review" },
  "subagentCommands": [
    { "key": "codex-local", "title": "本地 Codex", "adapter": "codex" },
    { "key": "claude-local", "title": "本地 Claude Code", "adapter": "claude-code" },
    {
      "key": "oracle-review",
      "title": "Oracle 咨询",
      "adapter": "oracle",
      "args": ["--engine", "api"],
      "envFrom": { "OPENAI_API_KEY": "REVIEW_OPENAI_API_KEY" }
    },
    {
      "key": "custom-review",
      "title": "自定义服务",
      "adapter": "custom",
      "mode": "bundle",
      "command": "/absolute/path/to/node",
      "entrypoint": "/absolute/path/to/custom-adapter.mjs",
      "args": ["--region", "example-region"]
    }
  ]
}
```

这是字段值示例，不是完整 store。外部 profile 的 model/effort 可省略，实际选择优先级是本次显式覆盖、profile、后端默认；省略不生成空参数。native 保持已有必填要求。非法配置或不可用执行器不触发换后端或近似模型替换。

Config Definition v4 的有限对象分支、标量 const 和叶级数组/KV 由 Core 统一实现，CLI、TUI、生效值与物化共用。Manifest v3、Store v5、Catalog v7 和 installed-runtime-config v2 不联动改号。正式字段合同见 [架构说明](../../../../docs/architecture.md)，作者维护入口见 [插件维护指南](../../../../docs/plugin-maintenance.md)。

renderer 只在 Guide 的 external-delegation 中生成执行器表，显示 key、名称、adapter、mode；不再展示能力布尔值，不把表塞进所有 Skill 或角色。profile 表对外部省略的 model/effort 显示“后端默认”；native 不补造这样的缺省配置。Advisor 仍只显示已配置的选项。

AW 注入 `.aw-runtime-config.json` 和 `scripts/aw-runtime-config.mjs`；插件不伪造或覆盖保留资源。reader 从本产物返回 installedIdentity、获准的 effectiveValues 和 resourceRoot，不读最新 store 或同名 sibling。保存未 apply 时新调用继续用旧安装资源，活跃调用也不重读配置换后端。缺失或损坏通过正常 sync/reinstall 恢复。

## Prompt 与模式

CLI 只有 --profile 和 --prompt 必填。任务可用 --prompt TEXT 或 --prompt -；stdin 读到 EOF，拒绝 TTY、空白、非法 UTF-8、重复 prompt 和超限。--instructions-file PATH 可选；相对路径相对调用 cwd，与 --workspace 的文件选择基准分开。

不传指令文件时，协议 prompt 保留任务原文，不添加默认指令或空标题。显式传入时要求非空、可读 UTF-8 文件，runner 读取一次后组合为“执行指令”和“本次任务”两个段落。保留原文本，不截断，不向 adapter 发送指令文件路径让它再次打开。显式坏文件不能当成省略。指令与任务各最多 256 KiB，组合结果不套用单份上限。

所有适配器都消费一个 prompt，不需要独立 instruction channel 能力声明。提示词拼接不提供 system/developer 权限，不代替业务授权或技术隔离。native 的角色通道不受影响。

workspace 只提供工作目录和任务，CLI 出现任何 --file 均在扫描和适配器启动前失败，code 为 filesNotAllowedInWorkspace，退出 2；包括 --file ''。关注文件写进 prompt，不能作为隐藏的材料参数传递。

bundle 提供 fileSelectors 原值数组和 fileResolver 命令描述。runner 只校验输入形状、NUL 与空选择项，不展开、不读取材料元数据或 ignore 文件。无 --file 则 []，不隐式增加材料。需要路径的适配器可调用公共解析器；原生消费必须符合相同的 AW 文件选择协议 v1。Oracle 在符合协议时直接消费原值，不调用 helper 或构建投影。完整协议与失败处理见 [文件选择与公共解析器](#文件选择与公共解析器)。

## Adapter v4 输入

runner 使用 shell:false、detached:false 启动一个前台 adapter。custom 的 argv 只有可选 entrypoint；内建 wrapper 使用本次 Node 和本产物入口。实际服务的定制 args 放入请求，不误当作 Node/wrapper 参数。

stdin 是一个 UTF-8 JSON 对象，然后 EOF。共同必填字段是 protocolVersion、execution、mode、workspace、prompt、args。execution 含 profile 和 executor；只有显式解析到的 model/reasoningEffort 才出现。环境值不放入 JSON。

bundle 请求：

```json
{
  "protocolVersion": 4,
  "execution": { "profile": "advisorProfile", "executor": "custom-review" },
  "mode": "bundle",
  "workspace": "/absolute/project",
  "prompt": "核对错误恢复方案，给出依据，不修改项目。",
  "fileSelectors": ["docs/design.md", "src/**/*.ts", "!**/*.test.ts"],
  "fileResolver": {
    "command": "/absolute/path/to/node",
    "args": ["/absolute/installed/guide/scripts/resolve-files.mjs"]
  },
  "args": ["--region", "example-region"]
}
```

workspace 请求：

```json
{
  "protocolVersion": 4,
  "execution": { "profile": "generalTaskProfile", "executor": "codex-local" },
  "mode": "workspace",
  "workspace": "/absolute/project",
  "prompt": "检查 src/main.ts 的错误处理；不要修改项目。",
  "args": []
}
```

fileSelectors 和 fileResolver 仅 bundle 必填；fileSelectors: [] 合法，提供 fileResolver 不等于必须调用。workspace 中两个字段都必须不存在，带空数组也拒绝；旧草案的 files 请求字段不再接受。fileSelectors 按 CLI 原值保留顺序、空格、逗号、重复和匹配字符，不是已展开文件列表。没有 access、instructions、task、materials.content、instructionChannel 或 supports 声明。

adapter 一次读取请求，不从 AW store 重新解析配置。两种 mode 均以真实绝对 workspace 为 cwd；bundle 不因此取得项目写入授权，也不是 OS 隔离。调用内固定的是 prompt、配置、原始选择式和解析器入口；集合在实际消费方解析时确定，内容在打开时确定。

## 文件选择与公共解析器

本节面向适配器作者，维护所有 bundle 适配器共用的固定选择协议、公共命令输入输出及接入要求。调用模型填写参数时只需 [文件选择用法](references/file-selection.md)。

### 固定选择协议与两种实现路径

AW 文件选择协议 v1 适用于所有 Adapter v4 bundle 执行器，包括公共 helper、custom 和内建 Oracle。在同一平台、同一 workspace、相同原始选择式及同一稳定可读文件树上，各实现必须得到相同的规范化路径集合。调用方不选择后端专属语义；路径排序只约束 helper 的输出，不强制后端采用相同打包顺序。

runner 保留重复 --file 的原值并提供 fileResolver，不展开文件。适配器可调用公共 helper，也可使用符合本节规则的原生选择能力；这是实现自由，不是语义自由。Oracle 原值透传必须符合本协议，不能仅凭名称或版本自报兼容。文件格式、读取和上传限制可导致明确失败，不能让成功结果静默少选文件。

v1 固化既有 Oracle 0.21.4 选择阶段，并保留 AW 已有的空输入校验、字面路径输出和显式错误要求。Adapter v4 固定绑定该语义，helper 的 protocolVersion: 1 同时绑定本节选择规则与 JSON 形状；不新增解析策略字段、版本白名单、运行账本或每次调用的双解析。后端更新不自动改写 v1。

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

protocolVersion 必须为 1；workspace 必须为现存的真实绝对目录，不能使用缺省 cwd 替代缺失字段；selectors 必须为字符串数组，使用上述选择值校验。适配器传入本次请求的 workspace 与 fileSelectors，不自行改写成另一份选择。该 helper 的版本同时固定本节 v1 选择语义与命令输入输出；Adapter v4 已绑定该语义，不新增另一个请求字段，不改变 installed-runtime-config v2 或 Eval 协议。

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
  "message": "文件选择没有匹配结果；请检查正向选择和排除条件。"
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

需要路径的适配器在模型提交前启动 helper，等待进程结束并验证退出码、JSON 版本、结果形状及读取限值。成功后读取 files；helper 非零、非法结果、读取超限或入口缺失时，不启动模型，不切换原生选择作为回退。已确认未提交且本地收尾完成时写 Adapter v4 failed、generationStarted=false；外层 runner 退出 1，不把 helper 的退出 2 直接冒充 runner 输入错误。收尾不明仍按原协议使用 unknown。

helper 属于当前 adapter 的前台子进程，纳入现有 deadline、取消和进程归属处理。取消/超时后先确认停止，不遗留后台解析器；不增加 supervisor 或持久运行账本。入口或依赖缺失通过当前产物的 sync/reinstall 修复，不偷用其它安装来源。选择输入错误由调用方修正，新的模型提交仍需符合本次授权和预算。

内建 Oracle 不走 helper：直接将每个原始选择式传给一个 --file 选项；无选择式则不加文件参数。args 不能另加 --file/-f 或文件选择别名。特殊名称按固定 v1 规则处理，原生路径须有相应一致性证据；原始选择式过多或过长导致 argv 无法传递时明确失败，不生成投影、不截断、不拆成多次模型请求。

独立查看当前协议选择集合时可调用本节公共命令；它不冻结后续文件树，也不证明材料已送入模型。所有消费方仍须遵守相同选择规则。入口及依赖由同一安装产物提供，不引用宿主 Oracle 私有模块或开发仓库 node_modules。

## 参数和环境

args 中每项是一个真实后端 argv 值，不执行 shell split、变量插值或 shell。空字符串 argv 合法，NUL 非法。后端入口按最终 PATH 解析；不自动下载，不使用 Codex 专属 binary 环境变量替代通用配置。

内建 wrapper 拥有启动子命令、prompt stdin、工作目录、结构化输出、私有结果路径、bundle 文件输入和等待参数。args 与这些控制项冲突时明确拒绝，包括公开别名；不得让 args 把调用变成帮助、预览、仅入队、续接其它会话或多次生成。Oracle 的 --file/-f 及文件选择别名也不能通过 args 在 fileSelectors 之外追加来源。

profile/CLI 已解析 model 或 effort 时，args 不能再次设置同一后端控制项；没有解析值时，args 可以设置或沿用后端默认。检查只覆盖 wrapper 拥有的参数，不复制完整后端 parser 或建立通用功能黑名单。显式不支持的参数报告真实错误，不忽略或重试其它模型。

保留后端正常配置、权限、项目指令、hooks、插件、MCP 和工具。wrapper 不自动设置只读、关闭工具或绕过审批；用户显式 args 仍必须在本次授权内。后端自己的权限与任务授权不是一回事。

环境处理顺序：捕获原宿主环境，排除 AW 内部上下文和本次控制项；从原宿主快照解析 envFrom；合并 env 与 envFrom；最后注入 runner 控制值。同一目标键同时出现在 env 和 envFrom 时拒绝。来源不存在时报错，存在但为空保留空值；不支持链式引用或 ${...} 替换。

变量名为 `[A-Za-z_][A-Za-z0-9_]*`，值不得包含 NUL。env 只保存普通字面值，不能保存密钥。envFrom 只存来源名；解析后的秘密不进入安装资源、stdin JSON、执行器表或 preview。继承其余普通宿主环境及后端认证设置，最终环境通过 spawn.env 交给 adapter，再按实际后端接口使用。

`AW_PLUGIN_CONTEXT`、`AW_PLUGIN_*` 作者上下文、`AW_SUBAGENT_*` 运行控制项不能借 env/envFrom 注入。`AW_SUBAGENT_TEMP_DIR`、`AW_SUBAGENT_RESULT_FILE` 和进程归属标记由 runner 设置；现有 Eval 进程标记按原合同继承但不可覆盖。诊断脱敏已解析 envFrom 值及可识别凭据，不输出完整 env 或请求。受信任适配器可能读取宿主凭据，环境过滤不构成隔离。

## 内建后端

Codex 固定 workspace。使用 `codex exec --json --output-last-message <private-path> ... -`，prompt 经 stdin，cwd 为 workspace。model/effort 仅在明确设置时通过支持的官方参数传入。核对本次实际终态和最终消息；不锁精确版本、不扫描用户配置来证明隔离，不默认添加 ephemeral、只读、approval never 或禁用项目指令/工具的参数。

Claude Code 固定 workspace。使用 `claude --print --output-format json ...`，prompt 经 stdin。读取最终 result、错误状态和进程退出，不把内部 JSON 外壳当作面向调用模型的回答。不自动添加 bare、权限模式、工具关闭或审批绕过参数。

Oracle 固定 bundle。使用 `oracle --prompt - --wait --write-output <private-path> ...`。API/browser 由配置或 args 决定，不自动切换；effort 仅映射实际支持的引擎，不把 API effort 猜成 browser thinking time。本机参考实现会 trim stdin 外围空白，这不是所有版本保证；只使用公开 CLI，不 import Oracle 私有模块。

Oracle 将 fileSelectors 的每个原值作为一个 --file 选项值，以 workspace 为 cwd 调用；空数组不加文件参数。不预先拆逗号、排序、去重、展开路径或调用公共 helper，不构建 AW 材料投影。特殊名称、目录、排除和 glob 必须符合固定 v1；原生实现不符时由 adapter 适配或拒绝。不能把原始选择式误当作字面路径数组。

短 glob 避免把大匹配集合展开成 argv，但很多或很长的原始选择式仍可能超限。无法表达或启动失败时明确报告，不截断、不构建投影、不拆成多次模型提交。文件大小、类型和上传限制由实际后端处理；实际选择/内容错误依据后端证据映射。无法确认是否已提交或远端是否停止时用 unknown，不只凭非零退出声称未生成。

后端可执行文件缺失、必要接口不支持、认证或模型错误都按真实结果报告。可记录实际版本用于诊断，不根据精确版本字符串判断全部资格。各后端自己的 Node/平台要求由其实际安装和启动错误说明，AW 不自动升级运行环境。

## Adapter v4 结果

runner 创建本次私有临时目录并设置结果文件路径。adapter 把结果写到 AW_SUBAGENT_RESULT_FILE，使用同目录临时文件再 rename；目录和文件沿用 0700/0600。stdout/stderr 是有界诊断，不代替结果。

```json
{
  "protocolVersion": 4,
  "state": "completed",
  "generationStarted": true,
  "backendExitCode": 0,
  "text": "本次实际后端的完整最终回答。"
}
```

上述字段必填。state 是 completed、failed、cancelled 或 unknown。generationStarted 是 true、false 或 null；只有确认尚未生成时才能写 false。backendExitCode 为整数或 null，text 为字符串，非成功时可为空。可选 code、message、sessionId、model、remoteStopConfirmed 必须有实际证据。不再重复 service.state 或指令/访问能力自述。

| 状态 | 最低成立条件 |
| --- | --- |
| completed | adapter 验证本次实际服务终态和完整非空回答；generationStarted=true；后端和 adapter 均退出 0；runner 确认本地收尾；无中断或超限。 |
| failed | 已确认提交前失败或实际服务失败，没有仍可能活跃的冲突；保留已知提交阶段。 |
| cancelled | 本次确有停止请求，本地收尾已确认；已经提交时还需适用的服务停止确认。 |
| unknown | 结果缺失/非法、终态冲突、可能提交但终态不明、输出超限、本地收尾不明或远端停止未知。 |

adapter 对真实后端的终态映射负责。退出码、非空文本或自述 event 字符串不能单独证明服务成功。runner 核对结构、限值、adapter 退出和进程收尾，不把这些局部证据外推为任意后端真实性证明。

保留 30 分钟执行 deadline、4 MiB 最终正文、8 MiB 诊断和 32 MiB 结果文件上限。路径输入与元数据选择也要有明确的读取/取消边界；材料正文大小由实际后端处理，不恢复旧的通用 128 文件/1 MiB/8 MiB 材料限制。任何超限都不能以截断后的 completed 掩盖。

## 面向调用模型的输出

公开格式为文字，不提供过渡性 --json。成功时一行状态头加完整 Markdown 回答；UNKNOWN 先给“不自动重提”提示，再给标注的部分结果。状态头不重复 prompt、env、完整 argv 或事件日志。正文中的业务状态与服务调用状态分开。

--preview 读取任务、可选指令、配置并校验输入形状；bundle 只显示原始选择式及“未解析”，不调用 helper、adapter 或后端，不检查匹配文件，不显示实际文件数/清单或未经计算的 token。workspace 无文件筛选区。选择式数量与文件数量必须区分；长选择式可在显示层明确省略并报数，不能裁减协议输入。环境只显示变量名和引用来源。preview 不冻结后续 run，也不证明材料可读或可上传。

退出码 0=completed/preview/help，1=其它运行结果，2=无效输入。启动前输入错误进入 stderr 文本；已启动运行在 stdout 给出状态和可用正文，stderr 只保留有界、脱敏且必要的诊断。不得在本地收尾尚未确定时先输出完成状态。

## 前台生命周期与恢复

一次 run 只启动一个前台、非 detached adapter。“一次提交”约束 AW 重复启动同一任务，不限制外部后端在任务授权、范围和预算内的正常工具调用、多步推理或内部协作。宿主等待窗口结束后继续同一 session，不改解析后的配置、重复生成、换后端、force 或 resume。新有界追问是另一项生成，不是取回原结果。

runner 复用现有进程观察与归属机制，只停止本次可证明归属的 child 及后代；不按进程名停止共享浏览器。exit 与管道 close 分开观察，后代持管道或停止不明时有界收尾并报告 unknown。关闭本地管道不证明远端停止。

正常结束且本地收尾已确认后删除本次自有临时输入和结果资源；本方案不新增材料投影。无法确认时保留并说明实际位置，不扫描或删除来源不明目录。后端自己的 session/browser 状态不是 AW 的恢复账本；宿主崩溃或 session 丢失不承诺继续、恢复或远端取消。

## 升级与验证

外部 Adapter v3 直接切换到 v4，不保留双轨。旧 access、capability flags、prompt-file 和 v3 请求/结果明确不支持；旧注册项必须显式选择 adapter，不从路径猜测内建类型。installed-runtime-config 保持 v2，Eval instruction-v2 不改变。更新配置后通过正常 build/sync/reinstall 更新资源；升级前由原工具处理已知旧调用，不接管或删除旧 run store。

确定性验证使用 `pnpm plugin:test codex-enhance` 及 [仓库测试指南](../../../../docs/testing.md) 对应层级。覆盖可选指令、workspace 拒绝所有文件字段、原始选择式保真、preview 不扫描、实际 argv/stdin/env/cwd、helper 失败不提交、纯文字输出、一次生成及自有资源清理。公共 helper、custom 与 Oracle 实际选择路径对同一合成树和选择式验证 v1 的同一预期集合及失败边界；custom 从真实物化产物调用给定入口。Oracle 另用 fixture 验证原值透传、helper 调用与 AW 材料投影创建计数为 0；已知不符合协议时不提交模型。新解析器与完整 runtime closure 都须真实验证，不依赖本机 Oracle 私有路径。

fake 后端只证明本地协议与副作用。Codex、Claude、Oracle API/browser 的真实服务终态、模型能力与不同操作系统支持须分别验证，未执行时明确保留缺口。真实模型和 Eval 遵守 [插件维护流程](../../../../docs/plugin-maintenance.md) 的授权及独立审核要求，不能由离线测试或作者自查替代。
