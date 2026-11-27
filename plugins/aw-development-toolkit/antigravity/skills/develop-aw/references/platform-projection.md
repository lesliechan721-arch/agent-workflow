# 平台投影与能力要求

同一插件适配多个 Agent、按配置产生不同组件，或准备通用 Skills 导出时读取。先查当前 capabilities 的 manifest、platform-components、platform-capabilities surface；字段、合法取值和 schema 由 CLI/Core 提供。

## 选择足够的机制

| 差异 | 方法与核对 |
| --- | --- |
| 少量平台名称或静态文字 | templates.vars 与明确 include；只替换预期文件 |
| 平台文件集合不同 | fileRules include/exclude；核对最终引用闭包 |
| 同一角色、指令或 Hook 的平台字段差异 | 对应 agentOverrides；数组整体替换，null 明确不提供 |
| Skill 需要调用同包 Agent | 用受控占位符绑定实际调用名（见下）；动态 renderer 也可用 agentNaming |
| 配置或平台能力决定类别、名称、数量 | renderer 返回完整组件集合，采用 Artifact renderer（references/aw-artifact-renderer.md） |
| Skill 需要稳定脚本或权限入口 | 托管命令（references/managed-commands.md）；正文和权限按同一份共享路由表校验 |

作者不透传任意宿主 Manifest，也不指定安装命令、宿主路径或注册身份。平台不执行某字段的语义时应报告缺口，不能只保留字段就称支持。

## 平台、scope 与能力

PlatformTarget 有 codex、claude、antigravity、cursor、opencode、pi、copilot、grok、generic。具体 Agent 使用原生包或原生扩展；generic 仅输出通用 Skills。平台允许范围来自 Manifest platforms，省略或空数组允许全部，未知和重复 ID 拒绝。声明允许不代表真实运行；依赖仍须覆盖消费者平台。

静态与动态资源归一化为 Skills、MCP、Agents、Hooks、Instructions。作者按平台选择原始内容、替代行为或有意省略的项。AW 标准映射保留声明中的事件、模型、工具和权限要求，缺少安全映射时跳过该入口并报告原因。独立的适用项继续交付。Pi 的角色及依赖角色的 Skill 照常交付，执行扩展的现场缺口单独提示。

PlatformCapabilitiesV3 用 `kinds[*].status`、`kinds[*].delivery` 和 `features` 统一判断组件交付、自身及跨类别前提。status 只有 supported / unsupported，`component.kind.<kind>` 要求类别 supported 且 delivery 非空。具体 feature 必须支持全部请求值。agent.model 有 values 时还需核对模型白名单。返回完整 Skill 和作者声明的调用字段，调用及可见性缺口随交付报告。其他必要能力不足时保留具体 feature/values。需要适配通用环境时，为 `generic` 提供适用的 Skill 正文。

能力由平台标准映射和已确认接口限制决定，local 另检查客户端是否可用；profile 不依赖本机。缺少真实宿主执行证据不改变平台能力。

实际 render scope 由固定物理布局决定，不能用 activation scope 替代。Codex/Claude/Copilot 共享包固定 user；Codex 项目角色及独立项目包保留真实 project scope。artifacts.scopes、组件配置和 Skill 的 runtimeConfig 按 render scope 解释。共享命令的路由和按平台配置快照见 托管命令（`references/managed-commands.md`）。共享包按确定性平台映射与现场入口可用性判断；同物理位置冲突须停止该组。Codex 共享 user 包始终按 user Agent 视图绑定引用，Project-only 可在内存补评 user 动态 Agent，不写额外 User 角色文件，亦不引用 Project-only 角色。

核对安装态时，从公开原生命令/API 取得对应状态；本地配置只补充显式条目、scope、归属和内容，不能覆盖原生结果。共享包的当前项目 enabled 不证明独立项目安装；查询未提供的事实保留 unknown。字段和观察副作用通过 aw plugin status --json 查看原生事实与 configuration 补充；显式 --observe-native 可启动原生观察服务并加载插件代码。

Config v5 先按平台替换原始 definitions/fields，再展开引用，值按 defaults < common < platforms[P] 解析；项目 scope 不新增配置存储层。

## 同包 Agent 的实际调用名

Claude 的命名模式为 host-plugin：写规范化短名 role，实际调用 plugin:role。Codex、Pi、Antigravity、Cursor、Copilot、Grok 为 aw-prefix：文件名、文件内 name 与调用名均用 aw-sourceId-plugin-role。OpenCode 和 generic 为 unsupported。查询 `agentNamingMode`；动态上下文提供实例级 `agentNaming`。作者声明逻辑角色名，由 AW 投影，完整文件名（不含扩展名）不得超过 128 字符。

在 Skill Markdown 用双花括号包围 `aw.agent:<name>` 引用同包 Agent；name 对应静态稳定公共名或动态逻辑名，平台 override 改名仍按公共名引用。公共名不能归一化为合法引用键时不可用占位符引用，但实际平台名合法的独立 Agent 仍可交付，投影名及重名限制不变。AW 替换为目标实际调用名；目标能力不足则 Skill 整项 unmet，独立组件仍交付。作者明确省略目标（null override 或 omitted）时保留引用是错误；未声明角色同样拒绝。若平台不支持 Agent 且当前平台与实际 render scope 有适用的动态 renderer，未找到角色的引用按整项 unmet 处理，也适用于混合插件的静态 Skill。不可仅退回猜测的短名或输出裸占位符。导出仅 Skill 时也能补评同 scope 的动态 Agent，不因此导出 Agent 文件。

所有非 author-only Skill Markdown（含 README、references 与代码块）受解析；残缺语法拒绝，SKILL.md frontmatter name 禁止使用，其他字符串字段须合法 YAML 引号。讲解语法时分开写标识和双花括号。静态引用与构建后注入的 Markdown 自动派生 aw.skill-agent-placeholder.v1，动态生成引用必须显式声明该能力。

## AW 运行要求与真实资格

requires.aw.capabilities 描述 AW 的运行接口，不能与 Agent 组件能力互换。declared 是作者声明，derived 是结构推导，effective 是合并结果，detected 只是扫描提示。按真实依赖补要求，不给所有插件填能力全集。

修改直接要求时查询 requirements 帮助，使用 add/remove。该操作不代替实际平台实现。共享资源传播按 构建与共享（references/build-and-sharing.md）。

作者准备可选择明确 profile，不要求本机装客户端，但须保留 basis=profile 及能力输入。资格候选、确定性测试和真实客户端加载分别报告；不要以 supported 推断客户端会话已执行。通用 Skills 导出按 Portable 分发（references/portable-skills.md），不能用某 Native final 代替另一 profile。

## 验证最终结果

核对真实 final 的组件集合、正文、调用 metadata、权限、资源和命令闭包。逐项看实际交付、部分覆盖、能力跳过和真正未满足的依赖。仅有能力缺口可以完成零项交付。涉及旧输出时按 动态组件 Renderer（references/aw-artifact-renderer.md）判断。按 来源与运行包（references/source-materialization.md）固定 source/profile/config 与字节证据。
