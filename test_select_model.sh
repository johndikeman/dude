#!/usr/bin/env bash
# test_select_model.sh — unit-test the select_model helper in install-rpi-llm.sh
set -euo pipefail
cd "$(dirname "$0")"

fail=0
# extract only helpers (skip main) so sourcing doesn't run main
eval "$(sed -n '/^log()/,/^# --- main/p' scripts/install-rpi-llm.sh | head -n -2)"

check() {
  local ram="$1" want="$2"
  local got
  got=$(select_model "$ram")
  if [ "$got" != "$want" ]; then
    echo "FAIL: ram=${ram}mb expected $want got $got"
    fail=1
  else
    echo "ok: ram=${ram}mb -> $got"
  fi
}

check 8192 "qwen3:1.7b"
check 7000 "qwen3:1.7b"
check 6999 "qwen3:0.6b"
check 4096 "qwen3:0.6b"
check 3000 "qwen3:0.6b"
check 1024 "qwen3:0.6b"
check 512  "qwen3:0.6b"

# syntax check the whole script
bash -n scripts/install-rpi-llm.sh

# integration: run main() with stubbed curl/ollama/sudo so no real install happens
stubdir=$(mktemp -d)
cat > "$stubdir/curl" <<'EOF'
#!/usr/bin/env bash
case "${*}" in
  *11434*api/generate*) echo '{"response":"ok"}'; exit 0;;
  *11434*) echo "Ollama is running"; exit 0;;
esac
exit 0
EOF
cat > "$stubdir/ollama" <<'EOF'
#!/usr/bin/env bash
echo "ollama stub"
EOF
cat > "$stubdir/sudo" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$stubdir"/*
if PATH="$stubdir:$PATH" bash scripts/install-rpi-llm.sh > "$stubdir/out.txt" 2>&1 && grep -q 'qwen3:1.7b' "$stubdir/out.txt"; then
  echo "ok: stubbed main() flow completed and picked the right model"
else
  echo "FAIL: stubbed main() flow did not complete correctly"
  fail=1
fi
rm -rf "$stubdir"

if [ "$fail" -ne 0 ]; then echo "FAILURES"; exit 1; fi
echo "all select_model tests passed"
