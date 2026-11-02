# Shared native runtime

This private workspace package provides the same descriptor and resolver to Core, CLI, and Eval. Published products embed the required modules with `scripts/embed.mjs`; they do not depend on this workspace package at runtime. Core embeds only `descriptor` and `reader`.

`resolveNativeTool` defaults to `cache-only`. A foreground caller must select `network` to fetch a missing artifact. `fixture` uses an explicit local `archivePath`, or a valid cache when no archive is supplied. `source-candidate` requires an explicit archive and validates it even when a cache candidate exists. `importNativeTool` uses that same local path with no registry access. Callers supply their isolated cache root. Neither the resolver nor reader executes a downloaded helper during preparation.

The descriptor permits Windows x64 and arm64 PE variants. Global limits are 16 MiB compressed, 32 MiB expanded tar bytes, 64 entries, and 30 seconds for both registry requests together. Descriptor limits can reduce these sizes and counts. Archives use gzip and USTAR, contain the locked package manifest and executable, and cannot contain links, PAX/GNU extensions, unsafe paths, duplicate targets, or package scripts. Only the locked executable is extracted.

Host configuration is explicit `AW_NATIVE_REGISTRY_CONFIG` JSON:

```json
{
  "url": "https://registry.npmjs.org/",
  "scopes": { "@example": "https://registry.example/npm/" },
  "headers": { "authorization": "Bearer DEFAULT_REGISTRY_TOKEN" },
  "registryHeaders": {
    "https://registry.example/npm/": { "authorization": "Bearer SCOPE_REGISTRY_TOKEN" }
  },
  "proxy": "http://proxy.example:8080/"
}
```

`resolveNativeRegistryConfig(environment)` reads this configuration. Consumers pass `registryEnvironment: environment` to the resolver to defer that read until a network-mode cache miss. A valid cache does not depend on valid registry configuration. The reader does not read npmrc, global packages, PATH, or source checkouts. Default headers apply only to the default registry URL. A different scoped registry needs its own `registryHeaders`. URLs cannot contain credentials. Proxy support uses an HTTP proxy, with CONNECT for HTTPS targets. Redirects are rejected. The registry tarball must stay within the selected registry origin and path. Configuration and HTTP errors expose safe codes, and credentials are never saved in the cache.

Controlled test consumers can call `readNativeToolTestConfig(environment)` for `AW_NATIVE_TEST_CONFIG` JSON with `{mode, cacheRoot, archivePath?, descriptorPath?}`. The variable is accepted only with `AW_TEST_RUNNER_PROCESS_TREE=1`. Paths must be absolute, and `fixture` and `source-candidate` require an archive. The parser does not read files, use a registry, or alter resolver defaults. Consumers explicitly apply the result; background/cache-only consumers keep their cache-only mode.

Cache candidates are weak state at `<cacheRoot>/win32/<arch>/<sha256>/native.exe`. A small marker identifies owned candidates for bounded repair. Extra files, invalid ownership, links, and unsafe nodes are preserved and reported. Preparation uses an exclusive staging directory and publishes a verified nonempty directory by rename. Repair keeps the owned directory and marker intact and atomically replaces only the executable. Reads interrupted by this replacement revalidate the candidate at most eight times; foreign and unsafe errors are not retried. Existing valid concurrent winners are reused. Existing foreign empty directories are preserved. Node does not expose atomic directory rename with a no-replace flag on POSIX; an external process that creates an empty foreign directory between the final check and rename remains a POSIX race. Windows filesystem behavior and reparse checks require real Windows qualification.

The generated reader is a standalone ESM module. The generator reads its canonical `reader-runtime.mjs` text with normalized line endings; test-runner transforms cannot change that output. The generated module only validates and reads `AW_NATIVE_TOOL_CONTEXT`; it performs no filesystem or network access. A context is an internal result, not authentication of an arbitrary parent process. Hosts must bind it to the current producer, remove inherited reserved variables before a nested command, and prevent command environment overrides.

Run the local deterministic suite with `node --test packages/native-runtime/tests/*.test.mjs` from the repository root. The suite uses temporary directories, synthetic PE files, and loopback HTTP servers. It does not prove Windows ACL, Job containment, or native execution.
