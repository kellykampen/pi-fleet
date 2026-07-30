# Decision record: npm:pi-messenger for fleet agent mail

**Ticket:** FLT-59 (eval) / FLT-58 (implement)  
**Date:** 2026-07-30  
**Package:** [`pi-messenger@0.14.1`](https://www.npmjs.com/package/pi-messenger) —
[github.com/nicobailon/pi-messenger](https://github.com/nicobailon/pi-messenger)

## Recommendation: **NO-GO adopt-as-is → build custom `fleet-mail`**

Do **not** adopt `pi-messenger` as the fleet status-uplink default. Implement
custom `bin/fleet-mail` (file-backed under `~/.pi-fleet/mail`) with enforced
topology and anti-spam. Optionally revisit a thin wrap later if upstream adds
role routing + ack + replaceable status slots without steering floods.

## What pi-messenger provides

| Capability | pi-messenger |
| --- | --- |
| Install | `pi install npm:pi-messenger` (Pi **extension**) |
| Join / leave / presence | Yes — themed agent names, status bar |
| Send | Yes — free-form chat; **recipient wakes as steering prompt** |
| Feed / activity | Yes — edits, commits, messages timeline |
| File reservations | Yes — claim paths, auto-release |
| Stuck detection | Yes |
| Crew task DAG | Yes — plan/work/review waves |
| Daemon | No — file-based, no server |

## Mapped against FLT-58 v0 needs

| Need | Fit |
| --- | --- |
| Addressable mailboxes per seat role | **Weak** — presence names, not role mailboxes (`worker`/`project-lead`/`conductor`) |
| Structured `{type:status\|blocker\|done\|ask\|review\|ac, ticket, pr, head, body}` | **Missing** — free-form `message` string |
| unread / show / ack | **Missing** — steering injection, not durable inbox ack |
| Workers uplink = owning lead only | **Missing** — any peer can DM any peer / `@all` |
| Conductor rejects worker mail | **Missing** — no topology enforcement |
| Anti-spam + replaceable STATUS slots | **Missing** — steering-wakeup can reintroduce queue spam if status is frequent |
| Optional presence tooling; mail works without it | N/A (different product) |
| Works without cmux send drip | Partial — avoids cmux, but **steering** is another interrupt channel |
| Lead/conductor `--no-extensions` seats | **Poor** — extension must be loaded explicitly; lead/conductor isolate extensions |

## Why steering-wakeup is a risk for fleet

pi-messenger’s design goal is “message wakes the peer as a steering prompt.”
Fleet leads already suffer from **cmux send drip + steering queues**. Replacing
cmux drip with messenger steering for every status tick would recreate the same
failure mode. Fleet status must be **pullable, ackable, and replaceable**
(latest status per ticket wins), not an interrupt storm.

## Gaps if we only wrapped pi-messenger

A wrap would still need to invent:

1. Role topology allow/deny matrix  
2. Structured message schema + validation  
3. Durable unread/ack store (or map feed → ack, non-native)  
4. STATUS slot replacement + rate limits  
5. A path that works when lead/conductor run with extension discovery disabled  

At that point the wrap is larger than a small file-backed CLI and still depends
on an extension lifecycle we do not control.

## What custom v0 implements instead

- CLI: `fleet-mail send|inbox|show|ack`  
- Storage: `$PI_FLEET_HOME/mail/<mailbox>/inbox.json` (atomic, locked, 0600)  
- Topology enforced in `bin/lib/fleet-mail.cjs`  
- STATUS slots per `from+ticket` replace unacked prior status  
- Rate limit on non-status  
- Skill docs: workers → lead only; lead compact rollup → conductor; conductor
  never accepts worker mail  
- No requirement to use cmux send for status uplink  

## Revisit criteria

Re-evaluate adopt/wrap if upstream adds **all** of:

- Role-scoped routing hooks (or pluggable allowlists)  
- Structured message types + ticket slots with replace semantics  
- Non-steering durable inbox with ack (steering opt-in only)  
- Headless CLI usable without loading a full Pi extension in lead seats  

## Spike note

README/API review of `pi-messenger` 0.14.1 (join/send/feed/reserve/crew) was
sufficient for a no-go: topology and anti-spam are product requirements, not
thin config. A two-seat local smoke is provided for **`fleet-mail`**, not for
forcing messenger into the fleet default path.
