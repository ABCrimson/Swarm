#Requires -Version 5.1
# Remove the swarmd logon Scheduled Task installed by install.ps1. Leaves the
# binary and your SWARM data directory in place; pass -PurgeBinary to also
# remove the installed swarmd.exe. Never touches your data/event log.
[CmdletBinding()]
param([switch]$PurgeBinary)
$ErrorActionPreference = 'Stop'

$InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\swarmd'
$BinDest    = Join-Path $InstallDir 'swarmd.exe'
$TaskName   = 'SWARM Daemon (swarmd)'

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed Scheduled Task: $TaskName"
} else {
    Write-Host "No Scheduled Task named '$TaskName' — nothing to remove."
}

if ($PurgeBinary -and (Test-Path -LiteralPath $BinDest)) {
    Remove-Item -LiteralPath $BinDest -Force
    Write-Host "Removed binary: $BinDest"
}
Write-Host 'Your SWARM data directory and event log were left untouched.'
