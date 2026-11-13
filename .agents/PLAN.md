# Project plan

## Goal

Make the models on a self-hosted model host fully usable in T3 Code through Pi.
T3 Code is the interface and owns threads, permissions, its MCP bridge and UI.
Pi is the runtime. This package fills the gaps between them for local models.

## Success conditions

- One command sets up Pi and T3 Code for a host; `git pull` updates it.
- The host's chat models appear in T3 Code with real context sizes and follow the host.
- A request to a local model carries only the tool definitions it needs, and every
  T3 Code tool stays reachable.
- T3 Code's extension-free helpers (titles, commit messages) can use the same models.
- Limits that need T3 Code changes are documented, not imitated.

## Scope

Included: `setup.mjs`, the extensions under `extensions/`, shared code under `lib/`,
tests against the real `pi` binary, documentation.
Excluded: changing T3 Code or Pi, installing either, deploying or configuring model
servers, network setup, migrating conversation histories.

## Boundaries

- `models.json` is the source of truth for models. The package owns only
  `providers.<id>.models`.
- The package is loaded in place from its checkout as a Pi package.
- Setup may rewrite its own files and Pi settings without preserving earlier releases'
  layouts. It keeps a copy of what it replaces.

## Open planning questions

None.
