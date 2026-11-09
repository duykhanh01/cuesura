# The default account is the machine's existing login; cusr only writes to its own logins

The project owner settled this after the spike for feature 006 on 2026-11-04.

Each harness has a **default account**: the credential the pin currently uses, that is, the account already logged in on
the machine. It is created automatically both on upgrade and on a fresh install, and it is selected before spare accounts
of the same priority. cusr only reads this credential: it never writes to it, deletes it or logs it in again. If the user
removes it, cusr does not recreate it.

The user adds a **spare account** with `cusr account add`. The command runs the vendor CLI's own login flow
(`claude auth login`, `codex login --device-auth`) in a temporary directory, checks the format and identity, then moves
the result into a directory managed by cusr. cusr only writes to these directories. cusr does not share credentials with
interactive sessions or other tools such as Orca, does not accept paths to existing credentials, and does not import
accounts from other tools. The vendor issues each login its own OAuth session, so cusr and those tools can use the same
subscription without breaking each other's tokens.

Rationale. Users understand this immediately: the account logged in on the machine is the primary account, and an added
account is a spare; adding an account does not change the account in use. Writing to another party's credentials would
force cusr to coordinate locks with each vendor and each tool, and the spike showed that some tools write credentials
without taking a lock. Not every user has those tools.

Consequences. The default account shares its credential with the interactive session, so when the harness inside cusr
refreshes a token, the interactive session or a later cusr run can still be logged out, as before this feature. What
differs is that the task does not get stuck: a login error on the default account moves the task to a spare account. The
user logs in again on the machine and runs `cusr account check`. Switching to a different account on the machine
temporarily drops the default account from use; `check` picks up the new identity.

Rejected alternatives:

- Treat the machine's credential as a temporary legacy account, prefer spare accounts and advise removing it: fewer
  logout risks, but confusing, since adding an account would change the account in use.
- Point an account at the credential of Orca or of an interactive session and write back to it: this requires
  coordinating locks with the writer outside cusr, and still leaves a window for overwrites when that writer writes
  without taking the lock.

This is a design decision for feature 006; it does not describe a feature that has been implemented. Sources:
[FR-001 to FR-006 in the spec](../../specs/006-account-pool/spec.md),
R-08 and R-11 in research (not published) and
spike report (not published).
