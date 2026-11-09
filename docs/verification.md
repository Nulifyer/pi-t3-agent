# Verification

The 0.2.0 integration update was verified on Linux with Node 26.13.0, Pi 1.5.0,
and the generated bridge recovered from installed T3 Code 0.1.7, application
commit `322f6544dfad`.

`npm test` passed 35 checks covering installation and migration, settings and
credential preservation, generated model ownership, profile locking, resource
monitoring, catalog filtering and limits, command output, stdin, cancellation,
timeouts, and retention beyond 32 completed jobs.

`npm run test:pi` passed nine real-Pi scenarios. The same scenarios passed with
`PI_T3_TEST_BRIDGE` pointing to the installed T3 build's recovered bridge. They
cover initial T3 tool declarations, calls across user turns, another extension's
tools, cold discovery under T3's `--offline` launch, periodic model refresh,
updated context limits, removed models, outage fallback, extension-free helpers,
an explicit metadata network opt-out, automatic resource reload, extension code
updates, active-run deferral, questions, and workspace trust. Reload checks retain
the native conversation, saved plan, and running command without inference.

The user authorized migration of this host's existing Pi setup and testing against
its Juiced server. The migration backed up the old global extensions, adopted the
existing provider, preserved the default provider/model, and preserved unrelated
T3 providers. All ten installed extension source files matched this repository.
No T3 application code was changed.

Live checks established:

- Juiced supplied four enabled Chat models. T3's actual orchestration capabilities
  listed those four models plus its default entry and advertised cross-provider
  child-task support without constraints on the enabled Pi instance.
- A live Juiced model called the thread-read tool through the installed T3 bridge,
  read both returned text blocks, and returned the expected marker. The MCP target
  was a controlled read-only fixture, not a production conversation.
- A temporary skill in the host's actual `~/.agents/skills` directory was added,
  edited, and removed. The same Pi process observed each change without model
  turns or extension errors. The temporary skill was removed afterward.

The original default model reached the tool callback but did not complete its
final reply within the first three-minute test window. A second run was stopped
after the same partial result. A ready, tool-capable model discovered from Juiced
completed the full round trip. The saved default was not changed. These
observations do not establish the cause of the default model's latency.

Private live logs, credentials, endpoint details, recovered bridge code, and exact
host model IDs were kept outside Git. Automated tests use disposable profiles and
local fixture services. The Linux/Windows/macOS CI matrix is configured to run
both suites; this update does not claim a new hosted Windows or macOS result.

Native T3 plan panels, Plan mode, native terminal UI, real delegated-child execution,
browser/device UI, and every model's behavior were not established by these checks.
See [the source audit](integration-audit.txt) for ownership and remaining limits.
