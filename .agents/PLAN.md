# Project plan

## Goal

Provide a T3-only setup that connects the user's Juiced model host through Pi.
T3 is the user interface and owns orchestration, browser tools, permissions,
threads, and histories. Pi is the underlying runtime and transport.
The user authorized the complete source audit and implementation in this project,
and explicitly excluded changes to T3 Code itself. The user subsequently
authorized replacing the host's Pi setup and testing its existing Juiced server.

## Success conditions

- A public GitHub repository contains generic source and runnable instructions.
- The installer configures Pi tools and an operator-supplied endpoint.
- A local Pi integration check discovers a fixture model and streams a response.
- Windows command lifecycle is implemented and covered by hosted CI.
- Existing user settings are merged and backed up.
- T3's complete tool catalog and other extensions' tools remain usable.
- Juiced models are discovered without operator-maintained model lists, including
  cold T3 discovery and restricted helper processes.
- Skill and instruction updates reload in the existing runtime without model
  inference or loss of the conversation and managed commands.
- T3-only limitations are documented accurately rather than presented as parity.

## Scope

Included: installer, T3 tool guidance, managed commands, plans/questions, Juiced
discovery and generated native model snapshots, resource reload, migration,
optional search, integration tests against the existing T3 bridge, authorized
host-profile migration, and live Juiced acceptance probes.
Excluded: installing Pi/T3 themselves, migrating histories, deploying model servers,
copying private profiles into Git, restarting unrelated services, changing T3 Code, or configuring
network access. Standalone Pi interfaces are not product requirements.

## Product boundaries

Native Windows, Linux, and macOS. Pi 1.5.0 is the tested API baseline.

## Architecture boundaries

Pi owns provider transport and its native model cache. A generated models.json
snapshot supports T3's extension-free helpers and is refreshed from Juiced by
this package. T3 owns its bridge, browser,
permissions, orchestration, pairing, and histories. This package owns its
extensions and narrowly merged configuration. Endpoints are user input.

## Phases

1. Generic installer and cross-platform extension package.
2. Focused local checks and public publication with hosted platform checks.
3. T3-only integration audit and implementation, including resource reload and
   dynamic model lifecycle acceptance within this repository.

## Open planning questions

None required for the initial setup.
