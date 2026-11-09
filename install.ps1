$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'scripts/install.mjs') @args
exit $LASTEXITCODE
