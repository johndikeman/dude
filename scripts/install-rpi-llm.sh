#!/usr/bin/env bash
# install-rpi-llm.sh — install a local llm stack on a raspberry pi (or any linux box).
#
# adapts to available resources (ram is the binding constraint on a pi 4):
#   >= 7gb  -> qwen3:1.7b   (comfortable, q4_k_m)
#   >= 3gb  -> qwen3:0.6b   (practical floor for 4gb pi)
#   < 3gb   -> qwen3:0.6b   (tight but works; warn)
#
# what it does:
#   1. detects arm + ram, picks a model
#   2. installs ollama (official script) if not present
#   3. pulls the chosen model
#   4. prints a pi-harness models.json snippet pointing at the local api
#
# usage:
#   curl -fsSL <url>/install-rpi-llm.sh | bash          # or run locally
#   MODEL=qwen3:1.7b ./install-rpi-llm.sh               # force a model
#
set -euo pipefail

# --- helpers ---------------------------------------------------------------

log() { echo "[rpi-llm] $*"; }
die() { echo "[rpi-llm] ERROR: $*" >&2; exit 1; }

# pick the best model for this box based on total ram in mb.
# exported for testing.
select_model() {
  local ram_mb="$1"
  if [ "$ram_mb" -ge 7000 ]; then
    echo "qwen3:1.7b"
  elif [ "$ram_mb" -ge 3000 ]; then
    echo "qwen3:0.6b"
  else
    echo "qwen3:0.6b"
  fi
}

get_ram_mb() {
  awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo
}

# --- main ------------------------------------------------------------------

main() {
  if [ "$(uname -m)" != "aarch64" ] && [ "$(uname -m)" != "armv7l" ]; then
    log "warning: not an arm machine ($(uname -m)); continuing anyway (fine for a vps/test)"
  fi

  RAM_MB="$(get_ram_mb)"
  [ -n "$RAM_MB" ] && [ "$RAM_MB" -gt 0 ] || die "could not read MemTotal from /proc/meminfo"
  MODEL="${MODEL:-$(select_model "$RAM_MB")}"

  log "ram: ${RAM_MB}mb -> model: $MODEL"
  if [ "$RAM_MB" -lt 3000 ]; then
    log "warning: under 3gb ram — expect tight memory; consider a swapfile"
  fi

  # 1. ollama
  if command -v ollama >/dev/null 2>&1; then
    log "ollama already installed: $(ollama --version 2>/dev/null || echo unknown)"
  else
    log "installing ollama (official install script)..."
    curl -fsSL https://ollama.com/install.sh | sh
  fi

  # 2. make sure the daemon is up
  if ! curl -fsS http://localhost:11434/ >/dev/null 2>&1; then
    log "starting ollama daemon (systemctl)..."
    sudo systemctl enable --now ollama || true
    for i in $(seq 1 15); do
      curl -fsS http://localhost:11434/ >/dev/null 2>&1 && break
      sleep 1
    done
    curl -fsS http://localhost:11434/ >/dev/null 2>&1 || die "ollama daemon did not come up on :11434"
  fi
  log "ollama daemon is up"

  # 3. pull the model
  log "pulling $MODEL (this can take a few minutes)..."
  ollama pull "$MODEL"
  log "pulled $MODEL"

  # 4. quick smoke test
  log "smoke test: asking for one token..."
  RESP=$(curl -fsS http://localhost:11434/api/generate -d "{\"model\":\"$MODEL\",\"prompt\":\"say ok\",\"stream\":false}")
  echo "$RESP" | grep -q response || die "smoke test got unexpected response: $RESP"
  log "smoke test ok: $(echo "$RESP" | head -c 200)"

  # 5. print harness config snippet
  log "done. point your coding agent at the local model with this snippet in models.json:"
  cat <<EOF

  {
    "providers": [
      {
        "name": "local-ollama",
        "baseUrl": "http://localhost:11434/v1",
        "apiKey": "none",
        "models": [
          {
            "id": "$MODEL",
            "contextWindow": 8192,
            "maxTokens": 2048
          }
        ]
      }
    ]
  }

EOF
  log "tip: keep contextWindow + maxTokens small so the kv cache fits in ram"
}

main "$@"
