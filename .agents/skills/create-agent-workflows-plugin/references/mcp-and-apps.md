# MCP 服务器与 Apps 配置

插件可以通过 `.mcp.json` 声明 MCP（Model Context Protocol）服务器，通过 `.app.json` 声明应用集成。这两个文件作为独立的 JSON 配置存在于插件根目录，由 manifest 中的 `mcpServers` / `apps` 字段指向。

## .mcp.json 规范

### 文件位置

```text
plugins/<name>/
├── .agents-plugin/plugin.json    # mcpServers: "./.mcp.json"
└── .mcp.json                     # MCP 服务器配置
```

### manifest 声明

```json
{
  "mcpServers": "./.mcp.json"
}
```

路径必须以 `./` 开头，是相对于插件根目录的单个字符串，不能写成数组或对象。

### 文件格式

```json
{
  "mcpServers": {
    "<server-name>": {
      "command": "<executable>",
      "args": ["<arg1>", "<arg2>"],
      "env": {
        "KEY": "value"
      }
    }
  }
}
```

顶层必须有 `mcpServers` 键，值是服务器名称到配置的映射。服务器 key 使用 JSON 中的原始属性名作为身份，允许包含点号、空格、斜杠、大小写或 Unicode。

### 服务器类型

#### stdio（本地进程）

通过启动本地进程、使用标准输入/输出通信：

```json
{
  "mcpServers": {
    "sqlite": {
      "command": "uvx",
      "args": ["mcp-server-sqlite", "--db-path", "./data.db"],
      "env": {
        "UV_PYTHON": "python3"
      }
    }
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `command` | string | 是 | 可执行文件路径或名称 |
| `args` | string[] | 否 | 命令行参数 |
| `env` | object | 否 | 环境变量（键值对） |
| `cwd` | string | 否 | 工作目录 |

#### SSE / HTTP（远程服务）

通过 HTTP URL 连接远程 MCP 服务：

```json
{
  "mcpServers": {
    "review-service": {
      "url": "https://mcp.example.com/review",
      "headers": {
        "Authorization": "Bearer ${API_TOKEN}"
      }
    }
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `url` | string | 是 | MCP 服务端点 URL |
| `headers` | object | 否 | HTTP 请求头，支持 `${ENV_VAR}` 环境变量插值 |

### 环境变量引用

MCP 配置中可以使用 `${ENV_VAR}` 语法引用环境变量：

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}"
      }
    }
  }
}
```

`${user_config.KEY}` 是 Claude runtime 的原生占位符，不是公共 `.mcp.json` 合同。若同一 `.mcp.json` 同时给 Codex 使用，不要直接写 `${user_config.KEY}`；请使用环境变量占位符，或用 `buildConfig.templates` 按平台渲染不同配置。

### 完整示例

```json
{
  "mcpServers": {
    "acme.tools v1": {
      "command": "node",
      "args": ["./scripts/acme-mcp.js"],
      "env": {
        "ACME_TOKEN": "${ACME_TOKEN}"
      }
    },
    "local-db": {
      "command": "node",
      "args": ["./scripts/mcp-db-server.js"],
      "env": {
        "DB_PATH": "./data/app.db"
      }
    },
    "remote-api": {
      "url": "https://api.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${SERVICE_API_KEY}"
      }
    }
  }
}
```

---

## .app.json 规范

### 文件位置

```text
plugins/<name>/
├── .agents-plugin/plugin.json    # apps: "./.app.json"
└── .app.json                     # 应用配置
```

### manifest 声明

```json
{
  "apps": "./.app.json"
}
```

路径规则与 `mcpServers` 相同。`apps` 是 Codex 能力，因此插件必须支持 Codex；`marketplace.policy.products` 如果收窄为 `["CLAUDE"]`，再声明 `apps` 就是矛盾配置，会在 manifest/build 校验阶段失败。

### 文件格式

```json
{
  "apps": {
    "<app-name>": {
      "id": "<connector-id>"
    }
  }
}
```

顶层必须有 `apps` 键；渲染后的最终产物还要求每个 `apps.*.id` 都是非空字符串。Codex loader 当前消费的是 connector id，`url` / `description` 不是当前公共 contract 的有效字段。

### 示例

```json
{
  "apps": {
    "dashboard": {
      "id": "dashboard-connector"
    }
  }
}
```

---

## 平台行为

### Claude

- `.mcp.json` 中的 `mcpServers` 配置透传到 Claude runtime manifest
- Claude Code 原生支持 MCP 服务器的启动和生命周期管理
- `.app.json` 当前不被 Claude 读取；Claude-only 插件不能声明 `apps`

### Codex

- Codex user scope 通过 native plugin runtime 加载 `.mcp.json`
- Codex project scope 会把 rendered `.mcp.json` 中的每个 `mcpServers.<key>` 写入当前仓库 `.codex/config.toml [mcp_servers.*]`，并按同一个原始 key 记录 tracking `artifactKey`
- 需要 TOML quoted key 的 server 会写成 `[mcp_servers."acme.tools v1"]`；这是单个 server key，不是 `[mcp_servers.acme.tools]` 的嵌套路径
- `.app.json` 用于 Codex 应用集成，但 Codex project scope 首版不支持 apps；只要 manifest 声明 `apps`，project install/upgrade 会 fail fast，请改用 `--scope user` 或拆分插件
- Codex 支持 `streamable_http` 和 `stdio` 两种传输方式

## 注意事项

- `.mcp.json` 和 `.app.json` 是独立的 JSON 文件，不嵌入 `plugin.json`
- 文件存在时必须在 manifest 中声明对应字段，反之亦然
- 路径字段只能是单个字符串，不能是数组或对象
- `apps` 要求插件最终支持 Codex；`products=["CLAUDE"] + apps` 不是“Claude 忽略 app”，而是直接失败
- Codex project scope 写入 MCP 时会完整透传 string / boolean / number / array / object；`null` 因 TOML 无等价表示会在写入前失败
- 脚手架脚本支持 `--with-mcp` 和 `--with-apps` 标志；`--with-apps` 会生成带示例 connector id 的最小文件，作者需要替换成真实 id
- `.mcp.json` 和 `.app.json` 作为模板化 JSON 原生资产走同一套规则：命中 `buildConfig.templates` 时源码层不强制 raw JSON 可解析，最终渲染产物必须分别满足 `mcpServers` 对象和 `apps.*.id` 非空字符串。详见 `references/build-config-spec.md`
