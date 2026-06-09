#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/personal-vault}"

cd "$APP_DIR"
git pull --ff-only

python3 -m venv .venv
.venv/bin/python -m pip install -r backend/requirements.txt

cd frontend
npm ci
npm run build

sudo systemctl restart personal-vault
sudo systemctl reload nginx
