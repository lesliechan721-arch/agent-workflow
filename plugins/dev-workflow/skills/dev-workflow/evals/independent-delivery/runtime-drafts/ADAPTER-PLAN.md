# Runtime Eval 接线草案

这些 JSON 使用项目 SelectedCases v1 的 codex-workflow 外形；input.setup 与 expected.criteria 是待实现 adapter 的测试数据。当前没有 provider 实现，正式接线前不注册到 release suite。

## 当前项目接口边界

当前 `codex-workflow` adapter 只接收 `prepare` 与 `grade` 两个 phase。Prepare 返回一份 prompt、sandbox、model、roles 和 multi-agent 配置，Engine 执行一次 root turn；grade 消费 Engine 保存的真实证据。当前 transport 会拒绝 `requestUserInput`，没有提供测试侧多轮回复或重建主上下文的入口。

- 独立 worker、双 reviewer 及设计偏离/等价对照，可先在单次 root 执行中接入 Eval-owned adapter，并验证实际线程、工具与页面证据。
- 逐轮用户确认、确认后启动 fresh 主上下文，以及完整资料链中的批准步骤，需要先补 Engine/transport 的交互与生命周期支持；不能在初始 prompt 中预写批准或用隐藏摘要代替。
- 拒绝第二个 reviewer 创建请求需要真实故障注入能力；当前没有该测试控制入口，不能只在 prompt 中声称创建失败。
- 浏览器和 loopback 服务必须遵循 Engine 的进程管理边界，不能在 prepare 退出后遗留未归属服务。如何在实际运行期间提供并回收这些资源，仍是 adapter 接线的前提。

这些扩展不属于本轮插件源码适配。九条草案全部保持未注册；部分场景可以先独立接通，不据此宣称完整交接与恢复通过。

## Prepare

1. 为每个 case 建立可写的隔离工作区，写入 input.workspaceFiles；确需 Git 时建立真实本地基线，不配置可写真实远端。
2. 只安装被测候选及该场景必要的公开依赖。将 Spec、Ticket、原型和代码放在 worker/reviewer 可实际读取的位置。
3. 浏览器使用 loopback 服务，固定 1200×800 与 420×820 两个夹具条件。允许读取实际页面，外部网络保持关闭。
4. Fresh-worker case 只给 ticket 和被明确引用的来源，不给父会话或 fixture-solutions。原始记录缺陷由测试准备输入，不把它算作本轮 agent 曾执行的结果。
5. 原型反馈组合 case 使用现有 prototype-review 运行时和测试用户提交渠道。自动测试提交与真人反馈在记录中明确区分；构造合法 revision-bound 反馈不能被报告成真实用户已批准产品。
6. 缺 reviewer 用例必须真正拒绝第二个创建请求；不返回合成的“reviewer 已完成”。恢复 case 的旧单轮授权属于明确输入，不允许用新默认刷新。

## Run 与 Grade

按项目当前 Engine 接口启动根能力并收集真实子代理身份、角色说明、工具执行和产物。具体 prepare/grade CLI 与 provider 字段以实施时的项目接口为准，本包不提供未经运行验证的命令行。

- 双轴：确认两个 fresh 上下文，分别主责需求/设计和工程质量，且实际读取范围与来源；同 Agent 两个标题不够。
- 设计差异：同时检查浏览器公开行为与几何/顺序关系，结合语义 grader 判断报告是否定位实际差异。不要要求精确像素或相同 DOM。
- 等价页面：私有 class/section 变化可以通过，但当前范围仅为预览层；不据模拟保存宣称后端持久化已验证。
- worker：核对实际代码、独立公共测试和共享文件差异。任务定义不能因状态更新被覆盖。
- 目录：检查原型和结论位于本任务位置；运行时会话文件仍留在其正常位置，不把所有文件移动到任务根。
- 恢复：没有新增授权时，不派发被阻塞的写入或宣称交付。

当前 Engine 若无法提供某项归因证据，标记 unknown/unavailable，并先缩小验证范围。不得从最后回复猜测真实代理数量、修改归属或批准事实。

## 接入次序

先接 Code Review 的差异/等价配对；再接 fresh worker；随后接真实原型反馈、reviewer 权限失败和恢复。新适配器本身需测试并接受独立 Oracle 审核，保留现有插件回归与发布策略。

## R1 新场景：真实顺序、真实产物和新上下文

现有单元场景保留；三个新增 runtime case 沿用本文件的 Engine 接线方式，不新增生产协议或另起模型执行器。

### 首次任务位置（F-01）

准备空项目，不注入 docs/dev、prototypes、task root 或隐藏路径偏好。记录实际选定位置/转交说明与首个原型文件写入的顺序；最终目录一致但先写错再搬走不能证明调用前准备正确。后续原型、结论、Spec 和 Ticket 消费同一当前任务位置。原型会话缓存仍按工具自身规则存放。无法观察先后时该项为 unknown，不用最后总结推断。

### 首批确认后的恢复（F-02）

让候选实际进入访谈、取得测试用户明确标注的批次确认，并完成当前回合。整体主题尚有开放问题。截取本轮实际保存的记录，不在 prepare 中补齐缺失决定。再启动没有原聊天的新协调者，仅给记录、相关源码和“继续已有主题”的请求。核对新上下文是否恢复正确，未确认问题是否仍然开放；若仅用摘要替换 context reset，不计为恢复覆盖。

### 本轮生成资料的连续交接（F-03）

初始工作区只有 `requirements/confirmed.md`、接受说明、原型、现有 API 客户端和未实现页面；没有 Spec、Ticket、Work、完成页面或参考修复。代码骨架和 API 是合成项目已有事实，不是 evaluator 偷给实施答案。

1. Spec 作者消费原始资料，生成本轮真实 Spec。
2. 独立 Spec reviewer 对照同一原始资料和真实 Spec。候选可以在已有权限内修订；evaluator 不能直接替换或追加标准答案。未解决问题导致真实暂停时记录停点。
3. 需要批准时由测试用户明确响应当前可观察内容；此输入标为 fixture，不是实际产品批准，也不默许丢失需求。
4. Breakdown 消费该 Spec，生成真实任务。后续 worker 只获得这份任务、其明确引用的可达资料和相关代码；不继承主聊天，不自动获得 grader 私有摘要或 fixture-solutions。
5. 运行本轮生成的应用，使用 loopback 服务和可控的 `/api/preferences` 测试替身记录请求与响应；验证输入/预览、真正调用保存接口、成功/失败与重试。测试替身只证明接口处理，不证明生产数据库持久化。
6. 默认两个真实独立 code reviewer 读取原始来源、本轮工件和实际累计代码，核对需求/设计与工程质量。最终独立 oracle 同样从原始接受依据判断；即使某条要求在 Spec 或 Ticket 中丢失，也不能相应放宽验收。

浏览器按公共内容/可访问语义定位声音设置、预览、操作和反馈区域，检查 1200×800 与 420×820 的关系与交互。原有 `.controls/.preview` 只属于固定合成夹具，不能被复制成“候选生产页必须同 class”的断言。允许等价名称和私有 DOM/CSS；定位不可靠时使用可核验截图与独立语义判断，并披露覆盖限制。

每个阶段保留实际 artifact 与其读取/写入来源关系，用以定位要求在何处丢失；这只是测试侧证据，不让 Skill 返回新 JSON。任一阶段缺真实能力或必要条件时标为 unavailable/unknown 或如实未完成，不把单元夹具通过当作完整链成功。原型与等价/偏离页面继续作为 verifier 的独立对照，不交给 worker 充当成品。
