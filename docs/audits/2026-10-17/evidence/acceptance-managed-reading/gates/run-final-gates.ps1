$ErrorActionPreference = 'Stop'
$repoPath = 'C:\Users\44548\.codex\worktrees\managed-spec-provenance\heimdall'
$gateDir = Join-Path $repoPath 'core\workspace\_runs\managed-readers-20261017\gates-final'
New-Item -ItemType Directory -Path $gateDir -Force | Out-Null
Set-Location -LiteralPath $repoPath
$gateRows = @()
foreach ($gateName in @('lint', 'test', 'smoke')) {
  $startedAt = (Get-Date).ToUniversalTime().ToString('o')
  $gateLog = Join-Path $gateDir ($gateName + '.log')
  & pnpm -C core $gateName *> $gateLog
  $gateExit = $LASTEXITCODE
  $gateRows += [ordered]@{ name = $gateName; exitCode = $gateExit; startedAt = $startedAt; completedAt = (Get-Date).ToUniversalTime().ToString('o'); log = ($gateName + '.log') }
  $gateRows | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $gateDir 'core-gates.json') -Encoding utf8NoBOM
  Write-Output ($gateName + ': exit ' + $gateExit)
  Get-Content -LiteralPath $gateLog -Tail 12
  if ($gateExit -ne 0) { exit $gateExit }
}
