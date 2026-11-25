<!-- aw:compatibility-generic -->
支持子代理委派的通用 Agent 宿主；本通用产物不包含 AW 托管外部执行器。
<!-- /aw:compatibility-generic -->

<!-- aw:compatibility-native-only -->
AW 支持的宿主；当前仅启用宿主原生委派。
<!-- /aw:compatibility-native-only -->

<!-- aw:compatibility-with-external -->
AW 支持的宿主及所选执行器；外部执行与自省需要支持托管命令的 AW、已应用的平台配置和对应后端。
<!-- /aw:compatibility-with-external -->

<!-- aw:generic-description -->
description: 需要实际委派、沟通、等待或续接子代理时使用，包括其它技能要求委派，或需确定执行配置、组织隔离上下文并管理等待与验收的情况。已有完整调度与生命周期约定、仅讨论是否委派，或自身只需完成已分配任务时不使用。
<!-- /aw:generic-description -->

<!-- aw:generic-short-description -->
short-description: 确定执行配置、组织隔离任务上下文并管理子代理生命周期
<!-- /aw:generic-short-description -->

<!-- aw:routing-generic-inline -->
@@SUMMARY@@

显式配置对象省略 `executor` 时按 `native` 解释（区别于自由文本仅提厂商或模型偏好）。调用方已明确选定原生配置时直接复用；@@DEFAULT_RULE@@明确要求 AW 托管外部执行器或不可用硬约束时，停止并报告缺口。
<!-- /aw:routing-generic-inline -->

<!-- aw:routing-generic-selection -->
@@SUMMARY@@

显式配置对象省略 `executor` 时按 `native` 解释（区别于自由文本仅提厂商或模型偏好）。按当前已掌握信息分流：
- **调用方已明确选定原生配置**：跳过选型文档，直接进入下方原生委派分支。
- **未指定配置**：先读取 执行器选型（`references/executor-selection.md`）选择档位，不省略选型步骤直接沿用默认。
- **明确要求外部执行器或不可用硬约束**：停止并报告缺口，不私自切换执行器。
<!-- /aw:routing-generic-selection -->

<!-- aw:routing-native-inline -->
@@SUMMARY@@

显式配置对象省略 `executor` 时按 `native` 解释（区别于自由文本仅提厂商或模型偏好）。调用方已明确选定原生配置时直接复用；@@DEFAULT_RULE@@明确要求外部执行器、特定外部厂商或不可用硬约束时，停止并报告缺口，不私自改派 `native`。
<!-- /aw:routing-native-inline -->

<!-- aw:routing-native-selection -->
@@SUMMARY@@

显式配置对象省略 `executor` 时按 `native` 解释（区别于自由文本仅提厂商或模型偏好）。按当前已掌握信息分流（**不要省略选型直接沿用默认**）：
- **调用方已确定 `native` 配置**：跳过选型文档，直接进入下方 `native` 分支。
- **未指定配置**：先读取 执行器选型（`references/executor-selection.md`）选择档位后再委派。
- **明确要求外部执行器、特定外部厂商或不可用硬约束**：停止并报告缺口，不私自切换执行器。
<!-- /aw:routing-native-selection -->

<!-- aw:routing-external-uniform -->
@@SUMMARY@@

显式配置对象省略 `executor` 时按 `native` 解释（区别于自由文本仅提厂商或模型偏好）。按当前已掌握信息分流：
- **未指定执行器且无厂商、模型或异构约束**：@@DIRECT_BASELINE@@
- **已有可执行方案**：已确定 `native`，或已确定上方精确外部 `key` 且已定 `model`（未另要求按复杂度选推理强度）或明确沿用默认 → 跳过选型文档，直接进入下方对应执行分支。
- **需要匹配或自省**：自由文本按厂商/平台/模型偏好指定、要求异构对比，或已定外部 `key` 但省略 `model`（或需按复杂度选推理强度）且未明说沿用默认 → 先读取 选型与自省（`references/executor-selection.md`），确定方案后再委派。
- **要求无法满足**：明确指定了不可用的执行器、厂商或硬约束 → 停止并报告缺口，不私自切换执行器或材料目的地。
<!-- /aw:routing-external-uniform -->

<!-- aw:routing-external-full -->
@@SUMMARY@@

显式配置对象省略 `executor` 时按 `native` 解释（区别于自由文本仅提厂商或模型偏好）。按当前已掌握信息分流（**不要省略选型直接沿用默认**）：
- **已有可执行方案**：已确定 `native`，或已确定上方精确外部 `key` 且已定 `model`（未另要求按复杂度选推理强度）或明确沿用默认 → 跳过选型文档，直接进入下方对应执行分支。
- **需要选型、匹配或自省**：未指定配置、自由文本按厂商/平台/模型偏好指定、要求异构对比，或已定外部 `key` 但省略 `model`（或需按复杂度选推理强度）且未明说沿用默认 → 先读取 选型与自省（`references/executor-selection.md`），确定 `{ executor, model?, reasoningEffort? }` 后再委派。
- **要求无法满足**：明确指定了不可用的执行器、厂商或硬约束 → 停止并报告缺口，不私自切换执行器或材料目的地。
<!-- /aw:routing-external-full -->

<!-- aw:delegation-generic -->
### 原生 / 宿主子代理

- **配置与回退**：模型和推理强度按 `明确要求 > 配置偏好 > 宿主默认` 采用；配置偏好经实际报错确认不可用且允许回退时降级并说明实际值。
- **角色与默认指令**：使用当前宿主可用的子代理机制；未指定角色时，将 任务指令（`assets/task-instructions.md`）的核心边界并入任务提示。
- **缺口停止**：调用方指定的角色不可用、宿主无可用原生子代理能力或硬要求不受支持时，停止并报告缺口。
<!-- /aw:delegation-generic -->

<!-- aw:delegation-antigravity -->
### `native` 原生委派（Antigravity）

- **首选通道（`swarm`）**：本技能显式指示你在顶层交互会话中优先通过 `swarm` 发起原生委派（除非调用方显式要求依赖宿主硬权限隔离的原生 `TypeName`，如只读 `research`）。
- **模型、角色与收尾（`swarm`）**：模型按 `明确要求 > 配置偏好 > 省略沿用当前模型` 传入完整模型 ID 或展示名，不传裸基名或独立 `reasoningEffort`（配置偏好经报错确认不可用且允许回退时降级并说明）。未指定角色时，将 任务指令（`assets/task-instructions.md`）的核心边界并入 `brief`；普通单次委派无需额外添加监控/播报角色，核验产物且无需续接后 `kill` 清理。
- **回退通道（`invoke_subagent`）**：仅当当前会话未暴露 `swarm`（如无头 `agy` CLI）、受限于子会话无法创建 swarm（如返回 `no swarm yet; only the coordinator can start one`），或调用方显式要求宿主硬权限隔离 `TypeName`（如 `research`）时回退 `invoke_subagent`；角色使用调用方指定 `TypeName` 或宿主默认角色（未指定角色时将 任务指令（`assets/task-instructions.md`）的核心边界并入任务提示）。命中配置偏好中的精确模型 ID 且允许回退时，降级为 `Model: "inherit"` 并在汇报中说明实际通道与模型降级；调用方**显式硬要求**精确模型且无可用外部通道时，停止并报告缺口。
- **缺口停止**：调用方指定的角色不可用、宿主无可用原生子代理工具或硬要求不受支持时，停止并报告缺口。
<!-- /aw:delegation-antigravity -->

<!-- aw:delegation-native -->
### `native` 原生委派

- **配置与回退**：使用宿主原生子代理工具，模型和推理强度按 `明确要求 > 配置偏好 > 宿主默认` 采用；配置偏好经实际报错确认不可用且允许回退时降级并说明实际值。
- **角色与默认指令**：使用宿主默认角色；未指定角色时，将 任务指令（`assets/task-instructions.md`）的核心边界并入任务提示。
- **缺口停止**：调用方指定的角色不可用、宿主无可用原生子代理工具或硬要求不受支持时，停止并报告缺口。
<!-- /aw:delegation-native -->

<!-- aw:delegation-external -->
### 非 `native` 外部委派

- **启动、等待、取结果或停止**：读取 外部执行协议（`references/external-execution.md`），通过 AW 托管命令执行。
- **向已有外部 `run` 发消息或终态恢复**：直接读取 通讯与恢复（`references/communication.md`）。
<!-- /aw:delegation-external -->

<!-- aw:selection-intro-native -->
本文件用于将未指定的调用意图解析为确定的 `{ executor, model?, reasoningEffort? }`。确定后回到 `SKILL.md` 按原生子代理分支委派。
<!-- /aw:selection-intro-native -->

<!-- aw:selection-intro-external -->
本文件用于将调用意图解析为确定的 `{ executor, model?, reasoningEffort? }`。确定后回到 `SKILL.md` 按 `native` 或 外部执行协议（`references/external-execution.md`）委派。
<!-- /aw:selection-intro-external -->

<!-- aw:selection-router-native -->
## 按调用意图分流

- **调用方已明确选定原生配置**（含显式配置对象省略 `executor`）：直接复用，**禁止用“默认执行档位”覆盖已定执行器**。
- **未指定配置**：先按“自定义配置”（若有）匹配适用范围，未命中再按“内建档位”选出足够完成任务的最低档。
- **硬要求与继承回退**：调用方**显式要求**外部执行器或不可用硬约束时，停止并报告缺口，不私自切换执行器；仅未指定执行器而命中当前平台不可用的继承默认档位时，回退宿主原生 `native` 并在汇报中显式说明。
<!-- /aw:selection-router-native -->

<!-- aw:selection-router-external -->
## 按调用意图分流

| 调用意图 | 动作 |
| --- | --- |
| **调用方已定 `native` 或精确外部 `key`** | **禁止用“默认执行档位”覆盖已定执行器**（显式配置对象省略 `executor` 按 `native` 解释）。已定 `native` 直接回 `SKILL.md` 执行；已定外部 `key` 且缺 `model`（或需按复杂度选推理强度）且未明说沿用默认时，直接跳至“外部执行器自省”运行 `inspect --executor "<key>"`；已定外部 `key` 与 `model` 且仅省略推理强度、未要求按复杂度挑强度时，可跳过 `inspect` 沿用默认。 |
| **自由文本指定厂商、平台或模型偏好，或要求异构/不同厂商** | 先核对下方“自定义配置”（若有）是否命中对应适用范围，并查“可用执行器”筛选候选（异构时排除与 `native` 宿主同源者）；未定 `model`、需核实某模型归属或需按复杂度选推理强度时，运行 `inspect --executor "<key>"` 确认。 |
| **未指定执行器与约束** | 先按“自定义配置”（若有）数组顺序匹配，未命中再按“内建档位”选出足够完成任务的最低档；若命中外部执行器且省略 `model`（或需按复杂度选推理强度），再运行 `inspect --executor "<key>"` 选型。 |

调用方**显式要求**的执行器、厂商或硬约束无可用匹配时，停止并报告缺口，不私自切换执行器或材料目的地；仅在未指定执行器而命中当前平台不可用的继承默认档位时，回退宿主原生 `native` 并在汇报中显式说明。
<!-- /aw:selection-router-external -->

<!-- aw:custom-profiles-section -->
### 自定义配置

按以下数组顺序匹配适用范围，采用第一个匹配项（可用于异构审查或专项场景）。

| 适用范围 | executor | model | reasoningEffort |
| --- | --- | --- | --- |
@@ROWS@@

### 内建档位

仅在调用方未指定执行器、无厂商/异构约束且未命中上方自定义配置时采用；按歧义、耦合、验证难度和遗漏代价选择足够的最低档。
<!-- /aw:custom-profiles-section -->

<!-- aw:default-profiles-uniform-default -->
当前全部难度档位（`simple` / `general` / `complex` / `advanced`）共用 `native`（宿主默认）：无执行器、厂商或异构约束时，直接采用 `native`（宿主默认）。
<!-- /aw:default-profiles-uniform-default -->

<!-- aw:default-profiles-uniform-baseline -->
当前全部难度档位（`simple` / `general` / `complex` / `advanced`）共用 `general` 基线：@@LABEL@@。无执行器、厂商或异构约束时直接采用此基线。
<!-- /aw:default-profiles-uniform-baseline -->

<!-- aw:default-profiles-table -->
仅在调用方未指定执行器且无厂商/异构约束时采用；按歧义、耦合、验证难度和遗漏代价选择足够的最低档（未单独配置的档位继承 `general` 基线）。

@@TABLE@@
<!-- /aw:default-profiles-table -->

<!-- aw:introspection-section -->
## 外部执行器自省（`inspect`）

常规选型直接运行 `inspect --executor "<key>"`（上方“可用执行器”表已含已配置清单；无参 `inspect` 仅用于离线核对 `communication`/`resume` 等标志）：
- **跳过**：已确定 `model` 且未要求按复杂度选推理强度（或两项均已确定）、用户明确要求沿用后端默认，或同会话内已获取过该执行器目录。
- **调用**：仅确定外部 `key` 但省略 `model`、明确要求按复杂度选推理强度，或需在候选执行器中核实目标模型与 `efforts`。
- **推理强度三态（`effortSupport`）**：`[efforts=low,...]`（`separate`）按复杂度从中选用 `--reasoning-effort` 或省略沿用默认；`[efforts=none]`（`none`，如已将强度编码于模型 ID 中的变体模型）**勿传 `--reasoning-effort`**；未标注 `efforts`（`unknown`）在未显式要求时省略 `--reasoning-effort` 沿用后端默认。
- **环境不可用（`environment=unavailable`）**：表示后端 CLI 缺失、未认证或配置非法；不要盲目继续 `start`，按 `<diagnostic>` 核对环境问题或停止并报告缺口。
- **未探测环境（`environment=skipped`）**：表示按静态白名单（`modelsPolicy: "override"`）跳过探针，或第三方适配器不支持 `introspect`；若返回静态模型列表（`source=configured`）可直接按白名单发起 `start`，真实后端环境由 `start` 校验。
- **仅目录不可用（`environment` 为 `available` 或 `skipped`、且 `source=unavailable`，无静态模型声明）**：省略 `--model` / `--reasoning-effort` 沿用后端默认并在汇报中说明；**严禁编造未验证的模型 ID**。

```text
{{aw.command}} inspect --executor "<key>"
{{aw.command}} inspect
```

- 带 `--executor "<key>"`：按执行器 `modelsPolicy`（默认 `merge` 与动态探针融合；`override` 且静态 `models` 非空时直接采用静态白名单）返回 `source=dynamic|merged|configured|unavailable`、`environment=available|unavailable|skipped`、可用模型与三态 `effortSupport` / `efforts`。结合任务复杂度与目录说明选定具体模型及推理强度。
- 无 `--executor`：离线列出当前平台已配置外部执行器摘要（含 `communication`/`resume` 开关），不启动后端进程。
<!-- /aw:introspection-section -->

<!-- aw:readme-lead-generic -->
本 Skill 用于**实际委派**：确定执行配置、准备隔离任务上下文、等待与续接，并亲自核验结果。核心方法见 [SKILL.md](SKILL.md)。
<!-- /aw:readme-lead-generic -->

<!-- aw:readme-lead-native -->
本 Skill 用于**实际委派**：选定原生或外部执行器与配置、准备隔离任务上下文、等待与续接，并亲自核验结果。核心方法见 [SKILL.md](SKILL.md)。
<!-- /aw:readme-lead-native -->

<!-- aw:readme-scope-generic -->
当前为 `generic` 通用产物，仅包含宿主原生委派能力，不包含 AW 托管外部执行器分支：
<!-- /aw:readme-scope-generic -->

<!-- aw:readme-scope-external -->
按决策阶段按需读取资料，普通原生委派无需预读外部协议：
<!-- /aw:readme-scope-external -->

<!-- aw:readme-scope-native-only -->
当前平台未启用外部执行器，已自动省略外部执行协议与通讯文档：
<!-- /aw:readme-scope-native-only -->

<!-- aw:readme-bullet-selection-external -->
- 需要按任务难度选档、按厂商/平台/模型偏好匹配、筛选异构执行器或运行 `inspect` 自省选型时，读取 [选型与自省](references/executor-selection.md)。
<!-- /aw:readme-bullet-selection-external -->

<!-- aw:readme-bullet-selection-native -->
- 未指定配置需按任务难度选档时，读取 [执行器选型](references/executor-selection.md)。
<!-- /aw:readme-bullet-selection-native -->

<!-- aw:readme-bullet-external -->
- 选定非 `native` 外部执行器后，读取 [外部执行协议](references/external-execution.md)：`start`/`wait`/`result`/`stop`、共用回执格式、三态 `--instructions-file` 与预算边界。
- 向运行中外部代理发消息（`communication=true`）、恢复已结束任务（`resume=true`），或收到过程消息与投递缺口时，读取 [通讯与恢复](references/communication.md)。
<!-- /aw:readme-bullet-external -->

<!-- aw:readme-bullet-instructions-external -->
- [任务指令](assets/task-instructions.md) 为中性默认角色正文，供无专属角色或需内联默认角色的原生委派与省略 `--instructions-file` 的外部委派共用。
<!-- /aw:readme-bullet-instructions-external -->

<!-- aw:readme-bullet-instructions-native -->
- [任务指令](assets/task-instructions.md) 为中性默认角色正文，供无专属角色或需内联默认角色的原生委派纳入任务提示。
<!-- /aw:readme-bullet-instructions-native -->
