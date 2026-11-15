# 平台投影与能力要求

同一插件适配多个 Agent、按配置产生不同组件，或准备通用 Skills 导出时读取。先查当前 capabilities 的 manifest、platform-components、platform-capabilities surface；字段、合法取值和 schema 由 CLI/Core 提供。

## 选择足够的机制

| 差异 | 方法与核对 |
| --- | --- |
| 少量平台名称或静态文字 | templates.vars 与明确 include；只替换预期文件 |
| 平台文件集合不同 | fileRules include/exclude；核对最终引用闭包 |
| 同一角色、指令或 Hook 的平台字段差异 | 对应 agentOverrides；数组整体替换，null 明确不提供 |
| 配置或平台能力决定类别、名称、数量 | renderer 返回完整组件集合，采用 Artifact renderer（references/aw-artifact-renderer.md） |
| Skill 需要稳定脚本或权限入口 | 托管命令（references/managed-commands.md）；正文、权限和真实 producer 一起校验 |

作者不透传任意宿主 Manifest，也不指定安装命令、宿主路径或注册身份。平台不执行某字段的语义时应报告缺口，不能只保留字段就称支持。

## 平台、scope 与能力

PlatformTarget 有 codex、claude、antigravity、cursor、opencode、pi、gemini、copilot、grok、generic。具体 Agent 使用原生包或原生扩展；generic 仅输出通用 Skills。平台允许范围来自 Manifest platforms，省略或空数组允许全部，未知和重复 ID 拒绝。声明允许不代表真实运行；依赖仍须覆盖消费者平台。

静态与动态资源归一化为 Skills、MCP、Agents、Hooks、Instructions。同一正文只维护一份，平台负责包装和已核验字段映射。命令、模型、工具限制与权限均需实际等价；Pi Agents 只声明角色，由用户已有兼容消费者执行，不生成执行工具。

平台能力同时包含 kinds 和 features 的 supported/unsupported/unverified、交付方式、具体取值与原因。类别不足用派生 component.kind.<kind> 表达；它不增加默认调用行为。脚本只输出实际可支持部分，未满足部分保留具体 feature/values；不能将未知能力提升为支持。generic 不声称宿主调用或运行能力。

实际 render scope 由固定物理布局决定，不能用 activation scope 替代。Codex/Claude/Gemini/Copilot 共享包固定 user；Codex 项目角色及独立项目包保留真实 project scope。artifacts.scopes、config、命令 producer 和 runtimeConfig 均按 render scope 解释。共享包采用所有实际消费者共同能力；同物理位置冲突须停止该组。

Config v5 先按平台替换原始 definitions/fields，再展开引用，值按 defaults < common < platforms[P] 解析；项目 scope 不新增配置存储层。

## AW 运行要求与真实资格

requires.aw.capabilities 描述 AW 的运行接口，不能与 Agent 组件能力互换。declared 是作者声明，derived 是结构推导，effective 是合并结果，detected 只是扫描提示。按真实依赖补要求，不给所有插件填能力全集。

修改直接要求时查询 requirements 帮助，使用 add/remove。该操作不代替实际平台实现。共享资源传播按 构建与共享（references/build-and-sharing.md）。

作者准备可选择明确 profile，不要求本机装客户端，但须保留 basis=profile 及能力输入；unverified 仍未验证。资格候选、确定性测试和真实客户端加载分别报告。通用 Skills 导出按 Portable 分发（references/portable-skills.md），不能用某 Native final 代替另一 profile。

## 验证最终结果

核对真实 final 的组件集合、正文、调用 metadata、权限、资源和命令闭包；同时核对 omitted、unmet 与部分覆盖。renderer 成功有意空、全部 unmet 与失败的撤销行为不同。按 来源与运行包（references/source-materialization.md）固定 source/profile/config 与字节证据，不从源码声明猜最终动态集合。
