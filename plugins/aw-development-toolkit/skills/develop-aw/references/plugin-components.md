# Plugin 组件与配置

根据用户需要的结果选择组件，再查询 `aw plugin capabilities --json`、对应 `--surface` 和公开帮助。本文件提供选择与验证方法，字段及 accepted values 由当前 CLI/Core 合同负责。

## 选择组件

| 用户需要 | 选择与核对 |
| --- | --- |
| 可按任务采用的方法或明确指令入口 | Skill 或 slash command；按真实客户端能力设置 model-callable/manual-only，核对最终调用 metadata |
| 常驻指令、角色或 Agent 配置 | 对应 instruction、agent/role 或 extension；Agent 内容采用 `agent-content`，模型配置服从调用方的有效约束 |
| 在事件发生时执行动作 | Hook；写明触发、输入、副作用与失败行为，用受控事件作确定性验证 |
| 访问工具服务或 App | MCP/App；按合同声明 command、env、auth、网络和权限，验证实际启动、健康与清理 |
| 脚本需要稳定调用入口或独立资源生命周期 | 采用 托管命令（`references/managed-commands.md`），选择资源 producer、集合和权限 |
| 改变工具或 Agent 的可执行范围 | 权限声明；范围与所需动作匹配，核对目标平台的实际支持 |
| 根据配置、scope 或状态生成内容 | 按 平台投影（`references/platform-projection.md`） 选择投影机制；选定 renderer 后采用其 请求与输出方法（`references/aw-artifact-renderer.md`） |

Slash command 的参数与副作用在用户说明中前置。安装和生成结果须保留相应平台的调用语义；不能只看 source frontmatter 就确认两端均生效。

MCP/App 的凭据值不进入 Skill、日志或分发包。生命周期由实际 runtime/CLI 管理，文字描述不能代替成功运行或清理证据。

## 声明配置

插件配置使用 Config Definition v4，在 manifest 的 `config` 中声明 `schemaVersion: 4`，对应 capability 为 `aw.plugin-config.v4`。配置 schema、preset、作用域与验证使用同一合同。

条件对象、固定标量和对象内叶级数组/KV 使用该合同提供的结构能力；保存、呈现和运行资源共用该合同，不另写插件专用校验，也不把容器改存成 JSON 字符串。只在 Agent 内容中说明影响任务选择的非显然规则，字段表和默认值保留在其权威声明。

敏感字段沿当前合同限制为顶层 string，且不带 default 或 choices。Skill 产物和运行配置读取只使用允许的非敏感键；target 的 refreshKeys、敏感配置批次与输出隔离采用 Artifact renderer（`references/aw-artifact-renderer.md`）。

配置 helper 只完成合同允许的辅助任务；输出应确定、可测试。不要用 helper 重建另一套配置状态或隐式安装依赖。

## 读取本次安装生效的配置

`runtimeConfig` 声明在 `artifacts.targets[]` 的动态 Skill target 上，不是静态 Skill 或 manifest 顶层可直接追加的通用字段。已有该 target 时直接维护其声明；静态 Skill 出现这类需求时，先决定是否采用当前支持的动态 target。采用后按 renderer（`references/aw-artifact-renderer.md`） 实现请求与输出，正文静态不免除这些前提；未采用受支持的路径时，明确能力限制。

对受支持的 target，查询 `runtimeConfig` 的当前声明与 capability 要求，声明所需键及其依赖闭包。runtimeConfig 键须属于该 target 声明的 refreshKeys，闭包保持非敏感。AW 在 final Skill 中注入 reader，并按本次安装的有效配置提供值。

从脚本真实调用位置解析该 final 的 reader 和已安装配置。不能读“最新全局 store”替代本产物的生效配置，不能手写保留 receipt 或增加内容一致性门禁。按实际 user/project scope 验证；共享 Codex native projection 的 user 配置规则见 renderer 方法。

为独立托管包配置运行参数或文件时，采用 托管命令（`references/managed-commands.md`）中的资源与配置方法。

## 生命周期与交付

安装前环境校验或外部工具安装使用 `scripts.preApply`，读取 preApply（`references/aw-pre-apply.md`）。它在目标 preflight 后、cleanup 或 AW-owned 写入前运行；失败阻止该目标写入，外部动作的恢复由现有合同负责。构建期 Node 依赖和插件安装依赖分别按 构建与共享（`references/build-and-sharing.md`） 处理。

实现后验证真实受影响的组件和平台 final。README 说明用户可观察能力、入口、权限和限制；不复制 manifest 字段全集或内部生成算法。
