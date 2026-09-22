$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$probe = Join-Path $env:RUNNER_TEMP 'previewhost-backend'
New-Item -ItemType Directory -Path $probe -Force | Out-Null
Start-Transcript -Path (Join-Path $probe 'setup.log')
try {
    Write-Output "ImageOS=$env:ImageOS ImageVersion=$env:ImageVersion RUNNER_ARCH=$env:RUNNER_ARCH"
    Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber, OSArchitecture | Format-List
    Get-CimInstance Win32_ComputerSystem | Select-Object Manufacturer, Model, HypervisorPresent | Format-List
    Get-CimInstance Win32_Processor | Select-Object Name, VirtualizationFirmwareEnabled, SecondLevelAddressTranslationExtensions | Format-List

    # Install the supported WSL package if the image only has the installation stub.
    & wsl.exe --version
    if ($LASTEXITCODE -ne 0) {
        $arch = if ($env:RUNNER_ARCH -eq 'ARM64') { 'arm64' } else { 'x64' }
        $msi = Join-Path $probe 'wsl.msi'
        $url = "https://github.com/microsoft/WSL/releases/download/2.7.14/wsl.2.7.14.0.$arch.msi"
        Write-Output "Installing $url"
        Invoke-WebRequest $url -OutFile $msi -TimeoutSec 60
        $signature = Get-AuthenticodeSignature $msi
        $signature | Select-Object Status, @{Name='Signer'; Expression={$_.SignerCertificate.Subject}} | Format-List
        if ($signature.Status -ne 'Valid') { throw 'WSL installer signature is invalid.' }
        $install = Start-Process msiexec.exe -ArgumentList @('/i', "`"$msi`"", '/quiet', '/norestart', '/l*v', "`"$probe\wsl-install.log`"") -PassThru -Wait
        Write-Output "WSL MSI exit=$($install.ExitCode) (3010 means reboot required)"
        if ($install.ExitCode -notin @(0, 3010)) { throw "WSL installation failed: $($install.ExitCode)" }
        & wsl.exe --version
    }

    foreach ($featureName in @('Microsoft-Windows-Subsystem-Linux', 'VirtualMachinePlatform')) {
        $feature = Get-WindowsOptionalFeature -Online -FeatureName $featureName
        $feature | Select-Object FeatureName, State | Format-List
        if ($feature.State -ne 'Enabled') {
            & dism.exe /online /enable-feature "/featurename:$featureName" /all /norestart "/logpath:$probe\$featureName.log"
            Write-Output "Enable $featureName exit=$LASTEXITCODE (3010 means reboot required)"
            Get-WindowsOptionalFeature -Online -FeatureName $featureName | Select-Object FeatureName, State | Format-List
        }
    }
    & wsl.exe --status
    & bcdedit.exe /enum '{current}'

    $alpineArch = if ($env:RUNNER_ARCH -eq 'ARM64') { 'aarch64' } else { 'x86_64' }
    $file = "alpine-minirootfs-3.22.6-$alpineArch.tar.gz"
    $rootfs = Join-Path $probe $file
    $url = "https://dl-cdn.alpinelinux.org/alpine/v3.22/releases/$alpineArch/$file"
    Write-Output "Downloading $url"
    Invoke-WebRequest $url -OutFile $rootfs -TimeoutSec 60
    $expectedHash = if ($env:RUNNER_ARCH -eq 'ARM64') { '821565fa8f3953eefd12497b166b4b50add2f7c57fb312e75862f5867e06fefe' } else { '27694aaa55fd7a9e3ef596e0ad4eb66802308bb20172b17030cd5f4d8ae9bac2' }
    if ((Get-FileHash $rootfs -Algorithm SHA256).Hash -ne $expectedHash) { throw 'Alpine root filesystem checksum mismatch.' }

    Write-Output 'Attempting an actual WSL2 import and kernel boot.'
    & wsl.exe --import PreviewhostBackend "$probe\distro" $rootfs --version 2
    if ($LASTEXITCODE -ne 0) { throw "WSL2 import failed: $LASTEXITCODE" }
    & wsl.exe -d PreviewhostBackend --exec uname -a
    if ($LASTEXITCODE -ne 0) { throw "WSL2 kernel boot failed: $LASTEXITCODE" }
    & wsl.exe --list --verbose

    # This proves backend availability only. Previewhost must later run in Windows.
    $linuxProbe = @'
set -eu
apk add --no-cache docker
mkdir -p /sys/fs/cgroup
if ! mountpoint -q /sys/fs/cgroup; then mount -t cgroup2 none /sys/fs/cgroup; fi
dockerd >/tmp/dockerd.log 2>&1 &
daemon=$!
trap 'cat /tmp/dockerd.log; kill "$daemon" 2>/dev/null || true' EXIT
# Bounded initial socket readiness; no daemon restart or failed-command retry.
remaining=30
while [ ! -S /var/run/docker.sock ]; do
  kill -0 "$daemon"
  remaining=$((remaining - 1))
  [ "$remaining" -gt 0 ] || { echo 'Docker socket did not appear'; exit 1; }
  sleep 1
done
docker version
docker run --rm alpine:3.22 uname -a
'@
    $scriptPath = Join-Path $probe 'linux-probe.sh'
    [IO.File]::WriteAllText($scriptPath, $linuxProbe.Replace("`r`n", "`n") + "`n", [Text.UTF8Encoding]::new($false))
    $linuxScriptPath = '/mnt/' + $scriptPath.Substring(0, 1).ToLowerInvariant() + $scriptPath.Substring(2).Replace('\', '/')
    & wsl.exe -d PreviewhostBackend --exec sh $linuxScriptPath
    if ($LASTEXITCODE -ne 0) { throw "Linux container experiment failed: $LASTEXITCODE" }
    Write-Output 'PASS: Linux container started inside WSL2. Windows Previewhost databases are not yet tested.'
} finally {
    Stop-Transcript
}
