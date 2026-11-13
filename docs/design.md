# Design notes

Why each part of this package exists, what it relies on in T3 Code and Pi, and what was measured.
Source references are to T3 Code `v0.1.9` (`pingdotgg/t3code`) and Pi `v1.5.2` (`earendil-works/pi`).

## How T3 Code runs Pi

T3 Code never embeds Pi. It starts `pi --mode rpc` in three ways, and each one constrains the design.

| Launch | Arguments T3 Code adds | Extensions | Consequence |
|---|---|---|---|
| Thread session | `--session <file> --extension <bridge>` | loaded | Everything in this package runs here. |
| Discovery probe, to fill the model and skill pickers | `--no-session --offline` | loaded | The probe is the natural trigger for a catalog refresh. It must finish well inside T3 Code's 30-second limit. |
| Text helper, for titles, commit messages and branch names | `--no-session --offline --no-extensions --no-tools` | not loaded | A model that only an extension registers cannot be used. T3 Code's own error says to define it in `models.json`. |

Source: `packages/provider-pi/src/server/mcpInjection.ts` (`buildPiRpcLaunch`), `status.ts`
(`makePiDiscoveryConnection`), `textGeneration.ts` (`disableExtensions`, `disableTools`).

T3 Code injects its own generated extension, the bridge, into thread sessions. The bridge registers
T3 Code's MCP tools as Pi tools, adds T3 Code's orchestration instructions to the system prompt, and
enforces the composer's permission mode through Pi's `tool_call` hook
(`mcpExtensionSource.ts`). This package leaves all of that alone.

What the adapter renders (`adapter.ts`, `emitToolItem`):

- A tool named `bash` or `powershell` is shown as a command, with its output and exit code.
- `edit` and `write` are shown as file changes.
- Every other tool is shown generically, with its JSON input and output.
- `select`, `confirm`, `input` and `editor` dialogs from an extension become prompts in the composer.
  `notify` becomes a line in the work log, only during a turn. `setStatus` text is shown near the composer.
- An agent run that starts without a user prompt is adopted as a continuation of the thread
  (`agent_start` with no active turn). Where that support is missing the adapter stops the session
  (`PI_UNSOLICITED_ACTIVITY_ERROR`), so background-job notifications need the T3 Code version this
  was checked against, 0.1.9, or newer.
- There is no plan or to-do surface for Pi (`planning.emitsPlanUpdated: false`,
  `showInteractionModeToggle: false`).

## The problem that mattered most: tool definitions

For a model whose API is `openai-completions`, the bridge activates every T3 tool on each session
start, model change and turn (`reconcileDiscovery` in `mcpExtensionSource.ts`). Its comment gives the
reason: completion gateways can silently drop calls to tools that were not declared. For every other
API it keeps three tools declared and leaves the rest to Pi's `tool_search`.

Measured on a real T3 Code thread from this machine's Pi session log, before this rewrite:

| Part of the first request | Size |
|---|---|
| 68 T3 tool definitions | 49,253 characters |
| 15 other tool definitions | 12,456 characters |
| Skills list (25 skills) | 10,204 characters |
| T3 Code orchestration instructions | 3,601 characters |
| The previous release's own guidance | 2,038 characters |
| **Input tokens reported by the model host** | **22,449** |

Two of the three chat models on that host have 16,384 and 32,768 tokens of context, so one could not
run a turn at all and the other started with a third of its context left. `tool_search` did not
help: it only searches tools that are *not* active (`extensions/tool-search/tool.ts`, `searchAndLoad`),
and the bridge had activated all of them, so every search returned "No matching tools found".

### What the package does

Pi lets an active tool hide the declarations of other active tools through `prepareLoadout`, which
returns `hiddenDeclarations` (`core/agent-session.ts`, `_applyToolLoadout`). Hidden tools stay active
and executable; only their schemas are left out of requests. `extensions/toolshelf.ts` uses it:

- It registers one tool, `tool_shelf`, whose only job is to carry the hook. It hides itself.
- It hides every T3 tool except the three the bridge itself treats as always-direct.
- A `tool_result` handler on Pi's `tool_search` ranks the hidden tools for the query, un-hides the
  matches and adds them to the result. To the model there is one search tool and it works.
- A hidden tool that is called anyway runs, and is declared from then on. So does any tool that
  appears in the session's history, which covers resume, fork and tree navigation.
- Loaded tool names are saved as session entries, so they survive reloads and restarts.

Because the tools stay active, the bridge finds nothing missing and never re-adds anything. That is
why this works where the previous release's second allow-list fought the bridge and lost.

For models under `compactBelow` tokens of context, everything outside Pi's built-in tools and
`ask_user` is hidden as well, and the skills list is dropped from the prompt. T3 Code expands a skill
the user picks from its own menu, so skills remain usable.

Measured afterwards, same host, same model, same 25 skills, T3 Code's real bridge and real tool
catalogue, first request of a new session:

| Loadout | Input tokens |
|---|---|
| Before | 22,449 |
| Standard | 6,857 |
| Compact | 3,480 |

In the same run the model was asked to read a T3 thread. Unprompted, it called `tool_search`, then
`t3_thread_read` with the right argument. The request after the load reported 9,193 input tokens,
which is the one-time re-read caused by the changed tool list; the next was cached again.

### Alternatives rejected

- **Deactivating tools** each turn. The bridge re-activates them, so the transcript churns and tools
  from other extensions get lost. The previous release tried this and removed it.
- **Registering the provider under another API name** so the bridge takes its other branch. It keys
  on an internal detail of T3 Code and would break `models.json` overrides that depend on the API.
- **Rewriting the request payload** in `before_provider_request`. It works on the wire but leaves Pi's
  prompt and transcript claiming tools the model never saw.

## Model catalog

`models.json` is the single source of truth, for the reason in the launch table. `lib/sync.mjs`
overwrites `providers.<id>.models` and nothing else. Pi applies `modelOverrides` to models defined
in the same file (checked against Pi 1.5.2), so user settings have a home the sync never writes.

Triggers:

- The extension's startup, bounded to four seconds. Because T3 Code's probes load extensions, T3
  Code's provider refresh is what drives discovery; no timer runs here.
- `before_agent_start` in a live session, in the background, when the list is older than
  `refreshSeconds`.
- `/pi-sync`.

`pi-t3-agent.state.json` holds the time of the last attempt, shared by every Pi process of the
profile, so ten open threads still make one request per window.

A live session does not re-read `models.json` by itself: selecting a model another process just
added fails with "Model not found". The extension therefore watches the file and calls
`modelRegistry.refresh({ allowNetwork: false })`, which reloads it (`core/model-runtime.ts`, `refresh`).

T3 Code passes `--offline` to probes to keep Pi from renewing OAuth tokens in a process it is about
to kill. The catalog request is a read of the user's own host, so it is made regardless. Set
`discovery` to `off` or `refreshSeconds` to `0` in `pi-t3-agent.json` to stop it.

### Juiced

`GET <base>/juiced/catalog` is the only request, checked against Juiced 1.0.0-rc.21. Its entries
carry `discovery_schema_version` 1 fields, which `lib/catalog.mjs` reads as follows.

| Catalog field | Use |
|---|---|
| `operations` includes `chat/completions` | The model is a chat model. |
| `downloaded`, and `policy` is not `disabled` | The model is listed. A `hot` policy sorts it first. |
| `context.per_request_tokens` | `contextWindow`. `null` means unknown: 32,768 is assumed and reported as a guess. |
| `max_output_tokens` | Caps `maxTokens`. |
| `vision` | Image input. |
| `thinking.supported` with `thinking.request_control` of `chat_template_kwargs.enable_thinking` | Thinking is offered as a switch. |
| `thinking.default` of `off` | Thinking is not offered. See below. |
| `tool_calls.supported` | Sort order only. |

The context is not derived here. Juiced reports the slot size a loaded engine observed, or computes
it from the launch settings the way llama-server sizes slots, and names which in
`context.per_request_source`. A launch total is never used as a request size.

Thinking needs a switch the client can send. A model that thinks with no switch gets no toggle,
because a toggle would do nothing. A model whose switch is `reasoning_effort` is not offered
thinking either: that path was not run against a model.

Pi's default thinking level is `medium` for every model and cannot be set per model. If thinking
were offered for a model that the operator switched off in Juiced, every new thread would switch it
back on. So `thinking.default` of `off` is kept by leaving thinking out for that model.

The catalog also has a revision and an `ETag`. They are not used: a sync is at most one request per
`refreshSeconds` for the whole profile, and re-applying the list each time is what lets a changed
`pi-t3-agent.json` take effect.

Juiced 0.9 has no `discovery_schema_version`. For it the older reading is kept: `service` is `Chat`,
capabilities come from `labels`, and context is `context.observed_per_request_tokens` for a loaded
model, otherwise `options.resolved_ctx_size` divided by `--parallel`. The `reasoning` and `vision`
patterns in the configuration exist for that service and for plain OpenAI-compatible hosts.

Earlier release candidates of Juiced 1.0 reported none of this, and the previous release of this
package required a `health.all_models_loaded` array they did not send, so its discovery failed on
every attempt and served a stale list. That is why the catalog is read defensively and the tests
cover both versions.

Checked live on rc.21: the catalog listed the host's three enabled chat models with per-request
contexts; an unloaded model's computed context matched what its engine reported once loaded;
`enable_thinking` set to `false` and `true` removed and restored reasoning output on a loaded model;
and a model with thinking switched off on the host produced none until the request asked for it.

### Thinking

Models marked as reasoning get `thinkingFormat: "qwen-chat-template"`, which sends
`chat_template_kwargs.enable_thinking`, and a `thinkingLevelMap` that leaves only `off` and `medium`.
T3 Code offers exactly the levels that are not `null` (`modelCapabilities.ts`), so the picker shows
Off and Medium instead of five levels that all do the same thing. This mirrors Pi's built-in
llama.cpp provider (`extensions/llama/provider.ts`).

`maxTokens` defaults to a quarter of the context, at most 32,768. A lower cap cuts a long `write`
call off in the middle of its JSON arguments.

## Background commands

`extensions/background.ts` re-registers `bash` from Pi's exported `createBashToolDefinition` with one
extra parameter. Foreground calls go to the built-in implementation unchanged. Background calls run
through `createLocalBashOperations().exec`, Pi's own backend, which resolves the shell and kills the
process tree on every platform. Keeping the name `bash` keeps T3 Code's command rendering and its
approval rules.

On exit the extension calls `pi.sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })`. An
idle agent starts a run, which T3 Code adopts as a continuation; a busy one receives the message when
it finishes. Jobs the model stops itself do not notify. Jobs are kept in a `globalThis` registry so
that an extension reload does not orphan them, and are killed when the session ends.

## Reload and trust

`extensions/reload.ts` watches resource locations with `fs.watch` and dispatches `/pi-reload`, which
calls `ctx.reload()`, when the agent is idle. This follows the pattern in Pi's extension
documentation. It replaces a one-second polling loop that walked every skill directory synchronously
in every Pi process.

Trust cannot be asked at startup. In RPC mode Pi resolves it with `hasUI: false` (`main.ts`), so a
`project_trust` handler has no dialog to show; this was confirmed by experiment. Pi also caches the
decision for the life of the process. `/pi-trust` therefore saves the decision through
`ProjectTrustStore`, and it takes effect at the next session start.

## Installation

Pi loads a local package in place (`docs/packages.md`). Setup registers the checkout's path in
`settings.json`, so the running code is the checkout: `git pull` is the update, and there is no
copied tree to drift. The previous release copied ten files into the profile and tracked them with
hashes, a manifest, a lock file and per-field ownership records; most of its 455-line installer
existed to manage that copy.

T3 Code watches its `settings.json` (`apps/server/src/serverSettings.ts`), so enabling Pi there is a
supported way in. Setup changes only `providerInstances.pi` and keeps a copy of the file.

On Windows, Pi's installer writes `pi`, `pi.cmd` and `pi.ps1` launchers into `bin` in the Pi profile
and adds that folder to the user `PATH`. PowerShell prefers `pi.ps1`, so `pi` works when typed. T3
Code resolves a bare `pi` against its own `PATH` and `PATHEXT` (`resolveSpawnCommand`), which finds
`pi.cmd` only if T3 Code's environment already has that folder. Node cannot start either launcher by
bare name. `findPi` in `setup.mjs` therefore looks for `pi.exe` or `pi.cmd` on `PATH`, then in the
profile's `bin`, then in npm's global folder, and setup writes the full path as T3 Code's
`binaryPath`.

## Verification

`npm test` runs 14 unit tests of discovery, both Juiced versions, sync, the tool ranker and setup,
including takeover of a profile left by the previous release and the Windows launcher lookup.

`npm run test:pi` drives the installed `pi` binary over RPC, as T3 Code does, against a local model
host and a stand-in bridge that reproduces the real bridge's activation behaviour. Ten scenarios:
setup's own start of `pi`; on Windows, a launcher in a folder with spaces and brackets; on-demand tools across turns, reload and resume; the compact loadout and model switching; the probe
and helper launches; live catalog changes and an outage; background commands and the exit wake-up;
questions; skill reload without a model request; trust. Five of them were also checked to fail when
the feature they cover is switched off: tool hiding (two scenarios), the `models.json` watcher, the
exit wake-up and the resource watcher. The suite also passes with `PI_T3_TEST_BRIDGE` set to T3 Code
0.1.9's generated bridge.

Hosted CI runs both suites on Linux, Windows and macOS. A second Windows job installs Pi with Pi's
own installer and runs the Pi suite against it, on the oldest supported Node and the newest LTS.

Not verified: the T3 Code window itself and the PowerShell background variant.
