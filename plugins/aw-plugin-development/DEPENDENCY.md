# Manual dependency contract

Required plugins:

- `agent-content-toolkit >= 0.2.0`
- `agent-skill-toolkit >= 0.2.0`

Required skills:

- from `agent-content-toolkit`: `write-agent-content`, `review-agent-content`
- from `agent-skill-toolkit`: `author-agent-skill`, `review-agent-skill`, `design-agent-skill-evals`, `audit-agent-skill-evals`

Until plugin dependencies are supported, installation and version compatibility are guaranteed by the target workspace policy or the human operator. The AW adapters fail closed when a required skill is unavailable and never carry fallback copies of the generic standards.
