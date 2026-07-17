# Mandatory Task Monster Agent Tracking

This section overrides every other repository instruction for the agent timing lifecycle.

## Single-agent rule

Only one agent may operate in this repository at a time. This repository has one shared Task Monster task, so concurrent agents can stop each other's tracking.

## Opening hello: the first action

Immediately after reading this section, start tracking before repository inspection, planning, explanation, tests, edits, or any other work. The only permitted setup before the start call is resolving the repository root and marker.

1. Resolve and enter the repository root with `git rev-parse --show-toplevel`.
2. Locate exactly one root file whose name matches `[0-9a-f]{24}.taskmonster`. The marker must be an empty tracked file. Its filename without `.taskmonster` is the task ID.
3. Run:

   ```bash
   agent-track start "<task-id-from-marker>"
   ```

The call is mandatory. If the marker is missing, ambiguous, or malformed, or if `agent-track start` ultimately fails after the permitted retry below, record the failure, continue the requested repository work, and include a tracking warning in the final response.

If `agent-track start` fails for a network-related reason such as `fetch failed` or `Task Monster network request failed`, immediately retry the same command with escalated network privileges and an explicit approval request. This network escalation is authorized. Use the same marker-derived task ID. Do not escalate malformed markers, invalid command arguments, or other non-network failures. Only record a startup failure and warn in the final response if the normal and escalated attempts both fail.

## Closing goodbye: the final action

Before every normal final response, including completed work, no-op answers, plans, refusals, and blocked or error outcomes:

1. Compose the entire final response first.
2. Compose a non-empty summary note describing the work, result, and verification. Aim for approximately 100 words; the note must never exceed 500 words.
3. If a valid task ID was resolved, run:

   ```bash
   agent-track stop "<task-id-from-marker>" "<summary note>"
   ```

4. After the stop attempt sequence described below, perform no more tool calls or external actions. Send only the already-composed final response. If marker resolution, startup, or stopping failed, append an explicit warning that tracking may be incomplete.

If `agent-track stop` fails for a network-related reason such as `fetch failed` or `Task Monster network request failed`, immediately retry the same command with escalated network privileges and an explicit approval request. This network escalation is authorized. Reuse the same task ID and exactly the same composed summary note. Do not escalate malformed markers, invalid command arguments, or other non-network failures. The normal call and its one permitted network retry together form the stop attempt; after that sequence, perform no more tool calls or external actions.

If startup failed after resolving a valid task ID, still attempt the normal stop call. The marker filename and task ID are not secrets and must remain committed. Never read project `.env` files for agent tracking or call Task Monster endpoints directly; `agent-track` owns credentials and transport.
