#!/bin/bash
# macOS launcher for Game Night Launcher
# Double-click this file in Finder to start the server

cd "$(dirname "$0")"

echo "================================================"
echo "            GAME NIGHT LAUNCHER"
echo "================================================"
echo ""

# Check if Node.js is installed
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed or not in PATH."
  echo "Install Node.js from https://nodejs.org/ then re-run this file."
  echo ""
  read -n 1 -s -r -p "Press any key to close..."
  exit 1
fi

# Check for dependencies
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
    echo ""
fi

# Kill any process using port 3000
echo "Checking for processes on port 3000..."
PORT_PID=$(lsof -ti:3000)
if [ ! -z "$PORT_PID" ]; then
    echo "Killing existing process on port 3000 (PID: $PORT_PID)..."
    kill -9 $PORT_PID
    sleep 1
fi

# Start server in foreground (shows logs)
echo "Starting Game Launcher server..."
node server.js &
SERVER_PID=$!

# Give the server a moment to boot
sleep 2

# Open host screen in default browser
open "http://localhost:3000/"

# Wait for server process (keeps terminal open and shows logs)
wait $SERVER_PID
