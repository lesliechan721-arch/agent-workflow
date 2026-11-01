# 适配器文件选择

[适配器文档索引](README.md)

## 文件选择与公共解析器

本节面向适配器作者，维护所有 bundle 适配器共用的固定选择协议、公共命令输入输出及接入要求。调用模型填写参数时只需 [文件选择用法](../references/file-selection.md)。

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
