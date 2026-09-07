import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, realpathSync, existsSync, unlinkSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Council, validateConfig, resolveParticipants } from '../core.mjs';

let root = process.env.PI_COUNCIL_SDK;
if (!root) {
  try { root = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))); }
  catch { root = dirname(realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim())); }
}
while (!existsSync(join(root, 'package.json'))) {
  assert.notEqual(root, dirname(root), 'Could not locate installed pi package');
  root = dirname(root);
}
const sdk = await import(pathToFileURL(join(root, 'dist/index.js')));
const dir = mkdtempSync(join(tmpdir(), 'pi-council-test-'));
const config = validateConfig({ participants: [
  { name: 'a', model: 'test/model/a:1', role: 'Architect' },
  { name: 'b', model: 'test/model-b', role: 'Critic', thinking: 'off' },
] });
const model = { id: 'model/a:1', name: 'test', provider: 'test', api: 'openai-completions', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const registry = { find: (p, id) => p === 'test' ? { ...model, id } : undefined, hasConfiguredAuth: () => true };
assert.equal(config.maxRounds, 10);
assert.equal(validateConfig({ ...config, maxRounds: 25 }).maxRounds, 25);
assert.throws(() => validateConfig({ ...config, maxRounds: 0 }));
assert.throws(() => validateConfig({ ...config, maxRounds: 1.5 }));
assert.equal(resolveParticipants(config, registry)[0].model.id, 'model/a:1');
assert.throws(() => resolveParticipants(config, { ...registry, hasConfiguredAuth: () => false }), /auth/i);
assert.throws(() => validateConfig({ participants: [] }));
assert.throws(() => validateConfig({ ...config, chair: 'missing' }));
assert.throws(() => validateConfig({ ...config, timeoutSeconds: -1 }));
assert.throws(() => validateConfig({ participants: [config.participants[0], config.participants[0]] }));
assert.throws(() => validateConfig({ ...config, participants: config.participants.map(p => ({ ...p, thinking: 'turbo' })) }));

let fail = false, stall = false, toolProbe = false;
const probeCalls = new Map();
const observed = [];
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const { AssistantMessageEventStream } = await import(pathToFileURL(join(root, 'node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js')));
const runtime = {
  hasConfiguredAuth: () => true,
  getModel: (p, id) => ({ ...model, provider: p, id }),
  streamSimple(m, context, options) {
    const stream = new AssistantMessageEventStream();
    const last = context.messages.at(-2);
    observed.push({ id: m.id, messages: structuredClone(context.messages), system: context.systemPrompt, tools: context.tools });
    const emit = (aborted = false) => {
      const error = aborted || (fail && m.id === 'model-b');
      const message = { role: 'assistant', api: m.api, provider: m.provider, model: m.id, usage,
        content: [{ type: 'text', text: `${m.id}: response to ${JSON.stringify(last.content).slice(0, 80)}` }],
        stopReason: aborted ? 'aborted' : error ? 'error' : 'stop', timestamp: Date.now(),
        ...(error ? { errorMessage: aborted ? 'cancelled' : 'mock failure' } : {}) };
      stream.push(error ? { type: 'error', reason: message.stopReason, error: message } : { type: 'done', reason: 'stop', message });
      stream.end();
    };
    if (stall) {
      if (options.signal.aborted) emit(true);
      else options.signal.addEventListener('abort', () => emit(true), { once: true });
    } else if (toolProbe && !probeCalls.has(m.id)) {
      probeCalls.set(m.id, true);
      const message = { role: 'assistant', api: m.api, provider: m.provider, model: m.id, usage,
        content: [{ type: 'toolCall', id: `ls-${m.id}`, name: 'ls', arguments: { path: dir } }],
        stopReason: 'toolUse', timestamp: Date.now() };
      setTimeout(() => { stream.push({ type: 'done', reason: 'toolUse', message }); stream.end(); }, 1100);
    } else queueMicrotask(() => emit());
    return stream;
  },
};

try {
  const council = new Council({ sdk, agentDir: dir });
  const meeting = council.create({ cwd: dir, config, mode: 'plan', topic: 'Design a small feature' });
  const options = { runtime, registry, trusted: false };
  await council.round(meeting.id, 'Initial constraint', options);
  let saved = council.load(meeting.id, dir);
  assert.equal(saved.rounds[0].results.length, 2);
  assert(saved.rounds[0].results.every(r => r.status === 'ok'));
  const oneRound = council.create({ cwd: dir, config: { ...config, maxRounds: 1 }, mode: 'discussion', topic: 'One round only' });
  // Reuse the completed round as a fixture: rejecting the next round must make no requests.
  const capped = council.load(oneRound.id, dir);
  capped.rounds = structuredClone(saved.rounds);
  council.save(capped);
  const beforeLimit = observed.length;
  await assert.rejects(() => council.round(oneRound.id, '', options), /Round limit/);
  assert.equal(observed.length, beforeLimit);
  const files = saved.participants.map(p => p.sessionFile);
  assert(files.every(f => existsSync(join(council.directory(meeting.id), f))));
  assert(observed.every(o => o.tools.map(t => t.name).sort().join(',') === 'find,grep,ls,read'));
  assert(!JSON.stringify(observed[0].messages).includes('model-b: response'));
  assert(observed.every(o => JSON.stringify(o.messages.at(-1)).includes('TIME BUDGET')));

  // New engine instance, same real SDK JSONL sessions.
  const reopened = new Council({ sdk, agentDir: dir });
  await reopened.round(meeting.id, 'Added rollback requirement', options);
  saved = reopened.load(meeting.id, dir);
  assert.deepEqual(saved.participants.map(p => p.sessionFile), files);
  const second = observed.slice(2);
  assert(second.every(o => o.messages.some(m => m.role === 'assistant')));
  assert(second.every(o => JSON.stringify(o.messages.at(-2)).includes('Added rollback requirement')));
  assert(second.every(o => JSON.stringify(o.messages.at(-2)).includes('model-b: response')));
  assert(second.every(o => JSON.stringify(o.messages.at(-2)).includes('model/a:1: response')));
  const output = await reopened.finish(meeting.id, options);
  assert.match(readFileSync(output, 'utf8'), /model\/a:1/);
  const output2 = await reopened.finish(meeting.id, options);
  assert.notEqual(output, output2);
  assert.throws(() => reopened.load(meeting.id, '/different-cwd'), /directory/i);
  assert.throws(() => reopened.directory('../escape'));

  fail = true;
  await reopened.round(meeting.id, 'Fail one participant', options);
  saved = reopened.load(meeting.id, dir);
  assert(saved.rounds.at(-1).results.some(r => r.status === 'error'));
  await assert.rejects(() => reopened.finish(meeting.id, options), /successful/i);
  fail = false;

  stall = true;
  const active = reopened.round(meeting.id, 'Wait for cancellation', options);
  while (!reopened.sessions.size) await new Promise(r => setTimeout(r, 5));
  await assert.rejects(() => council.round(meeting.id, 'Conflict', options), /lock/i);
  await reopened.stop();
  await active;
  saved = reopened.load(meeting.id, dir);
  assert(saved.rounds.at(-1).results.every(r => r.status === 'error'));
  assert(!existsSync(join(reopened.directory(meeting.id), 'operation.lock')));
  stall = false;
  assert.equal(reopened.list(dir).length, 2);

  toolProbe = true;
  const probe = reopened.create({ cwd: dir, config, mode: 'discussion', topic: 'Tool continuation deadline test' });
  const probeStart = observed.length;
  await reopened.round(probe.id, '', options);
  const probeObserved = observed.slice(probeStart);
  assert.equal(probeObserved.length, 4, 'Two participants each make two model requests');
  for (const id of [model.id, 'model-b']) {
    const calls = probeObserved.filter(o => o.id === id);
    const remaining = calls.map(o => Number(o.messages.at(-1).content.match(/Remaining: (\d+)/)[1]));
    assert(remaining[1] < remaining[0], 'Remaining time must refresh after tool execution');
    assert.equal(calls[1].messages.filter(m => typeof m.content === 'string' && m.content.includes('FACILITATOR TIME BUDGET')).length, 1, 'Reminders must not accumulate in saved history');
  }
  toolProbe = false;
  stall = true;
  const timeout = reopened.create({ cwd: dir, config: { ...config, timeoutSeconds: 10 }, mode: 'discussion', topic: 'Deadline test' });
  await reopened.round(timeout.id, '', options);
  assert(reopened.load(timeout.id, dir).rounds[0].results.every(r => r.status === 'error' && r.error.includes('deadline')));
  stall = false;

  // Verify the local installation shape: an auto-discovered extension directory link.
  mkdirSync(join(dir, 'extensions'));
  symlinkSync(join(import.meta.dirname, '..'), join(dir, 'extensions/council'), 'junction');
  const loader = new sdk.DefaultResourceLoader({ cwd: dir, agentDir: dir,
    settingsManager: sdk.SettingsManager.inMemory({ packages: [] }),
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.equal(loader.getExtensions().extensions.length, 1);
  const commands = loader.getExtensions().extensions[0].commands;
  assert(commands.has('council'));
  assert(commands.has('council-plan'));
  // Exercise the actual command factory with a fake UI, never real credentials.
  const require = createRequire(join(root, 'dist/index.js'));
  const jiti = require('jiti').createJiti(join(root, 'dist/index.js'), {
    alias: { '@earendil-works/pi-coding-agent': join(root, 'dist/index.js') },
  });
  const factory = await jiti.import(join(import.meta.dirname, '../index.ts'), { default: true });
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const registered = new Map(), events = new Map(), messages = [];
    factory({ registerCommand: (n, c) => registered.set(n, c), on: (n, f) => events.set(n, f),
      sendMessage: (m, options) => {
        assert.equal(options.triggerTurn, false, 'Messages must display without starting the parent model');
        assert.notEqual(options.deliverAs, 'nextTurn', 'Do not hide results until a later user prompt');
        messages.push(m.content);
      }, appendEntry: () => {} });
    const selections = ['Cancel'];
    const inputs = [];
    const context = { cwd: dir, hasUI: true,
      modelRegistry: { ...registry, getAvailable: () => [model, { ...model, id: 'model-b' }] },
      ui: { select: async () => selections.shift(), input: async () => inputs.shift(), confirm: async () => true } };
    const command = registered.get('council');
    await command.handler('setup', { ...context, hasUI: false });
    assert(messages.at(-1).includes('Create a configuration file first'));
    await command.handler('setup', context);
    assert(!existsSync(join(dir, 'council.json')));
    selections.push('Create a configuration template');
    await command.handler('setup', context);
    const template = readFileSync(join(dir, 'council.json'), 'utf8');
    assert(template.includes('PROVIDER/MODEL_ID'));
    await command.handler('setup', context);
    assert.equal(readFileSync(join(dir, 'council.json'), 'utf8'), template, 'Existing config must not be overwritten');
    unlinkSync(join(dir, 'council.json'));
    selections.push('Choose registered models interactively', 'test/model/a:1', 'low', 'test/model-b', 'off', 'Done choosing', 'a');
    inputs.push('a', 'Architect', 'b', 'Critic');
    await command.handler('setup', context);
    const selectedConfig = validateConfig(JSON.parse(readFileSync(join(dir, 'council.json'), 'utf8')));
    assert.equal(selectedConfig.participants[0].model, 'test/model/a:1');
    assert.equal(selectedConfig.participants[1].thinking, 'off');
    await command.handler('resume ' + meeting.id, context);
    assert(messages.at(-1).includes('Selected meeting'));
    await command.handler('status', context);
    assert(messages.at(-1).includes(meeting.id));
    await command.handler('roudn', context);
    assert(messages.at(-1).includes('Unknown council action'));
    await events.get('session_shutdown')();
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
  console.log('PASS: config/UI setup, SDK history/reopen, read-only tools, rounds, synthesis, failure, cancellation, lock, per-request budget updates, timeout, discovery');
} finally { rmSync(dir, { recursive: true, force: true }); }
