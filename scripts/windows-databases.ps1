# Windows Server 2025 provides WSL2. Keep Node and every test on Windows.
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$directory = Join-Path $env:RUNNER_TEMP 'previewhost-docker'
$source = Join-Path $PSScriptRoot 'windows-docker-pipe.go'
$bridge = $null
$daemon = $null
$imported = $false
New-Item -ItemType Directory $directory | Out-Null
try {
    $rootfs = Join-Path $directory 'rootfs.tar.gz'
    Invoke-WebRequest 'https://dl-cdn.alpinelinux.org/alpine/v3.22/releases/x86_64/alpine-minirootfs-3.22.6-x86_64.tar.gz' -OutFile $rootfs -TimeoutSec 60
    if ((Get-FileHash $rootfs -Algorithm SHA256).Hash -ne '27694aaa55fd7a9e3ef596e0ad4eb66802308bb20172b17030cd5f4d8ae9bac2') {
        throw 'Alpine root filesystem checksum mismatch.'
    }
    wsl.exe --import PreviewhostBackend "$directory\distro" $rootfs --version 2
    $imported = $true
    wsl.exe -d PreviewhostBackend --exec /sbin/apk add --no-cache docker socat
    wsl.exe -d PreviewhostBackend --exec sh -c 'mkdir -p /sys/fs/cgroup; mountpoint -q /sys/fs/cgroup || mount -t cgroup2 none /sys/fs/cgroup'
    $daemon = Start-Process wsl.exe -ArgumentList '-d PreviewhostBackend --exec /usr/bin/dockerd' -PassThru -RedirectStandardOutput "$directory\docker.log" -RedirectStandardError "$directory\docker-error.log"
    # Bounded initial readiness, without restarting the daemon or repeating tests.
    wsl.exe -d PreviewhostBackend --exec sh -c 'set -e; remaining=30; while [ ! -S /var/run/docker.sock ]; do remaining=$((remaining-1)); [ "$remaining" -gt 0 ] || exit 1; sleep 1; done; docker version; docker pull postgres:17-alpine; docker pull redis:7-alpine'

    New-Item -ItemType Directory "$directory\bridge" | Out-Null
    Copy-Item $source "$directory\bridge\main.go"
    Push-Location "$directory\bridge"
    try {
        go mod init previewhost-ci-docker
        go get github.com/Microsoft/go-winio@v0.6.2
        go build -o "$directory\bridge.exe" .
    } finally { Pop-Location }
    # Also exercise the documented Windows default used by unconfigured project owners.
    $env:PREVIEWHOST_TEST_DOCKER_SOCKET = '\\.\pipe\docker_engine'
    $ready = "$directory\ready"
    $bridge = Start-Process "$directory\bridge.exe" -ArgumentList @($env:PREVIEWHOST_TEST_DOCKER_SOCKET, "`"$ready`"") -PassThru -RedirectStandardOutput "$directory\bridge.log" -RedirectStandardError "$directory\bridge-error.log"
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    while (!(Test-Path $ready)) {
        if ($bridge.HasExited -or [DateTime]::UtcNow -ge $deadline) { throw 'Docker pipe did not become ready.' }
        Start-Sleep -Milliseconds 50
    }
    npm run verify
    if ($LASTEXITCODE -ne 0) { throw "Shared suite failed ($LASTEXITCODE)." }
} finally {
    try {
        if ($bridge -and !$bridge.HasExited) { $bridge.Kill(); $bridge.WaitForExit() }
    } finally {
        try { if ($imported) { wsl.exe --unregister PreviewhostBackend } }
        finally {
            if ($daemon -and !$daemon.HasExited) { $daemon.Kill(); $daemon.WaitForExit() }
            Get-ChildItem $directory -Filter '*error.log' | ForEach-Object { Get-Content $_.FullName -Tail 30 }
        }
    }
}
