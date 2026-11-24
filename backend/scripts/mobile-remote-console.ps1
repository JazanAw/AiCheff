param(
  [string]$BackendUrl = "http://localhost:8787"
)

$ErrorActionPreference = "Stop"

Write-Host "AICheff Expo Console Bridge" -ForegroundColor Cyan
Write-Host "Backend: $BackendUrl" -ForegroundColor DarkCyan
Write-Host ""
Write-Host "Tippe Expo-Kommandos und druecke Enter (z.B. w, r, j, m)." -ForegroundColor Yellow
Write-Host "Beenden mit: exit" -ForegroundColor Yellow
Write-Host ""

while ($true) {
  $inputValue = Read-Host "expo>"
  if ($null -eq $inputValue) {
    continue
  }

  $command = $inputValue.Trim()
  if ($command.Length -eq 0) {
    continue
  }

  if ($command -eq "exit" -or $command -eq "quit") {
    break
  }

  try {
    $body = @{ input = $command } | ConvertTo-Json -Compress
    $response = Invoke-RestMethod -Method POST -Uri "$BackendUrl/api/system/mobile/input" -Body $body -ContentType "application/json"
    if ($response -and $response.ok) {
      Write-Host "Gesendet: $command" -ForegroundColor Green
    } else {
      Write-Host "Antwort: $($response | ConvertTo-Json -Compress)"
    }
  } catch {
    Write-Host "Fehler: $($_.Exception.Message)" -ForegroundColor Red
  }
}

Write-Host "Konsole beendet." -ForegroundColor DarkGray
