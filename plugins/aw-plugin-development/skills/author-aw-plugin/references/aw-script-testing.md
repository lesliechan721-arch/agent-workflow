# Script / Build / Test

Node runtime 默认只使用 `node:` 模块和插件内静态相对 import。需要第三方依赖时，按目标工作区 manifest 合同声明 package root 和 registry-backed production dependencies；不借用 workspace 根依赖。

build 规则读取 [Build 作者策略](build-config-spec.md)。build、test 和 materialization 命令必须从目标工作区的规则、package scripts、CI 或 CLI help 发现，不假设包管理器、固定目录或固定命令名。

确定性测试执行真实 helper、preApply、renderer、validator 或 bundle 路径，断言公开输出、副作用、失败边界或 runtime closure。测试使用隔离 home/project，不访问用户环境。模型判断和措辞质量属于 Eval，不用 prose 正则模拟。

完成前验证：声明脚本可执行；build-generated target 都已物化；最终 Skill nested references 无断链；敏感值已脱敏；重复运行无额外副作用。
