# TUI interface

General rules for every screen of `cusr`. When changing a view, keep the points below; to change them, change them here first.

## Colors by role

Views refer to role names in `views/theme.ts` and do not write colors themselves. `test/unit/tui/theme.test.ts` enforces this.

| Role | Meaning | Used for |
| --- | --- | --- |
| `GOOD`, `GOOD_STRONG` | Ran, passed | Stage done, gate passed, daemon healthy |
| `BAD`, `BAD_STRONG` | Error, rejected | Stage failed, tool error |
| `NOTICE`, `WARN` | Paused or needs reading, not broken | Waiting, work that needs the user, stale data |
| `STOPPED`, `STOPPED_STRONG` | Cancelled | Task cancelled; orange because yellow already means waiting |
| `ACTIVE` | Running, cursor | Current stage, `◂ reading` |
| `FOCUS` | Where the eye should stop | Selected row, keys, main heading |
| `DIM`, `BOLD` (`views/ink.ts`) | Text weight | Secondary, emphasis |
| `FAINT` | Absent | Stage skipped by mode |

## Two signals per state

Exactly one color signal plus one colorless signal (symbol or text). Do not add a third signal. With `NO_COLOR`, the
symbol alone must still be distinguishable.

| State | Symbol |
| --- | --- |
| Done | `✓` |
| Running | `●` (Home row `◉`) |
| Waiting | `‖` |
| Failed | `✕` |
| Cancelled | `■` |
| Not reached | `○` |
| Skipped by mode | `–` |
| No longer running | `·` |

## Screen size

- The minimum is 80×24. Below the minimum, only a message asking to enlarge the window is shown.
- The one-line rail uses `stepperRow`: drop the completed stages at the start first, then the not-yet-reached stages at
  the end; the dropped part is marked `…`. The current stage, a waiting stage, or the place where the task ended always
  stays intact.
- Cut by cell count (`displayWidth`, `truncate`), not by string length. Vietnamese text and wide characters must have frame tests.
- Tables truncate rather than wrap; the full value is in the footer or the detail screen.

## Frame and density

- At most one border layer from the terminal edge to the content. Long log areas have no vertical borders, so copied
  text does not pick up borders.
- The same information does not repeat in several places on one screen. With one project, hide the Project column and
  the `Projects:` line; from two projects on, show them again.
- Spacing comes from blank rows and fixed columns, not from frames.

## State of an item

An item waiting on data must say exactly one thing:

| State | Shows |
| --- | --- |
| Reading | `Reading…` |
| Read error | A clear error; dependent items show `Could not be read.` |
| Nothing | A specific answer, such as `No steps yet`; this is not waiting |
| Stale data | Keep the data, with a `WARN` warning |

## Log

A record that cannot be read as text takes only one line, showing its type. Full JSON is shown after `Ctrl-O`, never in
default mode.

The gates screen is one stop along `←`/`→`, located exactly at the `gates` stage in the attempt chain. The gate list is
above, and the log of the selected gate is below. By default it selects the failing gate of the latest round and opens at
the end of the log, where the test runner reports the error. The log only exists after the gate finishes, so a running
gate shows its name, its elapsed time and the time of its last output. When wide, the list is one column; when narrow, it
is one line that always keeps the selected gate visible. An expired log is a normal state and is not highlighted as an error.
