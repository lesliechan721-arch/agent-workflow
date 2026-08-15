# Coding Conventions

本文件面向仓库维护者，负责 TypeScript 实现约定。系统边界和产品合同见[架构说明](architecture.md)，测试书写和验证选择见[测试指南](testing.md)。

## TypeScript Style

- TypeScript strict mode；ESM import 使用 `.js` 后缀。
- 2 空格缩进，单引号，无分号省略。
- public function 和复杂边界使用明确类型。

## Functions and Modules

- 优先使用小函数和已有 helper，不为单次使用创建抽象。
- 跨模块公共数据使用现有共享类型，不创建结构相同的局部合同。
- 模块职责必须遵守架构边界。需要改变职责时，先更新架构说明，不在局部分支建立平行实现。
