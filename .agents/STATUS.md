# Project status

## Project state

Version 1.0.0 is a rewrite of the 0.2 package. It replaces the copied-extension
installer with an in-place Pi package and adds the tool loadout budget, which is the
change that makes small-context models usable. No machine has run it inside a T3 Code
window yet.

## Current batch

Rewrite after a review of T3 Code 0.1.9, Pi 1.5.2 and the 0.2 package.
Findings and measurements are in `docs/design.md`.

## Verification

Local, Linux, Pi 1.5.2:

- `npm test`: 15 pass.
- `npm run test:pi`: 9 pass with the stand-in bridge and with T3 Code 0.1.9's real bridge.
  A tenth scenario runs only on Windows.
- Live, Juiced 1.0.0-rc.21: discovery returned the host's chat models with per-request
  context, thinking and image support from the catalog alone. The thinking switch was
  checked on a loaded model and on a model with thinking off by default.
- Live, one session: first-request input tokens 6,857 (standard) and 3,480 (compact),
  against 22,449 recorded for the 0.2 package on the same host and model. The model
  completed a `tool_search` then T3 tool call without help.

Hosted CI runs both suites on Linux, Windows and macOS. A second Windows job installs Pi
with Pi's own installer, on Node 22.19 and Node 26, and passes: setup finds `pi.cmd` in
the profile's `bin` without `PATH`, and the Pi suite runs against that install.

On Windows the Pi suite starts Pi through the launcher setup writes. With a `PATH` that
has no Node.js, that launcher started Pi in all three Windows jobs, while npm's `pi.cmd`
and the Pi installer's `pi.cmd` both failed with `'"node"' is not recognized`. That is the
error one Windows machine reported from setup.

Open: that machine has not run the fixed setup yet. How its Node.js is installed, and
why `node` works when typed but is missing from `PATH`, is not known.

Not verified: the T3 Code window and the PowerShell background variant.

## Next action

On each machine: `git pull`, then `node setup.mjs` with no options to take over the
0.2 install. Then open a thread in T3 Code and confirm the model list, a tool search
and a background command.

## Blockers

None in this package. A plan panel and Plan mode for Pi need T3 Code changes.
