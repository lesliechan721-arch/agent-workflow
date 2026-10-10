# 独立 Skill 工具维护

本目录是三个确定性工具的唯一实现位置。`src/init-skill.mjs` 创建标准起稿，`src/check-skill.mjs` 做静态包检查，`src/audit-output-contracts.mjs` 只报告输出合同候选与引用线索。旧插件级 scanner 不再维护。

使用 Node.js >=22 和锁定的 pnpm 版本准备本目录依赖：

```sh
pnpm --dir plugins/agent-skill-toolkit/tooling install --ignore-workspace --frozen-lockfile
node plugins/agent-skill-toolkit/tooling/build.mjs --out /absolute/path/to/new-output
pnpm --dir plugins/agent-skill-toolkit/tooling test
```

输出父目录必须存在，输出目录必须尚不存在。独立构建产生六个 `skills/<skill>/scripts/*.mjs` 副本和四个 `assets/tooling-NOTICE.txt`。每个脚本内含所需 parser；运行只依靠 Node 和显式输入。NOTICE 保留通用依赖许可。AW 使用 `scripts/build-tools.mjs` 调用同一构建函数，并只写经核对的 staging 副本中的声明目标。

`test:isolated` 是显式 macOS 验证：

```sh
pnpm --dir plugins/agent-skill-toolkit/tooling test:isolated
```

它通过 `sandbox-exec` 禁网并阻断宿主依赖读取。需要允许创建 OS sandbox 的宿主环境；普通插件测试不隐式运行它。其它系统尚无同等 OS 隔离证据。

checker 规则快照为 `authoring-2026-10-10`。检查标准 frontmatter、已出现的常用调用 metadata、明确 Markdown 本地引用和受检树安全；它不执行包内代码，也不证明所有客户端兼容。读取有节点、文件数、单文件和累计字节上限。JSON 的 `complete`、`coverage` 和诊断共同说明覆盖。checker 退出 0 表示静态范围完成且无错误，1 表示无效包或检查未完成，2 表示参数、根路径或工具故障。init 的 `state: scaffold` 只表示起稿；参数错误退出 2，创建失败退出 1。

audit 使用输出 v2，只按名称发现候选。`reference-candidate`、`resolved-path` 或 `base-unknown` 不证明业务用途，`businessUse` 固定为 `not-assessed`。完整扫描退出 0，即使没有候选或引用；受限扫描退出 1，参数、根读取或工具故障退出 2。修改规则和公开结果时，同时更新行为测试、规则快照或输出版本及消费说明。
