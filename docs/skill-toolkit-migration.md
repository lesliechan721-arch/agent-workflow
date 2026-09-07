# Skill 工具链迁移记录

本次以 V4 草案为内容基线，适配当前 AW 源码合同。草案目录保持不变；运行资源由当前插件源码和 AW 构建产生。

## 已确定的结构

| 插件 | Skill |
| --- | --- |
| agent-content-toolkit | agent-content |
| agent-skill-toolkit | author-agent-skill、review-agent-skill、simplify-agent-skill、audit-agent-skill-evals、review-agent-architecture |
| aw-development-toolkit | develop-aw、review-aw、publish-aw-catalog |
| aw-skill-eval-runner | run-aw-skill-evals |

只有 Publisher 是 manual-only 用户宏，其余九个 Skill 可被模型和其它 Skill 使用。Plugin 稳定版本保持 `0.1.0`，Catalog 版本保持 `0.1.0-beta.9`；本次不发布远端，也不修改用户已有安装与 project intent。

## 保留与适配

- `agent-content` 合并写作与评审共同方法，保持调用方的操作边界，不引入模式状态机。
- Eval 设计进入 Author 的 reference；Auditor 保留源用例审核、独立正式准入和结果归因。真实执行仍由 Runner 负责。
- 调用与组合规则各保留一份源码，通过 AW `skillRuntimeFiles` 投影给 Author 和两个 Reviewer。可选 AW 归档说明由 AW 插件拥有并导出；构建复用不增加反向安装依赖。
- 移除 ReferenceAuditResult、强制 SkillDesignBrief、通用 QualityReviewResult 和同上下文 AWAuthoringContext。EvalSpec/Audit/Result 与 publication plan/journal 保留；可选 Release Check 消费 AWReviewEvidence。
- 当前 AW 只有 `preApply` 对应的安装前合同，修正草案的 postApply 分支；恢复 renderer 配置隔离、敏感值和 portable surface 边界。
- Runner 保留 Full Access、进程树、macOS Codex/keychain 拒绝与非受管风险边界；不以单次提权绕过。
- Publisher 使用 CLI 默认 Workspace、remote 和 branch。授权时展示解析后的完整 planDigest，apply 显式使用同一目标与摘要。
- 显式报告归档继续支持现有 `skill`、`workflow`、`aw-plugin` 和 `aw-workflow` kind；Catalog 与 portfolio 报告写到指定目录，不新增 archive kind。

## 分阶段验证

阶段一 checkpoint 为 `c04f1f17`：新增只读 inspection 与 Eval/portable 来源绑定。独立 Milestone Review 的来源漂移、静态 final 映射、可选 Eval 门禁和多凭据顺序问题已修复。构建、三包单元测试与 CLI 集成回归通过；用例、fixture 与默认配置在 prepare 提交前变化都会拒绝最终输出。

阶段二已迁移 Skill、共享资源与机器消费者。V4 的 43 个 Skill 主文件与 reference 均有最终源码或构建投影映射。正式构建和公开 Catalog build/validate 通过；CLI runtime bundle 与本地 Catalog snapshot 均包含目标四插件、Codex/Claude 各十个 Skill，各二十四个共享资源副本与源码逐字节一致，退休文件和入口均已消失。

确定性验证通过：Eval 单元测试 246 项（另有 2 项环境跳过）、Core 116 项、CLI 2253 项、CLI integration 476 项、build smoke 10 项、Git batch dist contract 2 项。四插件的双平台测试均通过；十九份 Eval 文档、一百一十七条用例通过当前公开 parser。全量测试发现的旧 inventory 数量快照已移除，实际注册用例仍逐个经真实 adapter 验证。Author behavior 与 AW Review diagnostic 也已通过当前 Workspace 的 prepare、正式 Spec validation 和来源 inspection；未执行模型。

合同扫描覆盖 641 个源码与物化文本文件，扫描完整；所列格式各有一份源码、两份平台副本。扫描器对无法从静态路径证明的业务用途保留 unknown，不据此删除 AWReviewEvidence 或 EvalAudit 等已有实际消费者的合同。全新独立上下文的阶段二 Milestone Review 通过，未发现阻塞项。

阶段三完成整体独立评审、修复与最终检查。实际结果在阶段完成时更新，不能用“已设计测试”替代执行记录。

## 尚需真实环境证据

本轮只运行确定性测试和本地物化，不运行昂贵模型 Eval、原生用户宏或真实远端发布。因此保留以下证据边界：

- Trigger、源码行为与 diagnostic 用例即使通过格式检查，也仍未证明模型行为。
- deny CLI fixture 只提供拒绝路径诊断，不能证明 AW 开发、执行或发布成功。
- 正式 Oracle 独立准入、候选变化后的重新审核和完整 Runner 执行，需要真实 Spec/Audit/Result 与实际执行证据。
- Publisher 的原生宏注入与用户 planDigest 授权，需要对应客户端的真实交互；文本中出现 `$publish-aw-catalog` 不构成该证据。
- 有限简化实验的结论只适用于固定环境、用例和预算；不声称普遍无回归或全局最优。

未运行项目保持明确未知，不将缺少证据自动写成生产 Skill 缺陷，也不手工生成 passing Audit 或 ready 结果。
