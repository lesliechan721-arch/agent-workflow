# AW Plugin Source 作者指南

> [!NOTE]
> 本文件已迁移。单插件从零起步、验证与删除教程唯一权威正文见：
> [开发你的第一个插件](authoring/first-plugin.md)
> 配置声明与 Manifest 完整规范见 [Plugin Manifest 与配置声明合同](reference/manifest-and-config.md)；运行时与平台投影见 [插件运行时合同](reference/plugin-runtime.md)；托管命令见 [托管命令参考合同](reference/managed-commands.md)。

## Plugin Source 边界

目录结构、文件组织与 Manifest v3 边界见 [开发你的第一个插件：前提条件与目录边界](authoring/first-plugin.md#1-前提条件与目录边界)。

## Config Definition v5 合同

配置 Schema 完整定义与规范见 [Plugin Manifest 与配置声明合同](reference/manifest-and-config.md)。

### 条件对象与常量

条件对象（`variants`）与常量（`const`）声明规范见 [Plugin Manifest 与配置声明合同：条件对象与常量](reference/manifest-and-config.md#条件对象variants与常量const)。

### 已安装配置读取

已安装插件读取配置规范见 [插件运行时合同：已安装配置读取合同](reference/plugin-runtime.md#2-已安装配置读取合同)。

## 插件配置（Config Definition v5）

配置 Schema 完整定义与规范见 [Plugin Manifest 与配置声明合同](reference/manifest-and-config.md)。

### 配置声明与本地 $ref

配置声明语法与 `$ref` 展开机制见 [定义复用与本地 $ref](reference/manifest-and-config.md#32-定义复用与本地-ref)。

### 运行时配置读取（readRuntimeConfig）

已安装插件读取配置规范见 [已安装配置读取合同](reference/plugin-runtime.md#2-已安装配置读取合同)。

### 本地配置测试与依赖校验

配置验证命令与存储解耦见 [Config Store v6 持久化合同](reference/manifest-and-config.md#4-config-store-v6-持久化合同)。

## 单插件作者闭环

单插件初始化、validate、test、build 与 status 流程见 [开发你的第一个插件：作者验证、测试与构建闭环](authoring/first-plugin.md#3-作者验证测试与构建闭环)。只读取证见 [Review 与 Eval 参考合同](reference/review-and-eval.md)。

## 安全删除命令

从 Catalog Workspace 中安全删除单插件源码命令、受保护的目标树匹配门禁与恢复说明见 [开发你的第一个插件：安全删除插件](authoring/first-plugin.md#5-安全删除插件)。

## 托管命令与精确权限

托管命令 Manifest 声明、稳定 ID 算法、权限与沙箱排除见 [托管命令参考合同](reference/managed-commands.md)。

## Build、Portable 和信任边界

原生工具依赖见 [原生工具参考合同](reference/native-tools.md)；平台策略见 [平台策略架构说明](maintainers/architecture/platforms.md)；动态渲染器与 preApply 规范见 [插件运行时合同](reference/plugin-runtime.md)。

## 版本与恢复

单插件版本与快照恢复见 [开发你的第一个插件](authoring/first-plugin.md)；Catalog 级别版本策略与 Journal 状态机见 [外部 Catalog 参考合同](reference/catalog.md)。

## Related documents

- [开发你的第一个插件](authoring/first-plugin.md)
- [Catalog 作者指南](authoring/catalog.md)
- [Plugin Manifest 与配置声明合同](reference/manifest-and-config.md)
- [插件运行时合同](reference/plugin-runtime.md)
- [托管命令参考合同](reference/managed-commands.md)
- [AW 维护者指南](maintainers/README.md)
