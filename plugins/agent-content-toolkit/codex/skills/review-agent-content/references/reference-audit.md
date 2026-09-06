# Reference 审计

仅在评审 reference 包、大型 reference 或会加载多个 reference 的 active path 时使用本文档。

## 审计触发条件

尺寸信号只要求进行语义评审，本身不是缺陷。文件满足以下任一条件时进行评审：

- 文件大约超过 300 行或预估超过 4000 个 token；
- 一条 active path 会加载多个大型 reference；
- 一个文件服务多个独立 branch；
- 典型 branch 只需要文件的一小部分；
- 用户明确询问渐进式披露。

## 单个 reference 检查

| 检查项 | 问题 |
| --- | --- |
| 必要性 | 删除此内容会导致什么现实故障？ |
| 单一职责 | 文件是否只服务一个概念或执行 branch？ |
| Branch locality | branch 命中后，是否需要文件的大部分内容？ |
| 指针 | Agent 能否在正确时机到达本文档，而不必每次运行都加载？ |
| 聚焦性 | 文件是否混合了可独立加载的主题？ |
| Co-location | 定义、规则和 caveat 是否由同一位置负责？ |
| 新鲜度 | 会变化的事实是否有来源、日期和复查策略？ |
| 替代方案 | 此内容是否更适合改为脚本、asset、环境查询或删除？ |

对每条代表性 active path，记录主文档、已加载的 reference、总字节数、token 估算、指针证据和预估的不必要内容比例。

## 结论

`keep | add-index | split-by-branch | inline-core | move-to-script-or-data | delete-or-environment-lookup | needs-ablation`

如果 branch 命中后需要一个大型扁平权威 reference 的大部分内容，则不要拆分它。不要仅因指针有效而保留不必要的 reference。
