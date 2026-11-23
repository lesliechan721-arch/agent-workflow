# 动态组件 Renderer

按平台能力、配置或实际 scope 动态生成五类组件时读取。先查询 platform-components、platform-capabilities 与 artifacts surface，使用其公开 schema；配置采用 组件方法（references/plugin-components.md），命令采用 托管命令（references/managed-commands.md）。

## 声明和请求

Manifest v4 的 artifacts 声明 configKeys、可选 sourceDirs/runtimeImports/scopes；不预枚举动态 ID。scripts.artifacts.render 指向 Node 入口。仅有托管命令 renderer 时可以不声明 artifacts。

从 AW_PLUGIN_CONTEXT 文件读取 schemaVersion=2、surface=agent-plugin、platform、实际 render scope、plugin、config、changedConfigKeys、allowedOutputKinds、platformCapabilities、resources 和 previousComponents。resources 是已核验只读入口，previousComponents 只有本批身份。platformCapabilities v2 包含 platform、scope、basis、kinds、features 和可选的 deliveryFeatures。具体交付及运行资格的判断采用 平台投影（references/platform-projection.md）。

每 render unit 按 Skill/非 Skill 权限分批。Skill 批次只见非敏感配置及依赖，非 Skill 批次不能输出 Skill；交集为空不调用。按 allowedOutputKinds 选择本批类别，不能从前一批输出发现下一批。changedConfigKeys 仅供优化，仍返回本批完整集合。配置从零新增组件和能力依据变化同样重新准备。

共享包 scope 与 activation 分开，采用 平台投影（references/platform-projection.md）。HOME/AW_HOME/XDG 等临时根是输入隔离，不是 OS 沙箱。

## 完整输出与缺口

每批 stdout 输出一个 {version:3,components:[],omitted:[],unmet:[]}，三个数组都必填。组件含稳定 id、逻辑 name、kind、content，可有 requires。允许动态新增类别、数量与名称；同平台部署跨类别和静态组件共同查重，宿主映射名也不能冲突。改显示名不必改稳定 ID。

Skill 的 content.files 将相对路径映射到 {text} 或 {source:{kind:'bundle',path}} / {source:{kind:'runtime-import',name,path}}，必须有有效 SKILL.md，保留 README、二进制资源及运行闭包。引用不能越过已声明来源、包含绝对路径或逃逸链接。作者不覆盖保留 owner/runtime/command 文件。

`omitted` 表达作者有意不提供或配置关闭。`unmet` 表达仍有期望但缺少所需能力、配置或依赖，保留 requiredFeatures 的 feature 和具体 values。可返回符合声明及资源合同的完整组件，由 AW 处理标准映射，例如 Hook 要求 block 而目标只有 notify 时，保留 block 缺口。Instructions 拆分 audience 时，交付组件只含支持部分，缺口用 componentId 关联并列明缺少的 audience。模型、工具权限和阻断保持原要求。原因码须符合能力输入或登记的依赖与配置原因。

只有类别支持不足时使用对应 component.kind.<kind> 要求，不给普通 Skill 发明调用默认值。动态输出与静态条目用同一规则。动态 omitted 不能关闭静态条目。

## 资源、秘密与执行边界

runtimeImports 复用声明的 bundle-local export，不拼接 provider/sibling 源目录，不写导入资源。能力传播按 构建与共享（references/build-and-sharing.md）。相同输入产生相同完整集合。

stdout 仅 JSON，诊断写 stderr；所有输出不得泄露敏感值。stdout 上限16 MiB、诊断摘要64 KiB，秘密原值及 JSON 转义形式按现有规则扫描。进程失败、超时、非法输出不是空集合，不能删除旧输出。

有意为空的完整集合可在 Review 后安全撤销旧输出。仅有能力缺口时可以完成零项交付。旧 renderer 只返回缺项、缺少可证明撤回意图的完整声明时，继续保留可能生效的旧输出。Review 冻结集合、资源字节、输出位置和能力输入，Execute 重查 stale。status/list/inspect 使用已有证据，无当前证据时显示动态期望待确认。

## 命令和运行配置

同一个 renderer 可以接收单独的 `managed-commands` 请求。根据 surface 分支处理。动态路由使用 User 公共配置、无平台的请求和 ArtifactPlan v2。返回格式与替换语义见 托管命令（`references/managed-commands.md`）。

组件准备先取得完整集合并验证身份和运行资源。Skill 的命令引用与权限按本次共享路由表一起校验，再注入保留文件并冻结。组件遗漏、能力缺口和资源错误按各自的组件规则处理。

runtimeConfig 位于实际动态 Skill 组件，keys 必须在 artifacts.configKeys 的非敏感闭包并要求已核验运行能力。AW 注入 reader；不手写保留文件，不读最新全局 store 替代本产物已应用配置。
