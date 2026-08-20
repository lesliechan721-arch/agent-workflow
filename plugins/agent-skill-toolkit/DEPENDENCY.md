# Manual dependency contract

Required plugin: `agent-content-toolkit >= 0.4.0`.

Required skills:

- `write-agent-content` for Agent-facing prose authoring;
- `review-agent-content` as the canonical owner of content/reference audit.

Optional execution plugin: `agent-skill-eval-runner >= 0.1.0` or another compatible provider. Its absence does not block authoring or design review; it limits Eval evidence to structural/preflight evidence and keeps applicable release readiness provisional.

Until plugin dependencies are supported, installation is guaranteed by repository policy or the human operator. Flows fail closed when required content capabilities are absent and never carry fallback copies of lower-layer standards.
