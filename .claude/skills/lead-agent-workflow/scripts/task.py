"""Strict Markdown records, with atomic replacements and repeatable archive recovery."""
import datetime
import fcntl
import os
from pathlib import Path
import re
import sys
import tempfile

ID = re.compile(r"T[1-9][0-9]*(?:\.[1-9][0-9]*)*")
COLUMNS = "Task Parent Phase Outcome Owner Depends Head Reviewed Brief Report Block Next".split()
INDEX = "Task Parent Outcome Archived Evidence History".split()
OUTCOMES = {"merged", "accepted", "handed-off", "cancelled", "superseded"}
PHASES = {"queued", "tracking", "coding", "reported", "reviewing", "fixing", "ready"}
SECTIONS = {
    "coder": ["User request", "Ownership and completion", "Lead instructions", "Read", "Validation and delivery"],
    "reviewer": ["Source requirements", "Review target", "Read", "Findings and delivery"],
    "advisor": ["Question", "Authority", "Constraints", "Read", "Decisions and delivery"],
    "follow-up": ["Delta", "Target", "Decisions", "Read", "Validation and delivery"],
}


def require(ok, message):
    if not ok:
        raise ValueError(message)


def parent(task):
    return task.rsplit(".", 1)[0] if "." in task else "-"


def valid_id(task):
    require(ID.fullmatch(task), f"invalid task ID: {task}")


def atomic(path, content):
    """Flush a complete replacement before rename; never truncate the existing record."""
    fd, name = tempfile.mkstemp(prefix=".task-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as out:
            out.write(content)
            out.flush()
            os.fsync(out.fileno())
        os.replace(name, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def table(columns, rows):
    return "\n".join(["| " + " | ".join(columns) + " |",
                      "| " + " | ".join("---" for _ in columns) + " |"] +
                     ["| " + " | ".join(row[c] for c in columns) + " |" for row in rows])


def parse_table(text, columns):
    lines = text.splitlines()
    require(len(lines) >= 2, "missing Markdown table")
    cells = lambda line: [x.strip() for x in line[1:-1].split("|")]
    require(all(line.startswith("|") and line.endswith("|") for line in lines), "malformed table row")
    require(cells(lines[0]) == columns, "unexpected table columns")
    require(all(re.fullmatch(r":?-{3,}:?", x) for x in cells(lines[1])) and
            len(cells(lines[1])) == len(columns), "malformed table separator")
    rows = []
    for line in lines[2:]:
        values = cells(line)
        require(len(values) == len(columns) and all(values), "empty or extra table cell; use -")
        row = dict(zip(columns, values))
        valid_id(row["Task"])
        require(row["Task"] not in {r["Task"] for r in rows}, "duplicate task")
        require(row["Parent"] == parent(row["Task"]), "invalid parent")
        rows.append(row)
    return rows


def ledger(text):
    require(text.count("## Active tasks\n") == 1, "expected one Active tasks section")
    before, section = text.split("## Active tasks\n")
    match = re.fullmatch(r"\n*(\|[^\n]+\n(?:\|[^\n]+\n)*)(\n[\s\S]*)?", section)
    # Canonical table must be directly below its heading, followed only by other sections.
    require(match, "malformed Active tasks section")
    suffix = match[2] or ""
    require(not suffix.strip() or suffix.lstrip().startswith("## "), "unexpected text after active table")
    rows = parse_table(match[1], COLUMNS)
    for row in rows:
        require(row["Phase"] in PHASES, "invalid phase")
        require(row["Outcome"] in OUTCOMES | {"-"}, "invalid outcome")
        for field in ("Head", "Reviewed"):
            require(row[field] == "-" or re.fullmatch(r"[0-9a-f]{40}", row[field]), f"invalid {field}")
        if row["Depends"] != "-":
            for dependency in row["Depends"].split(","):
                valid_id(dependency.strip())
    return before + "## Active tasks\n", rows, suffix


def reference(run, value):
    path = Path(value)
    return path if path.is_absolute() else run / path


def brief_create(run, task, role):
    valid_id(task)
    require(role in SECTIONS, "unknown role")
    run.mkdir(parents=True, exist_ok=True)
    (run / "briefs").mkdir(exist_ok=True)
    (run / "reports").mkdir(exist_ok=True)
    template = (Path(__file__).resolve().parent.parent / "templates" / f"{role}.md").read_text()
    # Follow-up is a brief shape; update the actual recipient's existing role report.
    content = template.replace("@TASK@", task).replace("@PARENT@", parent(task))
    content = content.replace("@ROLE@", role).replace("@REPORT@", str(run / "reports" / f"{task}-{role}.md"))
    path = run / "briefs" / f"{task}-{role}.md"
    with path.open("x") as out:
        out.write(content)
    print(path)


def brief_check(path):
    content = path.read_text()
    require(not re.search(r"\{\{[A-Z_]+\}\}|@(TASK|PARENT|ROLE|REPORT)@", content), "unfinished placeholder")
    fields = {}
    for key in ("Task", "Parent", "Role", "Revision", "Report"):
        found = re.findall(rf"^{key}: (.+)$", content, re.M)
        require(len(found) == 1, f"expected one {key}")
        fields[key] = found[0].strip()
    valid_id(fields["Task"])
    require(fields["Parent"] == parent(fields["Task"]), "invalid parent")
    require(fields["Role"] in SECTIONS, "unknown role")
    require(re.fullmatch(r"[1-9][0-9]*", fields["Revision"]), "invalid revision")
    report = Path(fields["Report"])
    require(report.is_absolute() and report.parent.is_dir() and report.suffix == ".md" and
            (not report.exists() or report.is_file()), "report must be an absolute Markdown file in an existing directory")
    headings = re.split(r"^## (.+)\n", content, flags=re.M)
    names = headings[1::2]
    require(len(names) == len(set(names)), "duplicate section")
    bodies = dict(zip(names, headings[2::2]))
    for name in SECTIONS[fields["Role"]]:
        require(name in bodies and bodies[name].strip() not in ("", "-", "none"), f"missing content: {name}")
    for line in bodies["Read"].strip().splitlines():
        require(line.startswith("- "), "Read entries must be bullets")
        item = line[2:].strip()
        if item == "none":
            require(bodies["Read"].strip() == "- none", "none cannot accompany reading paths")
            continue
        location, sep, purpose = item.partition(" — ")
        require(sep and purpose.strip(), "Read entry needs a purpose after an em dash")
        if location.startswith("https://"):
            require(re.fullmatch(r"https://[^/\s]+(?:/\S*)?", location), "invalid source URL")
        else:
            source = Path(location.split("#", 1)[0])
            require(source.is_absolute() and source.is_file(), f"missing readable source: {source}")
    print(f"OK {path} (~{(len(content) + 3) // 4} tokens, character estimate only; clarity not assessed)")


def archived_entries(history):
    entries = {}
    if not history.exists():
        return "# Task history\n", entries
    content = history.read_text()
    require(content.startswith("# Task history\n"), "malformed history header")
    require(content == "# Task history\n" or content.startswith("# Task history\n\n## "),
            "malformed history body")
    for part in content.split("\n## ")[1:]:
        task, body = part.split("\n", 1)
        valid_id(task)
        require(task not in entries, "duplicate history entry")
        stamp, blank, raw = body.split("\n", 2)
        require(stamp.startswith("Archived: ") and blank == "", "malformed history entry")
        rows = parse_table(raw.strip(), COLUMNS)
        require(len(rows) == 1 and rows[0]["Task"] == task, "invalid history record")
        entries[task] = (stamp.removeprefix("Archived: "), rows[0])
    return content, entries


def archive(run, task):
    valid_id(task)
    path = run / "ledger.md"
    prefix, rows, suffix = ledger(path.read_text())
    directory = run / "archive"
    directory.mkdir(exist_ok=True)
    history = directory / f"{task.split('.')[0]}.md"
    content, entries = archived_entries(history)
    index_path = directory / "index.md"
    indexed = []
    if index_path.exists():
        index_text = index_path.read_text()
        require(index_text.startswith("# Archive index\n\n"), "malformed archive index")
        indexed = parse_table(index_text.removeprefix("# Archive index\n\n").strip(), INDEX)
    selected = [r for r in rows if r["Task"] == task or r["Task"].startswith(task + ".")]
    if not selected:
        require(task in entries and task in {r["Task"] for r in indexed}, "task not found")
        print(history)
        return
    require(any(r["Task"] == task for r in selected), "parent missing from active tasks")
    for row in selected:
        require(row["Outcome"] in OUTCOMES and row["Block"] == "-", "task or child is still live/blocked")
        optional_records = row["Phase"] == "tracking" or (
            row["Phase"] == "queued" and row["Outcome"] in {"cancelled", "superseded"})
        for field in ("Brief", "Report"):
            if row[field] == "-":
                require(optional_records and row["Next"] != "-", f"missing {field} record or closure explanation")
            else:
                require(reference(run, row[field]).is_file(), f"missing {field} record")
    stamp = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    for row in selected:
        key = row["Task"]
        if key in entries:
            require(entries[key][1] == row, f"history conflicts with ledger: {key}")
        else:
            entries[key] = (stamp, row)
            content += f"\n## {key}\nArchived: {stamp}\n\n" + table(COLUMNS, [row]) + "\n"
    # History first, then index, then remove active rows: retry can recover at either boundary.
    atomic(history, content)
    for row in selected:
        key = row["Task"]
        evidence = row["Next"] if row["Report"] == "-" else (
            f"[report]({os.path.relpath(reference(run, row['Report']), directory)})")
        record = dict(Task=key, Parent=row["Parent"], Outcome=row["Outcome"], Archived=entries[key][0],
                      Evidence=f"{row['Head']}; {evidence}",
                      History=f"[{key}]({history.name}#{key.lower().replace('.', '')})")
        old = next((r for r in indexed if r["Task"] == key), None)
        require(old is None or old == record, f"index conflicts with ledger: {key}")
        if old is None:
            indexed.append(record)
    atomic(index_path, "# Archive index\n\n" + table(INDEX, indexed) + "\n")
    remaining = [r for r in rows if r not in selected]
    # Preserve the actual continuation; add stable child IDs to its progress note once.
    for row in remaining:
        if row["Task"] == parent(task):
            marker = f"archived {task}"
            if marker not in row["Next"].split("; "):
                row["Next"] += "; " + marker
    atomic(path, prefix + table(COLUMNS, remaining) + "\n" + suffix)
    print(history)


def main(args):
    if len(args) == 3 and args[:2] == ["brief", "check"]:
        brief_check(Path(args[2]).resolve())
        return
    create = len(args) == 5 and args[:2] == ["brief", "create"]
    do_archive = len(args) == 3 and args[0] == "archive"
    require(create or do_archive, "usage: task.sh brief create RUN TASK ROLE | brief check PATH | archive RUN TASK")
    run = Path(args[2] if create else args[1]).resolve()
    require(create or run.is_dir(), "run directory missing")
    run.mkdir(parents=True, exist_ok=True)
    # flock releases on process exit, including abrupt interruption; no stale lock cleanup needed.
    with (run / ".task.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError("another task helper holds the run lock") from None
        if create:
            brief_create(run, args[3], args[4])
        else:
            archive(run, args[2])


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except (ValueError, OSError) as error:
        sys.exit(f"error: {error}")
