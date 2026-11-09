# Project plan

## Goal

Provide a public pi-t3-agent repository with an installer for an existing Pi agent.
The user requested Windows setup for local tools with a remote model service,
and a generic public repository without their private domains or configuration.
The user prioritizes quick setup over exhaustive hardening.

## Success conditions

- A public GitHub repository contains generic source and runnable instructions.
- The installer configures Pi tools and an operator-supplied endpoint.
- A local Pi integration check discovers a fixture model and streams a response.
- Windows command lifecycle is implemented and covered by hosted CI.
- Existing user settings are merged and backed up.

## Scope

Included: install scripts, direct tools, plans/questions, optional Juiced discovery,
optional SearXNG configuration, optional T3 Pi settings, and focused tests.
Excluded: installing Pi/T3 themselves, migrating histories, deploying model servers,
copying private profiles, restarting live services, or configuring network access.

## Product boundaries

Native Windows, Linux, and macOS. Pi 1.5.0 is the tested API baseline.

## Architecture boundaries

Pi owns provider transport and model cache. T3 owns its bridge, browser,
permissions, orchestration, pairing, and histories. This package owns its
extensions and narrowly merged configuration. Endpoints are user input.

## Phases

1. Generic installer and cross-platform extension package.
2. Focused local checks and public publication with hosted platform checks.

## Open planning questions

None required for the initial setup.
