# author-aw-plugin

在一个既有合法 AW Catalog Workspace 中创建或维护单个 AW Plugin Source，包括 manifest、Skill、extension、MCP/App、slash command、config、lifecycle、dynamic artifact、插件版本和构建配置。安全删除只处理 `author-aw-catalog` 已明确交接的任务。

## 使用前提

需要 Node.js 22+、当前 PATH 中已安装且提供所需作者命令的公开 `aw` CLI、目标工作区依赖，以及 `agent-content-toolkit` 和 `agent-skill-toolkit`。本 Skill 先检查本身的 AW requirements，再从 `aw catalog context --json` 取得既有合法 Workspace。合法 marker 下的 degraded Workspace 仍可定位并修复插件；marker 缺失或非法时，本 Skill 会停止并要求使用 `author-aw-catalog`。

## 工作方式与结果

本 Skill 会写入目标插件的 source truth，并按修改面运行外部 build、validation 和 tests。交付结果包含源码变化、确定性验证、已有的 materialized artifacts 和未完成项。

普通用户删除请求必须先使用 `author-aw-catalog`。只有它明确交接 Workspace 和插件名后，本 Skill 才调用公开的 `aw plugin remove`，返回 JSON receipt；成功后不再验证已删除插件，也不会修改 Catalog metadata、commit、build 或 publish。

它先读取 `aw plugin capabilities --json` 的实际领域，再按需查询一个领域；修改 Skill 时组合 `author-agent-skill`，并用 `aw skill validate` 验证。修改完成后先读取 `aw plugin requirements` receipt，再验证目标插件。它不拥有 Catalog metadata、inventory、版本、聚合 build/validate 或远端发布，也不手改 generated runtime、catalog 或 cache。独立 Review、Eval Audit、模型 Eval 和发布裁决不属于默认作者完成条件。
