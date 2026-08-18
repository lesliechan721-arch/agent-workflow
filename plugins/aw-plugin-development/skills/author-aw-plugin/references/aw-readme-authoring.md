# AW README authoring

本规范随 `author-aw-plugin` 分发，适用于目标 AW 插件根及其中的 Skill README。它不依赖宿主工作区的 `docs/`，因此插件位于其它项目或非 `plugins/` 目录时仍可使用。

## 文档职责

| 文件 | 主要读者 | 职责 |
| --- | --- | --- |
| `.agents-plugin/plugin.json` | CLI 与平台 | 名称、版本、平台、配置和能力等机器元数据 |
| 插件 `README.md` | 插件用户 | 安装价值、能力概览、典型使用和用户可观察边界 |
| Skill `README.md` | Skill 用户 | 适用场景、工作方式、结果和限制 |
| `SKILL.md` | Agent | 触发条件、执行流程、不变量和完成条件 |
| `evals/**` | 维护者 | 触发、行为、组合与回归评测 |
| `reports/**` | 维护者与审核者 | 正式质量证据 |

README 说明用户能获得什么、何时使用以及会产生什么影响。不要复制 `SKILL.md` 的内部算法、完整触发规则或逐步执行合同。

## 通用原则

- 先说明用户问题和产品价值，不以目录结构、manifest 字段或内部组件开头。
- 名称、命令、Skill 标识和配置键保持原始英文；正文语言服从目标插件既有约定。
- 内容同时适合源码浏览和安装后的 runtime 文件树。
- 用户决定是否安装和使用所需的信息直接写在 README 中；不能依赖安装制品中可能不存在的作者材料。
- 平台、scope、版本和配置 schema 以 manifest 为真值；调用策略以平台原生元数据和 `SKILL.md` frontmatter 为真值。README 只做人读摘要。
- 可以链接同一插件根内的 `SKILL.md`、`evals/` 或维护者入口；宿主工作区外材料只使用稳定公开链接。
- 不写迁移过程、CI 结果、runner、batch、trace、coverage、被评估 commit 或正式报告摘要。
- 不把普通插件 README 或 Skill README 默认交给 `write-agent-content`；它们属于 AW 产品说明，由当前 Author 按本规范维护。

## 插件 README

插件 README 通常覆盖：

1. 一两句话说明安装价值。
2. 可直接使用的安装或启用方式；仅在目标工作区确有该命令时给出。
3. 用户可见的 Skill、Slash Command、配置或其它能力，以及各自适用场景。
4. 至少一个可复用的真实请求或使用示例。
5. 相邻能力选择、不适用场景和用户可观察副作用。
6. 仅在需要时说明平台差异、scope、配置、人工依赖或安装前提。
7. 可选的简短维护者入口。

不要为了固定模板生成空章节。

## Skill README

Skill README 通常覆盖：

1. 标题和一句话任务说明。
2. 主要适用场景。
3. 容易混淆的高价值不适用场景。
4. 用户可观察的工作方式、确认点和最终结果。
5. 写入、Git、网络、子代理、外部命令和授权边界。
6. 仅在用户需要知道时说明调用方式或客户端差异。
7. 可选的 `SKILL.md`、`evals/` 或维护者入口链接。

## 维护门禁

- 新增、删除或重命名能力时同步插件 README。
- 改变平台、scope、调用策略、配置、权限或用户可观察结果时同步对应 README。
- README 属于 production source；修改现有插件的 production README 时按目标工作区版本规则处理。
- 作者验证检查 README 存在、非空、相对链接有效，并与 manifest 和调用元数据一致。
- 正式报告发布与 README 维护是独立流程；评审或报告发布不得自动改写 production README。
