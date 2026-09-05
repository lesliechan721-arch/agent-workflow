# AW preApply

先读取 `aw plugin capabilities --json` receipt；只有 receipt 含 `aw.plugin-pre-apply.v1` 时，才使用本合同。`preApply` 只用于安装前环境校验或安装外部系统工具。AW 插件依赖仍由 manifest `dependencies` 声明；Node 依赖在 build-time bundle 中解决。

Manifest v3 只接受 Node 声明：

```json
{
  "scripts": {
    "preApply": {
      "path": "./scripts/preApply.mjs",
      "timeoutMs": 300000
    }
  }
}
```

时限默认为 300 秒，可设为 1 秒到 30 分钟。公开 install、sync、reinstall 和 `config ... --apply` 命令可用 `--script-timeout` 覆盖。执行 `preApply` 前必须完成 TUI Review 确认，或为直接 CLI 显式传 `--yes`。

脚本以 plugin root 为工作目录，用固定 Node 运行。脚本从 stdin 读取 `PreApplyContextV1`：

```json
{
  "schemaVersion": 1,
  "plugin": { "pluginId": "source/example", "name": "example", "version": "1.0.0", "rootDir": "/bundle/example" },
  "target": { "platform": "codex", "scope": "project", "projectRoot": "/project" },
  "config": { "values": {} }
}
```

context 不含 components、平台 home、store path、artifact 内容、`sourceIdentity` 或私有运行状态。每个 target 在一次命令中最多执行一次。脚本必须幂等。

`preApply` 在目标只读 preflight 后、任何 stale cleanup 或 AW-owned 写入前执行。它在 install、sync、reinstall 和 `config ... --apply` 运行，不在 cleanup、uninstall、status 或 Review preparation 运行。非零退出、超时或 spawn 失败会阻止该 target 的 cleanup 和写入；其它 target 继续。AW 不回滚已成功的外部动作。失败输出必须脱敏，用户可重跑 sync 或 reinstall。

Node 示例：

```js
import { readFile } from 'node:fs/promises';

const context = JSON.parse(await readFile(0, 'utf8'));
if (context.schemaVersion !== 1) throw new Error('Unsupported preApply context.');
```

运行测试前，从目标工作区的规则、package scripts 或 CI 发现真实入口；不要假设固定包管理器或命令名。
