# 托管命令

为 Skill、用户或程序提供稳定的脚本入口时使用。完成主 Skill 的兼容检查后，运行 `aw dev plugin capabilities --surface managed-commands --json` 核对字段，用 `extensions` surface 查询宿主权限，用 `aw command --help` 核对管理入口。

## 声明包与路由

在 Manifest v4 中声明 `aw.managed-commands.v2` 和顶层 `command`。同一 AW_HOME 每个来源和插件共用一个包。将依赖自包含在插件相对 `sourceDir` 中，保留 `.aw/` 给 AW 注入。默认选择插件支持的全部 Native 平台，通过 `platforms` 限定实际发布范围。仅交付角色或 Portable 内容的平台可以留在该集合之外。

静态命令可以直接使用以下字段片段：

```json
{
  "command": {
    "sourceDir": "./commands",
    "platforms": ["codex", "claude"],
    "mode": "static",
    "routes": {
      "subcommands": [{ "name": "export", "runner": "node", "entry": "export.mjs" }]
    }
  }
}
```

AW 精确匹配 `--` 后首个 argv 元素，命中后将剩余参数接在固定 `args` 后面。可选 `fallback` 收到完整 argv。只允许已选命名路由时，用 `aw command run <source/plugin> --no-fallback -- <subcommand>`，该形式需要宿主策略单独覆盖。支持 `node` 和 `executable` runner。秘密经 `envFrom` 引用宿主变量。

公共配置需要选择路由时，改用 `mode: "dynamic"`、`refreshKeys` 和 `scripts.artifacts.render`。动态路由仅使用非敏感 User `common` 值和校验依赖。按 `surface.name === "managed-commands"` 分支，经 `commandSources[0].sourceDir` 取得已核验目录。返回 ArtifactPlan v2 的唯一完整路由产物：

```json
{
  "version": 2,
  "artifacts": [{
    "id": "command-routes",
    "target": "aw.command-routes",
    "kind": "commandRoutes",
    "refreshKeys": [],
    "routes": { "subcommands": [{ "name": "export", "runner": "node", "entry": "export.mjs" }] }
  }]
}
```

`refreshKeys` 与本次声明一致。空 `routes` 撤销全部路由。错误或不完整响应使发布失败，保留原有效版本。renderer 只选源目录中已有的入口。

## 运行配置和原生工具

运行脚本需要按平台读取已应用值时，在 `command.runtimeConfig.keys` 声明非敏感键，并核对覆盖的所有平台都能校验这些键和依赖。脚本相对命令包 revision 导入 `.aw/command-runtime-config.mjs`，调用 `await readCommandRuntimeConfig({ from: import.meta.url, keys })`。使用 `aw command run <source/plugin/platform> --` 启动，由 AW 传入已核验的平台上下文。读取器核验 revision 和平台快照，返回 `values`、`platform`、`installedIdentity`、`resourceRoot`。同一 AW_HOME 内同平台共用快照。不要从运行脚本直接读取最新 Config Store 或调用方提供的配置路径。

需要原生工具时，采用 原生工具（`references/native-tools.md`）声明 `plugin-command` consumer。命令包的发布范围决定哪些部署引入这项依赖。

## Skill 和宿主权限

在 Skill Markdown 中用双花括号包围 `aw.command`。AW 为声明运行配置的包展开为 `aw command run <source/plugin/platform> --`，其余包展开为 `aw command run <source/plugin> --`。所有 Markdown 都会处理，包括代码块中的示例。讲解该语法时分开写标识与花括号。核对引用所在的平台命中 `command.platforms`，且包中实际有可用路由。Portable 包提供可独立使用的正文与资源。

许可声明用 `{ "argsPrefix": ["export"] }` 指定最窄的可用前缀。每词使用安全 token `[A-Za-z0-9_./:@%+=,-]+`。`[]` 允许匹配插件的所有直接调用。权限前缀与 Skill 的入口一致。`generic` 自动跳过继承的结构化托管命令权限，普通字符串规则仍参与能力检查。对平台不同的授权用 `agentOverrides`；Claude 需要沙箱排除时用 `agentOverrides.claude.sandbox.excludedCommands`，另声明 `aw.claude.sandbox-exclusions.v1`。Bash 审批和沙箱排除分别配置。生成的规则匹配调用文字，路由修改后需看 Review 列出的实际入口变化。

没有可达路由时，部署撤回本次可触达的对应 `allow` 与沙箱例外，保留适用的 `ask`、`deny`。遇到 `invocationPolicyNotApplied`，按 `detail.skippedPermissionActions`、`detail.reasonCode` 和作用域定位缺口。遇到 `hostPermissionAdditionalImpact`，在确认前核对该原生规则对其他命令的影响。OpenCode V2 的命令前缀使用未加引号的安全词和单个空格，其他书写和已记住许可依宿主规则处理。验证时分别检查生成配置和相同客户端、产品面、模式及作用域下的实际审批。

Antigravity 只在可用 CLI 的 User Global 写入可表达的字面前缀。用 Project 或 Shared 时，按对应作用域的宿主策略验证。Grok Build 用空格连接解析后的参数进行匹配，请在 Review 核对参数边界合并的影响。Project 写入要求该项目已获 Grok 授信。

若回执报告 `permissionOwnershipDegraded` 或 `permissionOwnershipWriteFailed`，先核对宿主配置中的现有规则，再同步同一目标与范围。保留不能核验归属的规则，避免用重新生成的声明猜测旧规则归属。

## 验证和维护

用真实作者入口验证静态或动态路由，以及 Skill、权限和资源闭包。验证使用隔离准备。核对命名路由、通用入口、无可达路由，以及按平台应用后的值。保存配置后只有应用、安装或同步会刷新已应用快照。带 `--platform` 的 apply 只涉及目标平台快照，公共路由由无 `--platform` 的 apply 或同步刷新。

用 `aw command list` 与 `aw command show <source/plugin>` 检查所选包和路由。显式 `aw command package sync <source/plugin>` 从本机 Active 更新共享包。要更新宿主 Skill 和权限，运行相关平台的插件同步。卸载部署保留共享包。要移除共享包，先结束活跃任务，查看 `aw command package remove` 的影响。来源改绑后，用 `list` 提供的 `pkg-id` 精确清理旧包。
