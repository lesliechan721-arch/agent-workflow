# Script Authoring

脚本适用于解析、生成、转换、计算和静态校验。要求：相对路径、显式依赖、非交互、`--help`、可操作错误、稳定 stdout、stderr diagnostics、退出码、输入/输出上限、路径安全、幂等或 dry-run，以及 fixture/tests。

脚本不模拟 runtime agent 状态，不用 Git/文件侧信道替代正式工具状态。
