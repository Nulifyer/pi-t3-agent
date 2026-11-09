# pi-t3-agent

Set up an existing [Pi coding agent](https://github.com/earendil-works/pi) for
[T3 Code](https://github.com/pingdotgg/t3code), using your own model server.
Commands and file tools run on your computer. Inference runs at the endpoint you supply.

The installer adds direct file/search tools, managed commands, conversation-backed
plans, and structured questions. T3 supplies its own browser and orchestration tools.
Optional features include SearXNG web tools and automatic Juiced model discovery.
No domains, addresses, credentials, or model names from a private deployment are included.

## Quick start

Install Pi, T3 Code, Node.js 22.19 or newer, and Git first.
This release is tested against Pi 1.5.0. Native Windows also needs Git for Windows
for Pi's built-in Bash tool. The custom command tool uses PowerShell on Windows.

Clone this repository:

```sh
git clone https://github.com/Nulifyer/pi-t3-agent.git
cd pi-t3-agent
```

For **Windows PowerShell**, connect to an OpenAI-compatible model server:

```powershell
.\install.ps1 --base-url "https://ai.example.com/v1" --model "YOUR_MODEL_ID" --set-default
```

If local script execution is disabled, the same installer runs directly with Node:

```powershell
node scripts/install.mjs --base-url "https://ai.example.com/v1" --model "YOUR_MODEL_ID" --set-default
```

For **Linux or macOS**:

```sh
sh install.sh --base-url "https://ai.example.com/v1" --model "YOUR_MODEL_ID" --set-default
```

Replace the example URL and model ID. Use the API base URL your service expects,
including `/v1` when required. Match `--context-window` and `--max-tokens` to your
server's limits. Static models default to 65,536 context and at most 8,192 output tokens.
Add `--reasoning` or `--vision` only if the model and endpoint support them.

If your endpoint requires a key, add `--api-key-env MODEL_API_KEY`. Set that
variable in the environment that launches Pi or in T3's Pi provider environment.
The installer stores its name, not its value. Without this option, the provider
uses a dummy `local` key for servers that do not require authentication.

## Juiced discovery

For a [Juiced](https://github.com/Nulifyer/juiced) server, use its API base URL:

```powershell
.\install.ps1 --base-url "https://ai.example.com/v1" --discovery juiced
```

Pi discovers downloaded Chat models with Hot or On-demand policy. Disabled models
and speech/image services are excluded. Proper model IDs are preserved. Context
is bounded by effective serving capacity per parallel slot, capped at 65,536.
Pi retains its last successful catalog during an outage.

Add `--model "YOUR_MODEL_ID" --set-default` to choose a default for new sessions.
Existing conversations retain their selection. Model availability and capability
labels come from Juiced. Model-specific sampling preferences remain yours to configure
through Pi's `models.json` overrides.

## Connect T3

In T3 Settings, enable Pi on the local environment and refresh the provider.
Set its binary path if T3 cannot find Pi. Use these launch arguments:

```text
--tools +grep,+find,+ls,+tool_search
```

Alternatively, add `--configure-t3` to the installer. It updates only Pi's enabled
flag, binary path, and launch arguments in `~/.t3/userdata/settings.json`.
Start T3 once first. If your installation stores settings elsewhere, pass
`--t3-settings "PATH"`. Existing custom Pi launch arguments require a manual merge.
Other providers, pairing, custom models, and histories are preserved.

Start a new Pi conversation, or reload Pi resources. The installer does not restart
T3 or running agents. T3 creates its own bridge, which this repository does not replace.
Its normal provider refresh owns model-list updates. Older T3 versions may retain
retired models in their picker until updated.

## Optional web search

Add your own SearXNG JSON endpoint:

```powershell
.\install.ps1 --search-url "https://search.example.com"
```

This configures `pi-web-access@0.46.0`, installed by Pi on its next startup.
Search uses only SearXNG. Page extraction uses direct HTTP with an 8,000-character
inline budget. Hosted fetch fallbacks, generated summaries, and automatic browser
opening are disabled.

Private-address fetching remains blocked by default. If your reverse proxy needs
an exemption, add `--allow-fetch-range "YOUR_PROXY_IP/32"` with `--search-url`.
Use a narrow range you control. Search and model endpoints must be reachable
from this computer through your LAN, VPN, or other existing connection.

## Existing settings, updates, and removal

Run the installer with no options to add tools while keeping your existing providers.
Endpoint configuration creates provider `local` by default. Use `--provider NAME`
if that ID already exists. Existing provider IDs are never overwritten by a first install.

The default profile is `~/.pi/agent`, or `PI_CODING_AGENT_DIR` when set.
Use `--agent-dir PATH` for another profile. Set the same directory in T3's Pi
provider environment when using a custom profile.

Changed files receive private local backups under `backups/pi-t3-agent` in that
profile. Repeating the command is idempotent. Edited managed files or settings
cause a clear failure instead of being overwritten. Do not run two installers
against the same profile simultaneously.

```sh
node scripts/install.mjs --dry-run
git pull --ff-only
node scripts/install.mjs
node scripts/install.mjs --uninstall
```

Uninstall removes unchanged extension files and restores the fields it managed.
Unrelated edits and backups remain. It refuses removal if managed fields/files
have been edited. Backups may contain existing credentials; keep them private.
Do not copy your entire Pi or T3 profile into this repository.

## Command sessions and limits

`command_session` supports start, status, literal stdin, stop, and list. It uses
Bash on Linux/macOS and PowerShell on Windows. Windows can select Git Bash with
`--command-shell bash`; `PI_T3_BASH_PATH` can select its executable.

There are at most four running commands and 32 retained commands per Pi session.
The timeout defaults to 600 seconds and accepts 1–3,600. Each result returns at
most 8,000 characters, memory retains the latest 65,536 characters, and temporary
logs retain up to 8 MiB. Cancellation targets POSIX process groups or uses Windows
`taskkill /T /F`. `processExited` reports whether exit was actually observed.
This is process management, not an operating-system sandbox.

Pi extensions run with your user's permissions. Use T3's normal permission modes
and trust only projects you intend to run. Working transport does not establish
that every model can reliably use all tools.

## Verify

```sh
pi --list-models
npm test
npm run test:pi
```

In T3, select a model and ask it to read a harmless local file and run a small
command. Web tools need a reachable SearXNG service. Browser and question UI
acceptance must be checked in your T3 installation.

The CI matrix runs installer, command lifecycle, and catalog tests on Linux,
Windows, and macOS. Its Pi integration test uses a local fake model service,
not a private endpoint or a paid model. See [verification](docs/verification.md)
for what was actually checked before publication.

MIT licensed. This is a community setup package, independent of Pi and T3 Code.
