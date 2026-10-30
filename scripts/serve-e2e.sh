#!/usr/bin/env bash
# Start a throwaway Django server for Playwright e2e on 127.0.0.1:5192
# (playwright.config.mjs passes E2E_PORT; 5192 is only the manual-run default).
# Uses its own SQLite file (e2e.sqlite3) so the dev database is never touched.
set -euo pipefail
cd "$(dirname "$0")/.."

# Read the port before .env is sourced, so a stray E2E_PORT there cannot make the server
# listen somewhere other than where Playwright is waiting.
PORT="${E2E_PORT:-5192}"
# E2E_HOST=0.0.0.0 lets a phone on the same Wi-Fi reach it (via a Windows port proxy).
HOST="${E2E_HOST:-127.0.0.1}"
if [ -f ./.env ]; then
  set -a; . ./.env; set +a
fi
export DEBUG=1
export DEMO_PASSWORD=demo-password-123
# settings.py already reads SQLITE_PATH for the SQLite file; point it at the e2e DB.
export SQLITE_PATH="$PWD/e2e-$PORT.sqlite3"  # one DB per port: parallel runs never share a file
unset MYSQL_HOST

PYTHON="${PYTHON:-.venv/bin/python}"
rm -f "$SQLITE_PATH"
"$PYTHON" manage.py migrate --noinput
"$PYTHON" manage.py seed_demo
exec "$PYTHON" manage.py runserver "$HOST:$PORT" --noreload
