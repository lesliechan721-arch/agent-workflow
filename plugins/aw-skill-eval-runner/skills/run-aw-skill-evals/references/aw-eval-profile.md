# AW Skill Eval 适配说明

只在创建/审核 AW 格式资产或执行 AW 准入时读取。

## 格式基线与权威

Selected Cases 外层、Manifest、Spec/Audit/Result 的最终权威是实际安装 CLI/parser。版本不同先确认支持；只更新此 profile 和相关适配测试，不修改通用 Oracle 方法来迁就字段。

底层 provider 支持某能力，不代表外层 Selected Cases 已公开它。

调用者提供当前目标、用例、比较条件和本次授权范围；已有模型预算与使用情况一并保留。Runner 负责将这些输入落实为本次 Spec、准入与运行结果，不接管调用者的创作、评审或候选选择。通用源设计或源审核不要求先生成 AW Spec，也不因此启动模型。

## Selected Cases v1

根对象只含 `version: 1`、`suite`、`cases`。suite 使用 `kind`、`unitUnderTest`，按需带 `participants`、`policy`、`runtime`。kind 是该基线支持的 `trigger`、`conversation`、`custom-process` 或 `codex-workflow`。本文不是所有 kind 的完整 schema；未知字段用真实 parser 核验，不能靠猜。

policy 的 `optimization`、`falseNegativeCost`、`falsePositiveCost`、`rationale` 用于说明测试政策。所有 case 使用 `id`、`split`、`tags`。Trigger ID 必须小写 snake_case，split 为 train/validation/sanity；其他 kind 按其 parser。

### Trigger

使用 `input.query` 和**二选一**预期：

- `input.expectedLoad`：在观测期是否加载被测 Skill；false 不是“不是顶层 owner”。
- `input.expected.loadedSkills`：精确加载集合，不是允许集合；不得排除合法的可选辅助能力。

该外层没有 firstLoaded 字段。首次入口/组合使用能够提供实际材料与 trace 的行为测试，或等待明确实现的外层能力；不自行增加字段。

显式 `$name` 只证明请求调用，不证明加载。加载取自本次受控运行中匹配 participant、线程和目标路径的真实注入记录，或成功读取目标 SKILL.md 的事件；不由 query、expected 值、最终自述或可用列表预填。原生注入不要求再制造一次文件读取。完整且受支持的证据中未观察到加载，按未加载评分；必要观测缺失、损坏或无法可靠归属时记录 execution_error，不把它当作通过的负例。

原生 manual 调用须用真实客户端注入路径验收。伪造注入文本和 fake app-server 只适合验证拒绝或观察器行为，不能证明客户端实际加载。任务方法是否正确仍由行为 Oracle 判断。

仅 observer 已启用时使用 `shouldSpawnAgent`。workspaceFixture 需要对应 fixture 模块；其它 runtime 选项以 parser 为准。

### Conversation

case 使用 `prompt` 和非空可观察 `assertions`。按需使用：

- `input.workspaceFiles`：相对路径到真实测试内容；
- `input.scriptedReplies`：交互回复；
- `input.pathPrepend`：已存在且明确受控的 CLI fixture；
- `expected.output`、`workspaceUnchanged`、`allowedWorkspaceChanges`、`artifacts`。

需要可写工具时使用 `workspaceUnchanged: false`，并明确提供 `allowedWorkspaceChanges`。允许文件变化时，列出允许路径和至少一个实际 artifact；测试模型主动不写时使用空集合 `[]`，无需创建产物，任何最终文件变化仍判为越界。另从实际轨迹检查写入尝试，不能把写后恢复当作主动不写。`false` 选择运行环境，不赋予用户写入授权。

artifact 可用 path/exists/contains/notContains/json；路径不能越界或修改测试控制目录。空工作区不证明不存在的仓库、Spec、target 或授权状态。

### 条件 audit metadata

parser 支持四个字段：`rationale`、`minimalCounterexample`、`allowedVariance`、`errorCost`。boundary/regression 要前两项；high-cost/release-critical 要 errorCost（high/medium/low）；high-variance 要 allowedVariance。其余分析记在伴随说明，不向严格外层增加 oracle/version 等自定义键。

`evals/manifest.json` 使用 Manifest v1，profiles 与 suites 绑定 cases、kind、runs、timeout 和实际 provider 选择。字段以实际 CLI/parser 为准，未知字段按严格 parser 拒绝。

case.split 与显式 split 选择用于筛选用例；风险标签用于 Oracle 判断，Result.processManagement 记录实际进程管理证据。执行须满足 Audit、成本授权和进程管理要求。声明和格式通过不等于用例已运行；不可执行成功路径留在明确集成验收清单，不伪造 passing fixture。

Profile 的 `plugins` 选择参与插件并提供公共配置；需要区分共享 Skill 与项目产物时，使用 profile 层的 `configByScope.user` 和 `configByScope.project`，各自以已声明插件名映射配置覆盖。覆盖按顶层配置键替换，不深度合并；未提供的键继承公共配置。共享 Codex 原生 Skill 从 user 配置渲染，普通产物从 profile 的 scope 渲染。配置来自隔离准备输入，不读取真实用户 store；作用域配置变化后重新核验来源绑定和 Eval 输入。

## 格式辅助检查

没有可直接导入的官方 parser、且不需要构建或物化时，可用随包离线工具 `scripts/validate-eval-cases.mjs` 做基线字段子集检查：`node <实际脚本路径> <cases.json> --strict --format json`。它只需 Node 和显式输入；`--strict` 额外要求声明测试政策，不是引擎新增准入条件。辅助通过不证明完整格式或 Oracle 正确。环境已提供 `@lesliechan721/agent-skill-eval` 时，采用其公开 `parseSelectedCases`；正式 prepare 和 Spec 验证始终以官方 parser/validator 为准，不把 PATH 中存在 CLI 当成脚本可导入其依赖。

## 正式 Spec/Audit/Result

本节提供独立 Auditor 所需的格式与绑定依据；准备、复用 Audit、交接和停止点由 Runner 主入口（`SKILL.md`） 负责。只读源审核不要求 Spec，也不产生机器 pass。

`aw-skill-eval spec validate <spec.json>` 的成功 receipt 提供 workspace、provider、current/optional previous target、case digest 和 selected cases 的绑定事实。使用实际 receipt 值，providerDigest 取其 `calculated.providerDigest`，不自行实现摘要算法。

Audit 模板（`assets/eval-audit-template.json`） 是 **EvalAudit v1 形状样例**，全零 digest 与空批准集合不是证据。执行准入要求 Audit 与上述身份精确绑定，覆盖全部 selected cases，且 `status=pass`、没有 blocked case；用 `aw-skill-eval audit validate <audit.json> --spec <spec.json>` 核验，要求零退出且 `valid=true`。case、target 或必要身份变化后重新验证，source 审核结论不替代候选绑定。

`EvalResult v2` 使用对应输入执行 `aw-skill-eval result validate <result.json> --spec <spec.json> --audit <audit.json>`。验证通过只证明机器绑定；Oracle 和结果的语义判断归 Auditor。

格式、状态值与身份算法由 CLI/parser 拥有，模板保留在本插件。成本授权与 Audit 分别成立；实际执行和失败处理采用 执行与安全（`references/execution-and-safety.md`）。
