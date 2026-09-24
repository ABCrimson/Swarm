#Requires -Version 5.1
# Installs swarmd as a per-user logon Scheduled Task on Windows. The task runs
# in YOUR interactive session, non-elevated (RunLevel Limited): swarmd runs
# worker agents as you and touches your %APPDATA% and repositories, so it must
# never run as SYSTEM or elevated. Idempotent: re-run to upgrade (a running
# daemon is stopped first, since Windows cannot overwrite a running .exe).
# Loopback only (no --bind); see docs/daemon.md to reach it off-box.
#
# Binary source, in order of preference:
#   1. $env:SWARMD_BIN
#   2. swarmd-<arch>-pc-windows-msvc.exe next to this script (release asset)
#   3. swarmd.exe next to this script
#   4. ..\..\..\target\release\swarmd.exe (repository build)
#   5. swarmd.exe on PATH
#
# Keep this file ASCII-only: Windows PowerShell 5.1 reads a BOM-less script
# in the ANSI code page, where UTF-8 punctuation turns into quote characters.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'

$InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\swarmd'
$BinDest    = Join-Path $InstallDir 'swarmd.exe'
$DataDir    = Join-Path $env:APPDATA 'dev.crimson.swarm-orchestrator'
$LogFile    = Join-Path $DataDir 'swarmd.log'
$TaskName   = 'SWARM Daemon (swarmd)'

function Find-SourceBinary {
    if ($env:SWARMD_BIN) {
        if (Test-Path -LiteralPath $env:SWARMD_BIN -PathType Leaf) {
            return (Resolve-Path -LiteralPath $env:SWARMD_BIN).Path
        }
        throw "`$env:SWARMD_BIN ($env:SWARMD_BIN) is not a file"
    }
    $arch = switch ($env:PROCESSOR_ARCHITECTURE) {
        'ARM64' { 'aarch64' }
        default { 'x86_64' }
    }
    $candidates = @(
        (Join-Path $PSScriptRoot "swarmd-$arch-pc-windows-msvc.exe"),
        (Join-Path $PSScriptRoot 'swarmd.exe'),
        (Join-Path $PSScriptRoot '..\..\..\target\release\swarmd.exe')
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    $onPath = Get-Command 'swarmd.exe' -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($onPath) { return $onPath.Source }
    throw 'No swarmd.exe found. Build it with `cargo build -p swarmd --release` or set $env:SWARMD_BIN.'
}

# Stops the task and any swarmd.exe still running from $BinDest, so the
# binary can be replaced.
function Stop-InstalledDaemon {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $TaskName
    }
    Get-Process -Name 'swarmd' -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -eq $BinDest } |
        ForEach-Object {
            $_ | Stop-Process -Force
            $_.WaitForExit(10000) | Out-Null
        }
}

$src = Find-SourceBinary
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
New-Item -ItemType Directory -Force -Path $DataDir    | Out-Null
if ($src -ne $BinDest) {
    Stop-InstalledDaemon
    # Copy beside the destination, then swap it in.
    $staged = "$BinDest.new"
    Copy-Item -LiteralPath $src -Destination $staged -Force
    Move-Item -LiteralPath $staged -Destination $BinDest -Force
}
Write-Host "Installed binary: $BinDest"

# conhost --headless gives the console program a console without a window
# (and without handing it to Windows Terminal). swarmd writes its own log,
# so there is no shell wrapper or output redirection.
$conhost = Join-Path $env:SystemRoot 'System32\conhost.exe'
$action = New-ScheduledTaskAction -Execute $conhost `
    -Argument "--headless `"$BinDest`" --log-file `"$LogFile`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive -RunLevel Limited
# -ExecutionTimeLimit Zero: no limit. The default (72 hours) would stop the
# daemon after three days, and a stop is not a failure, so it would stay down.
# -Priority 5: normal priority. The default (7) is below normal, which every
# worker the daemon spawns would inherit.
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -Priority 5 -MultipleInstances IgnoreNew `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -Hidden

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings `
    -Description 'SWARM Orchestrator headless daemon' -Force | Out-Null

$registered = (Get-ScheduledTask -TaskName $TaskName).Settings
if ($registered.ExecutionTimeLimit -ne 'PT0S') {
    throw "The task's ExecutionTimeLimit is $($registered.ExecutionTimeLimit), expected PT0S (no limit)."
}
Start-ScheduledTask -TaskName $TaskName

Write-Host 'swarmd is registered as a logon Scheduled Task and started.'
Write-Host "Connect URL (carries the token): & '$BinDest' connect-url"
Write-Host "Log:                             Get-Content -Wait '$LogFile'"
Write-Host "Stop / start:                    Stop-ScheduledTask -TaskName '$TaskName' / Start-ScheduledTask -TaskName '$TaskName'"
