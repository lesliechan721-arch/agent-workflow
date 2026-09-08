# Plugin Review

检查：manifest/source truth、组件职责、dependencies、runtime imports/exports、共享脚本、build/materialization、profile 差异、动态 Skill final 和 leaf digest 去重。

用 `aw review inspect <plugin-path> --json` 取证；先报告无效机器事实。缺少 materialized final 时只评价可见 source，不推断 collection 已通过。项目级适配与 leaf Skill finding 分开 owner。
