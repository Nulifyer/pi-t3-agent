# Testing

## Evidence standard

Report exact checks and platform coverage. Fixture streaming proves integration,
not model quality or native T3 browser behavior.

## Fast checks

`npm test` checks installer preservation/removal, command lifetime and cancellation,
and catalog filtering/capability mapping. It needs Node 22.19 or newer.

## Full checks

`npm run test:pi` installs into a temporary profile and runs real Pi against a
local fake Juiced/chat endpoint. It requires Pi 1.5.0 on PATH.
GitHub Actions runs both on Linux, Windows, and macOS with Node 22.19.0.

## Environment

No dependencies are required by the installer. Pi supplies extension imports.
Tests must never alter a real user profile or call a private/paid model endpoint.

## Known gaps

Native T3 browser/question UI and third-party SearXNG connectivity require a user
installation. Hosted CI covers native Windows process handling when its run passes.
