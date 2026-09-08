# Develop AW

开发和维护 AW Catalog Workspace 与 Plugin Source，从初始化、组件修改和安全删除，到构建验证和本地开发源激活。

例如：“在当前 Workspace 增加一个 Skill 插件，并验证 Codex 和 Claude 产物。”它使用公开 AW CLI 固定目标，按 Catalog 或 Plugin 分支处理；Skill 正文由通用作者能力协作完成。

只修改授权源码，生成物由 AW 构建。删除会检查依赖；本地激活只在用户明确要求时执行，会改变本地 Catalog source 状态。开发过程可能运行目标脚本，因此需要可信的项目来源。此 Skill 不负责独立评审、模型 Eval 或远端发布。
