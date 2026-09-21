# Disposable diagnostic only. Run elevated on an expendable Windows runner after product compilation.
param([string]$ProductRoot = (Get-Location).Path)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows) { throw 'This diagnostic requires Windows.' }
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Creating temporary ordinary accounts requires an elevated runner.' }
$node = (Get-Command node.exe).Source
$ProductRoot = (Resolve-Path $ProductRoot).Path
if (-not (Test-Path (Join-Path $ProductRoot 'dist/docker.js'))) { throw 'Compile the product before this probe.' }
$id = [Guid]::NewGuid().ToString('N')
$directory = Join-Path $env:TEMP "previewhost-accounts-$id"
$accounts = @()
$processes = [Collections.Generic.List[Diagnostics.Process]]::new()
$deadline = [DateTime]::UtcNow.AddSeconds(150)
$results = @()
$cleanupFailed = $false
function Wait-File([string]$Path, [Diagnostics.Process]$Process) {
  while (-not (Test-Path $Path)) {
    if ($Process.HasExited -or [DateTime]::UtcNow -gt $deadline) { throw 'Worker exited or diagnostic deadline expired before its marker.' }
    Start-Sleep -Milliseconds 50
  }
}
function Start-Worker($Account, $Config, [string]$Name) {
  $path = Join-Path $directory "$Name.json"
  $Config | ConvertTo-Json -Compress | Set-Content -LiteralPath $path -Encoding utf8
  $worker = Join-Path $directory 'worker.mjs'
  $arguments = '"' + $worker + '" "' + $path + '"'
  $process = Start-Process -FilePath $node -ArgumentList $arguments -Credential $Account.Credential -LoadUserProfile -UseNewEnvironment `
    -WorkingDirectory $directory -PassThru -RedirectStandardInput (Join-Path $directory 'stdin.txt') `
    -RedirectStandardOutput (Join-Path $directory "$Name.stdout") -RedirectStandardError (Join-Path $directory "$Name.stderr")
  $processes.Add($process)
  return $process
}
try {
  New-Item -ItemType Directory -Path $directory | Out-Null
  Copy-Item (Join-Path $PSScriptRoot 'windows-accounts-worker.mjs') (Join-Path $directory 'worker.mjs')
  New-Item -ItemType File -Path (Join-Path $directory 'stdin.txt') | Out-Null
  foreach ($suffix in @('v', 'a')) {
    $name = 'ph' + $id.Substring(0, 12) + $suffix
    $password = ConvertTo-SecureString ('Aa1!' + [Guid]::NewGuid().ToString('N') + '!') -AsPlainText -Force
    $user = New-LocalUser -Name $name -Password $password -AccountNeverExpires -PasswordNeverExpires
    $accounts += @{ Name = $name; Sid = $user.SID.Value; Credential = [PSCredential]::new("$env:COMPUTERNAME\$name", $password) }
    Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $name
    & icacls.exe $directory /grant "*$($user.SID.Value):(OI)(CI)M" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Cannot grant access to disposable diagnostic files.' }
  }
  $victim = $accounts[0]
  foreach ($foreign in @($false, $true)) {
    foreach ($attach in @($false, $true)) {
      $label = $(if ($foreign) { 'foreign-owner' } else { 'same-account' }) + $(if ($attach) { '-attach' } else { '-http' })
      $serverAccount = $(if ($foreign) { $accounts[1] } else { $victim })
      $serverResult = Join-Path $directory "$label-server-result.json"
      $clientResult = Join-Path $directory "$label-client-result.json"
      $ready = Join-Path $directory "$label-ready"
      $common = @{ productRoot = $ProductRoot; pipe = "\\.\pipe\previewhost-$id-$label"; victimSid = $victim.Sid; foreign = $foreign; attach = $attach }
      $serverConfig = $common.Clone(); $serverConfig.role = 'server'; $serverConfig.accountSid = $serverAccount.Sid
      $serverConfig.result = $serverResult; $serverConfig.ready = $ready
      $server = Start-Worker $serverAccount $serverConfig "$label-server"
      Wait-File $ready $server
      $clientConfig = $common.Clone(); $clientConfig.role = 'client'; $clientConfig.accountSid = $victim.Sid
      $clientConfig.result = $clientResult; $clientConfig.serverResult = $serverResult
      $client = Start-Worker $victim $clientConfig "$label-client"
      foreach ($process in @($client, $server)) {
        $remaining = [int][Math]::Min(20000, [Math]::Max(1, ($deadline - [DateTime]::UtcNow).TotalMilliseconds))
        if (-not $process.WaitForExit($remaining)) { throw "$label exceeded the bounded worker timeout." }
        if ($process.ExitCode -ne 0) { throw "$label worker failed; inspect its fixed-label result." }
      }
      $observed = Get-Content -Raw $serverResult | ConvertFrom-Json
      $checked = Get-Content -Raw $clientResult | ConvertFrom-Json
      if (-not $observed.ok -or -not $checked.ok -or ($foreign -and $observed.bytes -ne 0)) { throw "$label failed its account boundary assertions." }
      $results += @{ case = $label; passed = $true; serverBytes = $observed.bytes }
    }
  }
} finally {
  foreach ($process in $processes) {
    try { if (-not $process.HasExited) { $process.Kill(); if (-not $process.WaitForExit(5000)) { $cleanupFailed = $true } } }
    catch { $cleanupFailed = $true }
    finally { $process.Dispose() }
  }
  foreach ($account in $accounts) {
    try { Remove-LocalUser -Name $account.Name -ErrorAction Stop }
    catch { $cleanupFailed = $true }
  }
  Write-Output (ConvertTo-Json -Compress @{ results = $results; cleanupComplete = (-not $cleanupFailed); diagnosticDirectory = $directory })
  if ($cleanupFailed) { throw 'Temporary process or account cleanup failed.' }
}
