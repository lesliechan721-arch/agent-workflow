# Ask Me

通过完整 Shape、逐轮访谈或可体验原型，为重要决定建立准确的共享理解。

Ask Me 先调查可以确认的事实，再按任务范围选择完整塑形、独立访谈或最低成本原型。

## 安装

```bash
aw install ask-me -p both
```

## 包含的 Skill

| Skill | 什么时候使用 |
| --- | --- |
| [`decision-shape`](skills/decision-shape/) | 一个复杂主题需要问答和按需原型共同形成完整共享理解 |
| [`decision-grill`](skills/decision-grill/) | 需要通过多轮访谈把一个计划、方案或重要决定想透 |
| [`decision-prototype`](skills/decision-prototype/) | 一个明确决定必须看到、运行、操作、实验或测量候选结果后才能作出 |

三个 Skill 都可以直接调用。`decision-shape` 是可选宏能力，拥有跨轮次共享决策方向（Decision frame），并把它传给当前叶子 Skill。方向变化时，它只重新打开受影响的决定。两个叶子 Skill 不互相调用，也不依赖 `decision-shape`。

`decision-prototype` 按主要不确定性选择逻辑演示、界面候选或技术实验，再选择反馈方式。Review Shell 负责呈现证据和收集输入。Shape 只吸收当前答案、成立条件、必要风险和证据指针。

## 典型用法

```text
把这个复杂的产品方向通过问答和必要原型完整塑形，最后给我一份当前有效的 Shape。
```

```text
围绕新的权限模型逐轮提问我，直到目标、取舍、失败路径和验证方式都清楚。
```

```text
这个审批页面怎么排版我说不清。做一个可点击原型让我试。
```

## 三个 Skill 怎么选

- “复杂主题需要问答和必要原型共同塑形” → `decision-shape`
- “我需要通过逐轮访谈把一个决定想清楚” → `decision-grill`
- “只靠说无法判断，我需要看到、操作或测量候选结果” → `decision-prototype`

## 边界

- 能从代码、配置或文档查到的事实不会反复询问用户。
- 普通实施任务中的局部歧义不会自动进入完整决策访谈。
- `decision-shape` 只在调用者提供路径、仓库有约定或跨会话确有价值时写入 Shape。
- `decision-grill` 已获保存授权且有明确位置时，可先保存用户明确确认的批次，并保留开放问题和整体待确认状态；除此之外，最终记录确认前保持只读。
- 持久化原型保存问题、可重放证据和结论；只有标准网页 Review 或用户明确要求时才需要 `prototype.json`。构建和迭代默认委派一个 Builder；极小新建、局部微调或子代理不可用时由主代理完成，主代理负责必要验收。
- `decision-prototype` 可以生成清楚标记的临时原型，并按需启动仅绑定本机的 Review 会话。页面用 tabs 展示单个大预览，可按需并排比较；用户选择总体判断后，页面才显示相关评论、受控参数或 drawer 标注。页面只有一个提交动作，同一 revision 的首个有效反馈生效。Agent 优先使用用户可交互的原生预览，脚本的 `open` 操作提供本机默认浏览器兜底；脚本技术失败后由 Agent 使用系统浏览器能力打开同一 URL，均失败则输出 URL 供用户自行打开。权限拒绝不能绕过。所有 `submitted` 回执直接包含当前 revision 已校验的完整反馈和文件路径。原型不会自动成为生产实现。

## Portable Agent Skills

三个 Skill 也可通过 portable-agent-skills 分发。使用 `aw skill install ask-me --scope <project|user>` 安装，或使用 `aw skill materialize ask-me --scope <project|user> --out <dir>` 导出。

## Review 默认期限

新会话默认有效 30 分钟。使用 `start --ttl` 可以设置本次会话期限，最大为 4 小时。

页面显示剩余期限，支持显式延长或取消本次会话。服务会自行到期，提交成功后也会自行关闭。`wait` 应在工具限制内采用较长等待窗口，避免短轮询。超时只结束当前等待，不取消仍有效的会话。原型和已保存的反馈继续保留。

Review Shell 的维护边界见 [`docs/prototype-review-ux.md`](docs/prototype-review-ux.md)，会话行为见 [`docs/prototype-review-runtime.md`](docs/prototype-review-runtime.md)。
