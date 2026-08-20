# Manual dependency contract

Required plugin: `agent-skill-toolkit >= 0.4.0`.

Required capability: an `audit-agent-skill-evals` preflight result whose target Skill digest and case corpus digest match the execution plan.

The runner fails closed when the audit or contracts are unavailable. It does not contain fallback Oracle or review rules.
