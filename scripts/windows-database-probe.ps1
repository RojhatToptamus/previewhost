$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$probe = Join-Path $env:RUNNER_TEMP 'previewhost-backend'
$diagnosis = $PWD.Path
$daemon = $null
$bridge = $null
try {
    & wsl.exe -d PreviewhostBackend --exec /sbin/apk add --no-cache socat
    $daemon = Start-Process wsl.exe -ArgumentList @('-d', 'PreviewhostBackend', '--exec', '/usr/bin/dockerd') -PassThru -RedirectStandardOutput "$probe\dockerd.log" -RedirectStandardError "$probe\dockerd-error.log"
    & wsl.exe -d PreviewhostBackend --exec sh -c 'set -e; remaining=30; while [ ! -S /var/run/docker.sock ]; do remaining=$((remaining-1)); [ "$remaining" -gt 0 ] || exit 1; sleep 1; done; docker version; docker pull postgres:17-alpine; docker pull redis:7-alpine'

    New-Item -ItemType Directory -Path "$probe\bridge" | Out-Null
    Copy-Item "$diagnosis\scripts\windows-pipe-bridge.go" "$probe\bridge\main.go"
    Push-Location "$probe\bridge"
    try {
        go mod init previewhost-backend-fixture
        go get github.com/Microsoft/go-winio@v0.6.2
        go build -o "$probe\bridge.exe" .
    } finally { Pop-Location }
    $env:PREVIEWHOST_TEST_DOCKER_SOCKET = '\\.\pipe\previewhost-backend-qualification'
    $bridge = Start-Process "$probe\bridge.exe" -ArgumentList $env:PREVIEWHOST_TEST_DOCKER_SOCKET -PassThru -RedirectStandardOutput "$probe\bridge.log" -RedirectStandardError "$probe\bridge-error.log"

    Push-Location "$diagnosis\product"
    try {
        npm ci --ignore-scripts
        npx tsc -p tsconfig.test.json
        # The user approved only this disposable, unpublished compiled test copy.
        # Source guard, pipe authentication, assertions and deadlines stay intact.
        node "$diagnosis\scripts\prepare-windows-database-probe.mjs"
        node -p "JSON.stringify({platform:process.platform,arch:process.arch,node:process.version})"
        node --test --test-reporter=tap --test-concurrency=1 .local/test-build/data.integration.test.js
    } finally { Pop-Location }
} finally {
    if ($bridge -and !$bridge.HasExited) { Stop-Process -Id $bridge.Id }
    if ($daemon -and !$daemon.HasExited) { Stop-Process -Id $daemon.Id }
    & wsl.exe --terminate PreviewhostBackend
    Get-ChildItem $probe -Filter '*error.log' | ForEach-Object { Write-Output $_.Name; Get-Content $_.FullName -Tail 60 }
}
