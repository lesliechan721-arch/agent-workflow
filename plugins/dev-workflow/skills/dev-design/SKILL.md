---
name: dev-design
description: 形成或修订可实施的开发设计与可选规格，内置跨阶段工程判据并严格停在写代码之前。
user-invocable: true
disable-model-invocation: true
compatibility: AW 支持的宿主；按需协作 decision-kit、human-content 与同插件工程能力，不自动修改产品代码。
metadata:
  short-description: 形成可直接施工的开发设计与按需规格，严格停在写代码之前
---

# Dev Design

<!-- design-playbook -->

<!-- core-discipline -->

## 位置与恢复

- 首次保存、建立交接记录或替换旧设计依据前，读取 `references/workspace.md`；会话中断或写入归属不明时读取 `references/recovery.md`。
- 交付可直接实施的设计依据（调用示例、具体类型/边界、状态归属、未决项与验证入口）；仅在用户或项目明确要求完整规格时输出完整文档。
