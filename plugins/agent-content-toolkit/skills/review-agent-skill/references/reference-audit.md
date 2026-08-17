# Reference Audit

## 触发

任一条件成立时执行逐文件审计：

- 单个 reference 大于约 300 行或 4000 估算 token；
- 一个 full active path 同时加载多个大型 reference；
- 一个文件服务多个彼此独立 branch；
- 典型 branch 只需要文件少量章节；
- 用户明确关注渐进式披露。

阈值只触发语义审计，不自动形成 finding。

## 每个 reference 检查

| 项目 | 问题 |
| --- | --- |
| Necessity | 删除后模型会在哪个真实场景中做错？ |
| Single responsibility | 是否围绕一个领域概念或执行 branch？ |
| Branch locality | 命中 branch 后是否需要文件大部分内容？ |
| Pointer | 是否能在正确时机到达且不每次加载？ |
| Focus | 是否混合可独立加载的主题？ |
| Co-location | 定义、规则和 caveat 是否有一个 owner？ |
| Source freshness | 易变事实是否有来源、日期和重查策略？ |
| Alternative | 是否更适合 script、asset、environment lookup 或删除？ |

## Verdict

`keep | add-index | split-by-branch | inline-core | move-to-script-or-data | delete-or-environment-lookup | needs-ablation`

同时报告 active-path files、总 bytes/tokens、典型 branch 和不需要加载的内容比例。
