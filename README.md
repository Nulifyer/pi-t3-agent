# pi-t3-agent

Use the models on your own model host in [T3 Code](https://github.com/pingdotgg/t3code), through the
[Pi](https://pi.dev) coding agent.

T3 Code already drives Pi, and Pi already talks to any OpenAI-compatible server. This package closes
the gaps that show up when the model is local:

- **Models appear by themselves.** The models your host serves are listed in T3 Code's picker with
  their real context size, and the list follows the host. Built for [Juiced](https://github.com/Nulifyer/juiced);
  any server with an OpenAI-style `/models` route also works.
- **Requests fit a local context.** T3 Code sends all of its tool definitions (about 70) with every
  request. On the setup this was measured on, that put 22,449 tokens in front of the first word of
  every conversation. With this package the same request is 6,857 tokens, or 3,480 for a
  small-context model, and every tool stays available.
- **Long commands do not block the agent.** The shell tool gains a background option, with a
  notification when the command exits.
- **Thinking is a proper on/off switch** in T3 Code's model options.
- **Skill and instruction edits apply to open threads** without restarting them.

It is a Pi package: a handful of extensions plus one setup script. It does not patch T3 Code or Pi.

## Requirements

- T3 Code 0.1.9 or newer, started at least once.
- Pi 1.5.0 or newer on the machine that runs the T3 Code server.
- Node.js 22.19 or newer, to run the setup script.
- A model host with an OpenAI-compatible API that T3 Code's machine can reach.

## Install

```sh
git clone https://github.com/Nulifyer/pi-t3-agent.git
cd pi-t3-agent
node setup.mjs --base-url https://ai.example.com/v1
```

Use your host's API base, including `/v1` if it has one. Setup then:

1. Adds a provider (named `juiced` unless you pass `--provider`) to Pi's `models.json`.
2. Asks the host for its models and prints them. This is your check that the URL and key work.
3. Registers this folder as a Pi package. Pi loads it from here, so keep the folder.
4. Enables Pi in T3 Code. T3 Code picks the change up while running.

In T3 Code, open **Settings > Providers**, refresh Pi, and choose a model in a thread.

On Windows, `pi` working in PowerShell does not mean a program can start it: PowerShell runs
`pi.ps1`, which T3 Code cannot. Setup finds the `pi.cmd` launcher beside it and gives T3 Code its
full path, so T3 Code does not depend on the `PATH` it was started with.

### If the host needs an API key

```sh
node setup.mjs --base-url https://ai.example.com/v1 --api-key-env MODEL_HOST_KEY
```

Then add `MODEL_HOST_KEY` to the Pi provider's environment in T3 Code's settings and mark it
sensitive. T3 Code stores it and passes it to Pi. Only the variable's name is written to disk by setup.

`--api-key KEY` stores the key itself in `models.json` instead. That file is readable only by you, but
the key is in plain text.

### Models the host does not describe fully

Juiced 1.0 says for each model whether it can think, read images and call tools, so nothing needs
setting. Other servers, and Juiced 0.9 for models it has not labelled, do not always say. Tell setup
once:

```sh
node setup.mjs --reasoning "qwen3*" --vision "gemma-3-*"
```

Patterns match model IDs, and `*` is a wildcard. Use `--exclude PATTERN` to hide models you do not
want in the picker. Each flag can be repeated, and re-running setup adds to what is saved.

### Other options

| Option | Effect |
|---|---|
| `--default-model ID` | The model behind T3 Code's "Pi default" entry. Without it, setup keeps a valid default or picks the first model. |
| `--trust-projects` | Pi loads project-local skills, settings and extensions without asking. Only for machines where you trust every repository you open. |
| `--agent-dir PATH` | Use another Pi profile. T3 Code is pointed at the same one. |
| `--pi-bin PATH` | Pi executable, if setup cannot find it. On Windows setup looks for `pi.cmd` or `pi.exe` on `PATH`, in Pi's own install folder and in npm's global folder. |
| `--no-t3` | Do not touch T3 Code's settings. Enable Pi there yourself. |
| `--status` | Show what is configured. Changes nothing. |
| `--remove` | Unregister the package and delete its configuration. The provider and its last model list stay in `models.json`. |

`node setup.mjs --help` lists everything. Setup can be re-run at any time. It keeps the URL and key
from the last run, and saves the files it replaces under `backups/pi-t3-agent/` in the Pi profile.

### Update

```sh
git pull
```

Pi runs the extensions from this folder, so there is nothing to reinstall. Open threads pick the
new code up with `/pi-reload`; new threads always use it. Re-run `node setup.mjs` only when the
release notes say setup changed.

### Coming from an earlier release

Run `node setup.mjs` with no options. It keeps your provider name, URL and key, removes the files
the old installer copied into the Pi profile, and carries over models you had marked as thinking or
image-capable.

## What it does

### Model list

Each time Pi starts, the package asks the host for its chat models if the saved list is older than
30 seconds, and writes them to the provider's `models` list in `models.json`. T3 Code starts Pi
whenever it refreshes the provider, so **refreshing Pi in T3 Code's settings is how you refresh the
list**. A thread that is already open follows the file and can select a new model without a restart.

If the host is unreachable, the last list stays and T3 Code shows a note next to the composer.
A model the host stops serving is removed at the next successful refresh.

`/pi-sync` in a thread asks the host immediately.

The list lives in `models.json` because that is the only place every Pi launch reads. T3 Code writes
thread titles, commit messages and branch names with Pi's extensions switched off, and those
requests can only use models defined there.

Do not edit the `models` list by hand; it is overwritten. Put your own settings for a model under
`modelOverrides` in the same provider entry. Pi applies them on top, and this package never changes
them:

```json
"modelOverrides": {
  "my-small-model": { "maxTokens": 256, "samplingParams": { "temperature": 0.2 } }
}
```

For Juiced, context size is what the catalog reports for one request. With several parallel slots
that is less than the launch context. Other servers are read through `/models`. If a server reports
no context size, 32,768 is assumed and setup tells you to set `contextWindow` under `modelOverrides`.

Thinking is offered for a model when Juiced reports that its chat template has an on/off switch. A
model whose thinking is switched off in Juiced's settings is listed without it; switch it on there to
get the option in T3 Code.

### Tool loadout

For a local model, T3 Code's bridge switches on every T3 tool so that each is described in every
request. This package leaves them switched on but takes their descriptions out of the request until
they are needed:

- Pi's own tools, `ask_user`, `background_job` and three T3 delegation tools are always described.
- Everything else is one `tool_search` call away. The model searches with a few words, the matching
  tools are described from the next request on, and they stay described for the rest of the thread.
- A tool the model calls without searching still runs.

For a model with a context window under 40,000 tokens the loadout is tighter: only Pi's file and
shell tools, `tool_search` and `ask_user` are described, and skills are not listed. Skills you attach
from T3 Code's `$` menu still work. Change the threshold with `--compact-below`.

Loading a tool changes the start of the prompt, so the host re-reads the conversation once. On the
measured setup one tool load meant re-reading about 9,200 tokens; the requests after it were served
from the host's prompt cache again.

### Background commands

The `bash` tool accepts `run_in_background`. The call returns a job ID at once. When the command
exits, the agent is told the exit code and the last output and continues on its own. `background_job` reads output, waits, stops a job, or lists jobs. Jobs end when
the thread's Pi session ends.

### Questions

`ask_user` lets the model ask you one question, with choices or as free text. It appears in T3 Code's
composer like any other prompt from Pi.

### Reload and trust

Skills, prompt templates and instruction files (`AGENTS.md` and similar) are watched. A change is
applied to open threads as soon as the agent is idle, without a model request. `/pi-reload` does the
same on demand and also reloads extensions.

Pi does not load a project's own skills, settings or extensions until you trust the folder, and it
cannot ask from inside T3 Code. `/pi-trust` asks in the composer and saves the answer. Pi decides
trust when a session starts, so the answer applies after you start a new thread in that folder or
switch the permission mode and back.

`/pi-status` shows the model, the last sync, the tool loadout and running jobs for the thread.

## Files

| File, in the Pi profile | Owner |
|---|---|
| `pi-t3-agent.json` | Setup. Provider name, patterns, thresholds. Safe to edit; see `lib/config.mjs` for the keys. |
| `pi-t3-agent.state.json` | The package. Time and result of the last sync. |
| `models.json`, `providers.<name>.models` | The package. Overwritten at each sync. |
| `models.json`, everything else | You. |
| `settings.json` | You. Setup adds the package path and enables Pi's `grep`, `find` and `ls` tools, which T3 Code's supervised mode runs without a prompt. |

## Limits

- T3 Code does not show a plan panel or a Plan mode for Pi. Nothing here imitates one.
- A background job has no terminal: programs that need one will not run in it.
- Whether a model handles tools well is up to the model. A model that cannot call tools reliably
  will not get better here; it will only have fewer tool definitions to be confused by.
- The PowerShell variant of the background option is written but has not been run on Windows.
- Verified on Linux against Pi 1.5.2 and the Pi bridge that T3 Code 0.1.9 generates. No test drives
  the T3 Code window itself. [docs/design.md](docs/design.md) says what was measured and how.

## Development

```sh
npm test          # unit tests, no Pi needed
npm run test:pi   # drives the installed pi binary against local fixture servers
```

Both suites use throwaway profiles and local servers. Set `PI_T3_TEST_BRIDGE` to T3 Code's generated
bridge (`~/.t3/caches/pi-t3-mcp-extension.ts`) to run the Pi suite against the real bridge instead of
the stand-in.

MIT licensed. Independent of the Pi and T3 Code projects.
