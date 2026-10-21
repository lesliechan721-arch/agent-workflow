# 构建与共享资源

需要编译 Node 工具、复用插件间文件，或向 Skill 注入与生成资源时读取。先从当前 capability receipt 查询所用声明；source/provider 的定位与修改归属见 [来源与运行包](source-materialization.md)。

## 按消费方式选机制

| 实际需要 | 使用的声明 | 消费方式 |
| --- | --- | --- |
| 构建本插件的 Node 工具 | `scripts.node.packageRoot`、`scripts.node.build` | 在构建 staging 中生成 bundle 内容 |
| 构建脚本读取另一插件的导出 | provider 的 `runtimeExports` 与 consumer 的 `buildImports` | 读取 CLI 注入的绝对文件路径环境变量 |
| 给静态 Skill 增加已有文件 | `buildConfig.skillRuntimeFiles` | 从本插件 source 或声明的 import 复制到 Skill 目标 |
| 声明 build 必须生成的 Skill 文件 | `buildConfig.generatedSkillRuntimeFiles` | build 自己生成文件，声明用于输入和 final 验证 |
| renderer 读取共享文件 | artifact 的 `runtimeImports` | 从本次 context 选择 bundle-local 文件，再生成所请求 artifact |

跨插件构建复用与安装依赖分别声明。只有消费者实际需要 provider 一同安装时才形成 manifest `dependencies`；import 本身不推断这项依赖。

## Node build 与可重用输入

`scripts.node.build` 使用当前合同的 Node runner、path 和可选 args；测试通过 `scripts.tests.node` 注册。Node 依赖在构建期 bundle 中解决，不让 Skill 首次运行时隐式安装。

构建只写其 staging，使用声明的输入，不读取用户真实配置或修改 provider source。只有已配置 build，且结果由注册输入决定时才声明 `buildConfig.cacheable: true`；该字段不是任意布尔开关，关闭时省略而非写入不被接受的值。存在未绑定的外部输入时先解决可重建性。

## Provider export 与 consumer import

Provider 在 `buildConfig.runtimeExports` 为导出提供稳定 name、source 及必需的 `requires.aw.capabilities`。没有额外能力时显式使用空数组。能力 metadata 由 provider 作者维护；Core 不通过扫描导出内容猜测它。

导出 source 必须符合当前作者验证：provider root 内 canonical 的普通非符号链接文件，不使用 Skill、报告、Eval、依赖目录或临时构建文件绕过资源边界。改变导出前核对实际 consumers，不能只验证 provider 自身。

Build import 以 plugin/export/env 声明，环境变量遵循 `AW_PLUGIN_IMPORT_<NAME>` 约定。构建脚本只读实际注入的绝对路径，不拼接 sibling source 或扫描其他插件 bundle。

Artifact runtime import 按当前 target 的 artifactId 和声明 name 从 context 选取，只读其 bundle-local path；具体 renderer 请求边界见 [Artifact renderer](aw-artifact-renderer.md)。

## Skill 文件与生成文件

`skillRuntimeFiles` 的每项指定 skill、target，并选择本插件 source 或 provider import。静态 Skill 的 target 只位于 references、assets 或 scripts，不覆盖已经存在的目标。通过 platforms 与 distributions 选择实际投影；字段省略和组合语义见 [平台投影](platform-projection.md)。

`generatedSkillRuntimeFiles` 声明 build 应生成的精确文件，不执行复制，也不建立安装依赖。source 校验可以接受已声明但尚未生成的目标；最终包必须包含真实普通文件及完整引用闭包。不要用声明替代生成结果，或用宽泛路径掩盖缺失文件。

## 能力要求与验证

只有 `skillRuntimeFiles.import` 和 artifact `runtimeImports` 将 provider export 的运行能力要求传播给 consumer。纯 `buildImports`、本地 `skillRuntimeFiles.source` 和 generated 文件不做这项传播；consumer 自己的运行要求由其声明负责。

能力计算的 declared、derived、detected 与 effective 含义见 [平台投影](platform-projection.md)。Provider/consumer 改动后，核对依赖顺序、实际构建结果、资源闭包及所选 surface 的 final。共享文件的源码位置、每个受影响消费者和最终路径分别记录；生成物由正常构建更新。
