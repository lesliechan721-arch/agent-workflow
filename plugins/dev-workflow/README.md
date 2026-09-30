# Dev Workflow

```bash
aw install dev-workflow --scope user --target codex --target claude-code
```

```text
完整开发：dev-workflow → dev-design → dev-build → 交付
                         对齐／规格      准备／实施／集成
                                           │
                          milestone／最终范围 → dev-repair
                                                   ├── dev-review-code
                                                   └── dev-implement
```

Design 可独立用于“先设计，以后实施”；Build 也可从已有有效目标直接工作。五个阶段是成果与责任的视图，专业能力可独立调用。小任务由 Design 判断，必要对齐、验证和最终核验保持，默认不建立流程文档。

## 能力

| Skill | 当前结果 |
| --- | --- |
| dev-workflow | 连接 Design 与 Build，处理跨阶段变化 |
| dev-design | 形成有确认依据的设计，选择对话或完整规格交付 |
| dev-spec | 综合完整当前规范及可达附件 |
| dev-review-spec | 独立核对规格保真、人审完整和可实施性 |
| dev-breakdown | 准备可独立接手的工作项与真实依赖 |
| dev-build | 协调实施与集成，采用有界核验结果推进交付 |
| dev-repair | 对当前范围组织独立审查、必要修复、验证与复审 |
| dev-implement | 实现一个已明确的工作项或有界修复 |
| dev-review-code | 当前范围的需求／设计与工程质量两份独立判断 |

修复预算遵循当前授权，未指定的新授权默认最多三轮，由 Repair 按证据继续或提前停；已有较低限制、已用次数和人类停止点保持。只读审查不自动取得修改权限。采用 Skill 不等于新建代理，角色隔离按实际审查要求执行。

## 资料

领域词汇、重要理由和确有消费者的公共合同按需维护。完整任务规格、原型和过程证据默认只在 `.dev-workflows/<task>/` 保存，目录用途见 [工作目录](references/local-workspace.md)。设计恢复使用当前设计产物；实施／修复需要协调时才创建 Work。普通开发完成前不推送，完成后也需要实际授权。

现有安装依赖为 decision-kit。安装、模型成本、提交与外部操作遵循项目和平台权限。用户只要一个阶段时在该阶段结束，完整结果采用本轮有效审查，不重复制造相同循环。
