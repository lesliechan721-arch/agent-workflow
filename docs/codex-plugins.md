# Plugins

This document summarizes the current plugin implementation in `/Users/LeslieChan/Desktop/codex/codex-rs` based on the source tree. It is an implementation note for maintainers and plugin authors, not a separate product contract.

## Overview

In the current `codex-rs` implementation, a plugin is a local package that can distribute exactly three capability families:

- Skills
- MCP servers
- Apps (connectors)

Plugins are not invoked directly. At runtime, Codex uses the underlying skills, MCP tools, MCP resources, and app tools contributed by a plugin.

## Manifest Model

Codex discovers a plugin manifest from either:

- `.codex-plugin/plugin.json`
- `.claude-plugin/plugin.json`

The manifest supports these top-level fields:

- `name`
- `version`
- `description`
- `skills`
- `mcpServers`
- `apps`
- `interface`

Of those fields, only `skills`, `mcpServers`, and `apps` contribute callable/runtime capability surfaces. The `interface` block is metadata for display, discovery, and marketplace presentation.

Manifest paths must:

- be relative to the plugin root
- start with `./`
- stay within the plugin root

## Capability Families

### 1. Skills

A plugin can contribute skills through:

- `plugin.json.skills`
- the default `skills/` directory under the plugin root

Those paths are loaded as skill roots and flow into the normal skills system. In model-facing instructions, plugin skills are namespaced with the plugin name, for example:

- `sample:sample-search`

Use plugin-distributed skills when the plugin needs to add:

- reusable instructions
- workflows
- prompt scaffolding
- tool-usage guidance
- dependency install guidance already supported by the skills system

### 2. MCP Servers

A plugin can contribute MCP server definitions through:

- `plugin.json.mcpServers`
- the default `.mcp.json` file under the plugin root

These server definitions are merged into Codex's effective MCP configuration. In practice, this is how a plugin contributes most executable capability.

Once loaded, plugin MCP servers can expose:

- MCP tools
- MCP resources
- MCP resource templates

The direct tool surface seen by the model comes from the MCP server's own tool list. In addition, Codex exposes generic MCP resource helpers when MCP servers are present:

- `list_mcp_resources`
- `list_mcp_resource_templates`
- `read_mcp_resource`

So a plugin that ships MCP servers can indirectly extend Codex beyond function-style tools and provide read-only contextual data through MCP resources as well.

### 3. Apps (Connectors)

A plugin can contribute apps through:

- `plugin.json.apps`
- the default `.app.json` file under the plugin root

The current app config format is a map of app entries whose meaningful runtime field is the connector `id`. In other words, plugins do not ship arbitrary app implementations locally. They declare connector IDs that should be associated with the plugin.

At runtime, those connector IDs are used to:

- attribute accessible connectors to the plugin
- expose matching `codex_apps` MCP tools for those connectors
- bias tool selection when the plugin is explicitly mentioned

This means the plugin-level `apps` capability is effectively a connector/app binding layer on top of the built-in `codex_apps` MCP system.

## What Codex Actually Tracks As Plugin Capability

The runtime capability summary for a loaded plugin reduces to:

- `has_skills`
- `mcp_server_names`
- `app_connector_ids`

This is the clearest implementation-level statement of what Codex treats as real plugin capability. If a field does not affect one of those three buckets, it is not part of the runtime capability surface.

## Runtime Exposure Rules

For a plugin to be active, all of the following must be true:

- the `plugins` feature is enabled
- the plugin is configured in `config.toml`
- the plugin is installed in the plugin cache
- the manifest is valid
- the plugin has no load error

When active:

- skill roots are merged into the effective skills set
- plugin MCP servers are merged into the effective MCP config
- plugin app connector IDs are merged into the effective connector/app set

When the user explicitly mentions a plugin, Codex injects developer guidance that points the model at that plugin's visible:

- skills
- MCP servers
- apps

That explicit mention path is also how plugin-associated app tools can become visible for a turn even when they are not otherwise front-and-center in the prompt.

## What `interface` Does And Does Not Do

The `interface` block can carry metadata such as:

- `displayName`
- `shortDescription`
- `longDescription`
- `developerName`
- `category`
- `capabilities`
- `websiteUrl`
- `privacyPolicyUrl`
- `termsOfServiceUrl`
- `defaultPrompt`
- `brandColor`
- `composerIcon`
- `logo`
- `screenshots`

These fields are useful for:

- marketplace display
- plugin listing UI
- discovery metadata
- prompt snippets or branding assets

They do not create new executable capability types.

In particular, `interface.capabilities` is descriptive metadata, not a runtime capability switch. The source currently does not use it as an enablement mechanism for tools, skills, or apps.

## What Plugins Cannot Natively Distribute Today

There is no first-class plugin manifest support for separate top-level capability families such as:

- custom local tool definitions outside MCP
- standalone agent roles
- hooks
- slash commands
- arbitrary executable app bundles

If a plugin needs executable extension behavior, it currently has to route that behavior through:

- skills
- MCP servers
- app connector IDs

## Marketplace Distribution Model

Plugins can be distributed through marketplaces. Marketplace entries support:

- local paths
- git repositories
- git repositories with subdirectory selection

Marketplace policy also carries:

- installation policy
- authentication policy
- product restrictions

This affects how a plugin is discovered and installed, but it does not add a fourth runtime capability family. After installation, the runtime still reduces the plugin to skills, MCP servers, and apps.

## Minimal Shape

The smallest useful plugin layouts usually look like one of these:

### Skill-only plugin

```text
my-plugin/
  .codex-plugin/plugin.json
  skills/
    my-skill/
      SKILL.md
```

### MCP plugin

```text
my-plugin/
  .codex-plugin/plugin.json
  .mcp.json
```

### App-binding plugin

```text
my-plugin/
  .codex-plugin/plugin.json
  .app.json
```

### Combined plugin

```text
my-plugin/
  .codex-plugin/plugin.json
  skills/
  .mcp.json
  .app.json
```

## Example Manifest

```json
{
  "name": "sample",
  "version": "1.0.0",
  "description": "Inspect sample data",
  "skills": "./skills",
  "mcpServers": "./config/sample.mcp.json",
  "apps": "./config/sample.app.json",
  "interface": {
    "displayName": "Sample",
    "shortDescription": "Inspect sample data",
    "capabilities": ["Skills", "MCP", "Apps"]
  }
}
```

## Practical Guidance

Choose the capability type based on the job:

- Use `skills` for promptable workflows, instructions, and repeatable task guidance.
- Use `mcpServers` for real executable integrations, structured tool calls, and MCP-provided resources.
- Use `apps` when the plugin should surface or claim existing connector-backed app tools from `codex_apps`.

If you need behavior outside those buckets, the current implementation does not provide a separate first-class plugin extension point.

## Source Areas

The current behavior described here is primarily implemented in:

- `codex-rs/core-plugins/src/manifest.rs`
- `codex-rs/core-plugins/src/loader.rs`
- `codex-rs/core-plugins/src/marketplace.rs`
- `codex-rs/plugin/src/lib.rs`
- `codex-rs/plugin/src/load_outcome.rs`
- `codex-rs/core/src/plugins/`
- `codex-rs/core/src/config/mod.rs`
- `codex-rs/codex-mcp/src/mcp/mod.rs`
- `codex-rs/core/src/mcp_tool_exposure.rs`
