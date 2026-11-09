# Project decisions

## Binding decisions

- Keep all deployment-specific URLs, addresses, model IDs, and secrets out of Git.
- Supply a Node installer with PowerShell and POSIX shell entrypoints.
- Leave existing model providers and defaults alone unless explicitly configured.
- Use Pi's supported provider interface for optional Juiced discovery.
- Use built-in Pi transport and T3's generated bridge without patching either.
- Use native PowerShell for Windows managed commands and Bash on Unix.
- T3 is the sole product interface. Preserve its generated bridge and tool catalog.
- Change implementation source only in this repository; do not modify T3 Code.
  The user also authorized replacing this host's Pi setup, narrowly configuring
  its T3 Pi provider, and testing its existing Juiced server. Preserve defaults,
  credentials, and unrelated settings. Keep private deployment data outside Git.
- Native T3 UI features that its Pi adapter does not expose remain documented
  limits, rather than local imitations.
- Juiced discovery owns a generated native model snapshot for extension-free T3
  helpers. Operator preferences and credentials remain separate and preserved.
- T3's --offline discovery launch may perform bounded metadata requests to the
  configured Juiced host. PI_T3_OFFLINE is an unambiguous metadata network opt-out;
  Pi itself sets PI_OFFLINE when processing T3's --offline argument.
- Reload resources through Pi's supported command API and retain managed commands
  across reload. Do not create model turns merely to refresh resources.

## Open decisions

None for the first release.

## Superseded decisions

Quick setup alone is insufficient for the user's current T3-only integration
requirements. The user requested the complete audit and implementation.
