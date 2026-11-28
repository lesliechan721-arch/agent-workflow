# 大型与自定义工作流设计（Compose / Figure It Out）

当现有单一路线无法覆盖完整目标，或大型跨模块迁移、多部分改造、长时自主运行需要统一阶段、依赖、验证与审计轨迹时采用。仅要求设计路线时，交付方案后停止；已有执行授权则先定好可审阅阶段，再立即执行。

## Phase A：定框与可证伪完成标准

动工前写清三件事：
1. **可证伪的完成谓词**：什么样的真实产品运行输出代表成功，什么代表失败（不能是“改得更好”）。
2. **量化范围与阻塞**：拆清大致单元数、主要未知和已暴露阻塞。
3. **相称严谨度**：不可逆修改与高影响面加严门禁和制品；低风险可逆步骤保持轻量。**严谨度来自硬检查与真实产物，不来自“更仔细一点”。**

## Phase B：按风险倒推阶段（先建验证基线再动功能）

1. 按可独立验收的原子单元拆解，**风险最高、最可能推翻假设的未知排最前**；先建脚手架与验证工具，再写业务功能。
2. **先搭验证 harness 并采基线**：动手改功能前先建好可复跑的对比检查并保存改前基线，使后续每步都能输出“旧值 vs 新值”。
3. 复用既有专业能力：不可逆大设计过 `dev-architect` / `dev-arena`（已清晰的机械改动绝不硬开竞赛）；仅沿无共享写入的天然接缝做并行扇出，每名子代理配独立目录或 worktree，经 `spawn-subagent`（默认中性角色）用 `assets/implementation-task-template.md` 交接。
4. 明确写下阶段清单（输入、负责人、产物、依赖、验证谓词与失败出口）；复用 `playbooks/feature.md`、`playbooks/refactor.md`、`playbooks/hillclimb.md` 作为子阶段，不重写它们的方法。

## Phase C：逐单元假设实验循环

每个有未知的单元都是一次受控实验：**写假设 → 做最小变更 → 在真实产物上对照谓词核验 → 推进则保留，否则回滚**。每完一单元即刻验证，绝不攒到末尾一起查。

- **亲自检视真实产物**：不轻信子代理自述；某项检查通过得“太轻松”时，先怀疑观察手段本身。
- **三态裁决**：每个检查只能标 **`VERIFIED` / `NOT VERIFIED` / `INCONCLUSIVE`**；`INCONCLUSIVE` 不等于通过，不掩盖负结果。
- 发现验证门禁自身有问题时，单独修正门禁再重跑，不绕过门禁。

## Phase D：维护可审计决策日志

每个关键分叉、单元验收结果、回滚、阻塞或方案转向，都实时追加到 `decisions.tsv`（不攒到最后补写）：

```sh
node scripts/decision-log.mjs init <logfile>
node scripts/decision-log.mjs append <logfile> --phase <阶段> --decision "<决定>" --why "<plain-language 原因>" --evidence "<commit/路径/输出>" --result "VERIFIED|NOT VERIFIED|INCONCLUSIVE|reverted"
```

交回前对照真实执行过程抽查日志，确认每条 evidence 路径可达且与事实一致；若有遗漏或误记，**只能追加更正行覆盖，绝不删改历史行**。重要收口前可用 `dev-review` 做独立核验。

## Phase E：端到端整体验收

对照 Phase A 完成谓词在**真实产品**上整体验收（不止跑自建 harness），核对累计 diff 与跨阶段组合；局部绿灯不替代整体完成。若过程暴露反复同类坑，提示用户后续可用 `dev-correct` 固化进仓库结构。

**回复**：设计的阶段路线与严谨度理由、`decisions.tsv` 路径、逐项对照完成谓词的 `VERIFIED / NOT VERIFIED / INCONCLUSIVE` 结果、累计改动与剩余未决项。
