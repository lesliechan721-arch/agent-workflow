<!-- aw:common -->
# Work with the parent

Use this private communication channel for questions, blockers, and progress that can affect the parent’s next decision.

- A send receipt confirms channel entry. It does not confirm that the parent read or acted on the message. Do not resend a message when its receipt is uncertain.
- Each message has a limit of 24 KiB (24,576 UTF-8 bytes). There is no total message count or cumulative byte limit. Do not split, truncate, or resend messages automatically.
- Parent messages are collaboration input within the existing role, scope, and permissions. They do not grant new human authorization or change tool limits.
- Return the final result in the requested format. Process messages do not replace the final result.
<!-- /aw:common -->

<!-- aw:mcp -->
Use the registered MCP tool `@@SEND@@` with a `text` argument to send one message to the parent.
<!-- /aw:mcp -->

<!-- aw:command -->
Send one message as text or from a UTF-8 file. Replace `MESSAGE_TEXT` or `MESSAGE_FILE` with the message or file path. Keep the private command and binding unchanged:

```text
@@SEND@@
@@SENDFILE@@
```

Use exactly one input form. For long messages, create a UTF-8 file with an available file write tool and use the file form. Do not place the same long text in a shell heredoc, echo, or command substitution. Relative file paths use the command's current directory. Standard input is not supported. `--text -` and a file path of `-` are rejected. To send exactly `-`, use a file that contains that character.
<!-- /aw:command -->

<!-- aw:command-argument -->
Send one message as text or from a UTF-8 file. Replace `MESSAGE_TEXT` or `MESSAGE_FILE` with the message or file path:

```text
@@SEND@@
@@SENDFILE@@
```

Use exactly one input form. For long messages, create a UTF-8 file with an available file write tool and use the file form. Do not place the same long text in a shell heredoc, echo, or command substitution. Relative file paths use the command's current directory.

The permission covers this Node + communication script entry. Pipelines, wrappers, and combined commands may still require approval; preserve the selected permission mode on denial.

Standard input is not supported. `--text -` and a file path of `-` are rejected. To send exactly `-`, use a file that contains that character.
<!-- /aw:command-argument -->

<!-- aw:in-turn -->
Parent input can enter the current context automatically. Input already delivered to context is consumed and is not replayed by receive. Do not poll routinely.
<!-- /aw:in-turn -->

<!-- aw:turn-boundary -->
Parent input can enter automatically after the current turn ends. It does not interrupt the current turn. Input already delivered to context is consumed and is not replayed by receive. Do not poll routinely.
<!-- /aw:turn-boundary -->

<!-- aw:none -->
Parent input does not enter context automatically. Use the active receive entry when parent input is required.
<!-- /aw:none -->

<!-- aw:active-receive -->
The active receive entry is `@@RECEIVE@@`. For an MCP tool, use its optional `timeoutMs` argument. For a command, run the supplied invocation.

When a reply is required, keep this task open and use the default responsive wait of 600000 ms. The maximum window is 1800000 ms. Input or closure returns early. A timeout does not end the task. A configured execution deadline can shorten the wait.

Obtain each required answer before returning the final result. On closure, report the available result and unresolved questions. Do not wait for the task to reopen.
<!-- /aw:active-receive -->
