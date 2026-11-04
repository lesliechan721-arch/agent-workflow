# Native tool reader

This private workspace package provides the standalone reader for host-provided native tools. Core and CLI embed it with `scripts/embed.mjs`; published products do not need this workspace package at runtime.

The reader validates `AW_NATIVE_TOOL_CONTEXT` and returns the requested key and protocol. A ready tool contains `state`, `protocol`, and an absolute `executable` path. An unavailable tool contains `state`, `protocol`, and an error `code`. The generated module performs no filesystem or network access.

The context is an internal host result. Hosts bind it to the current producer, remove inherited reserved variables before a nested command, and prevent command environment overrides. Windows Job package resolution belongs to Eval and uses that package's installed optional dependencies.

Run the deterministic reader and embedding tests with `node --test packages/native-runtime/tests/*.test.mjs` from the repository root. These tests do not prove Windows ACL, Job containment, or native execution.
