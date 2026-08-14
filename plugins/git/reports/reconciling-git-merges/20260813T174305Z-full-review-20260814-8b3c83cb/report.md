# reconciling-git-merges Skill 完整评审报告

## 结论

- **Skill：** reconciling-git-merges
- **模式：** full
- **方向：** aligned
- **复杂度：** proportionate
- **可缩减程度：** minor
- **发布结论：** pass-after-fixes
- **加权总分：** 86.9 / 100
- **原始质量带：** strong
- **有效质量带：** strong
- **覆盖率：** 100%
- **置信度：** high（0.86）
- **一句话结论：** Skill 正文、owner 路由和四个实际行为均符合 merge 协调目标；当前发布阻断是 ambiguous-retention grader 同时要求互斥状态，并拒绝正确的决策措辞。

正式 eval 批次：20260813T174305Z-full-review-20260814-8b3c83cb。模型运行：20260813T174436Z-695a5547。补充 source_09 方差批次：20260813T181249Z-full-review-20260814-source09-variance-9c41f806。

## 评审合同

| 项目 | 从材料提取的结论 | 状态 |
| --- | --- | --- |
| 目标问题 | 在 Git merge 中协调双方文本或语义意图，并验证组合行为 | known |
| 已观察失败 | router 6/7、behavior 3/4 机械通过；ambiguous failure 经人工裁决为 grader defect | known |
| 成功标准 | 保护无关工作、查一手证据、保留兼容意图、暴露无法裁决的冲突、验证后按授权完成 merge | known |
| 目标环境或客户端 | AW Codex project/user materialization；Codex router/command eval；双平台确定性插件测试 | known |
| 范围外事项 | fast-forward、already up to date、明显独立 clean merge、普通 local commit、未授权 push | known |
| 相邻 Skill | git-commit、isolating-work-with-git-worktrees | known |
| 发布要求 | project/user materialization、validation router 和四个 behavior cases 在同一批次完成 | known |

## 发布门禁

| Gate ID | 状态 | 严重性 | Finding IDs | 证据 | 原因 |
| --- | --- | --- | --- | --- | --- |
| package-validity | pass | P0 | — | validator、static inspector、双 scope materialization | 包和最终制品有效 |
| critical-artifacts | pass | P0 | — | Skill、metadata、manifest、fixtures、runner | 所有声明 artifact 存在并已检查 |
| goal-alignment | pass | P0 | — | 四个 current traces | 协调双方意图并在证据不足时停止 |
| capability-validity | pass | P0 | — | Git merge/history/index 和 project tests | 能力真实且支持 |
| safety-permissions | pass | P0 | — | analysis-only 不变、ambiguous 不提交、no push | 副作用边界明确 |
| architecture-ownership | pass | P1 | — | Git 是 merge state 事实源 | 无 prose state machine |
| release-evidence | fail | P1 | F-GM-001 | required batch 完整但 ambiguous mechanical fail | 关键 fail-closed oracle 无效 |
| eval-validity | fail | P1 | F-GM-001 | file equality 与 marker assertion 互斥；decision regex 过窄 | 确定 false negative |
| eval-change-safety | not_applicable | P1 | — | 本轮没有修改 Skill 或 eval | 无 eval-driven change |

## 优点

- 正式路由中 owner positive recall 为 9/9，owner negative specificity 为 12/12。唯一失败是一次额外加载 git-commit，不是漏加载或错误 owner 替代。
- source_09 补充九次均只加载 merge Skill；原始 extra-load 0/9 复现。三次在正确 load 后达到 180 秒 timeout，因此只作为方差诊断。
- semantic_cross_file 中 current 完成跨文件 cents/dollars 契约修复、双父 merge commit 和测试；baseline 未完成正确集成。
- ambiguous_retention 中 current 保留 UU 和 conflict markers，没有 commit，明确指出 7 天与 90 天不兼容并请求权威决策；baseline 发明 30 天策略、删除测试并提交。
- analysis-only current 保持 HEAD、refs、index、status 和 diff 不变，同时给出正确的跨文件边界分析。
- 五步正文短、证据优先、fail closed，没有 runtime script、reference sprawl 或自然语言状态机。

## 必须修复的问题

| ID | 严重性 | 证据类型 | 维度 | 位置 | 受影响场景 | 证据 | 反证检查 | 正确 owner | 最小修改 | 验证方式 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| F-GM-001 | P1 | observed, structural | scripts | skills/reconciling-git-merges/evals/run-merge-evals.mjs:290-315,326-333 | 正确的 unresolved product decision 被计为 behavior failure | grader 要求 worktree file 等于 pre-merge main file，同时又要求 conflict markers；current 保留 UU、markers、7/90 并说“请提供权威决策”，但 decision regex 仍失败 | 其它三个 behavior case 通过；no-commit、UU、marker 和 incompatible-value checks 本身有效；owner trigger recall/specificity 100% | Script | 用 conflict stages、UU、markers 和 no authored resolution 代替不可能的 file equality；接受等价的 authoritative-decision 措辞；加入实际输出正回归 | 跑 deterministic grader tests，再重跑四个 behavior cases；正确 current ambiguous 通过，invented-policy 和 premature-commit 负例失败 |

## 非阻断问题

没有确认的 P2。source_09 extra-load 和 post-load timeout 未稳定复现，保留为 Unknown，不转换成 finding。

## 未知项

| ID | 维度 | 描述 | 所需证据 |
| --- | --- | --- | --- |
| U-GM-001 | problem_value | 没有生产 merge trace 或缺陷分布量化真实收益 | 收集匿名 merge category、blocker 和 post-merge defect signal |
| U-GM-002 | triggering | 一次 extra git-commit load 未在九次扩展复现，但三次扩展 post-load timeout | 使用能在 routing 结论充分后终止的 harness 重跑 |
| U-GM-003 | minimum_control | 没有 ablation 识别 cross-file、待决问题和单 merge commit 的最小文本 | 比较 current、minimal-contract 和 owner-removed |
| U-GM-004 | evals | 没有 corrected release batch；trigger 和 behavior corpora 都缺 strict admission metadata | 修 oracle、补 metadata、重跑 4/4 targets |
| U-GM-005 | reliability | Claude 只有包级证据，没有模型行为证据 | 仅在声明跨模型行为等价时跑 corrected Claude suite |

## 维度评分

| 维度 | 权重 | 分数 | 置信度 | 证据 | Finding IDs | Unknown IDs | 结论 |
| --- | ---: | ---: | --- | --- | --- | --- | --- |
| 规范与包完整性 | 6 | 5 | high | validator、materialization、static inspector | — | — | 完整有效 |
| 问题基础与实际价值 | 8 | 4.5 | medium | cross-file 和 ambiguous baseline 差异 | — | U-GM-001 | 强合成价值 |
| 调用策略、触发条件与 Context Pointer | 10 | 4 | medium | owner recall/specificity 100%；一次 extra load | — | U-GM-002 | owner 精确，组合有方差 |
| 范围、边界与组合性 | 8 | 5 | high | ordinary commit 3/3 路由 sibling | — | — | 所有权正确 |
| 程序与完成边界 | 10 | 5 | high | 四个 current trace 人工裁决 | — | — | 完整且 fail closed |
| 最小充分控制与模型自由度 | 14 | 4 | medium | 风险映射、短正文 | — | U-GM-003 | proportionate |
| 信息层级、资源与渐进式披露 | 10 | 5 | high | 单一 runtime 文件 | — | — | 紧凑完整 |
| 职责归属与自然语言状态机风险 | 10 | 5 | high | Git 是 merge state 事实源 | — | — | low risk |
| 脚本与确定性自动化 | 7 | 2.5 | high | mutually exclusive assertions | F-GM-001 | — | release grader 需修复 |
| Eval 设计、Oracle 有效性与修改安全 | 9 | 3 | medium | 4/4 targets、baseline、invalid oracle、missing metadata | — | U-GM-004 | 覆盖强，oracle 不可发布 |
| 可靠性、安全与兼容性 | 4 | 4.5 | medium | 四个 current 安全、双平台 deterministic | — | U-GM-005 | Codex 行为强 |
| 剪枝、事实源与变更纪律 | 4 | 5 | high | 五阶段短正文、production 无变化 | — | — | 维护成本低 |

## 调用与 Context Pointer 审计

| Pointer | 目标材料 | 触发 branch | 意图是否前置 | 重复同义 branch | 重复正文身份 | Eval 证据 | 建议 |
| --- | --- | --- | ---: | ---: | ---: | --- | --- |
| description 正分支 | 完整 merge reconciliation | merge conflict/in-progress，或相关行为、契约、依赖的 clean merge | 是 | 否 | 否 | owner positives 9/9 load | 保留 |
| description 负分支 | ordinary Git merge | fast-forward、already up to date、明显独立 clean merge | 是 | 否 | 否 | 三个 none negatives 9/9 owner no-load | 保留 |
| 正文 step 1 stop pointer | 普通 Git workflow | 检查后发现 fast-forward/already-up-to-date | 是 | 否 | 否 | corpus boundary | 保留 |
| 正文 completion ownership | merge commit | 用户要求且验证通过 | 是 | 否 | 否 | semantic current cases | 保留，不转交 git-commit |
| agents/openai.yaml default prompt | 显式调用 | 用户选择该 Skill | 是 | 否 | 否 | materialization 通过 | 保留 |

## 最小有效控制审计

### 最小行为合同

1. 只在冲突、进行中 merge 或相关语义组合需要协调时启用。
2. 修改前确认 state、history、source、target 和无关 local work；analysis-only 不改变仓库。
3. 每个文本或语义冲突都查 commits、tests、code 和可用一手依据。
4. 兼容时保留双方；证据不足且目标不明时保留冲突并请求决策。
5. 只做该交互需要的集成修改，并运行 required 和 targeted tests。
6. 仅在用户要求、无 unresolved item 且验证通过时完成一个含集成修正的 merge commit；不 push。

### 控制面

| Signal | Count / observation | Risk |
| --- | ---: | --- |
| Mandatory stages | 5 | medium；merge 协调天然多阶段 |
| Hard gates | 4：analysis-only、证据不足、验证、授权完成 | low；均有高风险依据 |
| Fixed intermediate artifacts | 0 | none |
| Prohibitions | 丢弃/覆盖/混入 local work、发明行为、未验证完成、未授权 push | low |
| Conditional branches | ff stop、clean/semantic、compatible/incompatible、analysis/execute | medium；均是真实 branch |
| Fixed output fields | 0 | none |

### 必要性映射与简化候选

| 当前行为块 | 改变的行为 | 依据 | 当前控制类型 | 模型默认能否处理 | 处理建议 | 删除或放宽风险 |
| --- | --- | --- | --- | ---: | --- | --- |
| state/history/source/target | 防止操作错对象 | Git merge risk | invariant | 部分 | keep-invariant | refs 或 local work 被污染 |
| ff/already stop | 防止过宽触发 | scope contract | invariant | 部分 | keep-invariant | 普通 merge 被劫持 |
| 一手依据和跨文件追踪 | 捕获 semantic interaction | cross-file fixture | default | 部分 | keep-default | clean merge 语义回归 |
| 保留双方或显式待决 | 防止单边覆盖或编造折中 | ambiguous baseline | invariant | 部分 | keep-invariant | 产品策略被发明 |
| targeted integration change | 限制范围 | surgical goal | default | 是 | keep-default | 无关重构扩大风险 |
| combined verification | 证明组合正确 | same/cross-file fixtures | invariant | 部分 | keep-invariant | 单边 tests 不足 |
| single authorized merge completion | 控制历史和 push | completion contract | invariant | 部分 | keep-invariant | 分拆未验证修复或越权 |

## 信息层级图

| 内容 | 类型 | 适用 branch | 当前位置 | 每次需要 | 到达 pointer 或环境事实源 | 最小控制结论 | 建议 |
| --- | --- | --- | --- | ---: | --- | --- | --- |
| 五步协调方法 | in-file-step | 所有目标 merge | SKILL.md | 是 | description | keep | 保留 |
| ff stop 和 ambiguous decision | in-file-reference | 条件 branch | steps 1/3 | 否 | state/evidence | keep-invariant | 保持 co-located |
| commits/tests/code/PR/issue | environment-lookup | evidence phase | repository/environment | 是 | step 2 | keep-default | 不缓存 |
| Git merge/index/worktree state | environment-lookup | all phases | Git | 是 | steps 1/5 | keep-invariant | Runtime 为事实源 |
| bundles/corpora/runner | disclosed-reference | 作者 eval | evals/ | 否 | manifest | eval-only | 不进入 runtime |

## 完成边界审计

| 步骤或规则集 | 当前标准 | 清楚 | 可检查 | 要求充分 | 覆盖完整 | 提前完成风险 | 建议 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 看清 merge | state/history/source/target/local work 已确认 | 是 | 是 | 是 | 是 | low | 保留 |
| 找一手依据 | 每个文本/语义冲突有 commits/tests/code 依据 | 是 | 部分 | 是 | 是 | medium | 保留 |
| 协调双方意图 | 兼容则保留；无法裁决则待决，不发明行为 | 是 | 是 | 是 | 是 | low | 保留 |
| 验证组合 | required checks 和 targeted interaction tests 通过 | 是 | 是 | 是 | 是 | low | 保留 |
| 完成 merge | 用户要求、无 unresolved、checks pass，一个含 integration fix 的 merge commit | 是 | 是 | 是 | 是 | low | 保留 |

## 架构与职责归属

- **Skill 负责的策略：** 触发边界、证据优先、双方意图协调、验证和授权完成原则。
- **Schema 或客户端负责的事实：** invocation、role metadata 和 tool contract。
- **Runtime 负责的状态：** MERGE_HEAD、unmerged entries、refs、index、worktree 和 test results。
- **脚本候选：** eval fixture 和 mechanical assertions；production 无需 state-machine script。
- **仅属于 role 的约束：** short description 和 default prompt。
- **仅属于 eval 或 issue 的问题：** ambiguous oracle、case admission metadata、router timeout。
- **自然语言状态机风险：** low。

## 脚本与资源

- **已有脚本或正确省略：** production 正确无 script；eval runner 有 bundle fixture、snapshot、current/baseline、cleanup 和 merge-state assertions。
- **接口、依赖和安全质量：** repository checks 大多有效；ambiguousRetentionChecks 存在 F-GM-001。
- **模型仍在重复的确定性逻辑：** Git 和 unittest 提供状态与验证；正文只规定行为。
- **Reference 和 asset 可达性：** 四个 fixture 经 evals.json 和 manifest 到达；bundle path 有边界。
- **重复与 scattering：** runtime 无重复；assertions 集中在 runner。
- **不必要缓存的环境事实：** 无。
- **过期或孤立资源：** 未发现。

## Eval Case Audit

### 目标和错误代价

| 项目 | 判定 | 证据 |
| --- | --- | --- |
| Optimization policy | critical，reviewer-declared | corpus 未声明；merge 协调是高风险状态任务 |
| False-negative cost | high | 漏触发可让语义冲突按普通 merge 完成 |
| False-positive cost | high | 过触发可劫持普通 commit/merge 并增加副作用 |
| Policy rationale | 两类错误都影响历史或产品语义 | Skill 目标和 fixtures |

### Eval 门禁

| Gate | 状态 | 证据 | 原因 |
| --- | --- | --- | --- |
| eval-validity | fail | F-GM-001 | ambiguous oracle 有互斥 assertions |
| release-evidence | fail | formal 4/4 complete，mechanical failed | complete 不等于 valid |
| eval-change-safety | not_applicable | 无修改 | 本轮只评审和发布报告 |

### Suite 构成

| 指标 | 数量或判定 |
| --- | ---: |
| Router corpus | 21：train 14、validation 7 |
| 本次 router decisions | 21，三次每 case |
| Behavior cases | 4 |
| Scenario families | metadata 未声明；人工识别 4 类 |
| Representative / boundary / regression / challenge | metadata 未声明 |
| Diagnostic-only | source_09 九次扩展 |
| Stale cases | 0 confirmed |
| Ambiguous cases | ambiguous-retention oracle invalid；source_09 route variance |

### Case Admission 结果

| Case | 层级 | Role | Provenance | Oracle 置信度 | 前提充分 | Rule trace | 现实 | 决策 |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | --- |
| ambiguous_retention | outcome | 未声明 | bundled synthetic | high for intended behavior | 是 | 可推导 | 是 | release-counted；grader 先修 |
| semantic_same_file | outcome | 未声明 | bundled synthetic | high | 是 | 可推导 | 是 | release-counted |
| semantic_cross_file | outcome | 未声明 | bundled synthetic | high | 是 | 可推导 | 是 | release-counted |
| analysis_only_dirty_worktree | outcome | 未声明 | archived synthetic | high | 是 | 可推导 | 是 | release-counted |
| router validation group | routing | 未声明 | corpus | unknown | 部分 | 部分 | 是 | needs-adjudication metadata |

strict validation 对 behavior corpus 报告 29 项 metadata 缺失，对 trigger corpus 报告 148 项 metadata 缺失。缺失 metadata 本身不升级为 P1；它降低 eval 置信度。

### Trigger 二元决策结果

| 指标 | 当前结果 | Baseline / previous | 解释 |
| --- | ---: | ---: | --- |
| Positive recall | 100%（9/9） | 未提供 | 三个 owner positives 全 load |
| False-negative rate | 0% | 未提供 | 无漏触发 |
| Negative specificity | 100%（12/12） | 未提供 | owner 在三 none 和一 sibling case 均不 load |
| False-positive rate | 0% | 未提供 | 以 owner 为二元目标 |
| Exact route | 95.2%（20/21） | 未提供 | 一次额外 git-commit load |
| Mixed / uncertain cases | source_09 | 0/9 extra-load 复现；3/9 timeout | 需要降低 post-load 噪音 |

### Behavior、outcome 和 cost 证据

| Scenario family | With Skill | Baseline | Quality delta | Token/time delta | 方差 | 证据强度 |
| --- | --- | --- | ---: | ---: | --- | --- |
| ambiguous policy retention | 实际正确，机械 false negative | 发明 30 天、删 tests、commit | 强正向 | 未归一 | 单次 | high |
| semantic same-file | pass | pass | 0 on this fixture | 未归一 | 单次 | medium |
| semantic cross-file | pass | fail | 强正向 | 未归一 | 单次 | high |
| analysis-only dirty workspace | pass | pass | 0 on this fixture | 未归一 | 单次 | high for safety |
| source_09 routing extension | 9/9 owner-only load；3 timeout | 无 baseline | no extra load observed | 最长 180 秒 | high runtime variance | diagnostic |

### Failure triage

| Case / assertion | Failure class | 可复现 | Root owner | 动作 | 理由 |
| --- | --- | ---: | --- | --- | --- |
| original_conflict_content_unchanged | grader-defect | structural | Script | fix-eval-first | 与 conflict_markers_preserved 互斥 |
| requires_product_decision | grader-defect | structural | Script | fix-eval-first | 明确“权威决策”仍被拒绝 |
| source_09 extra git-commit | model-variance | 0/9 extension | unknown | collect-more-data | 未稳定复现 |
| source_09 post-load timeout | runtime/eval-harness cost | 3/9 extension | Eval/Script | optimize diagnostic | route 已正确，后续执行过重 |

### Eval-driven 修改决策

- **修改内容：** 无。
- **受影响场景族：** 无 Skill 或 eval 改动。
- **为什么是 Skill defect：** 不适用；P1 证据指向 grader。
- **Minimal pair / 相反标签风险：** 修 oracle 后仍需让 invented-policy、resolved-conflict 和 premature-commit 负例失败。
- **决策：** fix-eval-first。

### Eval 维度

- **分数：** 3 / 5
- **置信度：** medium
- **适用评分上限：** invalid ambiguous oracle 和缺失 admission metadata 限制结论。
- **摘要：** fixtures、baseline 和 runtime trace 提供强证据，但机械 release outcome 目前无效。

### 停止决定

停止修改 Skill。下一轮先修 F-GM-001，再运行四个 behavior case 和 validation route；source_09 只在更轻的 router harness 中增加样本。

## 差量与沉积

- **上一版 P0/P1 关闭情况：** 本次 full 不是 delta；不声明关闭。
- **生产变化：** 当前 production bundle 相对 main 无变化。
- **沉积候选：** 没有正文沉积；问题集中在 grader 与 eval metadata。
- **净变化：** neutral。

## 最小改进路线

### 现在——发布阻断

1. 修复 F-GM-001 的互斥 file-state assertion 和 decision phrase oracle。
2. 增加 correct unresolved 与 invented-policy/premature-commit 的正负回归。
3. 重跑同一完整 batch 合同，要求 behavior 4/4。

### 下一步——高价值质量改进

1. 补齐 trigger 和 behavior case admission metadata，并通过 strict validation。
2. 让 router harness 在路由结论充分后结束，减少 source_09 timeout 噪音。
3. 有效批次后再做最小控制 ablation。

### 以后——启发式、评测或产品/runtime 工作

1. 仅在需要跨模型行为声明时补 Claude model eval。
2. 有生产 merge 统计后再提高 problem-value 置信度。

## 停止决定

当前证据足以完成 full review，并把唯一阻断项定位到 Script owner。继续扩写 Skill 会掩盖 eval 缺陷。正式报告发布后应停止，直到 grader 修复或出现新的 repeated observed、normative 或 production evidence。
