# AW validation and version

## Common commands

```bash
pnpm build
node plugins/aw-plugin-development/skills/author-aw-plugin/scripts/validate_plugin.mjs plugins/<name> --repo-root <repo-root>
pnpm plugin:test <name>
pnpm plugin:test <name> --platform codex --scope project
pnpm plugin:eval <name> --skill <skill> --batch-name materialization --materialize-only
```

`validate_plugin.mjs`、版本检查和脚手架已复制到本 Skill。新工作流不依赖旧 `.agents/skills/create-aw-plugin` 工具路径。

## Manifest version

- 新插件保留初始稳定版本。
- 已有插件 production bundle 变化时，直接按兼容影响提高源码 manifest 的 major、minor 或 patch。
- 只修改作者期 eval/report 时不提高插件版本。

## Completion

- validator 与直接 deterministic tests 通过；
- build-required 分支生成的 artifact 存在且来源可追溯；
- Eval case 已通过独立 preflight；
- 未运行的模型证据明确标为未验证。
