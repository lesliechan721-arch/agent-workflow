# AW 验证和版本

## 工作区验证

从目标工作区的 manifest/schema、package scripts、CI 配置或维护规则发现适用的 build、test 和 materialization 命令。不要假设插件位于固定目录、工作区使用 pnpm，或一定存在 plugin:test / plugin:eval。

稳定 CLI 入口：

| 任务 | capability check | 执行 |
| --- | --- | --- |
| 创建插件和初始 Skill 骨架 | `aw --version`；`aw plugin init --help` | `aw plugin init <plugin-name> ... --repo-root <workspace-root> --plugin-root <plugin-root>` |
| 增加静态 Skill 骨架 | `aw --version`；`aw plugin add-skill --help` | `aw plugin add-skill <plugin-name> ... --repo-root <workspace-root> --plugin-root <plugin-root>` |
| 验证一个插件根 | `aw --version`；`aw plugin validate --help` | `aw plugin validate <plugin-root>` 加 help 明确支持的 flags |
| 查看 production bundle 状态 | `aw --version`；`aw plugin status --help` | `aw plugin status <plugin-name> --repo-root <workspace-root> --plugin-root <plugin-root> --base <git-ref>` |

每个分支先检查对应 help。命令或 flag 不存在时报告 capability 缺口；不得通过 `npx` 获取另一版本，不得猜测 CLI 或仓库路径。

## Eval 边界

Author 可以创建或修改 Eval 资产，但不自动做 Oracle Audit 或模型运行。用户明确要求运行 Eval 时，由上层工作流单独组合 Auditor、兼容 Runner 和必要授权。Author 的完成条件不依赖模型 Eval。

## Manifest 版本

- 新插件保留目标工作区规定的初始稳定版本。
- 日常开发不因 production bundle 变化直接提高插件版本；`unreleasedChanges` 是有效开发状态。
- release 请求只使用目标工作区提供的 release workflow；未提供时报告能力缺口。

## 完成条件

- `aw plugin validate`、适用的 `aw plugin status` 与本次修改直接相关的 tests 通过；
- build-required 分支生成的 artifact 存在且来源可追溯；
- 不存在的工作区命令不伪装成已运行；
- 未执行的独立 Review、Eval Audit 和模型 Eval 明确标为未验证。
