# Review Dimensions

> Canonical human rubric. `generate-standard-views.mjs` copies this file into `review-agent-skill`; do not edit the copied Skill reference manually.

## 1. 规范与包完整性（6）

检查：

- `SKILL.md`、YAML frontmatter、`name`、目录名和 `description` 是否符合当前规范。
- `compatibility`、`metadata`、`allowed-tools` 等可选字段是否有真实用途，并与目标客户端支持情况一致。
- 核心相对引用是否存在，一层可达资源是否可解析，必要脚本是否可运行。
- 包结构是否清楚，必需材料没有藏在不可发现或深链位置。
- 官方 validator 或等价静态验证是否通过。

高分：结构有效、引用完整、可选字段克制。低分：无效 frontmatter、关键引用断裂、目录/name 不一致、兼容性声明与实际依赖矛盾。

## 2. 问题基础与实际价值（8）

检查：

- Skill 是否源自真实任务、项目材料、失败 trace、运行手册或反复纠正。
- 目标问题是否可观察、可复现、可衡量；成功标准和范围外事项是否明确。
- 不加载 Skill 时模型是否会稳定出错、浪费显著成本或缺少关键领域知识。
- Skill 是否提供模型本来不知道的约定、程序、API 模式或非显然 gotcha。
- 是否有无 Skill、最小 Skill 或上一版基线用于证明增量价值。

高分：问题和收益有行为证据。低分：只写泛化常识，或无法说明为什么需要该 Skill。

## 3. 调用策略、触发条件与 Context Pointer（10）

### Invocation

仅在目标客户端支持相关机制时评估 model-invoked、user-invoked、router 或等价调用策略；客户端不支持时标为不适用，不把第三方字段当作通用规范。

检查 Skill 是否需要被模型自主发现、被其它 Skill 到达，或只应由用户手动调用；该选择是否值得其长期 context load 或人类 cognitive load。

### Description 与 Pointer

把 description 视为顶层 context pointer。对 description 及正文中的每个外部指针检查：

- 是否同时说明目标材料是什么，以及哪些真正不同的 branch 应触发读取。
- 是否先表达用户意图和最有判别力的触发信息，而不是内部实现清单。
- 同义词是否只是重复同一 branch；真正不同的 near-miss 是否被区分。
- 是否重复正文已经承担的身份信息。
- weak pointer 是否只写“详见 references”而没有到达条件。
- 必须读取的内容是否错误地藏在一个模型可能识别不到的 pointer 后。

### Trigger Eval

- 使用现实正例和 near-miss 负例，通常约 20 条，覆盖不同措辞、显式程度、复杂度和上下文。
- 每条多次运行，计算 trigger rate；固定 train/validation 划分，避免针对测试关键词过拟合。
- 检查相邻 Skill 同时触发、漏触发和误触发。

高分：调用策略合理，pointer branch 清楚，trigger 结果稳定。低分：description 只描述功能、堆砌同义词、边界过宽或没有行为测试。

## 4. 范围、边界与组合性（8）

检查：

- Skill 是否是一个连贯工作单元，而非多个不相关职责的集合。
- 授权、业务判断、领域程序、工具调用和结果生产是否分层清楚。
- 与相邻 Skill 是否重复、冲突、循环调用或同时管理同一流程。
- 是否因新 schema 字段、理论边界或一次异常扩大原始范围。
- 是否有清楚的停止、交接、失败和范围外边界。
- 拆分或合并是否真的改善触发、信息层级或执行，而不是只增加文档数量。

高分：边界清楚、可组合、不会劫持相邻任务。低分：同时承担触发、授权、runtime 状态、领域判断和所有恢复逻辑。

## 5. 程序与完成边界（10）

检查：

- 是否提供可复用方法、步骤、默认值或决策原则，而不是某个实例答案。
- 是否提供一个清楚默认值，而不是平铺等价菜单。
- 模板、例子、gotcha、checklist、validation loop 是否比抽象长文更有效。
- 指令顺序、优先级、输出合同和错误处理是否一致。

先读取最小有效控制审计的保留结论。只有 `keep-invariant` 和 `keep-default` 中需要持续跟踪的关键步骤，才执行 Completion Boundary Audit：

- **Clarity**：模型能否区分 done 与 not done。
- **Checkability**：是否可由文件、脚本、清单或明确断言验证。
- **Demand**：完成标准是否要求足够 legwork，而不是形式完成。
- **Exhaustiveness**：是否覆盖该步骤必须处理的对象。
- **Premature-completion risk**：后续步骤是否诱使模型过早结束当前工作。

不得通过增加完成条件来挽救一个不必要的步骤。先删除或放宽该步骤；只有真实 trace 显示模型仍被后续步骤牵引时，才考虑按 sequence 形成真正的上下文边界。

软性行为优先写目标行为；安全、权限和破坏性操作可以保留明确 prohibition。否定句本身不是规范缺陷，只能在 trace 支持时作为质量 finding。

高分：被证明必要的程序具有清楚且可检查的完成标准。低分：不必要步骤因完成条件完整而被保留，或大量 `must` 没有可执行程序。

## 6. 最小充分控制与模型自由度（14）

在评价现有章节组织前完成 Minimum Effective Control Audit：

1. 只根据目标问题、真实失败、硬性规范、模型无法知道的领域事实，以及脆弱或不可逆操作，写出不超过 8 条的最小行为合同。简单 Skill 可以少于 5 条。
2. 按行为块检查现有强制规则，不按段落数量机械建表。说明它改变的行为、依据和控制类型。
3. 每个行为块分类为 `keep-invariant`、`keep-default`、`relax`、`move`、`delete` 或 `needs-ablation`。
4. 不能说明删除或放宽后会增加哪种目标失败时，不得仅因规则正确、清楚或完整而保留为 mandatory。

检查控制强度是否匹配：

- 唯一合法流程、破坏性操作和硬性规范可以使用精确步骤及 prohibition。
- 有可靠默认但允许例外时，使用 default 和 escape hatch。
- 多种方案合理时，使用目标、原则和不变量。
- heuristic 应标为例子或提示，不成为完成门禁。
- 模型默认能可靠处理且没有独特领域价值的内容应删除。

记录控制面信号，包括 mandatory stages、hard gates、固定中间 artifact、prohibition、conditional branch 和固定输出字段。静态计数只提供线索，不自动形成 finding，也不按 token 数量直接判定复杂度。

评分锚点：

- **5 — 最小且充分**：每个强制规则有明确依据；可变任务保留判断空间；无法在保留核心行为时实质缩短。
- **4 — 基本适当**：主体控制合理，只有少量可删除、放宽或迁移的内容，没有明显限制正常策略。
- **3 — 正确但偏重**：多个 mandatory gate 缺少强依据，heuristic 被写成硬条件，或正文可显著缩短而不损失独特价值。
- **2 — 明显过度规定**：大量规则属于模型常识或防御性边界，开放任务被强制使用统一阶段、状态或 artifact。
- **1 — 以控制替代能力**：Skill 接近完整 runbook 或人工 SOP，模型主要执行文档而不是运用领域判断。
- **0 — 有害**：控制结构在多数目标场景中造成失败、严重漏检或无效工作。

缺少 ablation 不代表规则必然无效；使用 `needs-ablation`。但当多个强制规则的必要性未知时，本维度不能得到 4–5 分。

## 7. 信息层级、资源与渐进式披露（10）

先把内容分类：

1. **In-file step**：当前 branch 必须按序执行的动作。
2. **In-file reference**：同一文件中按需咨询的定义、规则或平坦 peer set。
3. **Disclosed reference**：只有特定 branch 才加载的外部材料。
4. **Environment lookup**：schema、配置、目录、`--help`、源码或其它现成事实源。

先检查内容是否应存在，再检查放置位置。把不必要内容移动到 reference 不能关闭最小控制 finding。

检查：

- `SKILL.md` 是否只保留每次激活都需要的步骤、核心 reference 和提前必须知道的 gotcha。
- disclosure 是否按 branch 决定，而不是只按文件大小决定。
- pointer 是否足以让模型在正确 branch 到达外部材料。
- reference 是否一层可达，避免深链和多重索引。
- 是否在平坦 reference 本来合理时机械拆分。
- 是否存在 sprawl：即便每行独特且有效，整体仍超过模型稳定关注能力。
- 拆分是否真正降低目标路径的 context load；把状态机移动到 reference 但每次都读取不算渐进式披露。
- context load 与人类 cognitive load 的取舍是否符合使用方式。
- references、assets、模板和数据是否有明确用途及到达 pointer。
- 同一概念的定义、规则和 caveat 是否 co-located，是否存在 duplication 或 scattering。
- assets 是否隐藏必须执行的指令；资源是否断裂、过期、不可达、孤立或从未使用。
- 版本化外部事实是否记录权威来源、核验日期和更新策略。

没有资源且确实无需资源可以得到高分。高分：内容先证明必要，随后放在正确 branch，每条路径只携带必要信息。低分：正文百科全书化、pointer 弱、reference 每次必读，或仅把不必要复杂度移出主文件。

## 8. 职责归属与自然语言状态机风险（10）

检查：

- Skill 是否只维护领域策略、项目约定、稳定默认值和少量不变量。
- 参数类型、枚举、必填字段和返回结构是否由 tool schema 提供。
- 真实状态、事件顺序、并发、幂等、取消和生命周期是否由 runtime 管理。
- 确定性解析、生成、转换和静态校验是否交给 script。
- role 是否只保留叶子职责、固定配置和最小输出要求。
- 尚未证实、低概率或组合爆炸边界是否留在 eval/issue。
- 是否以自然语言维护计时器、额度、pending、跨 actor 握手、乱序事件或取消/关闭竞态。

出现上述信号时读取 `references/architecture-boundaries.md`。高分：职责分层正确，复杂机制有一等能力。低分：核心正确性依赖模型记住多维状态或通过自然语言字符串维护分布式协议。

## 9. 脚本与确定性自动化（7）

评分对象是脚本决策是否正确，而不是脚本数量。

检查：

- 重复、复杂、确定、可测试的逻辑是否被脚本化。
- 不需要脚本时是否保持简单。
- 脚本是否使用 skill 根目录相对路径，并由 `SKILL.md` 清楚说明用途和调用时机。
- 是否自包含或固定依赖；非交互；支持 `--help`；错误可操作；退出码有意义。
- stdout 是否适合 agent 解析，diagnostics 是否写 stderr。
- 是否考虑幂等、输入限制、输出上限、safe defaults 和必要 dry-run。
- 是否有测试、fixture 或安全样例运行。
- 是否错误地用 shell、文件或 Git 侧信道模拟 runtime 状态。

详细检查见 `references/scripts-and-resources.md`。

## 10. Eval 设计、Oracle 有效性与修改安全（9）

存在 eval，或 eval 结果被用于评分、发布或修改 Skill 时，先消费 `audit-agent-skill-evals` 产生的 `EvalAuditResult`。先审核 suite，再使用其结果评价 Skill。

本维度只评四组内容：

1. **目标与代价**：是否声明 recall-first、precision-first、balanced 或 critical；是否分别评估 false negative 和 false positive 的现实代价。
2. **Case 与 oracle 有效性**：测试层级、unit under test、前提、oracle rationale、rule refs、observable assertion、allowed variance 和 minimal counterexample 是否成立。
3. **现实性与覆盖**：provenance、case role、scenario family、near-miss、minimal pair 和真实用户措辞是否可靠；challenge 和 diagnostic case 是否没有主导发布结论。
4. **结果与修改安全**：是否有实际运行、适用 baseline、trace、方差与成本；失败是否先归因；eval-driven 修改是否经过相邻边界和固定 validation/sanity/regression 回归。

对 trigger 或其它二元决策分别报告 positive recall、false-negative rate、negative specificity 和 false-positive rate。没有明确错误代价政策时，不把它们压缩为一个总准确率。

高分：关键 oracle 与现实性可靠，有重复运行和适用 baseline，eval-driven 修改经过净收益与回归验证。低分：错误或不现实用例、混合测试层级、少量随机结果或 challenge case 直接驱动 Skill 增加规则。

## 11. 可靠性、安全与兼容性（4）

检查：

- 环境、系统包、网络、权限和产品要求是否准确声明。
- 能力不可用时是否明确失败，而非静默降级或伪造成功。
- 外部搜索、敏感数据、凭据和副作用边界是否安全。
- 客户端特有字段是否先确认支持，不冒充通用 Agent Skills 规范。
- 声称支持的产品、版本和模型是否有验证或合理兼容策略。
- 失败时是否保留用户控制和可恢复信息。

## 12. 剪枝、事实源与变更纪律（4）

检查：

- schema、配置、目录、`--help` 或源码已经能直接回答的事实，是否仍被 Skill 低价值复制。
- 缓存外部事实时，是否只保留选择理由、稳定约定、非显然 gotcha 和更新策略。
- 每条指令是否相较默认行为产生可观察增量；不能确定时是否通过 ablation，而非凭语言直觉判 no-op。
- 共享规则是否有单一来源，避免复制到多个 role、prompt 或 reference。
- 修改是否替换或删除旧逻辑，而不是形成 sediment：历史规则只因“不敢删”永久沉积。
- delta review 是否跟踪正文、branch、资源、eval 和行为指标的净变化。
- 连续迭代中，质量提升是否超过 context、cognitive 和维护成本。

高分：当前版本已经完成删除审计，每个大行为块有边际价值证据，变更后净复杂度受控。低分：只承诺以后不增长，当前沉积未被审计；或每轮增加分支却没有行为改善。
