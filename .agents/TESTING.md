# Testing

## Commands

```sh
npm test          # unit tests: discovery, sync, setup, ranking. No Pi needed.
npm run test:pi   # drives the installed `pi` binary over RPC against local fixtures
PI_T3_TEST_BRIDGE=~/.t3/caches/pi-t3-mcp-extension.ts npm run test:pi   # same, real T3 Code bridge
```

## Standards

- Tests use throwaway profiles and local servers, with `HOME` redirected. They must
  not read the real Pi profile or contact a real host.
- A behaviour in a Pi process is verified through that process: recorded request
  payloads and RPC events, not internal state.
- When adding a scenario, break the feature once and confirm the scenario fails.
- Live checks against a real host are run by hand and reported in `docs/design.md`
  without endpoints, keys or model IDs.
- CI runs both suites on Linux, Windows and macOS. A local pass is not a hosted result.
