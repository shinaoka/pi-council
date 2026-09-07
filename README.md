# pin-council

Persistent multi-model discussions and implementation planning for [pi](https://pi.dev/).
Tested with pi 0.85.1 and Node.js 22. No additional runtime dependencies beyond pi.

## Install

```sh
pi install git:github.com/shinaoka/pin-council
```

Run `/reload`, then `/council setup` and `/council-plan new <topic>`.
For local development, use `pi -e ./index.ts` or link this directory under `~/.pi/agent/extensions/`. Use only one installation method to avoid duplicate commands.

All extension UI, help and built-in instructions are English. Contributions and plans follow the language requested in the topic.

## Design

- `/council` is the discussion engine; `/council-plan` uses the same engine with a planning prompt and PLAN output.
- One persistent SDK session per participant, not one per round. Session JSONL is reopened for each operation; no idle child processes. Other participants' published answers are explicitly forwarded by the facilitator.
- Global configuration only: `~/.pi/agent/council.json` (respects pi's agent directory). Missing configuration offers model selection, template creation, or cancellation. Credentials remain with pi, never in this file.
- Meetings snapshot participant configuration. Editing configuration affects only new meetings. The first participant is the default chair.
- Participants only receive read/grep/find/ls; no extensions, skills, shell, or write tools are loaded into children. This is a tool restriction, not a filesystem sandbox: read tools may access paths outside the project. Parent context is not automatically copied. Project context files are included only when the parent trusts the project.
- Round 1 is independent; later rounds receive the previous round's published answers and user feedback. Each command runs one round, so the user controls continuation. The chair synthesizes all recorded rounds, keeping disagreements visible.
- Private meeting storage is outside the repository, under `~/.pi/agent/council/meetings/`. A per-meeting exclusive lock prevents simultaneous writers. JSON manifests use atomic replacement. Failed/aborted rounds are recorded, not presented as successful. No automatic retries at the meeting level.
- Shutdown/reload aborts active SDK work and waits for cleanup. A normal operation has a configured deadline and a 20-turn cap per participant. SDK/network cancellation is cooperative, not process isolation.

## Configuration

`/council models` displays exact authenticated `provider/model-id` values from the parent pi registry. `/council setup` selects participants interactively or creates a template. Existing configuration is never overwritten by setup.

```json
{
  "participants": [
    { "name": "architect", "model": "provider/exact-model-id", "role": "Propose the simplest viable design", "thinking": "medium" },
    { "name": "critic", "model": "provider/another-model-id", "role": "Challenge assumptions and identify risks", "thinking": "medium" }
  ],
  "chair": "architect",
  "timeoutSeconds": 120,
  "maxRounds": 10
}
```

Replace placeholder model IDs with values from `/council models`. The template intentionally cannot start paid requests until edited. Model IDs are split at the first slash, preserving provider-specific IDs containing additional slashes or colons. Thinking is a separate field: off/minimal/low/medium/high/xhigh/max. SDK capability clamping is reported in operation results. 2–6 participants; timeout 10–600 seconds. `maxRounds` defaults to 10 and accepts any positive safe integer. Models unavailable in pi fail before meeting creation. Extension-registered provider definitions are copied to a dedicated ModelRuntime without loading the extensions in children. Host request hooks and transient CLI-only credentials are not copied.

## Iteration limit

The default discussion limit is **10 rounds**, including the initial independent proposals. Set `"maxRounds": 20` (or another positive integer) in `council.json` to override it for new meetings. Synthesis via `finish` does not count as a discussion round. Failed or interrupted rounds do count, preventing unbounded retries. Each `round` command advances one iteration; this is an upper limit, not an automatic ten-round loop.

## Time budget

Set `"timeoutSeconds": 300` in `council.json` for a five-minute budget **per participant response**, including tool use. The same budget applies to the chair's synthesis. This is not a total meeting budget; participants run in parallel. New meetings snapshot the value along with the participant list.

Every discussion/synthesis model request receives an ephemeral English reminder containing the total budget, UTC deadline and remaining seconds. Remaining time is recalculated after tool execution; reminders do not accumulate in saved history. Models are told to stop exploring in time to return findings and explicitly name unfinished checks. SDK-internal compaction is not a discussion request and uses its own prompt, but still falls under the response timer.

The deadline is enforced by a pi-side timer using `session.abort()`, not by trusting the prompt. Timeout/cancellation is recorded as a failure, never as a completed answer. Cancellation is cooperative: this is not a hard process-kill boundary. Time spent preparing the SDK session is outside the response budget; model runtime initialization separately has a 15-second deadline.

## Commands

```
/council-plan new Design an offline search feature
/council round Also consider migration and rollback
/council round Respond to the remaining objections
/council finish
/council status
/council list
/council resume <meeting-id>
/council stop
```

`/council-plan <topic>` also starts a planning meeting; `/council new <topic>` starts a general discussion. Both commands share one selected meeting. `resume` selects a meeting without making API requests; the next `round` or `finish` reopens its saved participant sessions. The selected ID is restored on parent session reload; use `list`/`resume` from another parent session. Resume requires the same canonical working directory.

`finish` requires a fully successful latest round. It asks the saved chair session to produce a synthesis, then saves a new, non-overwriting `PLAN-<timestamp>-<uuid>.md` (planning) or `CONCLUSION-...md` (general) inside the meeting directory. A saved PLAN is a draft for human approval; this extension never executes it. You can continue discussing after synthesis. Partial results and failures are retained in `meeting.json`; individual full histories are in `sessions/`.

Discussion execution requires interactive or RPC mode (not print/JSON mode). Results appear as messages without triggering the parent model. Round and synthesis output is bounded in the UI, with the full artifact path provided. The extension does not automatically hook existing `/plan` or require pi-subagents/pi-brainstorm.

## Recovery and limits

A hard process crash can leave `operation.lock`. The error identifies its location. Verify the owning process has exited before manually deleting that lock; no automatic stale-lock stealing. If a crash happened during a round, its in-progress entries are shown as interrupted on the next operation, while the underlying SDK histories are preserved.

Round exchange/synthesis is limited to 120,000 characters, failing explicitly instead of silently truncating evidence. SDK compaction may summarize older per-participant history. Files can contain sensitive project information; do not publish them casually. API cost is multiplied by participant count; no real model calls are made by setup or resume. Usage remains in child sessions, not the parent's footer.

## Verification

Run `node tests/check.mjs` from this directory. Tests resolve the installed SDK from `PI_COUNCIL_SDK` (package directory) or the real `pi` executable. No network requests are made. Test coverage includes configuration validation, real SDK session persistence and reopening with a mock stream, round exchange, partial failure, synthesis, cancellation, lock exclusion, and extension discovery. Live provider authentication and TUI interaction require a separate manual smoke test.
