# author-aw-plugin

创建或维护一个 AW plugin，包括 manifest、Skill、extension、MCP/App、slash command、dynamic artifact、版本和构建配置。

## 使用前提

需要 Node.js 22+、已安装且提供所需作者命令的公开 `aw` CLI、目标工作区依赖，以及 `agent-content-toolkit` 和 `agent-skill-toolkit`。目标可以是任意 Workspace v1；不需要 clone `agent-workflows` 或安装它的 `node_modules`。

## 工作方式与结果

本 Skill 会写入目标插件的 source truth，并按修改面运行外部 build、validation 和 tests。交付结果包含源码变化、确定性验证、已有的 materialized artifacts 和未完成项。

它不手改 generated runtime、catalog 或 cache。AW CLI/Core 是机器规范；本 Skill 只是调用公开命令的 Agent-facing 助手。独立 Review、Eval Audit、模型 Eval 和发布裁决不属于默认作者完成条件，必须由用户或上层工作流单独请求。
