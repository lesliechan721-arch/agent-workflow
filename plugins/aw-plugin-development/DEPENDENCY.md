# 手动依赖合同

必需插件：

- `agent-content-toolkit >= 0.5.0`
- `agent-skill-toolkit >= 0.8.0`

Author Skill 还需要已安装的 `aw` CLI，并由该 CLI 提供所需的 `aw plugin` 作者命令。使用前会检查 CLI 版本和所选命令的 help。由于 Review 和非作者流程不需要这些命令，静态插件 runtime 兼容版本仍为 `0.0.0`。对于非标准工作区布局，所选 CLI 命令必须提供相对于 `--repo-root` 的 `--plugin-root`；缺少该能力时 Author 会停止。

可选执行插件：

- 当用户要求真实模型 Eval 或 release-grade 行为证据时，使用 `agent-skill-eval-runner >= 0.3.0`。

缺少 runner 能力时，真实模型证据降级为 `structural`/`provisional`；这不构成 production Skill 缺陷，也不会触发本插件内嵌的备用 runner。
