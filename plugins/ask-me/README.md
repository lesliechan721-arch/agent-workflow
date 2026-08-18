# Ask Me

在动手前建立足够准确的共享理解。

Ask Me 不会把所有细节都问一遍。它先调查可以确认的事实，再用局部澄清、逐轮访谈或可体验原型处理真正需要用户参与的决定。

## 安装

```bash
aw install ask-me -p both
```

## 包含的 Skill

| Skill | 什么时候使用 |
| --- | --- |
| [`requirements-clarifier`](skills/requirements-clarifier/) | 具体实现请求只有少量关键歧义，需要用最少问题补齐边界 |
| [`decision-grill`](skills/decision-grill/) | 需要通过多轮访谈把计划、方案或重要决定想透并形成共享理解 |
| [`decision-prototype`](skills/decision-prototype/) | 一个决定必须看到、运行或操作候选方案后才能可靠作出 |

## 可配置的实施前检查

插件默认启用实施前质量门禁，以保持既有安装行为。它会在非平凡实现前检查是否仍有会明显影响成品、范围或验收的关键歧义；只有确实需要用户决定时才进入 `requirements-clarifier`。

按当前使用范围关闭或重新开启：

```bash
# user scope
aw config set ask-me qualityGateEnabled false --value-json
aw config set ask-me qualityGateEnabled true --value-json

# project shared scope
aw config set ask-me qualityGateEnabled false --value-json --scope project
aw config set ask-me qualityGateEnabled true --value-json --scope project
```

配置变化会触发 AW 重新渲染当前范围的受管产物。Codex 使用受管 developer instructions block；Claude 使用一个只负责实施前检查的内部 Skill。关闭后只移除该门禁，三个用户可用 Skill 仍保留。

## 典型用法

```text
实现订单导出。先检查有没有会影响成品或验收的关键歧义。
```

```text
围绕新的权限模型逐轮提问我，直到目标、取舍、失败路径和验证方式都清楚。
```

```text
这个审批页面怎么排版我说不清。做一个可点击原型让我试。
```

## 三个 Skill 怎么选

- “这个具体功能还有一两个关键点没说清” → `requirements-clarifier`
- “我需要把整个方案或决定系统地想清楚” → `decision-grill`
- “只靠说无法判断，我需要看到或操作候选结果” → `decision-prototype`

## 边界

- 能从代码、配置或文档查到的事实不会反复询问用户。
- 局部实现细节和已经有明确惯例的事项不会升级为用户决策。
- `requirements-clarifier` 和 `decision-grill` 在确认期间不修改文件。
- `decision-prototype` 可以生成清楚标记的临时原型，但不会把原型自动当作生产实现。

## 维护者

Skill 指令位于各自的 `SKILL.md`，触发与行为用例位于各自的 `evals/`。确定性插件测试：

```bash
pnpm plugin:test ask-me
```
