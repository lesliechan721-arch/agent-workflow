# AW validation and version

## Workspace validation

从目标工作区的 manifest/schema、CLI `--help`、package scripts、CI 配置或维护规则发现适用的 validator、build、test、materialization 和 Eval 命令。将确定性命令逐个传给：

```bash
node scripts/prepare-aw-authoring-context.mjs <plugin-root> \
  --repo-root <workspace-root> \
  --validator "<command>"
```

`prepare-aw-authoring-context.mjs` 不为未知工作区臆造默认命令。不要假设：

- 插件位于 `plugins/<name>/`；
- `author-aw-plugin` 位于宿主工作区的固定目录；
- 工作区使用 `pnpm`；
- 一定存在 `plugin:test`、`plugin:eval` 或本仓库的 CLI capability registry。

随本 Skill 分发的 `validate_plugin.mjs` 是当前仓库 CLI 合同的确定性实现；只有目标工作区提供兼容的 CLI capability registry 时才运行。其它工作区应使用其 CLI 暴露的 validator，或由未来的自定义插件接入层提供命令。

## Manifest version

- 新插件保留目标工作区规定的初始稳定版本。
- 已有插件 production bundle 变化时，按兼容影响提高源码 manifest 的 major、minor 或 patch。
- 只修改作者期 eval/report 时不提高插件版本。

## Completion

- 目标工作区要求的 deterministic validators 与 tests 通过；
- build-required 分支生成的 artifact 存在且来源可追溯；
- Eval case 已通过独立 preflight；
- 不存在的工作区命令不伪装成已运行，未运行的模型证据明确标为未验证。
