# Plugin Source 开发与验证

创建、修改、注册或验证 Plugin 时使用。目标与权威修改位置沿用主入口；需要解析 source/final/profile 时采用 来源与运行包（`references/source-materialization.md`）。

## 创建与注册

创建插件使用 `aw plugin init`，参数以公开帮助为准，不预建空目录。Workspace 初始化属于 Catalog 维护（`references/catalog-development.md`），普通插件修改不隐式初始化其他目录。

先从当前 capability receipt 确认所需组件和字段，再维护 source manifest 与对应文件。Plugin version 按项目发版约定维护；Catalog version 独立通过公开命令管理。安装依赖由 manifest `dependencies` 声明，构建共享不自动建立安装依赖。

插件内 Skill 使用 `author-agent-skill`，提供目标、源目录、构建与注入约束、允许路径和验收条件。Agent 内容使用 `agent-content`；已有有效上下文直接复用。AW manifest 注册、构建和平台验证仍由本任务完成。

## 按受影响机制修改

- 组件、配置、运行配置读取和生命周期脚本采用 组件方法（`references/plugin-components.md`）。
- Node 工具、共享 provider、静态或生成资源采用 构建与共享（`references/build-and-sharing.md`）。
- 模板、平台文件和能力要求采用 平台投影（`references/platform-projection.md`）。
- Portable 声明和导出采用 Portable 分发（`references/portable-skills.md`）。

## 验证与交付

按当前公开帮助和变更影响运行单插件 validate、test、build；明确只读限制时不执行可能运行插件代码的入口。

以受影响组件及其消费者确定验证范围。涉及共享 provider、依赖或组合变化时，核对实际消费文件、调用入口与运行要求；任务需要 Catalog 聚合产物时再完成相应聚合检查。本次需要核对运行包时，检查与来源交付采用 来源与运行包（`references/source-materialization.md`）。

报告实际差异、命令结果和未覆盖的组件、消费者或聚合。构建成功只证明该构建结果；质量判断和模型 Eval 使用各自证据。版本与发布元数据属于 source，远端发布由用户显式启动 `publish-aw-catalog`。
