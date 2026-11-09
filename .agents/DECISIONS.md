# Project decisions

## Binding decisions

- Keep all deployment-specific URLs, addresses, model IDs, and secrets out of Git.
- Supply a Node installer with PowerShell and POSIX shell entrypoints.
- Leave existing model providers and defaults alone unless explicitly configured.
- Use Pi's supported provider interface for optional Juiced discovery.
- Use built-in Pi transport and T3's generated bridge without patching either.
- Use native PowerShell for Windows managed commands and Bash on Unix.
- Prioritize quick setup and focused evidence, as the user requested.

## Open decisions

None for the first release.

## Superseded decisions

None.
