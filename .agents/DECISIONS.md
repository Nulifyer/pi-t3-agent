# Project decisions

## Binding decisions

- Keep deployment-specific URLs, addresses, model IDs and secrets out of Git.
- Do not modify T3 Code or Pi. Use their documented extension points only.
- Do not ship T3 Code's generated bridge. Tests use a handwritten stand-in and can be
  pointed at the real bridge with `PI_T3_TEST_BRIDGE`.
- Distribute as a Pi package loaded from the checkout. No copied files in the profile.
- `models.json` holds the model list so that T3 Code's extension-free helpers can use
  it. User settings go in `modelOverrides`, which the package never writes.
- Reduce request size by hiding tool declarations (`prepareLoadout`), never by
  deactivating tools. Deactivation fights T3 Code's bridge.
- Keep T3 Code's own instructions and permission hook untouched.
- Background commands keep the built-in tool name `bash` so T3 Code renders and
  approves them as commands.
- Catalog requests go to the user's configured host even when Pi runs `--offline`.
  `discovery: "off"` or `refreshSeconds: 0` disables them.
- Read Juiced 1.0's discovery fields (`discovery_schema_version` 1) from the catalog in one
  request. Keep the Juiced 0.9 reading and a plain `/models` list as fallbacks.
- Offer thinking only when the host reports the `chat_template_kwargs.enable_thinking` switch,
  and not when the host's default for the model is off. Pi has no per-model default level.
- Features with no T3 Code surface for Pi (plan panel, Plan mode) are not imitated.
- On Windows, T3 Code starts a launcher setup writes into the profile, which names Node.js
  by its full path. Pi's own launchers start `node` by name and fail where `PATH` lacks it.

## Open decisions

None.

## Superseded decisions

- The 0.2 installer that copied extensions into the profile and tracked them with a
  manifest, hashes and a lock. Replaced by in-place package loading.
- Registering the provider from an extension. Replaced by `models.json` as the only source.
- "Preserve T3's complete tool catalog in every request." Replaced by on-demand
  declaration; the catalog stays active and callable.
- The `update_plan` tool, the `~/.agents/AGENTS.md` prompt injection, and the package's
  own T3 usage guidance. Removed: no T3 Code surface, no such file by default, and
  T3 Code already supplies its instructions.
