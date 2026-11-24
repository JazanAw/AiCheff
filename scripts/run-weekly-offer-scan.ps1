<#
.SYNOPSIS
    Triggert den Cheffity Wochen-Auto-Scan über die Backend-API.

.DESCRIPTION
    Startet POST /api/offers/weekly-auto-scan/start und pollt danach
    GET /api/offers/weekly-auto-scan/status bis der Lauf fertig/Fehler/abgebrochen
    ist. Gedacht für die Windows-Aufgabenplanung.

    Das Backend muss laufen (npm run dev:server bzw. der Prod-Start). REWE/nahkauf
    werden bewusst NICHT gescrapt — sie bleiben Screenshot/PDF-Import.

.PARAMETER BackendUrl
    Basis-URL des Backends. Default: http://localhost:8787

.PARAMETER TimeoutMinutes
    Maximale Wartezeit beim Status-Polling. Default: 60.

.PARAMETER NoWait
    Nur starten, nicht auf das Ergebnis warten.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\run-weekly-offer-scan.ps1
#>
param(
    [string]$BackendUrl = "http://localhost:8787",
    [int]$TimeoutMinutes = 60,
    [switch]$NoWait
)

$ErrorActionPreference = "Stop"
$base = $BackendUrl.TrimEnd("/")

Write-Host "[weekly-scan] Starte Wochen-Auto-Scan über $base ..."

try {
    $startResp = Invoke-RestMethod -Method Post -Uri "$base/api/offers/weekly-auto-scan/start" `
        -ContentType "application/json" -Body "{}"
}
catch {
    # Bei 409 (läuft schon / anderer Job aktiv) den Fehlertext zeigen und sauber raus.
    $msg = $_.Exception.Message
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
        try { $msg = ($_.ErrorDetails.Message | ConvertFrom-Json).error } catch {}
    }
    Write-Warning "[weekly-scan] Start abgelehnt: $msg"
    exit 1
}

Write-Host "[weekly-scan] $($startResp.message)"

if ($NoWait) {
    Write-Host "[weekly-scan] -NoWait gesetzt — beende ohne zu warten."
    exit 0
}

$deadline = (Get-Date).AddMinutes($TimeoutMinutes)
$lastPhase = ""

while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 5
    try {
        $status = Invoke-RestMethod -Method Get -Uri "$base/api/offers/weekly-auto-scan/status"
    }
    catch {
        Write-Warning "[weekly-scan] Status nicht abrufbar: $($_.Exception.Message)"
        continue
    }

    $ws = $status.weeklyScan
    if ($ws.phase -ne $lastPhase) {
        Write-Host "[weekly-scan] Phase: $($ws.phase) — $($ws.message)"
        $lastPhase = $ws.phase
    }

    if (-not $ws.running) {
        if ($ws.phase -eq "done") {
            Write-Host "[weekly-scan] FERTIG: KW $($ws.isoWeek) · $($ws.aiClassifiedCount) per KI · $($ws.fallbackCount) per Regeln."
            exit 0
        }
        if ($ws.phase -eq "cancelled") {
            Write-Warning "[weekly-scan] Abgebrochen: $($ws.message)"
            exit 2
        }
        Write-Warning "[weekly-scan] FEHLER: $($ws.lastError)"
        exit 1
    }
}

Write-Warning "[weekly-scan] Zeitlimit ($TimeoutMinutes min) erreicht — Lauf evtl. noch aktiv. Status manuell prüfen."
exit 3
