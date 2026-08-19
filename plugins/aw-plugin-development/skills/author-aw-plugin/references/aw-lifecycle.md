# AW Lifecycle 与运行时 Context

只在插件声明 install、upgrade、uninstall lifecycle，或脚本需要读取 `AW_PLUGIN_CONTEXT` 时读取。

## Lifecycle

支持的事件只有 `install`、`upgrade`、`uninstall`。`aw install`、`aw upgrade`、`aw uninstall` 会自动运行对应 lifecycle；客户端首版没有 `--no-scripts` 跳过开关。脚本失败或超时会让命令失败，所以 lifecycle 必须尽量短、小、幂等。

可用 runner：

- `node`、`sh`、`bash`、`pwsh`、`powershell`、`cmd`
- `auto` 会按扩展名推断：`.js` / `.mjs` / `.cjs` 为 Node，`.sh` 为 `sh`，`.ps1` 为 PowerShell，`.cmd` / `.bat` 为 Windows cmd

生命周期声明可以用字符串简写：

```json
{
  "scripts": {
    "lifecycle": {
      "install": "./scripts/lifecycle.mjs"
    }
  }
}
```

也可以按 OS selector 分流：

```json
{
  "scripts": {
    "lifecycle": {
      "uninstall": {
        "unix": { "runner": "sh", "path": "./scripts/uninstall.sh" },
        "windows": { "runner": "powershell", "path": "./scripts/uninstall.ps1" }
      }
    }
  }
}
```

解析顺序：

| OS | selector 顺序 |
|----|---------------|
| Linux | `linux -> unix -> default` |
| macOS | `darwin -> unix -> default` |
| Windows | `win32 -> windows -> default` |

脚本路径必须在插件根内，不能写内联 shell 命令。Windows 插件优先写 Node 入口；确实需要 shell 时，单独提供 `.ps1` 或 `.cmd`。

超时优先级固定为 CLI `--script-timeout <ms>` > manifest `scripts.timeoutMs` > 默认 `30000`。合法范围是 `1000..300000` 的整数。

### 幂等要求

lifecycle 可能在这些情况下被再次调用：用户重复安装、升级失败后重试、卸载历史版本、双平台安装同一个插件。脚本应遵守：

- 不改写源码树和 generated bundle。
- 写入 AW 受管状态前先创建目录，已有内容按可重复执行处理。
- 清理操作允许目标不存在。
- uninstall lifecycle 使用 lifecycle active store 保存的最后一次成功脚本输入，不读取旧安装状态文件。
- 把 `context.plugin.rootDir` 或 `AW_PLUGIN_ROOT` 当作 runtime 真值，不从 `process.cwd()` 推断插件根。

`aw status` 只读取 current catalog、现场 owner marker 和平台原生状态。它不会运行 lifecycle、renderer，不会刷新 marketplace，也不会创建 config store。target 状态只允许 `present`、`absent`、`partial`、`error`：全部期望组件存在时是 `present`，全部缺失时是 `absent`，部分存在或不完整时是 `partial`，检查失败时是 `error`。没有声明 `config.schema`、`scripts.lifecycle` 或 `artifacts.targets` 不是问题，只表示插件没有对应能力。

## 运行时 Context

AW 会为 lifecycle 和 `pnpm plugin:test` 写入一个临时 JSON context，并把路径放到 `AW_PLUGIN_CONTEXT`。Node 入口建议这样读取：

```js
import { readFile } from 'node:fs/promises';

async function readAwContext() {
  const contextPath = process.env.AW_PLUGIN_CONTEXT;
  if (!contextPath) {
    throw new Error('AW_PLUGIN_CONTEXT is required.');
  }
  return JSON.parse(await readFile(contextPath, 'utf8'));
}

const context = await readAwContext();
```

稳定字段：

| 字段 | 说明 |
|------|------|
| `event` | `install` / `upgrade` / `uninstall` / `test` |
| `plugin.name`、`plugin.version` | 插件身份 |
| `plugin.rootDir` | 当前运行的 bundle root，等同 `AW_PLUGIN_ROOT` |
| `sourceRoot` | 仅 `pnpm plugin:test` 提供，指向原始源码插件根 |
| `platform` | `codex` 或 `claude` |
| `scope` | `user` 或 `project` |
| `cwd` | 命令项目根或测试 runner 的隔离项目根 |
| `paths.awHome` | 当前 AW home |
| `paths.codexHome` / `paths.claudeHome` | 平台 home，lifecycle context 提供 |
| `paths.manifestPath` | 当前 bundle manifest 路径，lifecycle context 提供 |
| `paths.configStores.user/project/projectLocal` | user、project shared、project local raw store 路径，有 config schema 时提供 |
| `config.schema` | 当前 schema |
| `config.values` | 已校验的 effective values |
| `config.sources` | 每个 key 的来源：`default`、`user`、`projectShared`、`projectLocal`、`missing` |
| `config.issues` | 配置问题，lifecycle 正常执行前应为空 |
| `script.runner`、`script.path`、`script.args`、`script.source` | 当前脚本解析结果；`pnpm plugin:test` 中 `script.path` 可为 `null` |
| `artifacts` | install/upgrade 过程中生成的 managed artifacts |

环境变量白名单：

| 变量 | 说明 |
|------|------|
| `AW_HOME` | AW home |
| `AW_CODEX_HOME` / `AW_CLAUDE_HOME` | 平台 home |
| `AW_PLUGIN_CONTEXT` | context JSON 文件路径 |
| `AW_PLUGIN_ROOT` | 当前 bundle root |
| `AW_PLUGIN_NAME` / `AW_PLUGIN_VERSION` | 插件身份 |
| `AW_PLUGIN_EVENT` | 当前事件 |
| `AW_PLUGIN_PLATFORM` | 当前平台 |
| `AW_PLUGIN_SCOPE` | 当前 scope |
| `PATH` | 由命令环境透传 |

POSIX 运行时会使用隔离 `HOME` / `TMPDIR`；Windows 运行时会使用隔离 `USERPROFILE` / `TEMP` / `TMP`。不要读取真实用户 home 或系统临时目录来保存插件状态。

作者 validator 执行 renderer fixture 时使用同一最小环境合同：只传上表变量、隔离 home/temp 和 Windows 启动 Node 所需的系统变量。它不会把父进程的其它环境变量传给插件 renderer。
