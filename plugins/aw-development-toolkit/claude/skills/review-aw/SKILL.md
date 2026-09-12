---
name: review-aw
description: >-
  审核 AW 插件内单个源 Skill、Plugin、Catalog、跨插件 workflow 或能力 portfolio 时使用。定位 source 与适用产物，按授权准备缺少的评审运行包，再使用通用 Reviewer；保留来源、profile 与修改 owner。只读审核被审源码；报告归档和 Release Check 按明确请求执行。
user-invocable: true
compatibility: 需要 Node.js 22+、公开 aw CLI、agent-content-toolkit 和 agent-skill-toolkit；完整评审准备依赖 review inspect 的 review 视图和 review prepare 能力。Release Check 另需对应机器证据接口。
metadata:
  short-description: 准备并审核 AW 源码对应的 Skill 运行包与项目设计
---

# Review AW

源码、已有产物和 Eval 保持只读。经授权的准备只向隔离目录生成本次待审副本；质量判断仍针对实际读取的对象。CLI 负责物化与身份核验，本 Skill 负责选择、语义评审和 finding 的源码归属。

## 目标与准备

1. 从本 Skill 实际 root 运行 `aw self check --from <skill-root> --json`；失败时报告能力缺口，只继续不依赖缺失能力的可见源码分析。按 `references/aw-review-routing.md` 固定 Workspace、目标和所需 profile；单个 AW 源 Skill 先解析所属 Plugin。
2. 用 `aw review inspect <target> --view review --json` 取得精简的 source→final 清单；按本次选择传入 `--skill`、`--platform`、`--scope`、`--config`，已有来源绑定以 `--materialization` 传入。只读取本次目标所需的结果与问题，完整包评审选择状态为 `ready` 的实际 final。
3. 缺少当前 final 且任务要求完整评审时，读取 `references/review-preparation.md`。完整审核请求涵盖必要本地准备，先说明 build/renderer 和隔离输出，再调用 `aw review prepare`；明确禁止执行时不准备。成功回执可直接用于本次 leaf 交接。源码分析请求或准备条件不足时，交付 source-only 结论和实际缺口。

## 评审路由

| 范围 | 使用 |
| --- | --- |
| 单个 AW 源 Skill / Plugin 内 leaf | `references/plugin-review.md`；将 final root、profile 及必要来源交给 `review-agent-skill` |
| Plugin composition | `references/plugin-review.md`；保留 manifest、依赖与共享资源 owner |
| Catalog | `references/catalog-review.md` |
| 跨插件用户路径 | `references/workflow-review.md` + `review-agent-architecture` |
| 公开能力组合 | `references/portfolio-review.md` + `review-agent-architecture` |
| 大型内容 / Eval Oracle 或结果 | 按需使用 `agent-content` / `audit-agent-skill-evals` |

完整性针对实际运行包；源码、build 声明及源 Eval 是带明确用途的辅助材料。相同 production digest 且 profile、权限、适用规范等价时可复用内容分析，环境适配仍逐项核验。发现位置与可修复的源码/provider/build 位置分别记录；缺少映射时保留 owner 未确认。

## 输出与证据

使用 `assets/human-report-template.md` 的适用部分，报告 scope、source-only 或所审 final/profile、design、complexity、必要 findings、关键 unknown 和下一步。未覆盖 profile 及准备失败单独说明，局部结论只对本次对象成立。

用户明确要求 Release Check 时读取 `references/release-check.md`；完整机器字段由 checker 使用 release 视图消费。用户明确要求归档时读取 `references/report-publication.md`，按归档副作用重新核对授权。leaf 只返回本次材料，项目归档由当前入口处理。

准备产物、质量结论和发布资格分别由对应能力确认。实际环境缺少所需命令或 profile 时报告原始限制，保留已完成的可见源码分析。
