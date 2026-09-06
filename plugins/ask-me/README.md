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
- `decision-grill` 在最终记录确认前不修改文件。
- `decision-prototype` 可以生成清楚标记的临时原型，并按需启动仅绑定本机的 Review 会话。页面用 tabs 展示单个大预览，可按需并排比较；用户选择总体判断后，页面才显示相关评论、受控参数或 drawer 标注。页面只有一个提交动作，同一 revision 的首个有效反馈生效。Agent 打开 URL、等待页面提交并读取 revision-bound feedback；脚本不自动打开浏览器，也不会把原型当作生产实现。

Review Shell 的维护边界见 [`docs/prototype-review-ux.md`](docs/prototype-review-ux.md)。
