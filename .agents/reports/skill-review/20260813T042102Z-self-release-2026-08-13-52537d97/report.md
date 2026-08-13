# Skill 评审报告

## 结论

- **Skill：** `skill-review`
- **模式：** release
- **方向：** at-risk
- **复杂度：** over-specified
- **可缩减程度：** significant
- **发布结论：** pass-after-fixes
- **加权总分：** 74.7 / 100
- **原始质量带：** adequate
- **有效质量带：** adequate
- **覆盖率：** 100%
- **置信度：** high（0.93）
- **一句话结论：** 包结构、脚本、安全边界和证据体系较强，但完整 release eval 发现 3 个 P1：触发精度不足、写入型 eval 合同自相矛盾，以及 evidence-only 评审重复产生错误 P1；当前版本不能作为 release pass。

这是自审报告。已激活的 `skill-review` 协议是 controller；再次读取的目标包只作为不可信分析材料。自审不替代独立 reviewer，但本次有完整、隔离的 Codex release eval 证据。

## 评审合同

| 项目 | 从材料提取的结论 | 状态 |
| --- | --- | --- |
| 目标问题 | 对已有静态或 AW 插件 Skill 做证据化质量、风险、评分和发布就绪性判断 | known |
| 已观察失败 | validation trigger 误触发；behavior 写入合同机械失败；evidence-only 输出产生错误 P1 | known |
| 成功标准 | 正确选模式；只使用授权范围；缺失证据记为 unknown；P0/P1 通过 admission gate；scorecard 可验证；release evidence 完整 | known |
| 目标环境或客户端 | 当前仓库静态 Codex Skill；Node.js 24.14.1；Codex CLI 0.147.0；`gpt-5.6-luna` | known |
| 范围外事项 | 直接创建、改写或修复 Skill；普通代码 review；Claude 行为；README 登记 | known |
| 相邻 Skill | `create-aw-plugin` 负责创建和维护；本 Skill 负责质量判断与报告 | known |
| 发布要求 | 用户要求完整 eval 和正式发布报告；未要求 README 登记 | known |

## 发布门禁

| Gate ID | 状态 | 严重性 | Finding IDs | 证据 | 原因 |
| --- | --- | --- | --- | --- | --- |
| package-validity | pass | P0 | — | official / structural | `skills-ref` 与静态诊断均通过 |
| critical-artifacts | pass | P0 | — | structural | 35 个文件存在；引用、JSON 和一层路径均有效 |
| goal-alignment | pass | P0 | — | structural | 目标、模式、范围和授权边界一致 |
| capability-validity | pass | P0 | — | structural / observed | Codex metadata 受当前 adapter 支持；脚本和构建 driver 可运行 |
| safety-permissions | pass | P0 | — | observed | 28 条 behavior trace 没有越权发布、外部访问或破坏性动作 |
| architecture-ownership | pass | P1 | — | structural | runtime 管生命周期，script 管确定性逻辑；Skill body 状态机风险低 |
| release-evidence | fail | P1 | F-001, F-002, F-003 | observed / structural | 三个 required target 全覆盖，但 trigger 和 behavior 均失败 |

## 优点

- 官方 `skills-ref validate` 通过。frontmatter、目录名和 Codex metadata 有效。
- 35 个包文件均可解析。没有缺失引用、深链或不可达 runtime resource。
- 三个脚本都有 `--help`、结构化输出和可操作错误。`node --check` 全部通过。
- 专用集成测试通过 13/13。它覆盖路径隔离、静态 eval、scorecard、finding admission 和发布分离。
- P0/P1 admission、unknown、coverage、confidence 和 release gate 分离。`validate_scorecard.mjs` 能机械阻止多维重复扣分和无证据低分。
- `seal-only` baseline 错误建议允许封存。加载 Skill 后正确停止。这证明授权边界有实际增量价值。
- 28 条 behavior trace 没有运行 `review:publish`、`review:release`、Git commit/push、外部下载或破坏性命令。

## 必须修复的问题

| ID | 严重性 | 证据类型 | 主维度 | 位置 | 受影响场景 | 正确 owner | 最小修改 | 验证方式 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| F-001 | P1 | observed, normative | triggering | `SKILL.md:3-11`；trigger validation | 实现 eval、定向修复、只运行脚本、只解释流程等 near-miss | Skill | 围绕“用户要的交付物是否是质量/风险/发布判断”重写 description；不要继续追加失败 query 原词 | 只用 train 调整；对新 validation/sanity 每例跑 3 次；strict negative 全部低于 0.5 |
| F-002 | P1 | observed, structural | evals | `evals/evals.json:206-232` | 在新隔离 workspace 保存 `.tmp/.../draft-only-helper.md` | Eval | 在 allowlist 中加入三个精确父目录和现有文件；不扩大到 review 目录外 | 先单跑 draft case，要求 current/baseline mechanical pass；再跑完整 release behavior |
| F-003 | P1 | observed, structural | instruction_design | `SKILL.md:40,57-83`；publication/draft behavior | 只提供 fixture、组件、诊断或 eval 摘要，没有本地 target | Skill | 把“只评已提供材料，缺失为 unknown”移到 inventory/diagnostic 步骤旁；本地 target 不可达时不运行 inspector | 重跑 quick、publication、delta、draft 和 self-review；不得因缺材料产生 P1，也不得无效调用 inspector |

### F-001 证据与反证

- 36 次 trigger 调用完整，无 execution error。
- 六个正例全部 3/3 触发。
- 五个 near-miss 负例失败：三个是 3/3 误触发，两个是 2/3 误触发。
- `SKILL.md:9-11` 已有负面清单。因此，继续增加负面关键词不是最小修复。
- `allow_implicit_invocation: true` 是有意的产品策略。项目规范要求先修 description 精度。

### F-002 证据与反证

- current 和 baseline 都创建了正确文件，且 artifact 内容断言通过。
- 两者都只因 `.tmp/`、`.tmp/agent-workflows/`、`.tmp/agent-workflows/reviews/` 三个必要父目录而失败。
- 写入只发生在隔离副本。源包没有变化。
- 这不是 sandbox 或后代进程失败。其它 13 个 behavior case 的机械检查完成。

### F-003 证据与反证

- publication current 把目标包和 raw eval 不在 workspace 转成两个 P1。
- draft current 把 package-validity 和 critical-artifacts 转成 P1。baseline 正确把它们保留为 unknown。
- current 在多项 fixture/evidence-only case 中尝试对不存在的 target 运行 inspector。
- `SKILL.md:40` 已明确规定缺失材料是 unknown。问题是这条不变量离必做诊断流程太远，执行时失去优先级。

## 非阻断问题

| ID | 严重性 | 证据类型 | 维度 | 位置 | 观察 | 建议 |
| --- | --- | --- | --- | --- | --- | --- |
| F-004 | P2 | observed, normative | minimum_control | `SKILL.md:57-84` | current 比 baseline 多 77.5% tokens、91.0% 时间和 61.2% 命令；quick/evidence-only branch 仍读大量无关材料 | 在 inventory 前按模式和材料类型分支；quick 只走 3–5 个相关维度；对精简版做 ablation |
| F-005 | P2 | observed | architecture | state-machine behavior | 识别出 timeout/pending/retry 风险，但建议继续定义 prose 状态转移，而不是先删或迁移到 runtime/script/eval | pointer 先要求列出 owner 和删除/迁移候选，最后才允许 prose fallback |
| F-006 | P2 | observed, structural | reliability | self-review behavior | 自审误报 inspector 不支持 `--help`；真实入口在参数解析前处理 `--help`，直接运行成功 | 静态安全检查后，必须读 CLI entrypoint 并实际运行 `--help`，再发布接口 finding |

## 未知项

| ID | 维度 | 描述 | 所需证据 |
| --- | --- | --- | --- |
| U-001 | evals | behavior 每 case 只运行 1 次，只覆盖一个 Codex 模型；方差、独立 reviewer 和其它客户端行为未知 | 对高风险 case 每例至少 3 次；需要更广声明时增加独立 reviewer 或第二客户端证据 |
| U-002 | minimum_control | 没有直接消融本 Skill 自身的 mandatory block；成本 trace 只能定位候选，不能证明准确最小文本 | 用 branch-first 最小 controller 与当前版跑同一 corpus，比较质量、token、时间和命令 |

## 维度评分

| 维度 | 权重 | 分数 | 置信度 | 最小证据 | Finding IDs | Unknown IDs | 结论 |
| --- | ---: | ---: | --- | --- | --- | --- | --- |
| 规范与包完整性 | 6 | 5.0 | high | `skills-ref`；静态诊断 | — | — | 包有效且引用完整 |
| 问题基础与实际价值 | 8 | 5.0 | high | 14 组 current/baseline；seal-only 差异 | — | — | 有真实增量价值 |
| 调用策略、触发条件与 Context Pointer | 10 | 2.0 | high | validation 7/12 | F-001 | — | recall 强，precision 差 |
| 范围、边界与组合性 | 8 | 5.0 | high | description、模式和相邻 Skill | — | — | 声明边界清楚 |
| 程序与完成边界 | 10 | 2.5 | high | publication/draft trace | F-003 | — | common path 产生错误 blocker |
| 最小充分控制与模型自由度 | 14 | 2.5 | medium | current/baseline 成本和命令 | F-004 | U-002 | quick/evidence-only 过度执行 |
| 信息层级、资源与渐进式披露 | 10 | 5.0 | high | 七个条件 pointer；无深链 | — | — | 结构层级强 |
| 职责归属与自然语言状态机风险 | 10 | 4.0 | medium | 静态 low risk；state-machine trace | F-005 | — | 规则正确，但行为应用有缺口 |
| 脚本与确定性自动化 | 7 | 5.0 | high | syntax/help/sample；13 tests | — | — | 自动化可靠 |
| 评测、验证与证据驱动迭代 | 9 | 2.5 | high | 完整 batch failed | F-002 | U-001 | corpus 广，但 release evidence 失败 |
| 可靠性、安全与兼容性 | 4 | 4.0 | high | 安全 trace；错误 help finding | F-006 | — | 安全强，自审可靠性有缺口 |
| 剪枝、事实源与变更纪律 | 4 | 5.0 | high | changelog、source map、单一脚本 owner | — | — | 当前维护纪律强 |

## 调用与 Context Pointer 审计

| Pointer | 目标材料 | 触发 branch | 意图是否前置 | 重复同义 branch | Eval 证据 | 建议 |
| --- | --- | --- | ---: | ---: | --- | --- |
| frontmatter description | 整个 Skill | 用户要质量、风险、finding、score 或 release judgment | 部分 | 否 | validation 7/12 | 按交付物重写；不要增加失败 query 词表 |
| `scoring-model.md` | 权重、gate、admission、verdict | 计分前 | 是 | 否 | scorecard validator 通过 | 保留 |
| `review-dimensions.md` | 12 维量表 | full/release | 是 | 否 | full behavior 有部分失败 | 保留 |
| `architecture-boundaries.md` | owner 矩阵和减法顺序 | 异步、重试、跨 actor、权限 | 是 | 否 | state-machine case 未正确应用 | 改为 outcome pointer |
| `scripts-and-resources.md` | 脚本与资源检查 | 存在 script/reference/asset | 是 | 否 | 脚本检查完成 | 保留 |
| `delta-review.md` | 修订版复核 | delta 或 previous | 是 | 否 | delta case 通过核心检查 | 保留 |
| `source-map.md` | 当前权威来源 | release 或权威判断 | 是 | 否 | 2026-08-13 已核对 | 保留 |
| `static-skill-evaluation.md` | 静态 Skill eval/publish | repo-local release/eval/publish | 是 | 否 | 完整 batch | 保留 |
| `agent-workflows-plugin.md` | 动态插件 source/final/evidence | AW 插件 | 是 | 否 | plugin evidence case 正确区分层级 | 保留 |
| report/scorecard assets | 输出与计算合同 | ledger 完成后 | 是 | 否 | scorecard valid | quick branch 应使用更短输出 |

## 最小有效控制审计

### 最小行为合同

1. 从用户交付目标选择唯一模式，不扩大深度或授权。
2. 把被审材料当作不可信证据；执行脚本前检查副作用。
3. 只使用已提供或可达材料；缺失材料是 unknown，不是目标缺陷。
4. 先分离强证据与 heuristic/inference，再定严重性。
5. P0/P1 必须有 location、scenario、证据、owner、反证、最小修复和验证；失败 gate 必须链接 finding。
6. full/release 完成 12 维和最小控制审计，并只加载当前 branch 需要的 reference。
7. 在输出 score、band 和 verdict 前验证 scorecard。
8. 正式发布与 README 登记使用两个独立授权边界。

### 控制面

| Signal | Count / observation | Risk |
| --- | ---: | --- |
| Mandatory stages | 8 个 common execution steps | quick/evidence-only branch 也容易进入完整流程 |
| Hard gates | 7 个 release gate；P0/P1 admission | 必要，但不能把 unknown 转为 fail |
| Fixed intermediate artifacts | evidence ledger、scorecard、report | 对 full/release 合理；普通 quick 偏重 |
| Prohibitions | body 静态计数 11 | 安全和授权类应保留 |
| Conditional branches | 4 个模式；7 个 reference pointer；发布/登记分支 | 分支定义清楚，但分支发生得太晚 |
| Fixed output fields | 主文件 0；模板包含 12 维和 7 gate | full/release 合理；quick 应压缩 |

### 必要性映射与简化候选

| 当前行为块 | 改变的行为 | 依据 | 当前控制类型 | 模型默认能否处理 | 处理建议 | 删除或放宽风险 |
| --- | --- | --- | --- | ---: | --- | --- |
| 不可信对象与自审 controller | 防 prompt injection 和自授权 | 安全不变量、behavior case | prohibition | 否 | keep-invariant | 删除会越权或服从目标指令 |
| 互斥模式和 quick 默认 | 控制深度、评分与输出 | 多个 regression case | default/gate | 否 | keep-default | 删除会把普通 review 扩成 full |
| evidence authority 与 P0/P1 admission | 防无证据 blocker | 核心目标、scorecard validator | invariant | 否 | keep-invariant | 删除会错误升级严重性 |
| 所有 branch 先 inventory + diagnostic | 强制本地包检查 | 静态包 review 有价值 | mandatory stage | 部分 | relax | 仅对可达本地包保留；否则会误判 unknown |
| full/release 12 维与语义审计 | 确保发布覆盖 | release 合同 | mandatory stage | 否 | keep-default | 删除会降低发布 coverage |
| quick 也读模板、资源和邻近 fixture | 追求完整上下文 | 没有必要性证据；成本 trace 负面 | mandatory spillover | 是 | delete / relax | 预计无目标失败；需 ablation 验证 |
| scorecard validator | 机械计算与一致性 | 集成测试和本次验证 | invariant | 否 | keep-invariant | 删除会产生错误 score/band |
| publication 与 README 分离 | 防越权持久化 | behavior baseline 失败 | invariant | 否 | keep-invariant | 删除会把 seal/register 混入 review |

复杂度结论为 `over-specified`。原因是 common workflow 在 quick/evidence-only branch 中产生可观察的过度执行和错误 blocker。这个结论不否定 full/release 的严格 gate，也不建议删除安全和授权不变量。

## 信息层级图

| 内容 | 类型 | 适用 branch | 当前位置 | 每次需要 | 到达 pointer / 事实源 | 最小控制结论 | 建议 |
| --- | --- | --- | --- | ---: | --- | --- | --- |
| 模式、不可信边界、evidence admission | in-file-step | 全部 | `SKILL.md` | 是 | 直接加载 | keep-invariant/default | 保留 |
| 评分纪律摘要 | in-file-reference | 计分 review | `SKILL.md` | 否 | scoring pointer | needs-ablation | 可压缩并减少与 scoring model 重复 |
| 12 维量表 | disclosed-reference | full/release | `references/review-dimensions.md` | 否 | 明确 branch | keep-default | 保留 |
| architecture owner | disclosed-reference | 状态机信号 | `references/architecture-boundaries.md` | 否 | 明确 branch | keep-default | 改强 outcome pointer |
| 静态/plugin eval 规则 | disclosed-reference | 对应目标 | 两个 target reference | 否 | 明确 branch | keep-default | 保留 |
| report/scorecard template | disclosed-reference / asset | 输出阶段 | `assets/` | 否 | workflow step 6–7 | relax | quick 使用短报告 |
| schema、Codex metadata、目录、help | environment-lookup | capability/script | repo source、`--help` | 否 | 环境事实 | keep-default | 不缓存大段事实 |
| 官方 Agent Skills 规范 | environment-lookup | release | source map URL | 否 | current-check | keep-invariant | 每次 release 重查 |

## 完成边界审计

| 步骤或规则集 | 当前标准 | 清楚 | 可检查 | 要求充分 | 覆盖完整 | 提前完成风险 | 建议 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 模式选择 | 互斥 quick/full/release/delta | 是 | 是 | 是 | 是 | 低 | 保留 |
| 本地 inventory / diagnostic | 枚举并运行 inspector | 部分 | 是 | 对本地包是 | 对 evidence object 否 | 高 | 先判断材料类型和 target 可达性 |
| finding/unknown ledger | score 前完成；低分有归属 | 是 | 是 | 是 | 是 | 低 | 保留 validator |
| P0/P1 admission | 7 个必需字段和反证 | 是 | 是 | 是 | 是 | 低 | 保留 |
| full/release 审计 | 12 维、最小合同、适用 audit | 是 | 是 | 是 | 是 | 中 | 仅在模式 branch 内强制 |
| 脚本静态安全检查 | “先做静态检查” | 部分 | 部分 | 部分 | 否 | 中 | 至少读 imports、写入/进程/网络和 CLI entrypoint，再安全运行 `--help` |
| scorecard 验证 | validator 无 error | 是 | 是 | 是 | 是 | 低 | 保留 |
| 正式发布 | 命令成功，正式目录和 sealed batch 可核对 | 是 | 是 | 是 | 是 | 低 | 保留；README 仍独立 |

## 架构与职责归属

- **Skill 负责的策略：** 使用时机、模式、evidence authority、finding admission、审计方法、发布授权边界。
- **Schema 或客户端负责的事实：** `agents/openai.yaml` 字段、tool 参数、metadata 限制和 runtime 能力。
- **Runtime 负责的状态：** Codex 进程、后代清理、隔离、batch open/sealed、target coverage 和生命周期。
- **脚本候选：** 已实现 package inspection、scorecard calculation、eval materialization 和 contract validation。
- **仅属于 role 的约束：** `agents/openai.yaml` 只保留显示、默认 prompt 和 implicit invocation 策略。
- **仅属于 eval 或 issue 的问题：** 未验证边界、方差、ablation 和未来客户端差异。
- **自然语言状态机风险：** low。

## 脚本与资源

- **已有脚本：** `inspect_skill_target.mjs`、`validate_scorecard.mjs`、`run_static_skill_evals.mjs`。
- **接口、依赖和安全质量：** 三者非交互并支持 `--help`。诊断器只读。eval runner 的写入固定在项目 `.tmp`，并验证 symlink、路径、source digest、隔离和凭据清理。
- **模型仍在重复的确定性逻辑：** behavior full case 手算 score 和 band，产生了不一致的 effective band；full/release 应始终走 validator。
- **Reference 和 asset 可达性：** 全部一层可达；无缺失和深链。
- **重复：** evidence taxonomy 和授权边界在主文件与详细 reference 中有少量摘要重复，当前有跨 audience 用途。
- **Scattering 与 co-location：** 12 维、评分、architecture 和 target eval 各有明确 owner 文件。
- **不必要缓存的环境事实：** 未发现大段 schema 缓存；source map 只保留 URL、用途和日期。
- **过期或孤立资源：** 未发现。

## 评测与证据

- **批次：** `20260813T042102Z-self-release-2026-08-13-52537d97`
- **来源：** commit `e3ec40af4b65f7e6bfb2e834c490c0cf55a532be`，`inScopeDirty=false`
- **模型：** `gpt-5.6-luna`，Codex CLI 0.147.0
- **进程管理：** managed；完整后代跟踪和清理
- **Materialization：** pass；package digest 匹配
- **Trigger：** complete，7/12 pass；六个正例全过，五个负例失败
- **Behavior：** 14 case、28 current/baseline run 全部 complete；一个写入 case 使 mechanical target fail
- **定性 trace：** failed。授权、untrusted、delta 和 source/final/model 分层有增益；缺材料严重性、self-review、architecture subtraction 和若干输出合同有失败
- **Baseline：** owner-removed no-skill baseline
- **Ablation：** 本 Skill 自身没有；portable corpus 中的设计 case 不是 executed release evidence
- **成本：** current 1,980,277 tokens / 1,017.6s / 79 commands；baseline 1,115,666 tokens / 532.6s / 49 commands
- **发布仍缺少的证据：** 三个 P1 修复后的新完整批次；高风险 behavior 的重复运行；独立 reviewer 复核

## 当前官方来源核对

核对日期：2026-08-13。

- [Agent Skills specification](https://agentskills.io/specification)
- [Best practices for skill creators](https://agentskills.io/skill-creation/best-practices)
- [Optimizing skill descriptions](https://agentskills.io/skill-creation/optimizing-descriptions)
- [Using scripts in skills](https://agentskills.io/skill-creation/using-scripts)
- [Evaluating skill output quality](https://agentskills.io/skill-creation/evaluating-skills)

## 最小改进路线

### 现在——发布阻断

1. 用 train 数据重构 description，不看 validation 原词继续堆负面清单。
2. 修复 draft-persistence allowlist，使必要父目录不触发 mechanical failure。
3. 把 supplied-evidence/unknown 规则移到 diagnostic 前，并让 inspector 只在本地 target 可达时运行。
4. 重跑完整 release-required suites；新批次必须 materialization pass、strict trigger validation pass、behavior mechanical pass，并完成定性 trace review。

### 下一步——高价值质量改进

1. 让 quick/evidence-only branch 在 inventory 前结束不适用流程。
2. 修复 state-machine 输出，让 runtime/script/eval owner 和迁移候选先于 prose 规则。
3. 修复 self-review 完成边界：读 CLI entrypoint，并实际运行 `--help` 后再报告接口 finding。
4. 对当前 controller 与精简版做 ablation，要求质量不降且 token、时间、命令减少。

### 以后——评测和独立复核

1. 对 publication、draft、self-review、state-machine、seal-only 等高风险 case 每例运行至少 3 次。
2. 获取独立 reviewer。需要声明跨客户端时，再补 Claude 或其它目标客户端证据。

## 停止决定

本轮 release 评审合同已完成。包结构、官方来源、脚本、12 维、最小控制、pointer、信息层级、完成边界、完整 eval 和 trace 都已检查。继续修改报告不会改变 3 个 observed/structural P1。

因此现在应停止评审并发布这份 `pass-after-fixes` 报告。下一轮只应在 F-001、F-002、F-003 有修复和新完整 eval 批次后开始。此次正式发布不登记 README。
