#!/bin/sh
# Start Ollama, then make sure the configured models are present (pulled once into the persistent disk).
set -eu
ollama serve &
pid=$!
i=0
until ollama list >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 60 ]; then echo "ollama did not start" >&2; exit 1; fi
  sleep 1
done
for m in "$ELEVATE_LLM_MODEL" "$ELEVATE_EMBED_MODEL"; do
  if ollama list | awk 'NR>1 {print $1}' | grep -qx -e "$m" -e "$m:latest"; then
    echo "model present: $m"
  else
    echo "pulling model: $m"
    ollama pull "$m"
  fi
done
echo "ollama ready"
wait "$pid"
