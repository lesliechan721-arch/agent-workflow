---
name: dev-verify-author
description: 创建、维修或维护可复跑的项目验证基础设施、功能地图、形式化模型与负例检测证据，按需封装为正式 Skill。
user-invocable: true
disable-model-invocation: true
compatibility: AW 支持的宿主；需要运行项目本地启动与验证命令以实跑闭环并验证负例敏感性。
metadata:
  short-description: 创建、维修或维护可复跑的项目验证资产、功能地图与形式化模型
---

# Dev Verify Author

为项目构建或维护可被冷启动 Agent 直接复跑的验证基础设施，不作为普通开发任务的自动下游。

## 按任务读取

| 任务 | 读取资料 |
| --- | --- |
| 创建、维修或维护运行验证入口、五段闭环与功能地图 | `references/create-or-repair.md` |
| 建立或维护形式化属性、模型与实现对应 | `references/formal-verification.md` |
| 运行已有形式化属性集、执行负例敏感性与结果解释 | `references/formal-check.md` |
| 封装为独立可发现的正式项目 Skill | `references/formal-skill.md` |

需要建立或校验性能基准时直接调用 `dev-benchmark`。

## 核心产物

- **运行验证资产**：掌握真实启动（Launch）、实例身份健康（Doctor）、真实表面驱动（Driver）、原始证据（Evidence）和清理后留证（Cleanup）五段闭环，并按用户能力建立功能地图（可采用 `assets/project-verification-template.md` 与 `assets/feature-map-template.md`）。
- **形式化验证资产**：从有来源的高危属性出发，保存假设、抽象、原子边界、搜索范围、实现映射与同步基准（可采用 `assets/formal-verification-template.md`）。

## 交付前必须亲手跑通并验证敏感性

**从未亲手跑通的验证脚本或文档只是草稿，不是交付物。**

1. 按你写的指令端到端跑一遍代表闭环（启动 → 健康检查 → 驱动一条映射功能 → 采集证据 → 清理），并核对清理后证据仍在约定位置。
2. 适用且安全可隔离时，用**可撤销的已知坏样例**（负例）证明检查真的会为目标缺陷报红，再恢复基线重跑变绿；无法安全做负例时标明“检测敏感性未核验”。
3. 维护旧资产时对比上次同步版本与当前改动，区分产品回归、入口驱动错误、环境漂移与文档过期；修完文档后必须按新文档实跑。检出产品 bug 证明入口有效，但产品仍失败，严禁降级预期换绿灯。

交付：资产位置、功能地图覆盖、实跑与负例敏感性输出、清理留证结果及未覆盖项。
