#!/bin/bash

echo "🚀 Starting Anthropic to OpenAI Proxy Server..."
echo ""

# Load environment variables if present
if [ -f ".env" ]; then
    set -a
    source .env
    set +a
fi

# Default port if not provided
export PORT="${PORT:-9095}"

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

# Start the server with bun and load .env file
bun run start 