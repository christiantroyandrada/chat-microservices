#!/usr/bin/env bash
set -euo pipefail

ARTIFACTS_DIR=${1:-./artifacts}
OUT=${2:-coverage/combined-lcov.info}

mkdir -p "$(dirname "$OUT")"
temporary=$(mktemp "${OUT}.XXXXXX")
trap 'rm -f "$temporary"' EXIT

for svc in chat-service notification-service user-service; do
  file="$ARTIFACTS_DIR/lcov-$svc/lcov.info"
  if [ ! -s "$file" ]; then
    echo "Missing or empty coverage for $svc: $file" >&2
    exit 1
  fi

  sources=0
  while IFS= read -r line || [ -n "$line" ]; do
    if [[ "$line" == SF:* ]]; then
      source=${line#SF:}
      source=${source#./}
      source=${source#build/}
      if [[ "$source" == src/* || "$source" == tests/* ]]; then source="$svc/$source"; fi
      case "$source" in
        *'/../'*|*'/./'*|*'/..'|*'/.' ) echo "Invalid coverage source: $source" >&2; exit 1 ;;
      esac
      if [[ "$source" != "$svc/src/"* && "$source" != "$svc/tests/"* ]] || [ ! -f "$source" ]; then
        echo "Unresolved coverage source for $svc: $source" >&2
        exit 1
      fi
      line="SF:$source"
      sources=$((sources + 1))
    fi
    printf '%s\n' "$line" >> "$temporary"
  done < "$file"

  if [ "$sources" -eq 0 ]; then
    echo "No source records in coverage for $svc" >&2
    exit 1
  fi
  printf '\n' >> "$temporary"
done

mv "$temporary" "$OUT"
