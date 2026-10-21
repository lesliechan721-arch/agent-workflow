---
name: author-agent-skill
description: >-
  创建或修改 Agent Skill 时使用，包括任务方法、description、调用字段、references、脚本、模板和 Eval 用例；完成当前修改所需的自检与修复。
metadata:
  short-description: 设计、创建和维护可独立使用的 Agent Skill，并验证实际交付
---

# Author Agent Skill

将真实任务中的可复用知识和方法做成 Skill。编写正文和 reference 时使用 `agent-content`。

## 提炼任务方法

读取用户任务、现有材料和受影响文件。新建或实质重写时，按 [设计与验证](references/design-and-validation.md) 找出执行者缺少的领域知识、选择依据和易错点；从实际资料提炼方法，不把一次任务的答案写成所有输入的固定步骤。

已有明确要求就直接采用。局部修词或路径修正只处理当前变更；职责或调用范围改变时，按 [调用与描述](references/skill-invocation.md) 核对代表性请求和相近边界。组合、角色或交接改变时，使用 [组合规则](references/skill-composition.md)。

## 制作 Skill

创建包或修改字段时读取 [格式与调用字段](references/skill-format.md)。新目录使用初始化工具：

```sh
node scripts/init-skill.mjs <new-directory> --description "说明该技能处理的用户任务" --format json
```

补齐生成文件中的任务方法，再添加确实需要的资料、脚本或模板。

正文保留共同方法和关键陷阱。分支资料提供明确的读取条件；模板服务实际输出；脚本服务稳定复用的机械操作。按变更面采用：

| 任务 | 方法 |
| --- | --- |
| 漏触发、误触发或调用行为改变 | [触发诊断](references/trigger-development.md) |
| 创建或修改随包脚本，以及编写调用说明 | [脚本设计](references/script-authoring.md) |
| 创建或修改 Eval case、fixture 和断言 | [Eval 设计](references/eval-design.md) |

## 验证

按本次修改影响完成相称自检。修改脚本时执行实际正常输入与关键错误输入，核对输出、退出码和文件影响；修改方法时用代表性任务核对资料、分支选择、相邻边界与产物。

结构、字段或引用改变后检查包：

```sh
node scripts/check-skill.mjs <skill-directory> --format json
```

按诊断修复并重验；工具参数按需查询 `--help`。
