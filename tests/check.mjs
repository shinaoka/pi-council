import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, realpathSync, existsSync, unlinkSync, mkdirSync, symlinkSync, readdirSync } from 'node:fs';
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
assert.equal(config.timeoutSeconds, 600);
assert.equal(validateConfig({ ...config, timeoutSeconds: 120 }).timeoutSeconds, 120);
assert.equal(validateConfig({ ...config, maxRounds: 25 }).maxRounds, 25);
for (const maxRounds of [0, 1.5]) assert.throws(() => validateConfig({ ...config, maxRounds }));
assert.equal(resolveParticipants(config, registry)[0].model.id, 'model/a:1');
assert.throws(() => resolveParticipants(config, { ...registry, hasConfiguredAuth: () => false }), /auth/i);
assert.throws(() => validateConfig({ participants: [] }));
assert.throws(() => validateConfig({ ...config, chair: 'missing' }));
assert.throws(() => validateConfig({ ...config, timeoutSeconds: -1 }));
assert.throws(() => validateConfig({ participants: [config.participants[0], config.participants[0]] }));

let fail = false, stall = false, toolProbe = false, keepDiscussing = false, invalidDecision = false;
const probeCalls = new Set(), observed = [];
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const { AssistantMessageEventStream } = await import(pathToFileURL(join(root, 'node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js')));
const runtime = {
  hasConfiguredAuth: () => true,
  getModel: (p, id) => ({ ...model, provider: p, id }),
  streamSimple(m, context, options) {
    const stream = new AssistantMessageEventStream();
    observed.push({ id: m.id, messages: structuredClone(context.messages), tools: context.tools });
    const emit = (aborted = false) => {
      const error = aborted || (fail && m.id === 'model-b');
      const message = { role: 'assistant', api: m.api, provider: m.provider, model: m.id, usage,
        content: [{ type: 'text', text: (JSON.stringify(context.messages.at(-2)).includes('CHAIR SYNTHESIS')
          ? `${invalidDecision ? 'MAYBE' : keepDiscussing ? 'CONTINUE' : 'DONE'}\n` : '') + `${m.id}: published answer` }],
        stopReason: aborted ? 'aborted' : error ? 'error' : 'stop', timestamp: Date.now(),
        ...(error ? { errorMessage: aborted ? 'cancelled' : 'mock failure' } : {}) };
      stream.push(error ? { type: 'error', reason: message.stopReason, error: message } : { type: 'done', reason: 'stop', message });
      stream.end();
    };
    if (stall) {
      if (options.signal.aborted) emit(true);
      else options.signal.addEventListener('abort', () => emit(true), { once: true });
    } else if (toolProbe && !probeCalls.has(m.id)) {
      probeCalls.add(m.id);
      const message = { role: 'assistant', api: m.api, provider: m.provider, model: m.id, usage,
        content: [{ type: 'toolCall', id: `ls-${m.id}`, name: 'ls', arguments: { path: dir } }],
        stopReason: 'toolUse', timestamp: Date.now() };
      setTimeout(() => { stream.push({ type: 'done', reason: 'toolUse', message }); stream.end(); }, 1100);
    } else queueMicrotask(() => emit());
    return stream;
  },
};
const options = { runtime, registry, trusted: false };
const council = new Council({ sdk, agentDir: dir });
try {
  council.start({ cwd: dir, config, mode: 'plan', topic: 'Design a small feature' }, options);
  const first = await council.run('Initial constraint');
  assert.match(first, /Chair recommends human review/);
  assert.match(first, /Iterations this request: 2\/10/);
  assert(council.meeting.lastRound.results.every(r => r.status === 'ok'));
  const sessions = [...council.sessions.values()].map(s => s.session);
  assert(sessions.every(s => s.sessionFile === undefined));
  assert(observed.every(o => o.tools.map(t => t.name).sort().join(',') === 'find,grep,ls,read'));
  assert(!JSON.stringify(observed[0].messages).includes('model-b: published answer'));
  await council.run('Added rollback requirement');
  assert.deepEqual([...council.sessions.values()].map(s => s.session), sessions, 'Retain the same SDK objects');
  const second = observed.slice(6).filter(o => !JSON.stringify(o.messages.at(-2)).includes('CHAIR SYNTHESIS'));
  assert(second.every(o => o.messages.some(m => m.role === 'assistant')));
  for (const expected of ['Added rollback requirement', 'model-b: published answer', 'model/a:1: published answer']) {
    assert(second.every(o => JSON.stringify(o.messages.at(-2)).includes(expected)));
  }
  assert.match(await council.run('Keep dissent visible'), /published answer/);
  assert.deepEqual(readdirSync(dir), [], 'No meeting, transcript, session or PLAN files');

  fail = true;
  const beforeFailure = observed.length;
  await assert.rejects(() => council.run('Fail one participant'), /Discussion interrupted/);
  assert(council.meeting.lastRound.results.some(r => r.status === 'error'));
  assert.equal(observed.length - beforeFailure, 2, 'Failure must stop before chair synthesis or another iteration');
  fail = false;
  stall = true;
  const active = assert.rejects(() => council.run('Wait for cancellation'), /Discussion interrupted/);
  while (!observed.at(-1).messages.some(m => JSON.stringify(m.content).includes('Wait for cancellation'))) await new Promise(r => setTimeout(r, 5));
  await assert.rejects(() => council.run('Concurrent call'), /running/i);
  assert.throws(() => council.start({ cwd: dir, config, mode: 'plan', topic: 'Replacement' }, options), /running/i);
  await council.stop();
  await active;
  assert(council.meeting.lastRound.results.every(r => r.status === 'error'));
  stall = false;

  keepDiscussing = true;
  council.start({ cwd: dir, config: { ...config, maxRounds: 2 }, mode: 'discussion', topic: 'Two iterations' }, options);
  const beforeLimit = observed.length;
  const capped = await council.run();
  assert.equal(observed.length - beforeLimit, 6, 'Two peer calls plus one chair call per iteration');
  assert.match(capped, /Iteration limit reached/);
  assert(JSON.stringify(observed[beforeLimit + 3].messages).includes('Chair synthesis'));
  keepDiscussing = false;
  invalidDecision = true;
  await assert.rejects(() => council.run('Reconsider'), /invalid decision/);
  invalidDecision = false;

  toolProbe = true;
  council.start({ cwd: dir, config, mode: 'discussion', topic: 'Tool deadline test' }, options);
  const probeStart = observed.length;
  await council.run();
  const calls = observed.slice(probeStart).filter(o => !JSON.stringify(o.messages.at(-2)).includes('CHAIR SYNTHESIS'));
  assert.equal(calls.length, 6);
  for (const id of [model.id, 'model-b']) {
    const pair = calls.filter(o => o.id === id);
    const remaining = pair.map(o => Number(o.messages.at(-1).content.match(/Remaining: (\d+)/)[1]));
    assert(remaining[1] < remaining[0]);
    assert.equal(pair[1].messages.filter(m => typeof m.content === 'string' && m.content.includes('FACILITATOR TIME BUDGET')).length, 1);
  }
  toolProbe = false;
  stall = true;
  council.start({ cwd: dir, config: { ...config, timeoutSeconds: 10 }, mode: 'discussion', topic: 'Timeout' }, options);
  await assert.rejects(() => council.run(), /deadline/);
  assert(council.meeting.lastRound.results.every(r => r.status === 'error' && r.error.includes('deadline')));
  stall = false;
  await council.dispose();
  assert.equal(council.meeting, undefined);
  assert.equal(council.sessions.size, 0);
  assert.deepEqual(readdirSync(dir), []);

  mkdirSync(join(dir, 'extensions'));
  symlinkSync(join(import.meta.dirname, '..'), join(dir, 'extensions/council'), 'junction');
  const loader = new sdk.DefaultResourceLoader({ cwd: dir, agentDir: dir,
    settingsManager: sdk.SettingsManager.inMemory({ packages: [] }),
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.equal(loader.getExtensions().extensions.length, 1);
  const require = createRequire(join(root, 'dist/index.js'));
  const jiti = require('jiti').createJiti(join(root, 'dist/index.js'), {
    alias: { '@earendil-works/pi-coding-agent': join(root, 'dist/index.js'),
      '@earendil-works/pi-ai': join(root, 'node_modules/@earendil-works/pi-ai/dist/index.js'), typebox: require.resolve('typebox') },
  });
  const factory = await jiti.import(join(import.meta.dirname, '../index.ts'), { default: true });
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const commands = new Map(), tools = new Map(), events = new Map(), messages = [], requests = [];
    factory({ registerCommand: (n, c) => commands.set(n, c), registerTool: t => tools.set(t.name, t),
      on: (n, f) => events.set(n, f), sendUserMessage: m => requests.push(m),
      sendMessage: (m, opts) => { assert.equal(opts.triggerTurn, false); messages.push(m.content); } });
    const selections = ['Cancel'], inputs = [];
    const context = { cwd: dir, hasUI: true, isIdle: () => true,
      isProjectTrusted: () => false,
      modelRegistry: { ...registry, getRegisteredProviderIds: () => [], getAvailable: () => [model, { ...model, id: 'model-b' }] },
      ui: { select: async () => selections.shift(), input: async () => inputs.shift(), confirm: async () => true } };
    const command = commands.get('council');
    await command.handler('setup', context);
    assert(!existsSync(join(dir, 'council.json')));
    selections.push('Create a configuration template');
    await command.handler('setup', context);
    const template = readFileSync(join(dir, 'council.json'), 'utf8');
    assert.equal(JSON.parse(template).timeoutSeconds, 600);
    await command.handler('setup', context);
    assert.equal(readFileSync(join(dir, 'council.json'), 'utf8'), template);
    unlinkSync(join(dir, 'council.json'));
    selections.push('Choose registered models interactively', 'test/model/a:1', 'low', 'test/model-b', 'off', 'Done choosing', 'a');
    inputs.push('a', 'Architect', 'b', 'Critic');
    await command.handler('setup', context);
    assert.equal(JSON.parse(readFileSync(join(dir, 'council.json'), 'utf8')).participants[1].thinking, 'off');
    await commands.get('council-plan').handler('Design authentication', context);
    assert(requests.at(-1).includes('Design authentication'));
    assert(requests.at(-1).includes('start'));
    assert(tools.has('council'));
    const tool = tools.get('council');
    assert(tool.promptGuidelines.some(g => g.includes('iterates automatically')));
    await assert.rejects(() => tool.execute('no-meeting', { task: 'Continue' }, new AbortController().signal, undefined, context), /No active council/);
    const originalCreate = sdk.ModelRuntime.create;
    sdk.ModelRuntime.create = async () => runtime;
    try {
      const startIndex = observed.length;
      const started = await tool.execute('start', { task: 'Design authentication', newMeeting: true, mode: 'plan' }, new AbortController().signal, undefined, context);
      assert(started.content[0].text.includes('Chair recommends human review'));
      assert.equal(observed.length - startIndex, 6);
      const followup = await tool.execute('followup', { task: 'Reconsider rollback safety' }, new AbortController().signal, undefined, context);
      assert(followup.content[0].text.includes('published answer'));
      const followupCalls = observed.slice(startIndex + 6);
      assert(followupCalls.every(o => o.messages.some(m => m.role === 'assistant')));
      assert(followupCalls.every(o => JSON.stringify(o.messages).includes('Reconsider rollback safety')));
    } finally { sdk.ModelRuntime.create = originalCreate; }
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(() => tools.get('council').execute('test', { task: 'Reconsider' }, aborted.signal, undefined, context), /cancelled/);
    await events.get('session_shutdown')();
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
  console.log('PASS: config/UI, natural-language tool registration, same in-memory SDK sessions, no saved artifacts, peer exchange, limits, cancellation, timeout, loader');
} finally { await council.dispose(); rmSync(dir, { recursive: true, force: true }); }
