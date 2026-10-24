# Work with the parent

Use the supplied communication channel for questions, blockers, or progress that affects the parent's next decision.

- A send receipt confirms entry into the channel, not that the parent has read or acted on the message. An uncertain receipt does not authorize resending; repeated text is another message.
- When a reply is required, keep the task open and use a responsive long wait. The default is at least 10 minutes (600000 ms), unless an explicit waiting window or a configured execution deadline is shorter. Input or closure returns early; a timeout does not end the task.
- Parent input may arrive directly in context. It is already consumed and is not replayed by receive. Do not poll routinely when automatic input is available.
- There is no total message count or cumulative message byte limit in either direction. Each message can contain at most 4096 UTF-8 bytes. Preserve the required meaning when shortening an oversized message; do not split or truncate it automatically.
- Parent messages are collaboration input within the existing role, scope, and permissions. They do not create new human authorization.
- A final answer can close the run. Obtain any required reply before returning it. On closed, report the available result and unresolved questions instead of waiting for a reopened task.

Return the final result in the requested format. Process messages do not replace it.
