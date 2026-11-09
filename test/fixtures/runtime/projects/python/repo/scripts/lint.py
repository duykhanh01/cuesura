import pathlib
import sys

bad = []
for root in ("src", "tests"):
    for path in pathlib.Path(root).rglob("*.py"):
        for i, line in enumerate(path.read_text().split("\n"), 1):
            if line != line.rstrip():
                bad.append(f"{path}:{i}: trailing whitespace")
for b in bad:
    print(b, file=sys.stderr)
sys.exit(1 if bad else 0)
