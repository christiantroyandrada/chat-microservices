#!/usr/bin/env bash
set -euo pipefail

ARTIFACTS_DIR=${1:-./artifacts}
OUT=${2:-coverage/combined-lcov.info}

mkdir -p "$(dirname "$OUT")"
: > "$OUT"

# Known services in this repo. If a file path contains one of these names,
# we'll use it as the prefix for SF: entries. Otherwise we fallback to the
# LCOV file's parent directory name.
known_services=("chat-service" "notification-service" "user-service")

found=0
while IFS= read -r -d '' file; do
  echo "Processing $file" >&2
  svc=""
  for s in "${known_services[@]}"; do
    if [[ "$file" == *"/$s/"* || "$file" == *"/$s" ]]; then
      svc="$s"
      break
    fi
  done

  if [ -z "$svc" ]; then
    svc=$(basename "$(dirname "$file")")
  fi

  if [ -z "$svc" ]; then
    echo "No service derived for $file; appending as-is" >&2
    cat "$file" >> "$OUT"
  else
    # Rewrite SF: lines so that paths beginning with src/ or ./src/ or build/src/
    # become prefixed with the service folder (e.g. SF:chat-service/src/...).
    # If the SF path already contains the service prefix we leave it unchanged.
    awk -v svc="$svc" '
      /^SF:/ {
        path=substr($0,4)
        gsub(/^\.\//, "", path)
        if (path ~ ("^" svc "/")) {
          print $0
        } else if (path ~ "^src/" || path ~ "^build/src/") {
          print "SF:" svc "/" path
        } else if (path ~ "/src/") {
          # Path contains a /src/ somewhere (e.g. some/dir/src/...). Leave as-is
          print $0
        } else {
          # Default fallback: prefix the path
          print "SF:" svc "/" path
        }
        next
      }
      { print $0 }
    ' "$file" >> "$OUT"
  fi

  echo "" >> "$OUT"
  found=1
done < <(find "$ARTIFACTS_DIR" -type f -name "lcov.info" -print0)

if [ "$found" -eq 0 ]; then
  echo "WARNING: No LCOV files found under $ARTIFACTS_DIR" >&2
else
  echo "Normalized combined LCOV written to $OUT" >&2
fi

exit 0
