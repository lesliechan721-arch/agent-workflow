# author-aw-plugin

在一个既有合法 AW Catalog Workspace 中创建或维护单个 AW Plugin Source，包括 manifest、Skill、extension、MCP/App、slash command、config、lifecycle、dynamic artifact、插件版本和构建配置。安全删除只处理 `author-aw-catalog` 已明确交接的任务。

## 使用前提

需要 Node.js 22+、已安装且提供所需作者命令的公开 `aw` CLI、既有合法 Catalog Workspace、目标工作区依赖，以及 `agent-content-toolkit` 和 `agent-skill-toolkit`。不需要 clone `agent-workflows` 或安装它的 `node_modules`。没有合法 Workspace 时，本 Skill 会停止并要求使用 `author-aw-catalog`。

## 工作方式与结果

本 Skill 会写入目标插件的 source truth，并按修改面运行外部 build、validation 和 tests。交付结果包含源码变化、确定性验证、已有的 materialized artifacts 和未完成项。

普通用户删除请求必须先使用 `author-aw-catalog`。只有它明确交接 Workspace 和插件名后，本 Skill 才调用公开的 `aw plugin remove`，返回 JSON receipt；成功后不再验证已删除插件，也不会修改 Catalog metadata、commit、build 或 publish。

它通过当前 PATH 的 `aw plugin capabilities` 查询字段合同；修改 Skill 时组合 `author-agent-skill`，并用 `aw skill validate` 验证。它不拥有 Catalog metadata、inventory、版本、聚合 build/validate 或远端发布，也不手改 generated runtime、catalog 或 cache。独立 Review、Eval Audit、模型 Eval 和发布裁决不属于默认作者完成条件。
