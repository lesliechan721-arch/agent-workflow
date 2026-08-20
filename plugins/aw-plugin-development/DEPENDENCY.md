# Manual dependency contract

Required plugins:

- `agent-content-toolkit >= 0.4.0`
- `agent-skill-toolkit >= 0.4.0`

Optional execution plugin:

- `agent-skill-eval-runner >= 0.1.0` when the user requests real model Eval or release-grade
  behavior evidence.

Missing runner capability degrades real model evidence to `structural`/`provisional`; it does not
become a production Skill defect and does not trigger a fallback runner embedded in this plugin.
