# 平台投影与能力要求

同一 Plugin 需要适配 Codex、Claude、Portable，或需要根据配置选择内容时读取。先判断差异来自哪里，再选择足够的机制；不要为静态差异建立动态状态。

Skill 脚本需要读取本次安装生效的配置时，采用 组件方法（`references/plugin-components.md`） 中的安装态配置规则。下表处理产物本身的投影差异。

## 选择静态或动态机制

| 差异来源 | 优先方法 | 核对依据 |
| --- | --- | --- |
| 平台名称或少量静态文字替换 | `templates.vars` 与明确的 `templates.include` | 只替换预期文件，保留其他正文 |
| 各平台需要不同文件 | `fileRules` 的平台 include/exclude | 最终文件集合及引用闭包 |
| 平台 manifest 的专属字段 | 当前支持的 `manifestOverrides` | 对应平台公开字段和 validator |
| Skill 调用与权限需要稳定命令 | 采用 托管命令（`references/managed-commands.md`），由 AW 解析逻辑引用 | 最终正文和权限指向同一命令，独立包使用 AW-owned surface |
| 配置、scope 或状态决定实际 artifact | 声明 targets 并使用 renderer | 请求/输出、配置与状态边界 |

`manifestOverrides.claude` 只能使用当前公开支持的字段，不是任意对象合并入口。不要因另一个平台支持某字段就复制过去。renderer 的具体合同见 Artifact renderer（`references/aw-artifact-renderer.md`）。

## 区分 Native 与 Portable

`PlatformName` 仍为 Codex/Claude；公开 `PlatformTarget` 有 codex、claude、antigravity、cursor、opencode、pi、generic 七项。Manifest 顶层 platforms 是唯一支持集合：缺省或空数组表示全部，显式集合不可含未知或重复 ID。依赖支持集合须覆盖消费者，不能用本机选中交集绕过。不要写旧 products、distributions 或 delivery。

统一 skills 来源按具体目标生成。Codex/Claude Skill 固定进入 Native 包；五个 Portable 目标使用标准 Skill 投影，允许 Portable-only 插件。skillRuntimeFiles 和 generatedSkillRuntimeFiles 用 platforms 选择实际平台，省略时覆盖插件支持平台；核对资源最终存在及引用闭包，不用源码存在代替产物验证。

配置定义 v5 的平台替换先作用于原始 definitions/fields，再展开 $ref；内容消费始终使用当前平台的 common/平台覆盖。Native shared-user 是物理包体身份，不把它转换为 common 或其它平台配置。Portable 声明、导出和限制见 Portable 分发（`references/portable-skills.md`）。

## 维护 capabilities

安装兼容性使用当前 CLI/Core 计算的 requirements：

- declared：插件 manifest 自己声明的 AW 能力；
- derived：按合同从运行 import 等结构推导的能力；
- effective：declared 与 derived 的合并结果；
- detected：静态扫描发现的提示，用于发现可能漏声明的要求。

Detected 不提供完整运行证明。扫描只覆盖其支持的 SKILL shell 代码块和 manifest executable 等入口，不能穷尽 references、脚本或动态调用。缺少可推导声明时，按实际运行需求补充；不要为消除提示给所有插件添加能力全集。

需要调整 manifest 的直接要求时，读取 `aw dev plugin requirements --help`，通过 `aw dev plugin requirements <plugin-dir> --add <capability> --json` 或对应 remove 操作维护。该入口只更新 requires，不替代代码、import 或目标平台的实现。共享资源的传播条件见 构建与共享（`references/build-and-sharing.md`）。

## 验证选择的结果

核对所选 surface 的最终正文、文件集合、调用 metadata、权限、配置和 capability 要求是否符合其平台声明。模板只替换预期正文，文件规则按声明选择文件；动态投影按 renderer 的实际请求核对。

产物当前性、修改 owner、重建与跨 profile 证据使用 来源与运行包（`references/source-materialization.md`）。
