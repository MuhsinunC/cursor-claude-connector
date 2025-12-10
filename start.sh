#!/bin/bash

echo "🚀 Starting Anthropic to OpenAI Proxy Server..."
echo ""

# Config
NGROK_BIN="${NGROK_BIN:-ngrok}"
NGROK_DOMAIN="${NGROK_DOMAIN:-}"
NGROK_ENABLED="${NGROK_ENABLED:-true}"
NGROK_CONFIG_DEFAULT="$HOME/Library/Application Support/ngrok/ngrok.yml"
NGROK_CONFIG="${NGROK_CONFIG:-$NGROK_CONFIG_DEFAULT}"

# Skip ngrok when running on Vercel or when explicitly disabled
if [ -n "${VERCEL:-}" ]; then
  NGROK_ENABLED="false"
fi

# Load environment variables if present
if [ -f ".env" ]; then
    set -a
    source .env
    set +a
fi

# Default port if not provided
export PORT="${PORT:-9095}"

# Validate ngrok setup if enabled
check_ngrok() {
  if [ "$NGROK_ENABLED" != "true" ]; then
    return 1
  fi

  if ! command -v "$NGROK_BIN" >/dev/null 2>&1; then
    echo "⚠️  ngrok not found. Install it (brew install ngrok) or set NGROK_ENABLED=false."
    return 1
  fi

  if [ ! -f "$NGROK_CONFIG" ]; then
    echo "⚠️  ngrok config not found at '$NGROK_CONFIG'. Run: ngrok config add-authtoken <TOKEN>"
    return 1
  fi

  if ! grep -q "authtoken" "$NGROK_CONFIG"; then
    echo "⚠️  ngrok authtoken not set in '$NGROK_CONFIG'. Run: ngrok config add-authtoken <TOKEN>"
    return 1
  fi

  if [ -z "$NGROK_DOMAIN" ]; then
    echo "⚠️  NGROK_DOMAIN is not set. Set it to your reserved domain (e.g., example.ngrok-free.dev) or set NGROK_ENABLED=false."
    return 1
  fi

  return 0
}

NGROK_PID=""
start_ngrok() {
  if ! check_ngrok; then
    return
  fi

  echo "🌐 Starting ngrok tunnel on https://$NGROK_DOMAIN -> http://localhost:${PORT}"
  "$NGROK_BIN" http --domain="$NGROK_DOMAIN" "$PORT" >/tmp/ngrok.log 2>&1 &
  NGROK_PID=$!
  echo "🔗 ngrok PID: $NGROK_PID (logs: /tmp/ngrok.log)"
}

stop_ngrok() {
  if [ -n "$NGROK_PID" ]; then
    echo "🛑 Stopping ngrok (PID $NGROK_PID)..."
    kill "$NGROK_PID" >/dev/null 2>&1 || true
    NGROK_PID=""
  fi
}

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    bun install
    echo ""
fi

echo "🔨 Building project..."
bun run build


echo "🌐 Server starting on http://localhost:${PORT}"
echo "📚 API Documentation: http://localhost:${PORT}/"
echo "🔐 OAuth Login: http://localhost:${PORT}/auth/login"
echo ""
echo "Press Ctrl+C to stop the server"
echo ""

start_ngrok

cleanup() {
  stop_ngrok
  if [ -n "$SERVER_PID" ]; then
    echo "🛑 Stopping server (PID $SERVER_PID)..."
    kill "$SERVER_PID" >/dev/null 2>&1 || true
  fi
  exit 0
}

trap cleanup INT TERM

# Start the server with bun and keep PID
bun run start &
SERVER_PID=$!
wait $SERVER_PID
cleanup