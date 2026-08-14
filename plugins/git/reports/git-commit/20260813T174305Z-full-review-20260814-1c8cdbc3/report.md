# git-commit Skill 完整评审报告

## 结论

- **Skill：** git-commit
- **模式：** full
- **方向：** aligned
- **复杂度：** proportionate
- **可缩减程度：** minor
- **发布结论：** pass-after-fixes
- **加权总分：** 89.8 / 100
- **原始质量带：** strong
- **有效质量带：** strong
- **覆盖率：** 100%
- **置信度：** high（0.90）
- **一句话结论：** Skill 正文、触发边界和八个行为场景的实际结果均符合目标；当前阻断项是 release grader 对三种正确输出产生 false negative。

正式 eval 批次：20260813T174305Z-full-review-20260814-1c8cdbc3。模型运行：20260813T174436Z-ddf12068。

## 评审合同

| 项目 | 从材料提取的结论 | 状态 |
| --- | --- | --- |
| 目标问题 | 按用户授权创建一个新的本地 commit，同时保护范围外 index、worktree 和历史 | known |
| 已观察失败 | behavior 机械结果 5/8；三项失败经 trace 和仓库状态裁决为 grader false negative | known |
| 成功标准 | 精确范围、正常 hooks、一个新 commit、准确 message、提交后或失败后的实际状态报告 | known |
| 目标环境或客户端 | AW Codex project/user materialization；Codex 模型 eval；Codex 与 Claude 确定性插件测试 | known |
| 范围外事项 | message-only、查看或暂存-only、push-only、merge、amend、rebase、cherry-pick、revert、tag | known |
| 相邻 Skill | reconciling-git-merges、isolating-work-with-git-worktrees | known |
| 发布要求 | project/user materialization、validation trigger 和八个 behavior cases 在同一批次完成 | known |

## 发布门禁

| Gate ID | 状态 | 严重性 | Finding IDs | 证据 | 原因 |
| --- | --- | --- | --- | --- | --- |
| package-validity | pass | P0 | — | validator、static inspector、双 scope materialization | 包和最终制品有效 |
| critical-artifacts | pass | P0 | — | Skill、metadata、manifest、corpora、runner | 所有声明 artifact 存在并已检查 |
| goal-alignment | pass | P0 | — | Skill 正文和八个 current traces | 只创建授权的本地 commit |
| capability-validity | pass | P0 | — | 普通 Git status、diff、add、commit、show | 无不存在或不受支持的能力 |
| safety-permissions | pass | P0 | — | 精确暂存、hooks、冲突停止、no-push | 安全边界明确且已观察 |
| architecture-ownership | pass | P1 | — | state-machine risk low | Git 保存状态，Skill 只保存策略 |
| release-evidence | fail | P1 | F-GC-001 | required batch 完整但 behavior 机械失败 | 三个正确输出被 grader 拒绝 |
| eval-validity | fail | P1 | F-GC-001 | message 和 failure-report assertions | oracle 对允许措辞和分组过窄 |
| eval-change-safety | not_applicable | P1 | — | 本轮没有修改 Skill 或 eval | 无 eval-driven change |

## 优点

- validation split 8/8 cases、24/24 decisions 通过。正例 recall 100%，反例 specificity 100%，没有 multiple load。
- 八个 current 行为 trace 的仓库语义均正确。范围外 staged/unstaged 内容得到保留，hook 拒绝后 HEAD 和 index 状态正确，merge-in-progress 场景没有被误提交。
- conflict_or_operation_in_progress 中，current 正确停止；owner-removed baseline 反而选择单边内容并创建 merge commit。这是明确的安全增量价值。
- 正文只有三步执行流程和一个 message 小节。没有 runtime script、reference sprawl 或自然语言状态机。
- project 和 user materialization 内容一致；Codex 与 Claude 的确定性插件测试均通过。

## 必须修复的问题

| ID | 严重性 | 证据类型 | 维度 | 位置 | 受影响场景 | 证据 | 反证检查 | 正确 owner | 最小修改 | 验证方式 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| F-GC-001 | P1 | observed, structural | scripts | skills/git-commit/evals/run-commit-evals.mjs:435-536 | 三个正确行为被计为失败，正式 behavior 结果不能用于发布判断 | detailed body 的三条事实被强制要求为两种固定分组；修改 requested 文件不接受动词“修改”；hook failure 的准确状态报告不接受当前措辞。三项仓库状态断言均通过 | 五个其它 behavior case 和全部 trigger case 通过；手写 accepted-string 单测通过，但未覆盖实际输出 | Script | 让 grader 基于 fixture facts 和状态语义接受合理分组、等价中文动词与状态表述；加入三份实际输出作正回归 | 先跑 deterministic grader tests，再在同一批次重跑八个 behavior case；正确 current 全通过，unsupported claim 和错误状态负例仍失败 |

## 非阻断问题

没有独立 P2。缺失证据保留为 Unknown，不转换成 finding。

## 未知项

| ID | 维度 | 描述 | 所需证据 |
| --- | --- | --- | --- |
| U-GC-001 | problem_value | 没有生产 trace 或使用分布说明这些失败模式的真实频率 | 收集不含仓库内容的匿名 activation 和 failure category |
| U-GC-002 | minimum_control | 没有 ablation 单独证明 2–4 条 body 规则的最小价值 | 对比当前、短 message 指导和 owner-removed 变体 |
| U-GC-003 | evals | trigger corpus 缺少严格审计要求的 suite policy 和 per-case admission metadata | 补齐 schema 字段并通过 strict validation |
| U-GC-004 | reliability | Claude 只有包级兼容证据，没有模型行为证据 | 仅在声明跨模型行为等价时运行修正后的 Claude suite |

## 维度评分

| 维度 | 权重 | 分数 | 置信度 | 证据 | Finding IDs | Unknown IDs | 结论 |
| --- | ---: | ---: | --- | --- | --- | --- | --- |
| 规范与包完整性 | 6 | 5 | high | validator、materialization、static inspector | — | — | 完整有效 |
| 问题基础与实际价值 | 8 | 4.5 | medium | conflict current/baseline 强差异 | — | U-GC-001 | 有强合成价值 |
| 调用策略、触发条件与 Context Pointer | 10 | 5 | high | 24/24 route decisions | — | — | 精确稳定 |
| 范围、边界与组合性 | 8 | 5 | high | push-only、merge、history rewrite 边界 | — | — | 职责单一 |
| 程序与完成边界 | 10 | 5 | high | 八个 current trace 人工裁决 | — | — | 清楚且完整 |
| 最小充分控制与模型自由度 | 14 | 4 | medium | 风险映射、短正文 | — | U-GC-002 | proportionate |
| 信息层级、资源与渐进式披露 | 10 | 5 | high | 单一 runtime 文件 | — | — | 无披露负担 |
| 职责归属与自然语言状态机风险 | 10 | 5 | high | Git 是状态事实源 | — | — | low risk |
| 脚本与确定性自动化 | 7 | 2.5 | high | 三个 observed false negative | F-GC-001 | — | release grader 需修复 |
| Eval 设计、Oracle 有效性与修改安全 | 9 | 3.5 | medium | 4/4 targets、baseline、invalid oracle | — | U-GC-003 | 覆盖强，oracle 不可发布 |
| 可靠性、安全与兼容性 | 4 | 4.5 | medium | current 行为安全、双平台 deterministic | — | U-GC-004 | Codex 证据强 |
| 剪枝、事实源与变更纪律 | 4 | 5 | high | 短正文、production 相对 main 无变化 | — | — | 维护成本低 |

## 调用与 Context Pointer 审计

| Pointer | 目标材料 | 触发 branch | 意图是否前置 | 重复同义 branch | 重复正文身份 | Eval 证据 | 建议 |
| --- | --- | --- | ---: | ---: | ---: | --- | --- |
| description 正分支 | 完整 local-commit workflow | 用户明确要求创建新 commit，包括 commit-and-push 的 commit 步骤 | 是 | 否 | 否 | 正例 12/12 load | 保留 |
| description 负分支 | 普通 Git 或文本工作 | message-only、inspect/stage-only、push-only、history rewrite、merge | 是 | 否 | 否 | 反例 12/12 no-load | 保留 |
| 正文 no-push 边界 | push owner | 已完成 commit 后 | 是 | 否 | 否 | commit-and-push case 正确完成 commit 且不 push | 保留 |
| agents/openai.yaml default prompt | 显式调用 | 用户选择该 Skill | 是 | 否 | 否 | materialization 通过 | 保留 |

## 最小有效控制审计

### 最小行为合同

1. 只在用户要求实际创建一个新本地 commit 时启用。
2. 只提交授权范围，不改变范围外 index、worktree 或历史。
3. 检查 status、相关 diff 和完整 staged diff；只用精确路径暂存。
4. 冲突、进行中操作或范围不可隔离时停止。
5. 正常运行 hooks，只创建一个 commit，不 push。
6. message 遵守用户或仓库规范；否则只写 diff 可证实的事实。
7. 核对新 commit，并报告 hash、subject、剩余状态；失败时报告实际状态。

### 控制面

| Signal | Count / observation | Risk |
| --- | ---: | --- |
| Mandatory stages | 3 | low；与 Git commit 生命周期一致 |
| Hard gates | 3：授权范围、冲突/操作状态、hook 成功 | low；均是安全不变量 |
| Fixed intermediate artifacts | 1：完整 staged diff | low；Git 是事实源 |
| Prohibitions | add dot/add -A、push、改变范围外状态、猜测事实 | low |
| Conditional branches | repository convention、trivial/non-trivial、failure | low |
| Fixed output fields | success 3 项；failure 实际 state | low |

### 必要性映射与简化候选

| 当前行为块 | 改变的行为 | 依据 | 当前控制类型 | 模型默认能否处理 | 处理建议 | 删除或放宽风险 |
| --- | --- | --- | --- | ---: | --- | --- |
| 授权范围和冲突停止 | 防止越权提交 | observed conflict baseline、Git 风险 | invariant | 部分 | keep-invariant | 历史或用户工作被污染 |
| 精确暂存和 staged diff | 防止带入无关内容 | unrelated staged/unstaged fixtures | invariant | 部分 | keep-invariant | commit 范围扩大 |
| hooks | 保留仓库门禁 | hook rejection fixture | invariant | 部分 | keep-invariant | 绕过质量控制 |
| 一个 commit、no push | 控制完成边界 | 用户授权和 sibling ownership | invariant | 部分 | keep-invariant | 多提交或远端副作用 |
| message convention | 提高可检索性 | repository/message fixtures | default | 是 | keep-default | 质量降低但非状态破坏 |
| 2–4 body bullets | 限制噪音并保留关键事实 | 当前规范；无 ablation | default | 是 | needs-ablation | 可能过度固定表达 |
| 完成后状态报告 | 让用户知道实际结果 | success/failure contract | invariant | 部分 | keep-invariant | 状态不透明 |

## 信息层级图

| 内容 | 类型 | 适用 branch | 当前位置 | 每次需要 | 到达 pointer 或环境事实源 | 最小控制结论 | 建议 |
| --- | --- | --- | --- | ---: | --- | --- | --- |
| 三步 commit 方法 | in-file-step | 所有目标任务 | SKILL.md | 是 | description | keep | 保留 |
| message 默认 | in-file-reference | 仓库无规范时 | Message 小节 | 否 | step 1 | keep-default | 保持同文件 |
| status/diff/index/HEAD | environment-lookup | 当前仓库 | Git | 是 | steps 1–3 | keep-invariant | 不缓存 |
| eval corpora/runner | disclosed-reference | 作者评测 | evals/ | 否 | manifest | eval-only | 不进入 runtime |

## 完成边界审计

| 步骤或规则集 | 当前标准 | 清楚 | 可检查 | 要求充分 | 覆盖完整 | 提前完成风险 | 建议 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 状态和范围检查 | status、相关 diff、message 范围已确定 | 是 | 是 | 是 | 是 | low | 保留 |
| 精确暂存与提交 | staged diff 完整、hooks 正常、一个新 commit | 是 | 是 | 是 | 是 | low | 保留 |
| 验证与报告 | commit hash/subject 和剩余状态准确；失败报告实际状态 | 是 | 是 | 是 | 是 | low | 保留 |

## 架构与职责归属

- **Skill 负责的策略：** 触发、授权范围、暂存安全、message 默认和完成边界。
- **Schema 或客户端负责的事实：** Skill 注册、显式调用和工具参数。
- **Runtime 负责的状态：** HEAD、index、worktree、hooks 和进行中的 Git 操作。
- **脚本候选：** eval grader；production 不需要脚本。
- **仅属于 role 的约束：** short description 和 default prompt。
- **仅属于 eval 或 issue 的问题：** lexical grader、case admission metadata、ablation。
- **自然语言状态机风险：** low。

## 脚本与资源

- **已有脚本或正确省略：** production 正确省略 script；eval runner 提供 help、fixture setup、current/baseline、cleanup 和机械状态检查。
- **接口、依赖和安全质量：** Git 状态检查可靠；message regex 过窄，是 F-GC-001。
- **模型仍在重复的确定性逻辑：** status、diff 和 commit verification 由 Git 执行，没有在正文复制算法。
- **Reference 和 asset 可达性：** 无 runtime reference；eval 文件由 manifest 到达。
- **重复与 scattering：** runtime 无重复；grader assertions 集中在 runner。
- **不必要缓存的环境事实：** 无。
- **过期或孤立资源：** 未发现。

## Eval Case Audit

### 目标和错误代价

| 项目 | 判定 | 证据 |
| --- | --- | --- |
| Optimization policy | critical | behavior corpus policy |
| False-negative cost | high | 错误阻断用户明确授权的安全 commit |
| False-positive cost | high | 错误放过范围、历史或 hook 破坏 |
| Policy rationale | 两类错误都可造成明显用户损失 | behavior-cases.json |

### Eval 门禁

| Gate | 状态 | 证据 | 原因 |
| --- | --- | --- | --- |
| eval-validity | fail | F-GC-001 | 三个 release-counted correct output 被 grader 拒绝 |
| release-evidence | fail | batch 4/4 complete，behavior 5/8 mechanical | complete 不等于 valid |
| eval-change-safety | not_applicable | 无修改 | 本轮只评审和发布报告 |

### Suite 构成

| 指标 | 数量或判定 |
| --- | ---: |
| Trigger corpus | 20 cases：10 positive、10 negative；本次 validation 8 cases |
| Behavior cases | 8 |
| Behavior scenario families | 7 |
| Representative cases | 2 |
| Boundary cases | 6 |
| Regression / challenge / diagnostic-only | 0 / 0 / 0 |
| Stale cases | 0 |
| Ambiguous cases | trigger audit metadata 缺失；behavior case semantics 清楚 |

### Case Admission 结果

| Case | 层级 | Role | Provenance | Oracle 置信度 | 前提充分 | Rule trace | 现实 | 决策 |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | --- |
| detailed_body_for_nontrivial_change | outcome | representative | synthetic | high | 是 | 是 | 是 | release-counted；grader 先修 |
| trivial_change_may_omit_body | outcome | representative | synthetic | high | 是 | 是 | 是 | release-counted |
| staged_only_with_unstaged_hunks | outcome | boundary | synthetic | high | 是 | 是 | 是 | release-counted |
| unrelated_staged_content | outcome | boundary | synthetic | high | 是 | 是 | 是 | release-counted；grader 先修 |
| repository_message_convention | outcome | boundary | synthetic | high | 是 | 是 | 是 | release-counted |
| commit_and_push_composition | outcome | boundary | synthetic | high | 是 | 是 | 是 | release-counted |
| conflict_or_operation_in_progress | outcome | boundary | synthetic | high | 是 | 是 | 是 | release-counted |
| hook_rejection | outcome | boundary | synthetic | high | 是 | 是 | 是 | release-counted；grader 先修 |
| trigger validation group | routing | 未声明 | corpus | unknown | 部分 | 部分 | 是 | needs-adjudication metadata |

### Trigger 二元决策结果

| 指标 | 当前结果 | Baseline / previous | 解释 |
| --- | ---: | ---: | --- |
| Positive recall | 100%（12/12） | 未提供 | 四个正例各三次 |
| False-negative rate | 0% | 未提供 | 无漏触发 |
| Negative specificity | 100%（12/12） | 未提供 | 四个反例各三次 |
| False-positive rate | 0% | 未提供 | 无过触发 |
| Mixed / uncertain cases | 0 | — | validation route 稳定 |

### Behavior、outcome 和 cost 证据

| Scenario family | With Skill | Baseline | Quality delta | Token/time delta | 方差 | 证据强度 |
| --- | --- | --- | ---: | ---: | --- | --- |
| commit message detail | 实际正确，机械 false negative | 不满足固定 body 要求 | 正向，但 oracle 混淆 | 未归一 | 单次 | medium |
| scope isolation | 正确保留 unstaged/staged 外部内容 | mixed | 正向 | 未归一 | 单次 | high |
| repository convention/composition | 通过 | mixed | 非负 | 未归一 | 单次 | medium |
| conflict/in-progress | 正确停止 | 错误创建 merge commit | 强正向 | 未归一 | 单次 | high |
| hook rejection | 实际正确，机械 false negative | 也失败 | 无法用机械分数 | 未归一 | 单次 | high for oracle defect |

### Failure triage

| Case / assertion | Failure class | 可复现 | Root owner | 动作 | 理由 |
| --- | --- | ---: | --- | --- | --- |
| detailed body grouping and action words | grader-defect | structural | Script | fix-eval-first | allowed variance 明确允许其它合理分组 |
| unrelated staged subject verb | grader-defect | structural | Script | fix-eval-first | 修改是有效动作同义词 |
| hook failure state wording | grader-defect | structural | Script | fix-eval-first | 仓库状态和最终报告一致 |

### Eval-driven 修改决策

- **修改内容：** 无。
- **受影响场景族：** 无 Skill 改动。
- **为什么是 Skill defect：** 不适用；observed evidence 指向 grader。
- **Validation、sanity 和 regression 重跑：** 在 grader 修复后执行。
- **决策：** fix-eval-first。

### Eval 维度

- **分数：** 3.5 / 5
- **置信度：** medium
- **适用评分上限：** 当前 oracle defect 阻止 release evidence。
- **摘要：** 运行覆盖完整，baseline 和 runtime trace 有价值；机械结论目前无效。

### 停止决定

停止修改 Skill。下一轮必须先修 F-GC-001，并用同一完整 suite 产生新的 observed evidence。

## 差量与沉积

- **上一版 P0/P1 关闭情况：** 本次 full 不是 delta；不声明关闭。
- **生产变化：** 当前 production bundle 相对 main 无变化，branch 变化集中在 eval 资产。
- **沉积候选：** 没有正文规则沉积；问题集中在 grader。
- **净变化：** neutral。

## 最小改进路线

### 现在——发布阻断

1. 修复 F-GC-001 的三类 semantic grading。
2. 增加实际 current 输出的正回归和错误状态负回归。
3. 重跑同一完整 batch 合同，要求 behavior 8/8 且 trigger 8/8。

### 下一步——高价值质量改进

1. 补齐 trigger case admission metadata，并通过 strict validation。
2. 对 body 数量和分组规则做 ablation，再决定是否放宽正文。

### 以后——启发式、评测或产品/runtime 工作

1. 只有在需要跨模型行为声明时才补 Claude model eval。
2. 有隐私安全的生产使用数据后，再调整 problem-value 置信度。

## 停止决定

当前证据足以完成 full review，并明确定位到 Script owner。继续修改 Skill 会让正确行为迁就错误 oracle。报告发布后应停止，直到 grader 修复或出现新的 production、normative 或 repeated observed evidence。
