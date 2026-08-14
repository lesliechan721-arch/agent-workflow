# `<Skill name>` 评审技术附录

本附录服务复核和追溯。它不是主报告，也不重复主报告的判断和行动。只保留当前模式适用的审计；不生成空章节或 `not_applicable` 章节。

## Appendix A — 评审范围与合同

| 项目 | 从材料提取的结论 | 状态 | Evidence |
| --- | --- | --- | --- |
| 目标问题 | | known / unknown | |
| 已观察失败 | | known / unknown | |
| 成功标准 | | known / unknown | |
| 目标环境或客户端 | | known / unknown | |
| 范围外事项 | | known / unknown | |
| 相邻 Skill | | known / unknown | |
| 发布要求 | | known / unknown | |

## Appendix B — 完整发布门禁

主报告只显示失败和未知 gate。本表保存所有适用 gate 的完整状态。

| Gate ID | 状态 | 严重性 | Finding / Unknown IDs | Evidence | 原因 |
| --- | --- | --- | --- | --- | --- |
| package-validity | | | | | |
| critical-artifacts | | | | | |
| goal-alignment | | | | | |
| capability-validity | | | | | |
| safety-permissions | | | | | |
| architecture-ownership | | | | | |
| release-evidence | | | | | |
| eval-validity | | | | | |
| eval-change-safety | | | | | |

## Appendix C — Full Scorecard

full/release 包含全部 12 个维度。表中只存 ID 和短结论；详细证据保存在 JSON ledger。

| 维度 | 权重 | 分数 | 置信度 | Finding IDs | Unknown IDs | 结论 |
| --- | ---: | ---: | --- | --- | --- | --- |
| 规范与包完整性 | 6 | | | | | |
| 问题基础与实际价值 | 8 | | | | | |
| 调用策略、触发条件与 Context Pointer | 10 | | | | | |
| 范围、边界与组合性 | 8 | | | | | |
| 程序与完成边界 | 10 | | | | | |
| 最小充分控制与模型自由度 | 14 | | | | | |
| 信息层级、资源与渐进式披露 | 10 | | | | | |
| 职责归属与自然语言状态机风险 | 10 | | | | | |
| 脚本与确定性自动化 | 7 | | | | | |
| Eval 设计、Oracle 有效性与修改安全 | 9 | | | | | |
| 可靠性、安全与兼容性 | 4 | | | | | |
| 剪枝、事实源与变更纪律 | 4 | | | | | |

- **加权总分：**
- **原始质量带：**
- **有效质量带：**
- **复杂度上限原因：**

## Appendix D — Finding Admission Records

每个 P0/P1 必须有完整记录。P2/Advisory 只在需要复核定级时展开；其它项目保留在 JSON。

### `<F-ID>`

- **Location：**
- **Exact claim：**
- **Affected scenario：**
- **Material impact：**
- **Direct evidence：**
- **Counterevidence：**
- **Owner：** Skill | Schema | Client | Runtime | Script | Role | Eval | Project | User
- **Minimal action：**
- **Validation：**

| Premise | Source role | Evidence | Status |
| --- | --- | --- | --- |
| | | | supported / unsupported / unknown |

| Reachability kind | Path | Evidence | Status |
| --- | --- | --- | --- |
| entry-gate / execution-path | | | supported / unsupported / unknown |

## Appendix E — 适用专项审计

下面的小节只在对应对象存在时保留。主报告只有在审计产生 finding、决策关键 unknown 或结论变化时才引用这些结果。

### Invocation / Context Pointer Audit

| Pointer | 目标材料 | 触发 branch | 意图前置 | 重复 branch | 重复正文身份 | Eval 证据 | 建议 |
| --- | --- | --- | ---: | ---: | ---: | --- | --- |

### Minimum Effective Control Audit

#### 最小行为合同

只根据目标问题、真实失败、硬性规范、领域事实和操作脆弱性写不超过 8 条；不要复制现有章节组织。

1.

#### 控制面

| Signal | Count / observation | Risk |
| --- | ---: | --- |
| Mandatory stages | | |
| Hard gates | | |
| Fixed intermediate artifacts | | |
| Prohibitions | | |
| Conditional branches | | |
| Fixed output fields | | |

#### 必要性映射与简化候选

| 当前行为块 | 改变的行为 | 依据 | 当前控制类型 | 模型默认能否处理 | 处理建议 | 删除或放宽风险 |
| --- | --- | --- | --- | ---: | --- | --- |

处理建议只能是：`keep-invariant`、`keep-default`、`relax`、`move`、`delete`、`needs-ablation`。

### Information Hierarchy Map

| 内容 | 类型 | 适用 branch | 当前位置 | 每次需要 | Pointer 或环境事实源 | 最小控制结论 | 建议 |
| --- | --- | --- | --- | ---: | --- | --- | --- |

类型只能是：`in-file-step`、`in-file-reference`、`disclosed-reference`、`environment-lookup`。

### Completion Boundary Audit

只列最小有效控制审计决定保留为强制流程的步骤。

| 步骤或规则集 | 当前标准 | 清楚 | 可检查 | 要求充分 | 覆盖完整 | 提前完成风险 | 建议 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |

### Architecture and Ownership

- **Skill 负责的策略：**
- **Schema 或客户端负责的事实：**
- **Runtime 负责的状态：**
- **脚本候选：**
- **仅属于 role 的约束：**
- **仅属于 eval 或 issue 的问题：**
- **自然语言状态机风险：** low | medium | high

### Scripts and Resources

- **已有脚本或正确省略：**
- **接口、依赖和安全质量：**
- **模型仍在重复的确定性逻辑：**
- **Reference 和 asset 可达性：**
- **重复、scattering 与 co-location：**
- **不必要缓存的环境事实：**
- **过期或孤立资源：**

### Eval Case Audit

存在 eval，或当前判断使用 eval 结果时，使用 `eval-audit-report-template.md` 的适用部分。至少保存 optimization policy、错误代价、case admission、二元指标、mixed case、baseline、方差、failure triage、修改决定和仍缺的发布证据。

## Appendix F — Delta Record

只在 full/release 明确比较上一版时使用。delta 模式使用短报告，不生成本附录。

- **上一版 P0/P1 关闭情况：**
- **受影响维度：**
- **直接回归：**
- **行为指标变化：**
- **最小行为合同与复杂度变化：**
- **新增规则及其替代内容：**
- **沉积候选：**
- **净变化：** smaller | neutral | larger
