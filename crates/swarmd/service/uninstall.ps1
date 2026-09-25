#Requires -Version 5.1
# Removes the swarmd logon Scheduled Task installed by install.ps1, stopping
# the daemon first. Leaves the binary in place unless -PurgeBinary is given.
# Never touches your SWARM data directory or event log.
#
# Keep this file ASCII-only (see install.ps1).
[CmdletBinding()]
param([switch]$PurgeBinary)
$ErrorActionPreference = 'Stop'

$BinDest  = Join-Path $env:LOCALAPPDATA 'Programs\swarmd\swarmd.exe'
$TaskName = 'SWARM Daemon (swarmd)'

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed Scheduled Task: $TaskName"
} else {
    Write-Host "No Scheduled Task named '$TaskName'; nothing to remove."
}

# Stopping the task does not always stop its swarmd.exe; a running binary
# can be neither left behind as a zombie daemon nor deleted.
Get-Process -Name 'swarmd' -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -eq $BinDest } |
    ForEach-Object {
        $_ | Stop-Process -Force
        $_.WaitForExit(10000) | Out-Null
        Write-Host "Stopped swarmd (PID $($_.Id))."
    }

if ($PurgeBinary -and (Test-Path -LiteralPath $BinDest)) {
    Remove-Item -LiteralPath $BinDest -Force
    Write-Host "Removed binary: $BinDest"
}
Write-Host 'Your SWARM data directory and event log were left untouched.'
