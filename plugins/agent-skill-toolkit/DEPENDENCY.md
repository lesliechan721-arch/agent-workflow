# Manual dependency contract

Required plugin: `agent-content-toolkit >= 0.3.0`

Required skills:

- `write-agent-content` for authoring Agent-facing prose;
- `review-agent-content` for independent content/reference audit.

Until plugin dependencies are supported, installation and compatibility are guaranteed by repository policy or the human operator. Skill author/review flows fail closed when the required content capability is unavailable; they do not carry fallback copies of that workflow or its canonical content rules.
