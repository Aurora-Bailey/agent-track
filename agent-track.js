#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ENV_FILE = path.join(__dirname, '.env');
const MAX_NOTE_WORDS = 500;
const MAX_ATTEMPTS = 4;
const REQUEST_TIMEOUT_MS = 20_000;
const RETRY_DELAY_MS = 2_000;
const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

const USAGE = `Usage:
  agent-track start <task-id>
  agent-track stop <task-id> <note>

Examples:
  agent-track start taskid234234
  agent-track stop taskid234234 "Implemented the feature and ran the tests."
`;

class UsageError extends Error {}
class ConfigError extends Error {}

function parseDotEnv(contents) {
	const values = {};

	for (const rawLine of contents.split(/\r?\n/u)) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#')) continue;

		const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line);
		if (!match) continue;

		const [, key, rawValue] = match;
		let value = rawValue.trim();

		if (value.startsWith("'") && value.endsWith("'")) {
			value = value.slice(1, -1);
		} else if (value.startsWith('"') && value.endsWith('"')) {
			value = value
				.slice(1, -1)
				.replace(/\\n/gu, '\n')
				.replace(/\\r/gu, '\r')
				.replace(/\\t/gu, '\t')
				.replace(/\\"/gu, '"')
				.replace(/\\\\/gu, '\\');
		} else {
			value = value.replace(/\s+#.*$/u, '').trim();
		}

		values[key] = value;
	}

	return values;
}

function loadLocalEnv(env = process.env, envFile = ENV_FILE) {
	let contents;

	try {
		contents = fs.readFileSync(envFile, 'utf8');
	} catch (error) {
		if (error.code === 'ENOENT') {
			throw new ConfigError(`Missing configuration file: ${envFile}`);
		}
		throw error;
	}

	for (const [key, value] of Object.entries(parseDotEnv(contents))) {
		if (env[key] === undefined) env[key] = value;
	}

	return env;
}

function validateEndpoint(rawValue, expectedSuffix, variableName) {
	let url;

	try {
		url = new URL(rawValue);
	} catch {
		throw new ConfigError(`${variableName} must be a valid URL.`);
	}

	const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1']);
	if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopbackHosts.has(url.hostname))) {
		throw new ConfigError(`${variableName} must use HTTPS.`);
	}
	if (url.username || url.password || url.search || url.hash) {
		throw new ConfigError(`${variableName} cannot contain credentials, a query, or a fragment.`);
	}
	if (!url.pathname.endsWith(expectedSuffix)) {
		throw new ConfigError(`${variableName} must end with ${expectedSuffix}.`);
	}

	return url.toString();
}

function configFromEnv(env) {
	const token = env.TASK_MONSTER_QUICK_ACTION_TOKEN?.trim();
	const startValue = env.QUICK_ACTION_START?.trim();
	const stopValue = env.QUICK_ACTION_STOP?.trim();

	if (!token) throw new ConfigError('TASK_MONSTER_QUICK_ACTION_TOKEN is not configured.');
	if (/\s/u.test(token)) {
		throw new ConfigError('TASK_MONSTER_QUICK_ACTION_TOKEN cannot contain whitespace.');
	}
	if (!startValue) throw new ConfigError('QUICK_ACTION_START is not configured.');
	if (!stopValue) throw new ConfigError('QUICK_ACTION_STOP is not configured.');

	const startUrl = validateEndpoint(startValue, '/api/quick/add-task', 'QUICK_ACTION_START');
	const stopUrl = validateEndpoint(stopValue, '/api/quick/stop-task', 'QUICK_ACTION_STOP');

	if (new URL(startUrl).origin !== new URL(stopUrl).origin) {
		throw new ConfigError('QUICK_ACTION_START and QUICK_ACTION_STOP must use the same origin.');
	}

	return { token, startUrl, stopUrl };
}

function normalizeTaskId(value) {
	const taskId = value?.trim();
	if (!taskId) throw new UsageError('A task ID is required.');
	if (/\s/u.test(taskId)) throw new UsageError('The task ID cannot contain whitespace.');
	return taskId;
}

function normalizeNote(values) {
	const note = values.join(' ').trim().replace(/\s+/gu, ' ');
	if (!note) throw new UsageError('A note is required when stopping a task.');

	const wordCount = note.match(/\S+/gu)?.length ?? 0;
	if (wordCount > MAX_NOTE_WORDS) {
		throw new UsageError(`The stop note cannot exceed ${MAX_NOTE_WORDS} words.`);
	}

	return note;
}

function parseArguments(args) {
	if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
		return { help: true };
	}

	const [command, rawTaskId, ...rest] = args;
	if (command !== 'start' && command !== 'stop') {
		throw new UsageError('The command must be either start or stop.');
	}

	const taskId = normalizeTaskId(rawTaskId);

	if (command === 'start') {
		if (rest.length > 0) throw new UsageError('The start command does not accept a note.');
		return { command, taskId };
	}

	return { command, taskId, note: normalizeNote(rest) };
}

function wait(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryDelay(response, defaultDelay) {
	const retryAfter = response?.headers.get('retry-after');
	if (!retryAfter) return defaultDelay;

	const seconds = Number(retryAfter);
	if (Number.isFinite(seconds) && seconds >= 0) {
		return Math.min(seconds * 1_000, 10_000);
	}

	const retryDate = Date.parse(retryAfter);
	if (Number.isFinite(retryDate)) {
		return Math.min(Math.max(retryDate - Date.now(), 0), 10_000);
	}

	return defaultDelay;
}

async function readResponse(response) {
	const text = await response.text();
	if (!text) return null;

	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

async function sendTaskAction({
	command,
	taskId,
	note,
	config,
	fetchImpl = globalThis.fetch,
	maxAttempts = MAX_ATTEMPTS,
	timeoutMs = REQUEST_TIMEOUT_MS,
	retryDelayMs = RETRY_DELAY_MS,
	waitImpl = wait
}) {
	if (typeof fetchImpl !== 'function') {
		throw new Error('This command requires Node.js 20 or newer.');
	}

	const action = command === 'start' ? 'add-task' : 'stop-task';
	const url = command === 'start' ? config.startUrl : config.stopUrl;
	const body = {
		source: 'codex_agent',
		action,
		taskId,
		...(command === 'stop' ? { notes: note } : {})
	};

	let lastError;

	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), timeoutMs);
		let response;

		try {
			response = await fetchImpl(url, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${config.token}`,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify(body),
				signal: controller.signal
			});

			const responseBody = await readResponse(response);

			if (response.ok) {
				if (responseBody?.ok === false) {
					throw new Error('Task Monster rejected the request.');
				}
				if (responseBody?.action && responseBody.action !== action) {
					throw new Error('Task Monster returned an unexpected action.');
				}
				if (responseBody?.taskId && responseBody.taskId !== taskId) {
					throw new Error('Task Monster returned an unexpected task ID.');
				}
				return responseBody;
			}

			lastError = new Error(`Task Monster returned HTTP ${response.status}.`);
			if (!RETRYABLE_STATUS_CODES.has(response.status)) throw lastError;
		} catch (error) {
			lastError = error.name === 'AbortError' ? new Error('The Task Monster request timed out.') : error;

			if (response && !RETRYABLE_STATUS_CODES.has(response.status)) throw lastError;
			if (attempt === maxAttempts) throw lastError;
		} finally {
			clearTimeout(timeout);
		}

		if (attempt < maxAttempts) {
			await waitImpl(retryDelay(response, retryDelayMs));
		}
	}

	throw lastError;
}

async function main() {
	let parsed;

	try {
		parsed = parseArguments(process.argv.slice(2));
	} catch (error) {
		if (error instanceof UsageError) {
			console.error(`${error.message}\n\n${USAGE}`);
			process.exitCode = 2;
			return;
		}
		throw error;
	}

	if (parsed.help) {
		process.stdout.write(USAGE);
		return;
	}

	try {
		const config = configFromEnv(loadLocalEnv());
		await sendTaskAction({ ...parsed, config });
		const verb = parsed.command === 'start' ? 'Started' : 'Stopped';
		console.log(`${verb} task ${parsed.taskId}.`);
	} catch (error) {
		console.error(`agent-track: ${error.message}`);
		process.exitCode = 1;
	}
}

if (require.main === module) {
	main().catch((error) => {
		console.error(`agent-track: ${error.message}`);
		process.exitCode = 1;
	});
}

module.exports = {
	ConfigError,
	MAX_NOTE_WORDS,
	UsageError,
	configFromEnv,
	loadLocalEnv,
	normalizeNote,
	parseArguments,
	parseDotEnv,
	sendTaskAction,
	validateEndpoint
};
