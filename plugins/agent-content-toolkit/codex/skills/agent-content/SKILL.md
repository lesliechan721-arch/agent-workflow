---
name: agent-content
description: >-
  创建、修改、重组或评价供 Agent 读取的 AGENTS.md、CLAUDE.md、prompt、role instruction 和 reference 时使用；其它 Skill 也可用它处理正文。提供事实依据、指针、信息层级、最小控制、完成条件和剪枝方法。完整 Skill、Eval 或插件的生命周期由相应能力主导；不用于普通用户文档润色或仅解释字面含义。
metadata:
  short-description: 设计和评价有依据、易读取、不过度约束的 Agent-facing 内容
---

# Agent Content

保持当前请求的操作边界：要求写入才修改；只读请求只分析。

## 共同方法

使用 `references/agent-content-standard.md` 处理内容的读者、事实、读取路径、控制强度、输出需要与相称验证。局部修正只取相关规则，不重建完整计划；目标、必要约束或加载路径不清楚时，再在当前上下文澄清。

涉及多份或大型参考材料、拆分或读取路径争议时，使用 `references/reference-design.md`。先判断内容是否需要，再决定位置；不因文件更短就认定改进。

项目事实来自用户材料或实际环境，不为补全文档而编造命令、目录或政策。区分可直接确认的问题、设计建议和未知项；没有行为证据时，不把长度或文风偏好称为已证实的行为缺陷。

## 交付

按当前请求返回修改、分析或建议，说明实际验证与未验证部分。输出形式由用户和实际用途决定，不另造固定字段。直接需要人读评审时可参考 `assets/content-review-template.md`，省略无用章节。
