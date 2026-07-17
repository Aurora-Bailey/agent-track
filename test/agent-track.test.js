'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
	ConfigError,
	MAX_NOTE_WORDS,
	UsageError,
	configFromEnv,
	parseArguments,
	parseDotEnv,
	sendTaskAction
} = require('../agent-track');

test('parses dotenv values without overriding concerns in the parser', () => {
	assert.deepEqual(
		parseDotEnv(`
# comment
PLAIN=value
DOUBLE="two words"
SINGLE='literal value'
EXPORT_ME=kept # inline comment
`),
		{
			PLAIN: 'value',
			DOUBLE: 'two words',
			SINGLE: 'literal value',
			EXPORT_ME: 'kept'
		}
	);
});

test('parses start and stop commands', () => {
	assert.deepEqual(parseArguments(['start', 'task-123']), {
		command: 'start',
		taskId: 'task-123'
	});
	assert.deepEqual(parseArguments(['stop', 'task-123', 'Finished', 'all tests.']), {
		command: 'stop',
		taskId: 'task-123',
		note: 'Finished all tests.'
	});
});

test('requires a stop note and enforces the API word limit', () => {
	assert.throws(() => parseArguments(['stop', 'task-123']), UsageError);
	assert.throws(
		() => parseArguments(['stop', 'task-123', Array(MAX_NOTE_WORDS + 1).fill('word').join(' ')]),
		UsageError
	);
});

test('validates token and endpoint configuration', () => {
	assert.throws(() => configFromEnv({}), ConfigError);
	assert.throws(
		() =>
			configFromEnv({
				TASK_MONSTER_QUICK_ACTION_TOKEN: 'token',
				QUICK_ACTION_START: 'https://one.example/api/quick/add-task',
				QUICK_ACTION_STOP: 'https://two.example/api/quick/stop-task'
			}),
		/same origin/u
	);
});

test('sends authenticated start and stop requests with the expected bodies', async () => {
	const requests = [];
	const fetchImpl = async (url, options) => {
		const parsed = JSON.parse(options.body);
		requests.push({
			url,
			authorization: options.headers.Authorization,
			contentType: options.headers['Content-Type'],
			body: parsed
		});
		return new Response(JSON.stringify({ ok: true, action: parsed.action, taskId: parsed.taskId }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' }
		});
	};

	const config = configFromEnv({
		TASK_MONSTER_QUICK_ACTION_TOKEN: 'test-token',
		QUICK_ACTION_START: 'http://127.0.0.1:3000/api/quick/add-task',
		QUICK_ACTION_STOP: 'http://127.0.0.1:3000/api/quick/stop-task'
	});

	await sendTaskAction({ command: 'start', taskId: 'task-123', config, fetchImpl });
	await sendTaskAction({
		command: 'stop',
		taskId: 'task-123',
		note: 'Finished the implementation.',
		config,
		fetchImpl
	});

	assert.deepEqual(requests, [
		{
			url: 'http://127.0.0.1:3000/api/quick/add-task',
			authorization: 'Bearer test-token',
			contentType: 'application/json',
			body: { source: 'codex_agent', action: 'add-task', taskId: 'task-123' }
		},
		{
			url: 'http://127.0.0.1:3000/api/quick/stop-task',
			authorization: 'Bearer test-token',
			contentType: 'application/json',
			body: {
				source: 'codex_agent',
				action: 'stop-task',
				taskId: 'task-123',
				notes: 'Finished the implementation.'
			}
		}
	]);
});

test('retries an idempotent action after a transient server failure', async () => {
	let attempts = 0;
	const fetchImpl = async () => {
		attempts += 1;
		return new Response(
			JSON.stringify(
				attempts === 1
					? { ok: false }
					: { ok: true, action: 'add-task', taskId: 'task-123' }
			),
			{
				status: attempts === 1 ? 503 : 200,
				headers: { 'Content-Type': 'application/json' }
			}
		);
	};

	const config = configFromEnv({
		TASK_MONSTER_QUICK_ACTION_TOKEN: 'test-token',
		QUICK_ACTION_START: 'http://127.0.0.1:3000/api/quick/add-task',
		QUICK_ACTION_STOP: 'http://127.0.0.1:3000/api/quick/stop-task'
	});

	await sendTaskAction({
		command: 'start',
		taskId: 'task-123',
		config,
		fetchImpl,
		maxAttempts: 2,
		retryDelayMs: 0
	});

	assert.equal(attempts, 2);
});
