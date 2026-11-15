# Chrono Agent - One-Click Launcher for Windows PowerShell
$ErrorActionPreference = "Stop"

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "     Launching Chrono Agent (Windows)     " -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

# 1. Check for backend/.env
if (-not (Test-Path "backend\.env")) {
    Write-Host "[!] backend\.env not found. Copying .env.example to backend\.env..." -ForegroundColor Yellow
    Copy-Item ".env.example" "backend\.env"
    Write-Host "[!] Please configure your GROQ_API_KEY in backend\.env and re-run." -ForegroundColor Red
    exit 1
}

# 2. Check/Setup Backend Python Virtual Environment
if (-not (Test-Path "backend\.venv")) {
    Write-Host "[*] Creating Python virtual environment in backend\.venv..." -ForegroundColor Green
    python -m venv backend\.venv
    Write-Host "[*] Installing backend dependencies..." -ForegroundColor Green
    & backend\.venv\Scripts\python.exe -m pip install --upgrade pip
    & backend\.venv\Scripts\python.exe -m pip install -r backend\requirements.txt
}

# 3. Check/Setup Frontend Dependencies
if (-not (Test-Path "frontend\node_modules")) {
    Write-Host "[*] Installing frontend dependencies (npm install)..." -ForegroundColor Green
    npm --prefix frontend install
}

# 4. Start Background Processes
Write-Host "`n[*] Starting FastAPI Backend at http://127.0.0.1:8000..." -ForegroundColor Green
$backendProcess = Start-Process -FilePath "backend\.venv\Scripts\python.exe" `
    -ArgumentList "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8000", "--reload" `
    -WorkingDirectory "backend" `
    -PassThru

Write-Host "[*] Starting React + Vite Frontend at http://localhost:5173..." -ForegroundColor Green
$frontendProcess = Start-Process -FilePath "cmd.exe" `
    -ArgumentList "/c", "npm run dev" `
    -WorkingDirectory "frontend" `
    -PassThru

# Give servers 3 seconds to spin up
Start-Sleep -Seconds 3

# 5. Open Browser
Write-Host "[*] Opening browser at http://localhost:5173..." -ForegroundColor Cyan
Start-Process "http://localhost:5173"

Write-Host "`n==========================================" -ForegroundColor Green
Write-Host " Chrono Agent is LIVE!" -ForegroundColor Green
Write-Host " Backend:  http://127.0.0.1:8000" -ForegroundColor Green
Write-Host " Frontend: http://localhost:5173" -ForegroundColor Green
Write-Host " Press Ctrl+C in this console to stop all processes." -ForegroundColor Yellow
Write-Host "==========================================" -ForegroundColor Green

try {
    while ($true) {
        if ($backendProcess.HasExited) {
            Write-Host "[!] Backend server exited unexpectedly." -ForegroundColor Red
            break
        }
        if ($frontendProcess.HasExited) {
            Write-Host "[!] Frontend server exited unexpectedly." -ForegroundColor Red
            break
        }
        Start-Sleep -Seconds 1
    }
}
finally {
    Write-Host "`n[*] Stopping Chrono Agent services..." -ForegroundColor Yellow
    if ($backendProcess -and -not $backendProcess.HasExited) {
        Stop-Process -Id $backendProcess.Id -Force
    }
    if ($frontendProcess -and -not $frontendProcess.HasExited) {
        # Kill cmd and tree
        Stop-Process -Id $frontendProcess.Id -Force
    }
    Write-Host "[OK] All processes stopped cleanly." -ForegroundColor Green
}

