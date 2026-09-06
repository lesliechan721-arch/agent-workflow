# Skill 脚本编写

只在逻辑重复、确定、复杂且可测试时增加脚本。

- 在 `SKILL.md` 中说明脚本用途、调用时机、输入和成功输出。
- 使用 Skill 根相对路径；声明 Node/Python 等 runtime 和非标准依赖。
- 非交互运行，支持 `--help`；机器输出使用 JSON/CSV/TSV，诊断写 stderr。
- 使用有意义退出码，限制输入与输出，采用 safe defaults；有副作用时提供 dry-run 或显式确认边界。
- 尽量幂等；提供最小 fixture、单元测试或安全样例。
- 不用 shell、文件或 Git 侧信道模拟客户端/runtime 的真实状态。

这些是官方脚本设计 guidance，不应脱离目标环境机械形成发布阻断。
