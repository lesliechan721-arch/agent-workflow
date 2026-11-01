# 独立 Skill 工具维护

本目录是两个确定性工具的唯一实现位置。`src/init-skill.mjs` 创建标准起稿，`src/check-skill.mjs` 做静态包检查。

使用 Node.js >=22 和锁定的 pnpm 版本准备本目录依赖：

```sh
pnpm --dir plugins/agent-skill-toolkit/tooling install --ignore-workspace --frozen-lockfile
node plugins/agent-skill-toolkit/tooling/build.mjs --out /absolute/path/to/new-output
pnpm --dir plugins/agent-skill-toolkit/tooling test
```

输出父目录必须存在，输出目录必须尚不存在。独立构建产生四个 `skills/<skill>/scripts/*.mjs` 副本和三个 `assets/tooling-NOTICE.txt`。每个脚本内含所需 parser；运行只依靠 Node 和显式输入。NOTICE 保留通用依赖许可。AW 使用 `scripts/build-tools.mjs` 调用同一构建函数，并只写经核对的 staging 副本中的声明目标。

`test:isolated` 是显式 macOS 验证：

```sh
pnpm --dir plugins/agent-skill-toolkit/tooling test:isolated
```

它通过 `sandbox-exec` 禁网并阻断宿主依赖读取。需要允许创建 OS sandbox 的宿主环境；普通插件测试不隐式运行它。其它系统尚无同等 OS 隔离证据。

checker 规则快照为 `authoring-2026-10-28`。检查标准 frontmatter、已出现的常用调用 metadata、明确本地引用和受检树安全。独立代码格式资源路径以 Skill 根目录为基准；Markdown 链接以当前文档目录为基准，使用链接本身不会产生错误。资源路径识别覆盖 `SKILL.md`、`references/`、`assets/`、`scripts/`、`docs/`、包内实际顶层目录与文件，并能识别仍指向当前文档邻近文件的旧短路径。其他完全不存在的目录或文件名，若没有资源依据，不能仅凭代码格式判定其为包内资源。工具不把命令、代码块和一般业务输入路径当成资源指针。

checker 不执行包内代码，也不证明所有客户端兼容。读取有节点、文件数、单文件和累计字节上限。JSON 的 `complete`、`coverage` 和诊断共同说明覆盖。checker 退出 0 表示静态范围完成且无错误，1 表示无效包或检查未完成，2 表示参数、根路径或工具故障。init 的 `state: scaffold` 只表示起稿；参数错误退出 2，创建失败退出 1。
