$ErrorActionPreference = 'Stop'
$repoPath = 'C:\Users\44548\.codex\worktrees\managed-spec-provenance\heimdall'
$runDir = Join-Path $repoPath 'core\workspace\_runs\managed-readers-20261017'
$gateDir = Join-Path $runDir 'gates-final'
Set-Location -LiteralPath $repoPath
& pnpm -C console build *> (Join-Path $gateDir 'console-build.log')
$buildExit = $LASTEXITCODE
Write-Output ('console-build: exit ' + $buildExit)
Get-Content -LiteralPath (Join-Path $gateDir 'console-build.log') -Tail 8
if ($buildExit -ne 0) { exit $buildExit }
$browserCases = @(
  @{ name = 'managed-reading'; script = 'smoke-acceptance-managed-reading.mjs'; output = 'browser-final' },
  @{ name = 'spec-console'; script = 'smoke-acceptance-spec-console.mjs'; output = 'spec-final' },
  @{ name = 'comparison-console'; script = 'smoke-acceptance-comparison-console.mjs'; output = 'comparison-final' },
  @{ name = 'catalog-console'; script = 'smoke-acceptance-catalog-console.mjs'; output = 'catalog-final' },
  @{ name = 'acceptance-console'; script = 'smoke-acceptance-console.mjs'; output = 'acceptance-final' },
  @{ name = 'catalog-migration'; script = 'smoke-acceptance-catalog-migration.mjs'; output = 'migration-final' },
  @{ name = 'baseline-console'; script = 'smoke-acceptance-baseline-console.mjs'; output = 'baseline-final' },
  @{ name = 'managed-preparation'; script = 'smoke-acceptance-managed-preparation.mjs'; output = 'preparation-final' },
  @{ name = 'console-cdp'; script = 'smoke-console-cdp.mjs'; output = 'cdp-final' }
)
$browserRows = @()
foreach ($browserCase in $browserCases) {
  $startedAt = (Get-Date).ToUniversalTime().ToString('o')
  $browserLog = Join-Path $gateDir ($browserCase.name + '.log')
  $browserOutput = Join-Path $runDir $browserCase.output
  if (Test-Path -LiteralPath $browserOutput) { throw ('Fresh evidence output required: ' + $browserOutput) }
  if ($browserCase.name -eq 'console-cdp') { $env:HEIMDALL_E2E_CDP_SELF = '1' }
  & node (Join-Path 'core\scripts' $browserCase.script) $browserOutput *> $browserLog
  $browserExit = $LASTEXITCODE
  if ($browserCase.name -eq 'console-cdp') { Remove-Item Env:HEIMDALL_E2E_CDP_SELF }
  $browserRows += [ordered]@{ name = $browserCase.name; script = $browserCase.script; output = $browserCase.output; exitCode = $browserExit; startedAt = $startedAt; completedAt = (Get-Date).ToUniversalTime().ToString('o') }
  $browserRows | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $gateDir 'browser-gates.json') -Encoding utf8NoBOM
  Write-Output ($browserCase.name + ': exit ' + $browserExit)
  Get-Content -LiteralPath $browserLog -Tail 5
  if ($browserExit -ne 0) { exit $browserExit }
}
