<#
.SYNOPSIS
    Starts the AICheff backend STABLY and FULLY DECOUPLED from the launching shell.

.DESCRIPTION
    TWO real root causes of "server suddenly gone, port 8787 gone, no stacktrace,
    no lifecycle log":

    (1) CONSOLE INHERITANCE via stdout/stderr redirect.
        The previous launcher used `Start-Process -RedirectStandardOutput/-Error`.
        Any redirect forces .NET to launch with UseShellExecute=FALSE, which makes
        the spawned node INHERIT the launching shell's console. When that console
        goes away (terminal/tool session closes a few seconds after a request
        burst), Windows delivers a CTRL_CLOSE/console-close event to EVERY process
        sharing that console -- the server is torn down CLEANLY. No JS exception =>
        no stacktrace. That is the "gone shortly after" effect.

    (2) LIFECYCLE LOG NEVER REACHED A FILE.
        The old lifecycle/exception logging went only through appendBackendDebugLog,
        which writes to an in-memory ring + console.* (= stdout/stderr). On Windows a
        redirected stdout pipe is ASYNCHRONOUS; during teardown the buffered bytes
        are never flushed to the file. So backend.out/err.log stayed silent no matter
        what killed the process.

    Fixes here:
      * Launch with NO -RedirectStandard* => UseShellExecute=TRUE => the server gets
        its OWN console and is decoupled from this shell. A parent/console close can
        no longer tear it down.
      * `node --import tsx backend/src/server.ts` runs as ONE single process (no
        fragile tsx-CLI middle node forwarding its death to a grandchild).
      * The server writes its OWN logs directly to files (synchronous appendFileSync),
        independent of stdout:
            backend/backend.out.log        (full debug log, via BACKEND_LOG_FILE)
            backend/backend-lifecycle.log  (exit/beforeExit/signal/uncaught/...)
            backend/backend-heartbeat.log  (1/s; its last line = the death second)
        and a PID file backend/backend.pid for unambiguous identification.

    Stop it via the printed PID:  Stop-Process -Id <pid>  (or taskkill /PID <pid> /F).

.PARAMETER Port
    Backend port. Default: 8787 (exported as PORT env var).

.PARAMETER NoOpenAdmin
    Do not open /admin-v2 after confirming the backend is reachable. Used by the
    in-app restart flow; desktop/manual starts should open the page.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\start-backend.ps1
#>
param(
    [int]$Port = 8787,
    [switch]$NoOpenAdmin
)

$ErrorActionPreference = "Stop"

# Repo root = parent of this scripts/ directory.
$repoRoot = Split-Path -Parent $PSScriptRoot
$serverEntry = "backend/src/server.ts"
$logDir = Join-Path $repoRoot "backend"
$outLog = Join-Path $logDir "backend.out.log"
$pidFile = Join-Path $logDir "backend.pid"
$lifecycleLog = Join-Path $logDir "backend-lifecycle.log"
$heartbeatLog = Join-Path $logDir "backend-heartbeat.log"
$healthUrl = "http://127.0.0.1:${Port}/api/health"
$adminUrl = "http://localhost:${Port}/admin-v2"

function Open-AdminPage {
    if ($NoOpenAdmin) { return }
    try {
        Start-Process $adminUrl | Out-Null
        Write-Host "[start-backend] Opened:    $adminUrl"
    } catch {
        Write-Warning "[start-backend] Backend is healthy, but opening $adminUrl failed: $($_.Exception.Message)"
    }
}

function Test-BackendHealth {
    try {
        $r = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 2
        return ($r.StatusCode -eq 200)
    } catch {
        return $false
    }
}

function Get-PortOwnerPid {
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($conn -and $conn.OwningProcess) { return @($conn)[0].OwningProcess }
    try {
        $line = netstat -ano | Select-String -Pattern "[:.]$Port\s+.*\s+ABH.REN\s+\d+" | Select-Object -First 1
        if ($line -and ($line.Line -match '\s+(\d+)\s*$')) { return [int]$Matches[1] }
    } catch {
        # Best-effort diagnostic only; health remains the source of truth.
    }
    return $null
}

# node loads tsx as a loader -- we start the ONE process directly.
$nodeArgs = @("--import", "tsx", $serverEntry)

Write-Host "[start-backend] Repo:      $repoRoot"
Write-Host "[start-backend] Start:     node $($nodeArgs -join ' ')"
Write-Host "[start-backend] Port:      $Port"
Write-Host "[start-backend] Log:       $outLog"
Write-Host "[start-backend] Lifecycle: $lifecycleLog"
Write-Host "[start-backend] Heartbeat: $heartbeatLog"

# Desktop/manual behavior: if a backend is already serving this port, do not start
# another local backend. Just open the existing Admin UI and exit cleanly.
if (Test-BackendHealth) {
    $ownerPid = Get-PortOwnerPid
    Write-Host ""
    Write-Host "[start-backend] Backend already HEALTHY on $healthUrl"
    Write-Host "[start-backend] Existing PID: $ownerPid"
    Open-AdminPage
    exit 0
}

# The server writes its full debug log itself (direct file append, NOT stdout).
$env:PORT = "$Port"
$env:BACKEND_LOG_FILE = $outLog

# WinGet installs Poppler into a package directory that is not always visible to
# long-running shells immediately after installation. Make the renderer visible
# to the backend process explicitly; the detector still decides at runtime.
try {
    $wingetPackages = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages"
    if (Test-Path $wingetPackages) {
        $popplerExe = Get-ChildItem -LiteralPath $wingetPackages -Recurse -Filter "pdftoppm.exe" -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($popplerExe) {
            $popplerBin = Split-Path -Parent $popplerExe.FullName
            if (Test-Path $popplerBin) {
                $env:Path = "$popplerBin;$env:Path"
                Write-Host "[start-backend] Poppler:   $popplerBin"
            }
        }
    }
} catch {
    Write-Warning "[start-backend] Poppler auto-detect failed: $($_.Exception.Message)"
}

# CRITICAL: no -RedirectStandardOutput/-RedirectStandardError. That keeps
# UseShellExecute=TRUE so the backend gets its OWN console and is decoupled from
# this shell -- a console-close here can no longer kill it.
$proc = Start-Process -FilePath "node" `
    -ArgumentList $nodeArgs `
    -WorkingDirectory $repoRoot `
    -WindowStyle Hidden `
    -PassThru

$startedPid = $proc.Id
Write-Host ""
Write-Host "[start-backend] Launched node, PID=$startedPid (decoupled, own console)."

# Poll health for up to ~20s and validate the SAME pid owns the port.
$deadline = (Get-Date).AddSeconds(20)
$healthy = $false
while ((Get-Date) -lt $deadline) {
    if (-not (Get-Process -Id $startedPid -ErrorAction SilentlyContinue)) {
        Write-Error "[start-backend] Process $startedPid exited during startup -- see $outLog / $lifecycleLog"
        exit 1
    }
    try {
        $r = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 3
        if ($r.StatusCode -eq 200) { $healthy = $true; break }
    } catch {
        Start-Sleep -Milliseconds 400
    }
}

if (-not $healthy) {
    Write-Error "[start-backend] Health never reached 200 within 20s -- see $outLog / $lifecycleLog"
    exit 1
}

# Verify the port owner is exactly our process (no stale/foreign listener).
$ownerPid = Get-PortOwnerPid
if ($ownerPid -ne $startedPid) {
    Write-Warning "[start-backend] Port $Port owner PID=$ownerPid differs from launched PID=$startedPid (foreign/stale listener?)."
}

Write-Host ""
Write-Host "[start-backend] Backend HEALTHY on $healthUrl"
Write-Host "[start-backend] PID:   $startedPid  (port owner PID: $ownerPid; pidfile: $pidFile)"
Write-Host "[start-backend] Stop:  Stop-Process -Id $startedPid"
Open-AdminPage
exit 0
