#!/usr/bin/env bash
# Mechanical brief/archive operations; Python 3 stdlib only.
set -euo pipefail
exec python3 "$(dirname "$0")/task.py" "$@"
