---
name: create-agent-workflows-plugin
description: 当用户明确要在 `agent-workflows` 仓库新增或维护 `plugins/<name>/` 插件项目时使用；涵盖 `.agents-plugin/plugin.json`、skill 文档、`agents/openai.yaml`、`extensions.*`、`buildConfig` 和 bundle 校验。
---

# Create Agent Workflows Plugin

在当前仓库创建或维护同时支持 Codex 和 Claude Code 的双平台插件。插件作者只需维护 `plugins/<name>/` 下的文件；运行时 manifest、平台 manifest 和本地 marketplace 镜像由 CLI 在构建或安装时生成。

## 权威来源

- 以当前实现为准：`packages/cli/src/types.ts`、`utils/manifest.ts`、`generators/local-plugin.ts`、`scripts/bundle-plugins.ts`。
- 不把仓库里的历史材料当作当前约定；规则以代码为准。
- 脚手架和辅助脚本用零依赖 Node.js。

## 快速开始

1. **确认命名**：插件名和 skill 名都使用小写短横线格式，例如 `repo-check`。
2. **确定能力**：只有 `skills`、`skills + extensions`，还是需要 `mcpServers`、`apps` 或只给 Claude 用的 manifest 字段。
3. **跑脚手架**：新建插件先跑 `scripts/init_plugin.js`（见下方命令）；维护已有插件先读 `.agents-plugin/plugin.json`。
4. **编辑 manifest**：按需补齐 `.agents-plugin/plugin.json` 字段。字段规范见 `references/plugin-json-spec.md`；extensions 和 buildConfig 详见 `references/extensions-and-buildconfig.md`。
5. **写 skill 文档**：把 `SKILL.md` 的占位流程改成真实工作流，配置触发策略。配方详见 `references/skill-trigger-recipes.md`。
6. **构建验证**：运行 `pnpm build` 生成 runtime bundle，用 `scripts/validate_plugin.js` 检查插件完整性。

## 最小插件结构

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

常见可选文件：`.mcp.json`（MCP 服务器配置）、`.app.json`（应用配置）、`commands/`（Claude 命令）、`output-styles/`（Claude 输出样式）。

## 最小 Manifest 示例

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

完整字段规范见 `references/plugin-json-spec.md`。

## 脚手架脚本

```bash
node .agents/skills/create-agent-workflows-plugin/scripts/init_plugin.js repo-check \
  --description "检查仓库状态并输出诊断结论。" \
  --display-name "Repo Check" \
  --short-description "检查仓库状态" \
  --skill-name repo-check \
  --skill-description "手动触发这个 skill，执行仓库检查工作流"
```

- 创建 `plugins/<name>/` 插件目录和最小骨架文件
- 写入带 `marketplace` block 的 `.agents-plugin/plugin.json`
- 初始化 `skills/<skill-name>/SKILL.md` 和 `agents/openai.yaml`
- 可选 `--with-mcp`：同时创建 `.mcp.json` 存根
- 可选 `--with-apps`：同时创建 `.app.json` 存根
- 不改 `plugins/marketplace-source.json`，不生成平台 manifest

## 触发策略速查

| 平台 | 自动触发字段 | 手动触发方式 | 配置位置 |
|------|-------------|-------------|----------|
| Codex | `allow_implicit_invocation` | `$skill-name` | `agents/openai.yaml` |
| Claude Code | `disable-model-invocation` | `user-invocable` | `SKILL.md` frontmatter |

两平台触发开关完全独立，互不读取。配方详见 `references/skill-trigger-recipes.md`。

## 验证清单

- `plugins/<name>/.agents-plugin/plugin.json` 是唯一手动维护的 manifest
- `.agents-plugin/plugin.json` 已包含 `marketplace` block
- `plugins/marketplace-source.json` 未被无关改写
- 插件目录里没有 `.claude-plugin/` 或 `.codex-plugin/` 目录
- `SKILL.md` 不再有 TODO 占位符，已写入真实工作流
- `agents/openai.yaml` 已明确 Codex 触发策略
- `pnpm build` 能生成 `packages/cli/plugins-dist/plugins/<name>/`
- 改到 manifest、bundle 或安装逻辑时，至少运行对应的 `pnpm test:*`

## 禁止操作

- 不要手改 `packages/cli/plugins-dist`、`~/.aw`、仓库根目录 marketplace manifest
- 不要在插件目录里手写 `.claude-plugin/plugin.json` 或 `.codex-plugin/plugin.json`
- 不要给 `skills`、`mcpServers`、`apps` 写数组或对象
- 不要混用平台触发字段（Claude 的 `user-invocable` 不影响 Codex，反之亦然）

## 现有样例

仓库里可参考 `plugins/git-commit/`，涵盖 skills、extensions 四种类型的完整示例。
