# Project status

## Project state

The generic installer and extension package live at
https://github.com/Nulifyer/pi-t3-agent. This batch delivers the verified 0.2.0
T3 integration update, source audit, migration, and regression coverage.

## Current batch

T3-only integration audit and implementation. Owner: Codex in this workspace.
Package-owned changes are implemented and installed in this host's Pi profile
under the user's explicit authorization. T3 application source is unchanged.

## In progress

None. Implementation and local acceptance are complete. The user authorized
commit and push of this batch.

## Verification

35 focused tests and nine real-Pi integration scenarios passed locally on Linux,
Node 26.13.0, Pi 1.5.0, including the recovered bridge from installed T3 0.1.7.
All ten installed extension files match the repository; repeat installation
changes zero files. Defaults, credentials, endpoint, and unrelated T3 providers
were preserved, and recognized legacy global extensions were retired with backups.

Live evidence established discovery of four Juiced models, a successful model
thread-read round trip through the installed T3 bridge to a controlled MCP target,
and actual ~/.agents skill add/edit/remove reload without inference. The saved
default model called the tool but stalled before its final response; the cause
remains unestablished. A different discovered ready model completed the probe
without changing the saved default. See docs/verification.md and the source audit.

Privacy inspection found no private endpoint or model IDs in repository content.
This pass does not claim new hosted Windows/macOS results or full desktop UI
acceptance. Previous hosted results belong to the published revisions.

## Next action

On another host, pull the updated project and rerun its installer against the
same profile; older global setups require --migrate-legacy. Existing agents need
a one-time restart/resume in T3; subsequent resource edits reload in place.
Hosted platform acceptance belongs to the new CI run, not these Linux results.

## Blockers

No package implementation blocker remains. Native T3 Plan mode/panel and terminal
UI require T3 adapter changes, which the user prohibited. Model-level reliability
and the default model's latency are not established by transport compatibility.
