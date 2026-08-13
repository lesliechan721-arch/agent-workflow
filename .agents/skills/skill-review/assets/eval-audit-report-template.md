## Eval Case Audit

只保留适用部分。目标没有 eval，且当前判断不使用 eval 结果时，记录 `not_applicable` 和理由。

### 目标和错误代价

| 项目 | 判定 | 证据 |
| --- | --- | --- |
| Optimization policy | recall-first / precision-first / balanced / critical | |
| False-negative cost | low / medium / high / critical | |
| False-positive cost | low / medium / high / critical | |
| Policy rationale | | |

### Eval 门禁

| Gate | 状态 | 证据 | 原因 |
| --- | --- | --- | --- |
| eval-validity | pass / fail / unknown / not_applicable | | |
| release-evidence | pass / fail / unknown / not_applicable | | |
| eval-change-safety | pass / fail / unknown / not_applicable | | |

### Suite 构成

| 指标 | 数量或判定 |
| --- | ---: |
| Cases | |
| Scenario families | |
| Decision boundaries / minimal pairs | |
| Representative cases | |
| Regression cases | |
| Boundary cases | |
| Challenge cases | |
| Diagnostic-only cases | |
| Stale / ambiguous cases | |

### Case Admission 结果

| Case | 层级 | Role | Provenance | Oracle 置信度 | 前提充分 | Rule trace | 现实 | 决策 |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | --- |

决策只使用：`release-counted`、`diagnostic-only`、`needs-adjudication`、`stale`、`remove`。

### Trigger 或其它二元决策结果

| 指标 | 当前结果 | Baseline / previous | 解释 |
| --- | ---: | ---: | --- |
| Positive recall | | | |
| False-negative rate | | | |
| Negative specificity | | | |
| False-positive rate | | | |
| Mixed / uncertain cases | | | |

没有已记录的错误代价政策时，不把这些指标压缩成一个 accuracy。

### Behavior、outcome 和 cost 证据

| Scenario family | With Skill | Baseline | Quality delta | Token/time delta | 方差 | 证据强度 |
| --- | --- | --- | ---: | ---: | --- | --- |

### Failure triage

| Case / assertion | Failure class | 可复现 | Root owner | 动作 | 理由 |
| --- | --- | ---: | --- | --- | --- |

Failure class：`skill-defect`、`oracle-defect`、`fixture-defect`、`grader-defect`、`runtime-or-tool-defect`、`model-variance`、`stale-case`、`insufficient-runs`、`expected-tradeoff`、`unknown`。

### Eval-driven 修改决策

- **修改内容：**
- **受影响场景族：**
- **为什么是 Skill defect：**
- **原始失败证据：**
- **Minimal pair / 相反标签风险：**
- **Validation、sanity 和 regression 重跑：**
- **Quality delta：**
- **Context / branch / maintenance delta：**
- **决策：** accept | reject | collect-more-data | fix-eval-first | accepted-risk

### Eval 维度

- **分数：** 0–5
- **置信度：** high | medium | low | unknown
- **适用评分上限：**
- **摘要：**

### 停止决定

说明下一步是修改 Skill、修复 eval、增加运行、接受取舍，还是停止迭代。
