# Delta Review

修订版默认做差量评审，防止每轮 review 扩张新的理论问题。

## 必做步骤

1. 列出上一轮 P0/P1 和接受的设计决策。
2. 逐项判断：closed、partially closed、open、regressed。
3. 比较 `SKILL.md` 的行数、字符、控制词、生命周期词和协议词。
4. 比较新增/删除的 references、scripts、assets、evals 和 role 指令。
5. 检查新文字是否有新 observed/documented 证据和对应 eval。
6. 重新评分受影响维度；未受影响维度沿用基线并说明。

## 防漂移规则

没有新证据时：

- 不重新扫描并升级一批理论边界。
- 不因 schema 新增字段自动扩大 Skill 目标。
- 不把 advisory 直接改写进正文。
- 不因总分提升而忽略正文、分支或重复协议持续增长。

连续两轮出现“正文和条件增长，但 behavior eval 无改善”时，方向标记至少为 `at-risk`，并建议停止补丁、做架构性减法。

## 复杂度预算

报告以下 delta：

- `SKILL.md` 字符、行数、估算 token。
- 条件/控制标记。
- 生命周期和协议标记。
- 重复段落或多个 role 的相同协议。
- 资源总大小和不可达文件。
- eval case 数量与通过率。

复杂度增加不是自动缺陷；它必须由行为收益证明。

## Delta 结论

- **improved**：旧问题关闭，行为证据改善，复杂度合理。
- **neutral**：主要是清晰度或结构调整，无明显质量变化。
- **regressed**：引入新失败、误触发或断裂。
- **drifted**：修改逐渐偏离原目标，或以自然语言补运行时/程序逻辑。
