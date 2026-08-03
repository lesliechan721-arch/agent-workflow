# Skill 设计指南

创建新的 skill、重写现有 `SKILL.md`，或改变 skill 的职责、输入输出和触发边界时先读本文。字段如何映射到 Claude、Codex 和 AW 内建触发配置，继续查看 `references/skills-and-triggers.md`。

本指南采用 Agent Skills 的渐进式披露模型：启动时只暴露 `name` 和 `description`，触发后加载完整 `SKILL.md`，其它 reference、script 和 asset 再按任务需要读取。

## 先判断是否应该做成 skill

Skill 适合封装需要模型判断、领域知识或多步骤协作的可复用工作流。先写清楚：

- 用户想完成什么，而不是准备调用哪些内部实现
- 输入、输出和成功标准
- 必须遵守的项目约定或领域规则
- 模型在没有本 skill 时容易犯的具体错误
- 哪些相邻任务不属于本 skill

以下情况优先使用其它能力：

| 需求 | 优先能力 |
|------|----------|
| 每次会话都必须生效的规则或权限 | `extensions` |
| 一个显式快捷入口，不承载独立工作流 | 公共 `slashCommands` |
| 完全确定、无需模型判断的重复计算 | 可测试脚本；需要模型编排时再由 skill 调用 |
| 只随 AW config 生成 Codex 产物 | `codex.skill` dynamic artifact |

不要把一个紧密工作流拆成许多只能串联使用的小 skill，也不要把数据库查询、数据库管理和发布运维等不相干职责塞进同一 skill。目标是一个能独立解释、独立触发、与其它 skill 组合的工作单元。

## 从真实经验提炼

不要只让模型凭通用知识生成最终 skill。优先收集：

- 已经成功完成过的真实任务和操作顺序
- 用户或 reviewer 对 agent 做过的纠正
- 项目文档、schema、runbook、issue、事故和修复记录
- 实际输入输出样例
- 失败案例、非直觉约束和恢复方式

第一版完成后仍要用真实任务执行并查看完整轨迹。agent 反复试错通常意味着指令太模糊；无条件执行无关步骤通常意味着范围太宽；每次都临时重写同一段逻辑则适合提炼为脚本。

## Frontmatter profile

### Agent Skills portable core

以下字段属于 Agent Skills 核心格式：

| 字段 | 约束 | 使用方式 |
|------|------|----------|
| `name` | 必填，1–64 字符；不得以短横线开头、结尾或包含连续短横线；必须与目录名一致 | 稳定的 skill 标识 |
| `description` | 必填，1–1024 字符 | 同时说明做什么和何时使用 |
| `license` | 可选，非空字符串 | 许可证名称或 skill 内许可证文件 |
| `compatibility` | 可选，1–500 字符 | 只写真实环境要求，例如 Node、系统包、网络或目标产品 |
| `metadata` | 可选，string → string | 客户端或项目附加元数据 |
| `allowed-tools` | 可选，空格分隔字符串；实验性 | 预批准工具声明，客户端支持可能不同 |

Portable core 只保证格式可被兼容客户端理解，不保证所有客户端都执行实验字段。

AW source profile 为了与插件目录、脚手架及两个宿主平台保持一致，额外把 `name` 收窄为 ASCII 小写短横线格式：`[a-z0-9]+(?:-[a-z0-9]+)*`。这是项目约束，不要把它误写成所有 Agent Skills 客户端都必须采用的额外限制；独立 portable skill 的最终判定以对应版本的上游 `skills-ref` 为准。

### AW 平台扩展

AW 的共享源码还允许目标平台需要的扩展：

| 字段或文件 | 平台 | 说明 |
|------------|------|------|
| `user-invocable` | Claude | 是否保留用户手动入口 |
| `disable-model-invocation` | Claude | 是否禁止模型自动调用 |
| `shell` | Claude | 命令结果填充使用的 shell |
| `allowed-tools` 数组形式 | Claude | Claude 可读写法；不是 portable core 的 canonical 表达 |
| `metadata.short-description` | 项目/UI 约定 | 仍必须是字符串 metadata |
| `agents/openai.yaml` | Codex | UI、依赖和隐式调用策略；`short_description` 为 25–64 字符，`default_prompt` 必须显式包含 `$skill-name` |

双平台源码可以保留这些已知扩展，但不能声称源码能严格通过只接受 portable core 的 validator。需要严格可移植时，使用字符串形式 `allowed-tools`，移除平台扩展，或通过模板生成分平台 frontmatter。

仓库内 `validate_plugin.js --strict-agent-skills` 用于和 AW manifest、目标平台一起做 portable core 预检，不是上游 reference validator 的替代品。需要发布独立 portable skill 时，在 `skills-ref` 可用的环境额外运行：

```bash
skills-ref validate <skill-directory>
```

## 写好 description

`description` 是自动发现 skill 的主要输入。按以下顺序写：

1. 用指令式条件开头，例如“当用户……时使用”
2. 描述用户意图和可交付结果
3. 加入用户可能使用的领域词、文件类型或任务线索
4. 写出容易误触发的近似任务边界

推荐模板：

```yaml
description: >
  当用户需要 <目标或结果> 时使用，包括 <典型场景或线索>。
  不用于 <最容易混淆的相邻任务>。
```

避免：

- `帮助处理数据` 这类无法确定范围的描述
- 只列内部实现，例如“调用脚本 A 和 API B”
- 把完整工作流和所有边界都塞进 description
- 为少数测试 query 逐个堆关键词

允许自动触发的 skill 应通过正例和近似负例验证 description。固定 manual 的 skill 仍要写清范围，方便用户发现、显式选择和未来策略调整。评估方法见 `references/skill-evaluation.md`。

## 组织 SKILL.md

只保留 agent 每次触发后都需要的内容。推荐结构：

```markdown
# Skill 名称

目标和完成标准。

## 前置判断

需要检查的输入、状态或授权边界。

## 工作流

1. 执行步骤
2. 验证结果
3. 失败则修复并重跑验证

## 输出

需要交付的文件、数据或回复结构。

## Gotchas / 边界

- 没有本指令时容易做错的项目事实
- 禁止或需要确认的操作
```

按任务脆弱度控制细节：

- 多种方案都正确时说明目标和选择依据，允许 agent 判断
- 顺序敏感、破坏性或一致性要求高时给出准确步骤和验证门
- 有多个方案时给默认方案，只简要说明何时改用替代项
- 写可复用过程，不写只适用于一个具体请求的答案

高价值内容通常是非直觉 gotcha、短输出模板、带依赖关系的 checklist，以及“执行 → 验证 → 修复 → 重验”循环。机械校验优先交给脚本。

## 渐进式披露

- 主 `SKILL.md` 保持少于 500 行、建议少于 5,000 tokens
- 只把每次执行都需要的工作流和 gotcha 放在主文件
- 直接从 `SKILL.md` 指向所需资源，避免 reference 再层层转引
- 每个引用都写清读取条件，例如“API 返回非 2xx 时读取……”
- 不要用“按需查看 references/”这类无法判断时机的入口

资源分工：

| 目录 | 放置内容 |
|------|----------|
| `references/` | 仅在特定分支需要的领域规则、schema 和长说明 |
| `scripts/` | 可重复、可测试的确定性逻辑；规范见 `references/skill-scripts.md` |
| `assets/` | 输出模板、图片、静态数据和其它无需作为指令阅读的资源 |
| `evals/` | 作者期触发与输出质量用例；规范见 `references/skill-evaluation.md` |

## 完成检查

- [ ] 职责是一个连贯工作单元
- [ ] 内容来自真实项目知识或执行反馈
- [ ] description 同时覆盖用户意图、触发线索和近似边界
- [ ] portable core 与平台扩展没有混写成同一标准
- [ ] 主文件只有每次都需要的内容，并在预算内
- [ ] 脆弱步骤有验证门，失败后会修复并重验
- [ ] 输出格式在确有要求时给出短模板
- [ ] scripts、references 和 assets 都有明确读取或执行条件
- [ ] 已按 `references/skill-evaluation.md` 用真实任务检查结果

## 上游参考

- [Agent Skills specification](https://agentskills.io/specification)
- [Best practices for skill creators](https://agentskills.io/skill-creation/best-practices)
- [Optimizing skill descriptions](https://agentskills.io/skill-creation/optimizing-descriptions)
