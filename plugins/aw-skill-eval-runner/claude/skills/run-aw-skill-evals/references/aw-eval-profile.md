# AW Skill Eval 适配说明

只在创建/审核 AW 格式资产或执行 AW 准入时读取。

## 格式基线与权威

Selected Cases 外层、Manifest、Spec/Audit/Result 的最终权威是实际安装 CLI/parser。版本不同先确认支持；只更新此 profile 和相关适配测试，不修改通用 Oracle 方法来迁就字段。

底层 provider 支持某能力，不代表外层 Selected Cases 已公开它。

Author 的完整开发分支可在有效授权和预算内交接实际候选与用例。交接保留当前产物、比较条件、已用预算和修复后的重验目标；本 Runner 仍负责准备、准入和执行，结果返回该次真实候选。通用源设计或源审核不要求先生成 AW Spec，也不因此启动模型。

## Selected Cases v1

根对象只含 `version: 1`、`suite`、`cases`。suite 使用 `kind`、`unitUnderTest`，按需带 `participants`、`policy`、`runtime`。kind 是该基线支持的 `trigger`、`conversation`、`custom-process` 或 `codex-workflow`。本文不是所有 kind 的完整 schema；未知字段用真实 parser 核验，不能靠猜。

policy 的 `optimization`、`falseNegativeCost`、`falsePositiveCost`、`rationale` 用于说明测试政策。所有 case 使用 `id`、`split`、`tags`。Trigger ID 必须小写 snake_case，split 为 train/validation/sanity；其他 kind 按其 parser。

### Trigger

使用 `input.query` 和**二选一**预期：

- `input.expectedLoad`：在观测期是否加载被测 Skill；false 不是“不是顶层 owner”。
- `input.expected.loadedSkills`：精确加载集合，不是允许集合；不得排除合法的可选辅助能力。

该外层没有 firstLoaded 字段。首次入口/组合使用能够提供实际材料与 trace 的行为测试，或等待明确实现的外层能力；不自行增加字段。原生 manual 宏必须用真实注入路径验收，文本出现 `$name` 不能独自证明宏已注入。

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

保留基线 parser 的四个字段：`rationale`、`minimalCounterexample`、`allowedVariance`、`errorCost`。boundary/regression 要前两项；high-cost/release-critical 要 errorCost（high/medium/low）；high-variance 要 allowedVariance。其余分析记在伴随说明，不向严格外层增加 oracle/version 等自定义键。

`evals/manifest.json` 使用当前 Manifest v1：profiles 与 suites 绑定 cases、kind、runs、timeout、requiredForRelease 和 releaseSplits。测试被标必需不等于已经运行；不可执行成功路径留在明确集成验收清单，不伪造 passing fixture。

Profile 的 `plugins` 选择参与插件并提供公共配置；需要区分共享 Skill 与项目产物时，使用 profile 层的 `configByScope.user` 和 `configByScope.project`，各自以已声明插件名映射配置覆盖。覆盖按顶层配置键替换，不深度合并；未提供的键继承公共配置。共享 Codex 原生 Skill 从 user 配置渲染，普通产物从 profile 的 scope 渲染。配置来自隔离准备输入，不读取真实用户 store；作用域配置变化后重新核验来源绑定和 Eval 输入。

## 格式辅助检查

本 Skill 携带 `scripts/validate-eval-cases.mjs`，只检查基线字段子集；运行方式：`node <实际脚本路径> <cases.json> --strict --format json`。它是 AW profile 辅助工具，不是通用格式标准、不证明 Oracle 正确，也不替代官方 parser。项目确定性测试使用当前 `@lesliechan721/agent-skill-eval` 的公开 `parseSelectedCases` 核验格式，不依赖草案交付目录中的工具。

## 正式 Spec/Audit/Result

Runner 准备或验证 Spec；其 receipt 固定 workspace/provider/current/previous target/case digest 和 selected cases。只读源审核不要求 Spec，也不产生机器 pass。

Runner 复用精确绑定的有效 Audit；否则在独立上下文使用 `audit-agent-skill-evals`，提供：已验证 Spec、selected cases、相关 fixture、**本 profile 的实际路径**、所需 Audit 输出路径及当前 CLI 验证命令。不能只传一句“使用 Auditor”却省略专属合同。

`assets/eval-audit-template.json` 是消费者要求的 **EvalAudit v1 形状样例**。全零 digest/空批准集合不是证据；从 validated receipt 取得实际值。以当前 `aw-skill-eval audit validate <audit> --spec <spec>` 核验；case、target 或必要身份变化后重新验证，source 审核结论不替代候选绑定。

Audit 的通用语义判断归 Auditor；格式、状态值、身份算法、验证和执行门禁归 CLI/Runner。消费者模板不搬回通用插件。成本授权与 Audit 是不同条件；执行和失败处理继续使用 `references/execution-and-safety.md`，不在此重复。
