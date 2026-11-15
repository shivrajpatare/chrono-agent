#!/usr/bin/env bash
# Chrono Agent - One-Click Launcher for macOS / Linux

set -e

echo "=========================================="
echo "    Launching Chrono Agent (macOS/Linux)  "
echo "=========================================="

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 1. Check for backend/.env
if [ ! -f "backend/.env" ]; then
    echo "[!] backend/.env not found. Copying .env.example to backend/.env..."
    cp .env.example backend/.env
    echo "[!] Please configure your GROQ_API_KEY in backend/.env and re-run."
    exit 1
fi

# 2. Check/Setup Backend Python Virtual Environment
if [ ! -d "backend/.venv" ]; then
    echo "[*] Creating Python virtual environment in backend/.venv..."
    python3 -m venv backend/.venv
    echo "[*] Installing backend dependencies..."
    backend/.venv/bin/pip install --upgrade pip
    backend/.venv/bin/pip install -r backend/requirements.txt
fi

# 3. Check/Setup Frontend Dependencies
if [ ! -d "frontend/node_modules" ]; then
    echo "[*] Installing frontend dependencies (npm install)..."
    (cd frontend && npm install)
fi

# Cleanup handler for graceful shutdown on Ctrl+C (SIGINT / SIGTERM)
cleanup() {
    echo ""
    echo "[*] Stopping Chrono Agent services..."
    if [ -n "$BACKEND_PID" ]; then
        kill "$BACKEND_PID" 2>/dev/null || true
    fi
    if [ -n "$FRONTEND_PID" ]; then
        kill "$FRONTEND_PID" 2>/dev/null || true
    fi
    echo "[✓] All processes stopped cleanly."
    exit 0
}
trap cleanup SIGINT SIGTERM EXIT

# 4. Start Background Processes
echo "[*] Starting FastAPI Backend on http://127.0.0.1:8000..."
(cd backend && source .venv/bin/activate && uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload) &
BACKEND_PID=$!

echo "[*] Starting React + Vite Frontend on http://localhost:5173..."
(cd frontend && npm run dev) &
FRONTEND_PID=$!

sleep 3

# 5. Open Browser (macOS / Linux)
if command -v open > /dev/null 2>&1; then
    open "http://localhost:5173"
elif command -v xdg-open > /dev/null 2>&1; then
    xdg-open "http://localhost:5173"
fi

echo "=========================================="
echo " Chrono Agent is LIVE!"
echo " Backend:  http://127.0.0.1:8000"
echo " Frontend: http://localhost:5173"
echo " Press Ctrl+C in this console to stop all processes."
echo "=========================================="

wait

