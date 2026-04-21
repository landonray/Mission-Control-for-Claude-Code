#!/bin/bash
set -e

# ============================================================
# setup.sh — Auto-configure Command Center before starting
#
# Installs dependencies and creates .env if missing.
# Reads NEON_API_KEY from ~/setup-tools/.env to fetch the
# database connection string automatically.
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SETUP_TOOLS_ENV="$HOME/setup-tools/.env"

# --- Step 1: Install dependencies if needed ---
if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
  echo "Installing dependencies..."
  npm install --prefix "$SCRIPT_DIR"
fi

# --- Step 2: Skip Neon auto-setup when DATABASE_URL is already in the environment.
# On managed hosts (Railway, Fly, etc.) env vars come from the platform, not a .env
# file. Without this check setup.sh would fail on those hosts trying to read
# ~/setup-tools/.env and make API calls it cannot make from a build container.
if [ -n "$DATABASE_URL" ]; then
  echo "DATABASE_URL already present in environment, skipping Neon auto-setup."
  exit 0
fi

# --- Step 3: Create .env if missing ---
if [ -f "$SCRIPT_DIR/.env" ]; then
  exit 0
fi

echo "No .env found — creating one..."

# Load NEON_API_KEY from setup-tools
NEON_API_KEY=""
if [ -f "$SETUP_TOOLS_ENV" ]; then
  NEON_API_KEY=$(grep '^NEON_API_KEY=' "$SETUP_TOOLS_ENV" | cut -d '=' -f2-)
fi

if [ -z "$NEON_API_KEY" ]; then
  echo "Error: NEON_API_KEY not found in $SETUP_TOOLS_ENV"
  echo "Add it there or create .env manually with DATABASE_URL."
  exit 1
fi

# Find the command-center project and get its connection string
echo "Fetching database URL from Neon..."

# Get org ID
ORG_ID=$(curl -sf -H "Authorization: Bearer $NEON_API_KEY" \
  "https://console.neon.tech/api/v2/users/me/organizations" \
  | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); \
    const o=JSON.parse(d).organizations[0]; \
    if(o) console.log(o.id); else process.exit(1)")

# Find command-center project
PROJECT_ID=$(curl -sf -H "Authorization: Bearer $NEON_API_KEY" \
  "https://console.neon.tech/api/v2/projects?org_id=$ORG_ID" \
  | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); \
    const p=JSON.parse(d).projects.find(p=>p.name==='command-center'); \
    if(p) console.log(p.id); else process.exit(1)")

if [ -z "$PROJECT_ID" ]; then
  echo "Error: No 'command-center' project found in Neon."
  exit 1
fi

# Get connection URI
DATABASE_URL=$(curl -sf -H "Authorization: Bearer $NEON_API_KEY" \
  "https://console.neon.tech/api/v2/projects/$PROJECT_ID/connection_uri?database_name=neondb&role_name=neondb_owner" \
  | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); \
    console.log(JSON.parse(d).uri)")

if [ -z "$DATABASE_URL" ]; then
  echo "Error: Could not fetch connection string from Neon."
  exit 1
fi

cat > "$SCRIPT_DIR/.env" <<EOF
DATABASE_URL=$DATABASE_URL
NODE_ENV=development
EOF

echo "Created .env with DATABASE_URL from Neon."
