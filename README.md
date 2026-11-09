# pi-t3-agent

Connect your [Juiced](https://github.com/Nulifyer/juiced) model host to
[T3 Code](https://github.com/pingdotgg/t3code) through the
[Pi runtime](https://github.com/earendil-works/pi). T3 is the user interface.
Files and commands run on the T3 environment's computer; inference runs on Juiced.

This package preserves T3's tools, discovers models, refreshes skills and
instructions, and adds managed commands, saved plans, and questions. It does not
modify T3 Code, replace its generated bridge, or install a second user interface.

## Install

Install T3 Code, Pi 1.5.x, Node.js 22.19 or newer, and Git first. Start T3 once.
Native Windows also needs Git for Windows for Pi's built-in Bash tool.

```sh
git clone https://github.com/Nulifyer/pi-t3-agent.git
cd pi-t3-agent
```

Windows PowerShell:

```powershell
.\install.ps1 --base-url "https://ai.example.com/v1" --configure-t3
```

Linux or macOS:

```sh
sh install.sh --base-url "https://ai.example.com/v1" --configure-t3
```

The same installer runs with `node scripts/install.mjs` if PowerShell scripts are
disabled. Replace the example URL with your API base, including `/v1` when needed.
No model name is required. In T3, refresh the Pi provider and choose a discovered
model. This configures the existing `pi` provider instance, including its driver,
binary, and profile environment. Existing launch arguments and other environment
variables are preserved. Running T3 processes are not restarted by the installer.

For authentication, add `--api-key-env MODEL_API_KEY` and set that variable in T3's
Pi provider environment. The installer stores the variable's name, not its value.
Without authentication, a dummy `local` key is used. Network routing, VPNs, and
server deployment remain yours to configure.

Use `--agent-dir PATH` for a separate profile. `--configure-t3` connects T3 to that
exact profile. Use `--t3-settings PATH` if T3 stores settings outside
`~/.t3/userdata/settings.json`, or `--pi-bin PATH` for another Pi executable.
Without `--configure-t3`, enable Pi and set `PI_CODING_AGENT_DIR` in T3 yourself.

## Model discovery

Supplying `--base-url` without `--model` selects Juiced discovery. The catalog
includes downloaded Chat models with Hot or On-demand policy. Explicitly
unavailable models, incompatible execution profiles, and incomplete artifacts
are excluded. IDs, per-slot context, reasoning, vision, and advertised output
limits come from Juiced. There is no fixed model list or 65,536-token ceiling.
When Juiced does not report an output limit, the fallback is at most 8,192 tokens
and half the serving context. Unknown model capabilities remain unverified.

Metadata refresh defaults to 30 seconds while idle and before a later turn when
due. `--catalog-refresh-seconds N` accepts 5–3,600. In T3:

- `/t3-refresh-models` forces a metadata refresh without inference.
- `/t3-status` reports loaded models and whether the last successful catalog is
  being retained during an outage.
- T3's provider refresh updates its displayed picker. An open picker may retain
  its previous snapshot until refreshed.

T3 starts some probes with `--offline` to avoid unrelated OAuth renewal. This
package still performs bounded metadata requests to the configured Juiced host.
Set `PI_T3_OFFLINE=1` in T3's provider environment to disable those requests.
`PI_OFFLINE` alone also disables them when no `--offline` argument is present.
Pi itself sets `PI_OFFLINE` when processing that argument, so `PI_T3_OFFLINE` is
the unambiguous opt-out for T3.

A generated catalog is written to the managed provider's `models` array in
`models.json`. This lets T3's extension-free title, branch, commit, and PR helpers
use discovered models. `pi-t3-agent-catalog.json` records the generated snapshot.
These are local profile data. Do not edit generated model entries; put sampling
and capability preferences in the provider's `modelOverrides`. Updates preserve
those preferences. A removed selected model is not replaced silently. Choose
another model in T3. Outages retain the last successful catalog.

For a generic OpenAI-compatible server without Juiced discovery, supply
`--discovery none --model YOUR_MODEL_ID`. Static models also accept
`--context-window`, `--max-tokens`, `--reasoning`, and `--vision`. Defaults are
65,536 context and at most 8,192 output tokens. Match them to your server.
`--set-default` is optional; T3's model picker normally controls selection.

## Skills and instructions

The running agent monitors shared `~/.agents/skills`, Pi resource directories,
project skill directories, context files, and discovered skill locations. It
also includes `~/.agents/AGENTS.md` when present. Changes are checked about once
per second. Additions, removals, description changes, and symlink targets are
detected. Reload waits until active agent work settles, then uses Pi's supported
resource reload command without making a model request or restarting the process.
The conversation, saved plan, selected model, and managed commands are retained.

Use `/t3-reload` in T3 for an explicit refresh. T3's own skill picker is a separate
provider snapshot; refresh it if an already open picker has not updated.

Project extensions, settings, and project skills still require project trust.
`/t3-trust` asks for approval through T3 and saves trust for the current workspace.
Pi's public reload API preserves the current trust decision. After first granting
trust, restart only that thread's agent through T3 and resume the conversation.
This one-time trust transition does not require restarting T3 or the model host.
Later resource updates reload in place. Trust is not granted globally.

## T3 tools and remaining limits

T3 owns thread communication, model delegation, worktrees, browser interaction,
devices, schedules, secrets, PR linking, and watches. This package preserves its
entire declared tool catalog and other extensions' tools. It does not maintain a
second tool allowlist. The model receives explicit guidance about using T3.

Some native features require T3 adapter changes and are outside this package:

- T3's Pi provider hides the native Plan-mode toggle. `update_plan` saves progress
  in the conversation, but does not populate T3's native plan panel or enable Plan mode.
- Managed commands render as tool results rather than native T3 terminal activities.
  They use pipes, not a PTY. `command_session` supports start, status, literal stdin,
  stop, and list, using PowerShell on Windows and Bash on Unix.
- Pi's native subagent controls differ from Codex's. Cross-model work uses T3's
  delegation tools and their returned lifecycle instructions.
- Actual model behavior, tool-call reliability, vision, and reasoning depend on
  the selected model and server. Transport compatibility does not establish model quality.

`ask_user` supports selectable choices or free text through T3. Commands have a
default 600-second timeout, configurable from 1 to 3,600. At most four processes
run at once. The latest 32 jobs are retained; completed jobs are evicted as needed.
Results return at most 8,000 characters, memory retains 65,536, and each log is
capped at 8 MiB. Cancellation targets process groups on Unix and uses `taskkill /T`
on Windows. Check `processExited` and `exitCode` before claiming completion.
T3's Stop action interrupts the agent; independently started command sessions
can remain running until explicitly stopped, timed out, or the session exits.

## Updates, migration, and removal

```sh
git pull --ff-only
node scripts/install.mjs --dry-run
node scripts/install.mjs
node scripts/install.mjs --uninstall
```

Managed files and settings receive private local backups. Edited owned fields
cause a clear failure rather than being overwritten. Uninstall preserves other
settings and operator-added provider preferences. An unchanged generated provider
can be removed; a provider with custom preferences is retained. Catalog refreshes
and installation share a lock. Do not edit generated snapshots during an update.

If an older setup installed global `agent-tools.ts`, `ask-user.ts`, a Juiced
provider, or a tool-filter extension, use `--migrate-legacy` to back up and retire
recognized files. Unrecognized files are preserved and reported for manual review.
Uninstall restores retired files from their private backups. When a recognized
legacy Juiced extension is retired, `--provider EXISTING_ID --migrate-legacy`
can adopt its existing provider while preserving credentials and defaults.
Otherwise, choose an unused ID such as `--provider t3-juiced`, then select its
model in T3. Never copy your real Pi or T3 profile into this repository.

## Optional research tools

`--search-url https://search.example.com` adds `pi-web-access@0.46.0` with SearXNG
search, direct HTTP extraction, and an 8,000-character inline budget. Hosted fetch
fallbacks, generated summaries, and automatic browser opening are disabled.
Private-address fetching remains blocked unless you explicitly supply a narrow
`--allow-fetch-range CIDR`. T3 remains the shared browser for interactive work.

## Verification

```sh
npm test
npm run test:pi
```

Tests use disposable profiles and local fixture endpoints. They exercise cold
discovery, tool calls across turns, helper processes, model refresh and retirement,
outages, questions, trust, and resource reload with a running command and saved plan.
CI runs the suites on Linux, Windows, and macOS. Local checks do not establish a
hosted platform result or full T3 desktop UI acceptance. See
[verification](docs/verification.md) and the [source audit](docs/integration-audit.txt).

MIT licensed. This community setup is independent of Pi and T3 Code.
