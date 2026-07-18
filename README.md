# agent-track

`agent-track` starts and stops one Task Monster task from the terminal. It owns the bearer-token handling so a person or AI agent can perform each transition with one command and never needs to read, print, or construct an authorization header.

## Requirements

- Node.js 20 or newer
- A Task Monster quick-action bearer token
- The targeted `add-task` and `stop-task` endpoint URLs

The command has no npm dependencies.

## Configuration

The installed repository has a local `.env` file with these settings:

```dotenv
TASK_MONSTER_QUICK_ACTION_TOKEN=your-quick-action-token
QUICK_ACTION_START=https://your-task-monster-host/api/quick/add-task
QUICK_ACTION_STOP=https://your-task-monster-host/api/quick/stop-task
```

The `.env` file is resolved relative to `agent-track.js`, not the current working directory. That makes the globally linked command work from any directory. The file is ignored by Git and should never be committed.

To configure another checkout, copy `.env.example` to `.env` and replace all three values.

## Usage

Start a specific task:

```bash
agent-track start taskid234234
```

Stop that task and attach a note:

```bash
agent-track stop taskid234234 "Implemented the requested change and ran the tests."
```

The stop note is required and may contain up to 500 words. Quote it when it contains spaces and keep sensitive details vague. If security controls block a stop request, retry with approved external-network escalation and a less detailed note. After three failed summary-note attempts, explicitly pass an empty note to end the task without a summary:

```bash
agent-track stop taskid234234 ""
```

Omitting the note argument is still an error; only an explicitly quoted empty string activates the fallback. The tool sends `source: "codex_agent"`, uses the targeted task action, retries transient failures, and exits nonzero unless Task Monster confirms a successful HTTP response.

You can also run the script without installing the command:

```bash
node agent-track.js start taskid234234
node agent-track.js stop taskid234234 "Implemented the requested change and ran the tests."
```

Show the built-in help:

```bash
agent-track --help
```

## AI-agent workflow

An agent can use the command as a single tool call at each lifecycle boundary:

```bash
agent-track start "$TASK_ID"
# perform the task
agent-track stop "$TASK_ID" "Concise note describing the completed work and verification."
```

After a successful start, the command prints this stop workflow so every repository receives the same current guidance automatically. The task ID is an ordinary CLI argument. The bearer token stays inside the ignored `.env` file and is never included in command output.

If the command reports a Task Monster network failure, retry the same command with the execution environment's approved external-network escalation. The diagnostic may include a network error code such as `ENETUNREACH`, but it never prints the configured endpoint or bearer token.

## Install the terminal command

Make the script executable and link it into a directory already on `PATH`:

```bash
chmod 700 agent-track.js
ln -sfn "$(pwd)/agent-track.js" "$HOME/.local/bin/agent-track"
```

This checkout is already linked on the machine where it was created. Re-run the commands above after moving the repository.

## Development

Run the syntax check and tests:

```bash
npm run check
npm test
```
