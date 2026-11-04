#!/bin/sh
# Đóng băng origin/main thành một release dogfood rồi trỏ `current` và skill cá nhân sang đó.
# Không restart daemon. Xem docs/dogfooding.md.
set -eu

ROOT="${CUSR_DOGFOOD_DIR:-$HOME/cuesura-dogfood}"
REPO="$ROOT/repo"
# Cùng Node với daemon và các wrapper trong ~/.local/bin.
PATH="$ROOT/tools/node/bin:$PATH"
export PATH
REF=origin/main
ALLOW_UNPROVEN=0
for arg in "$@"; do
  case "$arg" in
    --allow-unproven) ALLOW_UNPROVEN=1 ;;
    *) REF="$arg" ;;
  esac
done

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

# Hỏi chính release mới: nó từ chối config hoặc harness record nào thì đổi `current` sẽ làm task mới không chạy được.
# Release cũ chưa có lệnh này vẫn phải lùi về được.
if ! grep -q check-records "$RELEASE/dist/cli/cusr-runner.js"; then
  echo "Bỏ qua check-records: release $SHA chưa có lệnh này." >&2
elif ! node "$RELEASE/dist/cli/cusr-runner.js" check-records \
  --config "$ROOT/config.yaml" --data-dir "$ROOT/data"; then
  if [ "$ALLOW_UNPROVEN" -ne 1 ]; then
    echo "Chưa đổi current. Sửa config, hoặc chứng minh lại từng harness bị báo rồi chạy lại script:" >&2
    echo "  cd $ROOT && node $RELEASE/dist/cli/cusr-runner.js setup-harness --config config.yaml --data-dir data \\" >&2
    echo "    --harness <tên> --from prove-harness --model <model rẻ> --effort low --out evidence-<tên>.json" >&2
    echo "Pin cần đổi thì chạy đủ tham số pin theo docs/dogfooding.md, thêm --force." >&2
    echo "--allow-unproven đổi current dù task mới sẽ bị chặn." >&2
    echo "Chứng minh lại đổi manifest: task đang chạy sẽ chờ manifest_changed, chạy cusr task recheck để nhận manifest mới." >&2
    exit 1
  fi
  echo "Cảnh báo: đổi current dù release này chưa chấp nhận config hoặc harness record." >&2
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
