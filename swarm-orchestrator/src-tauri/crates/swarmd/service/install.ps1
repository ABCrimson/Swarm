#Requires -Version 5.1
# Install swarmd as a per-user logon Scheduled Task on Windows. The task
# runs in YOUR interactive session, non-elevated (RunLevel Limited): swarmd
# runs worker agents as you and touches your %APPDATA% and repos, so it must
# not run as SYSTEM or elevated. Idempotent — re-run to upgrade. Loopback
# only by default (no --bind); see docs/daemon.md to reach it off-box.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\swarmd'
$BinDest    = Join-Path $InstallDir 'swarmd.exe'
$DataDir    = Join-Path $env:APPDATA 'dev.crimson.swarm-orchestrator'
$LogFile    = Join-Path $DataDir 'swarmd.log'
$TaskName   = 'SWARM Daemon (swarmd)'

function Find-SourceBinary {
    if ($env:SWARMD_BIN) {
        if (Test-Path -LiteralPath $env:SWARMD_BIN -PathType Leaf) { return (Resolve-Path -LiteralPath $env:SWARMD_BIN).Path }
        throw "`$env:SWARMD_BIN ($env:SWARMD_BIN) is not a file"
    }
    $candidates = @(
        (Join-Path $ScriptDir 'swarmd.exe'),
        (Join-Path $ScriptDir '..\..\..\target\release\swarmd.exe')
    )
    foreach ($c in $candidates) { if (Test-Path -LiteralPath $c -PathType Leaf) { return (Resolve-Path -LiteralPath $c).Path } }
    $onPath = Get-Command 'swarmd.exe' -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }
    throw 'no swarmd.exe found — build it with `cargo build -p swarmd --release` or set $env:SWARMD_BIN'
}

$src = Find-SourceBinary
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
New-Item -ItemType Directory -Force -Path $DataDir    | Out-Null
if ((Resolve-Path -LiteralPath $src).Path -ne $BinDest) {
    Copy-Item -LiteralPath $src -Destination $BinDest -Force
}
Write-Host "Installed binary: $BinDest"

# Run through powershell so all output (the connect URL carries the token)
# is redirected into a user-private log under %APPDATA%. Hidden window = no
# console flash. Paths are wrapped in single quotes inside -Command; double
# any embedded apostrophe first so a username like O'Brien (which lands in
# %LOCALAPPDATA%/%APPDATA%) can't break out of the quoting.
$binEsc = $BinDest -replace "'", "''"
$logEsc = $LogFile -replace "'", "''"
$psArg = "-NoProfile -NonInteractive -WindowStyle Hidden -Command `"& '$binEsc' *>> '$logEsc'`""
$action    = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $psArg
$trigger   = New-ScheduledTaskTrigger -AtLogOn
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -Hidden

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Description 'SWARM Orchestrator headless daemon' -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

Write-Host 'swarmd is registered as a logon Scheduled Task and started.'
Write-Host "Connect URL (carries the token):  Select-String -Path '$LogFile' -Pattern 'Listening On'"
Write-Host "Stop / start:                     Stop-ScheduledTask -TaskName '$TaskName' / Start-ScheduledTask -TaskName '$TaskName'"
