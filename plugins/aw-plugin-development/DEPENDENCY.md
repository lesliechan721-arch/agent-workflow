# 手动依赖合同

必需插件：

- `agent-content-toolkit >= 0.5.0`
- `agent-skill-toolkit >= 0.8.0`

Author Skill 还需要已安装的 `aw` CLI，并由该 CLI 提供所需的 `aw plugin` 作者命令。使用前检查 CLI 版本和命令 help。Review 默认使用通用轻量检查与设计结论；只有显式发布检查才要求 materialized profiles。

可选执行插件：

- 当用户要求真实模型 Eval 时，使用 `agent-skill-eval-runner >= 0.3.0`。

缺少 runner 时，Eval 证据保持 `structural`；这不构成 production Skill 缺陷，也不会触发本插件内嵌 runner。
