<#
.SYNOPSIS
    Restarts the AICheff backend cleanly, fully decoupled from the dying instance.

.DESCRIPTION
    Triggered by the /admin-v2 "Backend neu starten" button. The backend starts
    this relauncher in a separate Windows process, then shuts itself down
    gracefully. This script waits for the old PID and port to go away, then calls
    scripts/start-backend.ps1.
#>
param(
    [int]$OldPid = 0,
    [int]$Port = 8787
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$startScript = Join-Path $PSScriptRoot "start-backend.ps1"
$logPath = Join-Path $repoRoot "backend\backend-restart.log"

function Write-RestartLog {
    param([string]$Message)
    $line = "[{0}] {1}" -f (Get-Date).ToString("o"), $Message
    try {
        Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
    } catch {
        # Logging must never prevent a restart.
    }
    Write-Host $Message
}

try {
    Write-RestartLog "[restart-backend] OldPid=$OldPid Port=$Port"

    if ($OldPid -gt 0) {
        $deadline = (Get-Date).AddSeconds(20)
        while ((Get-Date) -lt $deadline) {
            if (-not (Get-Process -Id $OldPid -ErrorAction SilentlyContinue)) { break }
            Start-Sleep -Milliseconds 300
        }
        if (Get-Process -Id $OldPid -ErrorAction SilentlyContinue) {
            Write-RestartLog "[restart-backend] PID $OldPid still alive after 20s; relaunch may hit EADDRINUSE."
        } else {
            Write-RestartLog "[restart-backend] Old PID $OldPid exited."
        }
    }

    $portDeadline = (Get-Date).AddSeconds(15)
    while ((Get-Date) -lt $portDeadline) {
        $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
        if (-not $listener) { break }
        Write-RestartLog "[restart-backend] Waiting for port $Port listener PID=$($listener.OwningProcess) to release."
        Start-Sleep -Milliseconds 300
    }

    $remainingListener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($remainingListener) {
        Write-RestartLog "[restart-backend] Port $Port still has listener PID=$($remainingListener.OwningProcess); start-backend will reuse it if healthy."
    } else {
        Write-RestartLog "[restart-backend] Port $Port released."
    }

    Write-RestartLog "[restart-backend] Re-launching via $startScript"
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $startScript -Port $Port -NoOpenAdmin
    $exitCode = $LASTEXITCODE
    Write-RestartLog "[restart-backend] start-backend.ps1 exited with code $exitCode"
    exit $exitCode
} catch {
    Write-RestartLog "[restart-backend] ERROR: $($_.Exception.Message)"
    exit 1
}
