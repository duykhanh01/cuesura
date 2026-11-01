#!/bin/sh
# Đóng băng origin/main thành một release dogfood rồi trỏ `current` và skill cá nhân sang đó.
# Không restart daemon. Xem docs/dogfooding.md.
set -eu

ROOT="${CUSR_DOGFOOD_DIR:-$HOME/cuesura-dogfood}"
REPO="$ROOT/repo"
REF="${1:-origin/main}"

git -C "$REPO" fetch -q origin --prune
SHA=$(git -C "$REPO" rev-parse --short=12 "$REF^{commit}")
RELEASE="$ROOT/releases/$SHA"

if [ ! -f "$RELEASE/dist/cli/cusr.js" ]; then
  TMP=$(mktemp -d "$ROOT/releases/.tmp.XXXXXX")
  trap 'rm -rf "$TMP"' EXIT
  git -C "$REPO" archive "$SHA" | tar -x -C "$TMP"
  (cd "$TMP" && pnpm install --frozen-lockfile && pnpm build)
  rm -rf "$RELEASE"
  mv "$TMP" "$RELEASE"
  trap - EXIT
fi

ln -sfn "releases/$SHA" "$ROOT/current.new"
mv -T "$ROOT/current.new" "$ROOT/current"

for dir in "$HOME/.claude/skills/cusr" "$HOME/.codex/skills/cusr"; do
  rm -rf "$dir"
  mkdir -p "$dir"
  cp -R "$RELEASE/skills/cusr/." "$dir/"
done

echo "current -> releases/$SHA"
echo "Owner restart: systemctl --user restart cusrd.service"
