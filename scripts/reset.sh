#!/usr/bin/env bash
# Returns the demo to a clean slate: stops the orchestrator and actor server, wipes all actor
# state, restarts the server, and warms every actor. Relay agents and tokens are kept.
# Start the orchestrator again afterwards: bun src/orchestrator.ts
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${DURABLE_ACTORS_PORT:-7100}"
LOG="${TMPDIR:-/tmp}/credit-bureau-actors.log"
cd "$ROOT"

echo "Stopping orchestrator"
pkill -f 'src/orchestrator.ts' || true

echo "Stopping actor server on port $PORT"
PIDS="$(lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN || true)"
if [ -n "$PIDS" ]; then kill $PIDS; fi
for _ in $(seq 1 40); do
    lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null || break
    sleep 0.25
done
if lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null; then
    echo "Actor server did not stop on port $PORT" >&2
    exit 1
fi

echo "Wiping $ROOT/.durable-actors"
rm -rf "$ROOT/.durable-actors"

echo "Starting actor server (log: $LOG)"
# --no-watch matters: hot reloads left alarms firing about 127s late, which breaks the default demo.
nohup bunx durable-actors dev --no-watch >"$LOG" 2>&1 &
disown
for _ in $(seq 1 240); do
    if lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null && grep -q 'Ready' "$LOG"; then break; fi
    sleep 0.5
done
if ! grep -q 'Ready' "$LOG"; then
    echo "Actor server did not become ready. See $LOG" >&2
    exit 1
fi

echo "Warming actors"
bun scripts/warm.ts
echo "Clean slate ready. Start the orchestrator with: bun src/orchestrator.ts"
