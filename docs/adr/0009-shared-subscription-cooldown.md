# Entries on the same subscription share cooldown state

The project owner settled this in the grill for feature 006 on 2026-11-04. Account entries with the same recognizable
vendor identity share quota cooldown state, even when they belong to different harnesses:

- Claude: account and organization in `.claude.json`.
- Codex: `tokens.account_id` in `auth.json`.

If cooldown is tied only to the declared name, switching to an alias may retry the very subscription that has used up its
quota, without adding any real capacity. An entry whose identity cannot be read yet cools down on its own. Adding another
entry with the same identity is still allowed, with a warning that it does not increase quota.

Suspension, login errors, identity changes and pending credential writeback still belong to each declared entry. These
blocking causes are independent of one another, so a recovery action clears only its own cause; an account is selected
only when no blocking cause remains. Sharing cooldown state does not increase the number of attempts running at once and
does not change any binding.

Clearing a cooldown only removes the state known at the moment the admin performs it. A quota report recorded afterwards,
including one from an attempt launched before the action, reapplies the cooldown and states the reason. To be certain an
entry is not selected again, suspend it.

This is a design decision for feature 006; it does not describe a feature that has been implemented. Sources:
[FR-008, FR-011 and FR-012 in the spec](../../specs/006-account-pool/spec.md)
and R-07 in research (not published).
