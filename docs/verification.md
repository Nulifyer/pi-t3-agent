# Initial verification

Before publication, `npm test` passed 23 tests on Linux using Node 26.13.0.
They cover settings preservation, idempotence, uninstall behavior, command output,
stdin, exit status, timeout, descendant cancellation, and Juiced catalog mapping.

`npm run test:pi` passed with Pi 1.5.0. The installer created an isolated profile,
Pi discovered a local fixture model, and a request streamed successfully through
Pi's native Chat Completions transport. The request declared the installed file,
command, plan, question, and discovery tools directly without code mode.

The source includes a Linux/Windows/macOS GitHub Actions matrix using Node 22.19.0
and npm-installed Pi 1.5.0. Check its run for current platform results.

A user profile and live model service were not changed. T3 browser interaction,
question UI rendering, and a user's SearXNG connection are not covered by these checks.

Hosted CI on runtime source c91ac9e passed both suites on Linux and macOS. Windows
passed installer preservation and command lifecycle cases, but its cwd path-string
assertion failed. Commit 7df9682 verifies cwd through a file write instead. Its
[platform run](https://github.com/Nulifyer/pi-t3-agent/actions/runs/42650767217) was
queued at handoff; a full Windows pass is not yet claimed.
