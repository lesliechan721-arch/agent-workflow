# Build 作者策略

字段合同运行 `aw plugin capabilities --surface build-config --json` 查询。build 只从已声明输入生成确定性 staging 输出；源码树和用户环境不是输出位置。

- `buildImports` 复用 canonical build 输入，不形成安装依赖。
- `skillRuntimeFiles` 投影已有 source/import 文件。
- `generatedSkillRuntimeFiles` 声明 build 创建的 Skill 文件。源码检查只豁免精确声明的 target；materialized runtime 必须存在并通过完整 closure。
- 只有输出完全由 registered build input 决定时使用 `cacheable: true`。
- 在目标工作区内发现 build、test 和 materialization 命令。不要假设包管理器；先读 workspace 规则与命令帮助。

构建脚本必须安全、可重复执行，并只修改 staging root。不得借 build 隐式安装工具或读取真实用户配置。
