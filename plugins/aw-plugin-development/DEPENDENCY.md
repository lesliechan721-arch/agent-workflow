# 依赖合同

必需插件：

- `agent-content-toolkit >= 0.1.0`
- `agent-skill-toolkit >= 0.1.0`

manifest 声明这两个同 source 依赖。AW 在安装、升级或重装本插件时解析依赖闭包，并先安装或升级它们。该保证不涵盖外部工具，也不求解或保证第三方版本范围。

Author Skill 还需要已安装的 `aw` CLI，并由该 CLI 提供所需的 `aw plugin` 作者命令。使用前会检查 CLI 版本和所选命令的 help。对于非标准工作区布局，所选 CLI 命令必须提供相对于 `--repo-root` 的 `--plugin-root`；缺少该能力时 Author 会停止。

可选执行插件：`agent-skill-eval-runner >= 0.1.0`。

缺少必需 toolkit 时作者或 Reviewer 停止，不复制本地备用标准。缺少 Eval runner 只限制执行证据，不阻断静态作者工作或质量评审。
