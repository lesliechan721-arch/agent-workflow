# Repository Guidelines

## Project Structure & Module Organization

这是一个 `pnpm` monorepo，工作区定义在 `pnpm-workspace.yaml`。主要代码在 `packages/cli`：`src/commands` 放 CLI 命令入口，`src/adapters` 处理 `codex` 和 `claude` 平台差异，`src/generators` 负责生成 instructions、hooks、permissions 和 agents，`src/utils` 放通用工具。测试位于 `packages/cli/tests/unit` 和 `packages/cli/tests/integration`，夹具在 `packages/cli/tests/fixtures`。仓库根目录的 `plugins/git-commit` 是真实插件样例，`docs/` 存放设计说明和评审记录。`packages/cli/dist` 与 `packages/cli/coverage` 属于构建或测试产物，不要手改。

## Build, Test, and Development Commands

- `pnpm install`：安装工作区依赖。
- `pnpm build`：编译 `@yiliang/aw`，输出到 `packages/cli/dist`。
- `pnpm test`：运行全部 Vitest 用例。
- `pnpm test:unit`：只跑单元测试，适合改动生成器或工具函数后快速回归。
- `pnpm test:integration`：验证 CLI 端到端行为和夹具产物。
- `pnpm test:coverage`：生成文本和 HTML 覆盖率报告。

## Coding Style & Naming Conventions

代码使用 TypeScript + ESM，保持 2 空格缩进，继续沿用 NodeNext 导入风格，在本地模块导入里写 `.js` 扩展名。新增模块文件名用 `kebab-case`，导出函数、变量和类型用 `camelCase` / `PascalCase`。优先小而明确的纯函数，把平台差异放进 `adapters`，把文件生成逻辑放进 `generators`。仓库里没有单独的 ESLint 或 Prettier，质量主要依赖 `tsc` 严格模式和测试。

## Testing Guidelines

测试框架是 Vitest。测试文件统一使用 `*.test.ts`，单元测试放 `tests/unit`，命令流和夹具校验放 `tests/integration`。修改插件生成逻辑时，同时更新对应 fixture 或样例插件，避免测试只改断言不改产物。当前没有强制覆盖率门槛，但涉及命令分支、清单解析或生成逻辑的改动，提交前至少运行相关测试；较大改动建议补跑 `pnpm test:coverage`。

## Commit & Pull Request Guidelines

Git 历史使用 Conventional Commits，并带清晰 scope，例如 `fix(cli): ...`、`feat(skills): ...`、`fix(git-commit): ...`。每个提交只解决一个行为变化，方便回滚和审查。仓库里没有独立 PR 模板，通常应在描述里写清问题、方案、影响范围和执行过的命令；如果改动会影响 CLI 输出或生成文件，附上前后示例，比截图更有用。关联 issue 或设计文档时，直接贴链接。
