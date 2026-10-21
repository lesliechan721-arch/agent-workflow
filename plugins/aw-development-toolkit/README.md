# AW Development Toolkit

为 AW 插件及其 Skill 提供来源解析、开发、验证和物化方法，维护 Catalog，并通过手动入口发布。依赖 `agent-content-toolkit` 和 `agent-skill-toolkit`。

```bash
aw install aw-development-toolkit -p codex
```

也支持 Claude，可将平台改为 `claude`。需要 PATH 中兼容的公开 AW CLI，不要求第三方项目具有本仓库的私有脚本目录。

| Skill | 适用任务 |
| --- | --- |
| `develop-aw` | AW 插件与 Skill 的来源、构建共享、平台投影和验证；维护 Workspace、版本与本地开发源 |
| `publish-aw-catalog` | 用户显式启动，生成具体发布计划，经该计划授权后发布 |

分析 AW Skill 的职责时可以只读源码；检查实际平台内容时核对匹配的 final，缺少时按任务授权准备隔离副本。准备可能运行必要的 build/renderer，明确的静态读取限制优先。

为通用方法准备完整包使用 `aw review prepare`；导出标准 Agent Skills 使用显式 Portable 声明与 `aw skill materialize`。两种用途分别核对其 source、配置和实际产物，不要求先创建 Eval。

Skill 内容设计使用通用 Author。用户显式启动的 Reviewer 与 Simplifier 可采用 AW 来源和物化方法，仍各自负责质量判断、候选与接受标准。采用 AW 方法不会自动运行专项工作流或模型 Eval。报告按当前任务交付，不作为插件发布门禁。

开发修改已授权源码，并按范围运行目标脚本；本地开发源激活按用户请求执行。发布计划读取远端 refs 并从已提交源码构建，apply 才执行已授权的远端变更；本地准备和检查不替代具体完整 planDigest 授权。
