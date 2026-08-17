# Package and disclosure

- `SKILL.md`：所有命中 branch 都需要的核心步骤、默认和 gotcha。
- `references/`：单一 branch 才需要的 focused 规则；直接从主文件一层到达。
- `scripts/`：重复、确定、可测试的解析、生成、转换和验证。
- `assets/`：模板、示例和静态数据，不隐藏强制指令。
- `evals/`：作者期测试定义，不进入 runtime 指令路径。

每个 reference 记录：目标 branch、incoming pointer、是否大部分内容都会被该 branch 使用、权威 source 和更新策略。
