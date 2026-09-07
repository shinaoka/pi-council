# pi-council

Automatic multi-model discussions and planning for [pi](https://pi.dev/). Tested with pi 0.85.1 and Node.js 22. Uses pi's SDK and bundled packages only.

## Install and use

```sh
pi install git:github.com/shinaoka/pi-council
```

Inside pi:

```text
/reload
/council setup
/council-plan Design an offline search feature
```

This first stage produces a **design/spec**, not a detailed implementation plan. Use natural language to refine it: **“Have the council reconsider migration and rollback safety.”** The parent calls the `council` tool with your feedback, reusing the same in-memory participant sessions. No `new`, `round`, or `finish` commands are needed.

After reviewing the design, say: **“I approve this design. Expand it into a detailed implementation plan, including rollback tests.”** The parent calls `council_implementation_plan`; only the chair model does that expansion. It does not start another debate or implement anything.

`/council <topic>` starts a general discussion instead of a design/spec discussion. Both topic commands start a fresh council. `/council help`, `/council models`, and `/council setup` provide help and configuration. Use **Esc** to cancel an active tool, or `/council stop`. A normal natural-language stop request may be queued until the current tool finishes, so use these controls for immediate cancellation.

For local development, use `pi -e ./index.ts` or link this directory under `~/.pi/agent/extensions/`. Use only one installation method to avoid duplicate commands.

## Discussion and synthesis

1. Each participant gives an independent proposal.
2. The configured **chair** reads the proposals and writes a synthesis preserving alternatives, dissent and unresolved questions.
3. If the chair requests further discussion, participants critique the peer answers and chair synthesis, then the chair revises its synthesis.
4. Stop when the chair recommends human review or the iteration limit is reached. Return the latest synthesis, clearly distinguishing those two reasons.

The default limit is **10 iterations per user request**. Each iteration includes participant responses and one chair synthesis. A fresh council always gets an independent-proposal iteration and then a peer-critique iteration before early stopping (unless you explicitly set `maxRounds` to 1). An explicit follow-up request gets a new bounded loop using the same conversation histories. The chair is one of the participants, not an additional model. Its decision is advice, **not proof of unanimity, correctness or human approval**. A failed participant or malformed chair decision stops the loop rather than pretending consensus or silently retrying.

The `council` tool takes `task` (topic or feedback), optional `newMeeting`, and optional `mode` (`plan` or `discussion`, used when starting). Set `newMeeting: true` to start; otherwise an active council is required. After reload, feedback alone cannot silently start a context-free replacement. The parent model selects the tool for natural-language council requests; it is instructed not to restart the automatic loop without a new user request. The extension does not automatically intercept unrelated conversation or the existing `/plan` command.

## Detailed implementation planning

`council_implementation_plan` takes required `approved: true` and optional `instructions`. The parent is instructed to set approval only after you explicitly approve the latest design and request detailed planning. Chair `DONE` is not user approval, and there is no automatic handoff or extra confirmation dialog. The flag conveys the parent's interpretation of your request; the extension does not independently parse natural-language consent.

The tool uses the latest completed synthesis and peer evidence, plus the chair's retained conversation. It rejects missing approval, a missing/currently failed synthesis, a changed working directory, or a concurrent operation. It does not silently reuse an older design after a failed discussion. Material design changes belong back in council; expansion should not invent solutions for unresolved requirements.

The single-model prompt requests a self-contained plan for an engineer without the chat history:

- Goal, approved design basis, architecture, global constraints and dependencies.
- Ordered, independently testable tasks with exact create/modify/test paths and consumed/produced interfaces.
- Checkbox steps, roughly one 2–5 minute action each where realistic.
- Concrete implementation and test code, exact verification commands/working directories and expected results, including failure/edge cases.
- Failing-test → minimal-fix → passing-test steps where applicable, final integration checks and sensible commit boundaries.
- A self-review mapping requirements to tasks/checks, checking cross-task names/types and eliminating placeholders.

Only read-only inspection is available. Commands in the plan are **proposed, not executed**. Unknown material facts should produce explicit blockers/questions, not invented APIs or a supposedly executable plan. These content requirements are prompt instructions, not a guarantee of model correctness; review the actual plan before using it.

Detailed planning has **no 1,200-word discussion limit**, but retains the same configured response deadline (default 600 seconds) and 20-turn budget. `maxRounds` does not apply: this is one chair response run, potentially with read-tool continuations. The full output must fit 48,000 UTF-8 bytes and 2,000 lines; oversized output fails instead of being returned as a silently incomplete plan. Ask to narrow or split the scope if needed.

The result is returned in chat. No files are saved, no additional model setting is needed, and no Superpowers dependency is required. Approval to write a plan is not approval to execute it.

## Configuration

`~/.pi/agent/council.json` is the only extension-specific saved configuration (respects pi's agent directory). If absent, choose registered models interactively, create a template, or cancel. Interactive choices can optionally be saved. Existing files are never overwritten by setup; edit them directly.

```json
{
  "participants": [
    { "name": "architect", "model": "PROVIDER/MODEL_ID", "role": "Propose the simplest viable design", "thinking": "medium" },
    { "name": "critic", "model": "PROVIDER/OTHER_MODEL_ID", "role": "Challenge assumptions, safety and tests", "thinking": "medium" }
  ],
  "chair": "architect",
  "timeoutSeconds": 600,
  "maxRounds": 10
}
```

Replace model placeholders with exact IDs from `/council models`. Authentication remains with pi (`/login`, environment variables, or `models.json`), never in this file. Model IDs are split at the first slash; additional slashes and colons are preserved. Thinking is separate: off/minimal/low/medium/high/xhigh/max; effective SDK-clamped values appear in the result.

Choose 2–6 participants. `chair` defaults to the first participant. `maxRounds` accepts any positive safe integer; `timeoutSeconds` accepts 10–600 seconds. A new council snapshots configuration; edits apply the next time you start a council with a topic command or `newMeeting: true`.

## Time budget and cost

Default: **600 seconds per individual response**, including tool use. The chair gets the same budget for each synthesis and detailed implementation-plan response. This is not a total meeting deadline. Models receive an English reminder on every discussion/synthesis request with total budget, UTC deadline and remaining seconds, refreshed after tool use. The reminder instructs them to stop exploring in time to return a useful answer with unfinished checks clearly named.

A pi-side timer calls `session.abort()` at the deadline. This is cooperative cancellation, not process isolation. Setup is outside the response budget; model-runtime initialization has a separate 15-second deadline. Each response, including detailed planning, also has a 20-turn cap. SDK-internal compaction uses its own prompt but remains subject to the response timer.

Automatic discussion can be expensive: with N participants, up to `(N + 1) × maxRounds` response runs are possible per request, plus tool continuations and SDK compaction. Reduce `maxRounds` or use cheaper models if appropriate. Child usage is not added to the parent's footer.

## State and safety

- One in-memory SDK session per participant; no waiting child processes and no separate meeting, transcript, session or PLAN files. The final PLAN is returned in chat, not written into the repository.
- **Exit, `/reload`, or switching parent sessions discards the council.** Pi itself may still persist normal parent chat and tool output under its own settings. This extension is not a no-logging/privacy mode.
- Starting a new council discards the previous one. Older versions' saved meeting directories are neither used nor deleted.
- Participants can use only read/grep/find/ls. No child extensions, skills, shell or write tools. This is a tool restriction, not a filesystem sandbox: readable paths outside the project remain accessible.
- Project context is included only when the parent trusts the project. Parent chat is not copied wholesale; include relevant constraints in the topic or feedback. Native/registered provider definitions and pi's credential files are reused; host request hooks and transient CLI-only credentials are not copied.
- Peer exchange is limited to 120,000 characters and fails explicitly if exceeded. Parent tool output is bounded to 48,000 characters with an explicit truncation notice. SDK compaction may summarize older participant history.
- UI, help and built-in instructions are English. Discussion and PLAN language follow the topic/user feedback. Plans require human review; no implementation is started.

## Verification

Run `npm test`. Tests use real SDK in-memory sessions with mock model streams: same-session follow-up, no saved artifacts, peer exchange, automatic iteration/early stop/limit, failure and invalid chair decisions, single-chair detailed planning, approval/precondition guards, full-output limits, cancellation, refreshed time reminders, timeout, setup UI and extension discovery. No model API requests are made. Live provider behavior and real TUI interaction need a separate smoke test.

Tests resolve the SDK from a local installation, `PI_COUNCIL_SDK` (package directory), or the installed `pi` executable.
