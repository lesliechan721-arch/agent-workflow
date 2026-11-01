# Develop AW

处理 AW 插件与 Skill 的开发任务，帮助你定位源码、选择构建与平台机制、核对实际运行包，并维护 Catalog 和本地开发源。

## 典型用法

- “分析这个 AW Skill 的职责，先不执行代码。”使用源码和声明即可开始。
- “把共享脚本提供给另一个插件，并让 Skill 能读取它。”核对共享方式、修改位置和实际包。
- “检查这个 Skill 的 Codex/project 内容。”核对匹配的产物，缺少时说明并准备隔离副本。
- “把这个 AW Skill 导出为标准 Agent Skills。”核对显式 Portable 声明，再导出所选包。

Skill 内容采用通用作者方法。用户显式启动的 Reviewer 和 Simplifier 可以采用本技能的 AW 方法，仍各自负责质量判断和候选接受。

## 结果与边界

按本次任务交付源码改动、实际产物、来源与验证结果。开发和物化可能执行目标 build/renderer；静态读取要求保持。修改在授权源码内进行，生成内容由 AW 重建。

删除插件会检查依赖和源码状态。本地开发源激活按用户明确请求执行。导出 Portable 包使用 `aw skill materialize`，不会自动安装到 Agent；为通用方法准备运行包可使用 `aw review prepare`。

实际 Catalog 发布由用户显式启动 `publish-aw-catalog`，并针对具体发布计划授权。
