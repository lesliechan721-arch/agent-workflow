---
name: create-agent-workflows-plugin
description: 当用户明确要在 `agent-workflows` 仓库新增或维护 `plugins/<name>/` 插件项目时使用；涵盖 `.agents-plugin/plugin.json`、skill 文档、`agents/openai.yaml`、`extensions.*`、`buildConfig` 和 bundle 校验。
---

# Create Agent Workflows Plugin

这个技能用于在当前仓库创建或维护插件项目。插件作者只需要维护 `plugins/<name>/` 下的文件；运行时 manifest、平台 manifest 和本地 marketplace 镜像都由 CLI 在构建或安装时生成。

## 权威来源

- 以当前实现为准，优先核对 `packages/cli/src/types.ts`、`packages/cli/src/utils/manifest.ts`、`packages/cli/src/generators/local-plugin.ts`、`packages/cli/scripts/bundle-plugins.ts` 和平台适配器。
- 不要把仓库里的历史材料当成插件作者约定；这里记录的规则以当前代码为准。
- 新脚手架和辅助脚本默认用零依赖 Node.js；只有需求本身依赖其他生态时才引入新依赖。

## 创建流程

1. 确认插件名和 skill 名都使用小写短横线格式，例如 `repo-check`。
2. 判断插件需要哪些能力：只有 `skills`、`skills + extensions`，还是还要接入 `mcpServers`、`apps` 或只给 Claude 用的 manifest 字段。
3. 新建插件时先跑脚手架；维护已有插件时，先读它的 `.agents-plugin/plugin.json` 和配套文件。
4. 按需求补齐 `.agents-plugin/plugin.json`、skill 文档、`agents/openai.yaml`、MCP/apps 配置和扩展声明。
5. 运行 `pnpm build` 或对应测试，生成 runtime bundle 并检查产物。
6. 不要手改 `packages/cli/plugins-dist`、`~/.aw`、仓库根目录 marketplace，也不要在插件目录里手写 `.claude-plugin/plugin.json` 或 `.codex-plugin/plugin.json`。

## 插件目录结构

最小插件结构：

```text
plugins/<name>/
├── .agents-plugin/
│   └── plugin.json
└── skills/
    └── <skill-name>/
        ├── SKILL.md
        └── agents/
            └── openai.yaml
```

常见可选文件：

- `mcpServers`: 通常指向 `./.mcp.json` 或 `./config/mcp-servers.json`
- `apps`: 通常指向 `./.app.json` 或 `./config/apps.json`
- 只给 Claude 用的 `commands`、`outputStyles`、`lspServers`: 通过 `buildConfig.manifestOverrides.claude.*` 指向插件内路径
- 额外模板或平台差异文件：通过 `buildConfig.fileRules` 和 `buildConfig.templates` 纳入 bundle

## 插件 Manifest

`plugins/<name>/.agents-plugin/plugin.json` 是唯一需要手动维护的 manifest。顶层只允许这些字段：

- `name`: 插件名，建议与目录名一致，使用小写短横线
- `version`: 插件版本，例如 `0.1.0`
- `description`: 插件说明
- `skills`: 可选，单个字符串路径
- `mcpServers`: 可选，单个字符串路径
- `apps`: 可选，单个字符串路径
- `marketplace`: 必填，插件条目元数据
- `interface`: 可选，只放展示元数据
- `extensions`: 可选，安装期或运行期派生的扩展能力
- `buildConfig`: 可选，构建 bundle 时使用的配置

路径字段必须以 `./` 开头，不能是绝对路径，也不能逃出插件根目录。插件目录里如果出现标准入口文件，也要声明对应字段：有 `skills/` 就声明 `skills`，有 `.mcp.json` 就声明 `mcpServers`，有 `.app.json` 就声明 `apps`。

最小 manifest 示例：

```json
{
  "name": "repo-check",
  "version": "0.1.0",
  "description": "检查仓库状态并输出诊断结论。",
  "skills": "./skills",
  "marketplace": {
    "category": "workflow",
    "strict": true,
    "policy": {
      "installation": "AVAILABLE",
      "authentication": "NONE",
      "products": ["CODEX"]
    }
  },
  "interface": {
    "displayName": "Repo Check",
    "shortDescription": "检查仓库状态",
    "capabilities": ["Skills"]
  },
  "extensions": {
    "instructions": [],
    "permissions": [],
    "hooks": [],
    "agents": []
  }
}
```

## Marketplace 字段

`plugins/marketplace-source.json` 只保存 marketplace 根级构建元数据，目前只接受 `owner` 和 `interface.displayName`。创建单个插件时通常不要改它。

插件自己的 marketplace 条目写在 `.agents-plugin/plugin.json` 的 `marketplace` block：

- `category`: 非空字符串，例如 `workflow`
- `tags`: 可选字符串数组，会去重和 trim
- `strict`: 必填 boolean
- `policy.installation`: 非空字符串
- `policy.authentication`: 非空字符串
- `policy.products`: 可选字符串数组，会去重和 trim

`pnpm build` 会把根级元数据和各插件的 marketplace 条目合成两份 runtime marketplace manifest：`.claude-plugin/marketplace.json` 和 `.agents/plugins/marketplace.json`。

## Skill 文件

每个 skill 至少有：

- `SKILL.md`: 写清楚真实工作流，不保留 TODO；frontmatter 必须有 `name`，`description` 要能准确描述触发场景
- `agents/openai.yaml`: 写 Codex 的 UI 元数据和触发策略；脚手架默认 `policy.allow_implicit_invocation: false`

触发策略不要混用平台规则：

- Codex 自动触发看 `agents/openai.yaml` 的 `policy.allow_implicit_invocation`
- Codex 显式触发可通过 `$skill-name` 或结构化 skill mention
- Claude Code 用户手动入口看 `SKILL.md` frontmatter 的 `user-invocable`
- Claude Code 模型自动调用看 `SKILL.md` frontmatter 的 `disable-model-invocation`
- `allow_implicit_invocation` 不影响 Claude Code；`user-invocable` / `disable-model-invocation` 不影响 Codex

有副作用的 skill 默认走保守配置：Codex 写 `allow_implicit_invocation: false`；如果也要避免 Claude 自动调用，写 `disable-model-invocation: true`。

## Extensions

`extensions` 用来声明 CLI 在安装或生成 bundle 时派生出的能力。不要新增顶层 `claude` block，也不要把 `hooks` / `agents` 塞进 `buildConfig.manifestOverrides.claude`。

- `instructions[]`: `{ name, title, content, paths? }`
  - Codex 安装时写入受管 `developer_instructions` block
  - Claude 安装时写入 `rules/<generated>.md`
- `permissions[]`: `{ name, allow?, ask?, deny? }`
  - Codex 安装时生成 `.rules` 文件
  - Claude 安装时合并到 `settings.awGenerated.permissions`
- `hooks[]`: `{ event, matcher?, command, description? }`
  - `event` 只能是 `before_tool`、`after_tool`、`session_start`、`session_stop`、`command`
  - Claude bundle 会让 `.claude-plugin/plugin.json.hooks` 指向 `./claude/hooks/hooks.json`
  - Codex 目前只把 `event: "command"` 的 hook 聚合进 `hooks.json`
- `agents[]`: `{ name, description, prompt, tools? }`
  - Claude bundle 会生成原生 agent Markdown，并写入 `.claude-plugin/plugin.json.agents`
  - Codex 安装时生成 role TOML；`tools` 当前只用于 Claude agent markdown

`agentOverrides` 目前出现在 schema 里，但各平台生成链路还不完全对称；只有确认目标生成路径会读取它时再使用。要让某个 hook/agent 不进入 Claude runtime bundle，可以在对应条目的 `agentOverrides.claude` 写 `null`。

## BuildConfig

`buildConfig` 只描述构建阶段如何生成 bundle，不是给平台私有字段开的通用出口。

- `templates.include`: glob 数组，只处理文本文件
- `templates.vars`: 每个变量必须同时给出 `{ "claude": string|boolean, "codex": string|boolean }`
- 模板语法支持 `{{var}}`、`{{#if var}}...{{/if}}`、`{{#unless var}}...{{/unless}}`
- `fileRules.claude` / `fileRules.codex`: `{ include: string[], exclude: string[] }`，把额外文件复制到对应平台 bundle
- `manifestOverrides.claude`: 只允许 `commands`、`outputStyles`、`lspServers`、`userConfig`、`channels`
- `manifestOverrides.codex`: 当前只允许空对象

`commands`、`outputStyles` 和字符串形式的 `lspServers` 都必须是插件内 `./` 相对路径；对象形式的 `lspServers`、`userConfig`、`channels` 会原样进入 Claude runtime manifest。

## 脚手架脚本

优先用脚手架创建第一版目录，再按需求补细节：

```bash
node .agents/skills/create-agent-workflows-plugin/scripts/init_plugin.js repo-check \
  --description "检查仓库状态并输出诊断结论。" \
  --display-name "Repo Check" \
  --short-description "检查仓库状态" \
  --skill-name repo-check \
  --skill-description "手动触发这个 skill，执行仓库检查工作流"
```

脚本会：

- 创建 `plugins/<name>/` 插件目录
- 写入带 `marketplace` block 的 `.agents-plugin/plugin.json`
- 初始化 `skills/<skill-name>/SKILL.md` 与 `agents/openai.yaml`
- 保持 `plugins/marketplace-source.json` 不变
- 不会在插件目录里生成 `.claude-plugin/plugin.json` 或 `.codex-plugin/plugin.json`
- 不会改写仓库根目录 marketplace manifest

如果需要更细的清单或触发策略，可读本技能同目录的 `references/` 文件；这些参考只记录当前代码里的约定。

## 验证

- `plugins/<name>/.agents-plugin/plugin.json` 是唯一需要手动维护的 manifest
- 插件条目元数据写在 `.agents-plugin/plugin.json.marketplace`
- `plugins/marketplace-source.json` 未被无关改写
- 插件目录里没有 `.claude-plugin/plugin.json` 或 `.codex-plugin/plugin.json`
- `skills/<skill-name>/SKILL.md` 不再有 TODO，占位说明已换成真实工作流
- `agents/openai.yaml` 已明确 Codex 触发策略
- `pnpm build` 能生成 `packages/cli/plugins-dist/plugins/<name>/`
- 改到 manifest、bundle、适配器或安装逻辑时，至少运行对应的 `pnpm test:*`
