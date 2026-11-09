# Testing

## Evidence standard

Report exact checks and platform coverage. Fixture streaming proves integration,
not model quality or native T3 browser behavior.

## Fast checks

`npm test` checks installer migration and preservation, generated catalog ownership,
profile locking, resource fingerprints, command lifetime and cancellation, retention,
and Juiced filtering/capability mapping. It needs Node 22.19 or newer.

## Full checks

`npm run test:pi` uses disposable profiles and real Pi 1.5.0 against local
Juiced/chat and MCP fixtures. It checks cold discovery, scoped refresh, helpers,
retirement, outages, multi-turn tools, resource reload, managed command and plan
preservation, questions, and workspace trust.

Set `PI_T3_TEST_BRIDGE` to an externally recovered installed T3 bridge to run the
same integration scenarios with that artifact. Never commit generated bridges.
GitHub Actions runs both on Linux, Windows, and macOS with Node 22.19.0.

## Environment

No dependencies are required by the installer. Pi supplies extension imports.
Automated tests must never alter a real user profile or call private/paid model
endpoints. The user separately authorized host migration and live Juiced probes.
Keep those probes outside the test suite and keep private evidence outside Git.

## Known gaps

Native T3 browser/question UI and third-party SearXNG connectivity require a user
installation. Hosted CI covers native Windows process handling when its run passes.
