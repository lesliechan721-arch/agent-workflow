# Composition Fitness Review

> GENERATED from `standards/rules.json`; do not edit manually.

## 六项清单

| 轴 | 问题 |
| --- | --- |
| Independent intents | 用户能否只请求其中一个结果而不需要其它结果？ |
| Permission modes | 是否混合只读、写入、高成本执行和正式发布？ |
| Evidence lifecycles | 作者、Oracle、运行证据和独立裁决是否由同一主体生成并判定？ |
| Environment profiles | 通用规范与单一项目、客户端或 runtime 细节是否混合？ |
| Clean-context phases | 哪些阶段需要独立上下文以避免自证、锚定或注意力竞争？ |
| Stable handoffs | 阶段之间能否用短而稳定的 artifact 合同通信？ |

## Verdict

- `coherent`：一个独立意图，权限和证据生命周期一致。
- `composite-proportionate`：多个不能独立触发的紧密分支，且共享大部分上下文。
- `overloaded`：多个独立意图或权限、证据、profile 不对称，典型 branch 承担大量无关内容。
- `orchestrator-needed`：阶段应分成多个 Skill，由轻量入口只管理顺序、授权和 handoff。

## 强拆分信号

- 创建或修改与独立 Review 混合。
- Eval case 设计与 Oracle 审核混合。
- 通用质量标准与项目 build、materialization 或 publish 混合。
- 长时间执行或状态管理与结果裁决混合。
- 阶段需要 clean context，且已有稳定 artifact handoff。

Reviewer 必须给出最小分解候选并比较 active-path load。文件长或分支多只触发审计，不单独形成 finding。
