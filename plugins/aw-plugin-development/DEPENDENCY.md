# Manual dependency contract

Required plugins:

- `agent-content-toolkit >= 0.5.0`
- `agent-skill-toolkit >= 0.7.1`

The Author Skill also requires an installed `aw` CLI that provides the required `aw plugin`
authoring command. It checks the CLI version and the selected command help before use. The static
plugin runtime compatibility remains `0.0.0` because Review and non-authoring flows do not require
these commands.
For non-standard workspace layouts, the selected CLI command must provide `--plugin-root` relative
to `--repo-root`; the Author stops if that capability is missing.

Optional execution plugin:

- `agent-skill-eval-runner >= 0.3.0` when the user requests real model Eval or release-grade
  behavior evidence.

Missing runner capability degrades real model evidence to `structural`/`provisional`; it does not
become a production Skill defect and does not trigger a fallback runner embedded in this plugin.
