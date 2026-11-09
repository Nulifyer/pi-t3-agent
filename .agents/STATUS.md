# Project status

## Project state

The generic installer and extension package are published at
https://github.com/Nulifyer/pi-t3-agent as a public repository.

## Current batch

Initial publication is complete. Correct the platform path handling found by CI.

## In progress

Windows command cancellation passed. Its cwd assertion needed canonical paths.
macOS installer preflight rejected the system /var symlink. Canonicalize the
selected profile root while retaining checks within the managed tree.

## Verification

23 focused installer/catalog/command tests pass on Linux with Node 26.13.0.
A real Pi 1.5.0 integration test discovers a local fixture model and streams a
response with the installed direct tool declarations. No private inference request
or live user profile change was needed.

## Next action

Push the focused platform correction and inspect Windows and Pi integration results.

## Blockers

The first platform run failed on the two path issues above.
Initial CI: https://github.com/Nulifyer/pi-t3-agent/actions/runs/42650283929
Linux passed. Windows passed command cancellation and installer preservation cases.
