# Project status

## Project state

The generic installer and extension package are public at
https://github.com/Nulifyer/pi-t3-agent. Runtime source is published through c91ac9e;
7df9682 changes only the working-directory assertion.

## Current batch

Initial setup is delivered for user installation. No active implementation batch.

## In progress

No local task. Hosted Windows checks for the revised assertion are queued.
The user explicitly prefers quick setup over further hardening.

## Verification

23 focused tests pass locally on Linux with Node 26.13.0. Real Pi 1.5.0 discovery
and fixture streaming pass. CI on c91ac9e passed both suites on Linux and macOS.
Windows passed installer cases, stdin, output, cancellation, timeout and shutdown;
its cwd path-string assertion failed. The replacement assertion checks an actual
file write within the requested cwd. That test revision awaits hosted execution.
Privacy inspection found no private deployment identifiers or credentials.

## Next action

User installs on Windows. If needed, read the latest CI run before claiming full
Windows acceptance: https://github.com/Nulifyer/pi-t3-agent/actions/runs/42650767217.

## Blockers

None for publication. The latest Windows result is unobserved.
