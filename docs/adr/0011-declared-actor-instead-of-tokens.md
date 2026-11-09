# Drop access tokens; callers declare their own actor

The project owner settled this on 2026-11-05.

The daemon no longer uses bearer tokens. There is no `owner.token`, no `runtime.access_tokens`, and no per-token project
scope. Only processes with the same UID can open the control socket (directory 0700, socket 0600). Callers declare their
actor via `CUSR_ACTOR`, sending it to the daemon in the `x-cusr-actor` header:

- Not set, or set to `owner`: `owner`, with `read`, `operate` and `admin` permissions.
- Set to `assistant`: `assistant`, with `read` and `operate` permissions.
- Any other value: the CLI rejects it immediately, and the daemon returns 401.

The `cusr` skill sets `CUSR_ACTOR=assistant` for every command. Every command is still recorded with its actor.

Rationale. A token creates no boundary on a single-user machine. Outsiders were already blocked by the socket's file mode.
Workers and the assistant run under the same UID, so they can read `owner.token`, or edit the user config to grant
themselves `admin`. Previously, what actually held the assistant back was a convention in the skill. What a token still
offered was the ability to record who did what, and to stop an assistant that mistakenly calls `approve` despite the
convention. A self-declared actor achieves exactly those two things without creating a secret file, editing config or
restarting the daemon. Issuing a token to the assistant was the step where newcomers got stuck when starting out.

Consequences. The assistant still does not approve escalations or turn on yolo (amended later: since issue 205 the
assistant can approve escalations with the `operate` permission), but that is a convention enforced by the daemon against
callers that declare correctly, not a security boundary: a process under the same UID that drops `CUSR_ACTOR` becomes
owner. Per-caller project scope is gone; every caller sees every project in the config. Old events with
`issued_by: token:<id>` remain readable; new commands record `issued_by: socket:<actor>`. Old configs that still contain
`runtime.access_tokens` still start, and the daemon writes one log line saying this key is ignored.

Rejected alternatives:

- Keep tokens and add a `cusr access grant` command to generate one for the assistant: less friction at setup, but it
  keeps a mechanism that protects nothing on a single-user machine.
- Tell callers apart by the peer's UID (`SO_PEERCRED`): only meaningful when the assistant runs under a different UID,
  which does not exist in v1.

When a real boundary is needed, for example a network channel such as a form or HTTP over Tailscale, or an assistant
running under a different UID, authentication will be added for that channel. Sources:
[constitution 7.0.0](../constitution.md), section "Callers and permissions" in
[deploy/README.md](../../deploy/README.md#callers-and-permissions).
