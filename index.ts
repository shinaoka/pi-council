import * as sdk from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Council, validateConfig, resolveParticipants } from './core.mjs';

const help = `Council / Council Plan
/council models — list pi models with configured authentication
/council setup — choose participants interactively or create a config template
/council-plan new <topic> — start a planning meeting with independent proposals
/council new <topic> — start a general discussion
/council round [feedback] — next round using the same participant sessions
/council finish — chair synthesizes and saves a PLAN or CONCLUSION
/council stop — cancel active work, keeping saved histories
/council status | list | resume <id>
Each round stops for your feedback. No implementation is performed.`;

export default function (pi: ExtensionAPI) {
  const agentDir = sdk.getAgentDir();
  const configFile = join(agentDir, 'council.json');
  const council = new Council({ sdk, agentDir });
  let selected: string | undefined;
  let operation: Promise<void> | undefined;
  let closing = false;
  let cancelRequested = false;
  let unsavedConfig: ReturnType<typeof validateConfig> | undefined;

  function show(content: string) {
    if (closing) return;
    pi.sendMessage({ customType: 'pin-council', content, display: true }, { triggerTurn: false });
  }
  function select(id: string) {
    selected = id;
    pi.appendEntry('pin-council-selection', { id });
  }
  const available = (ctx: ExtensionCommandContext) => ctx.modelRegistry.getAvailable()
    .map(m => `${m.provider}/${m.id}`).sort();

  async function configure(ctx: ExtensionCommandContext) {
    if (existsSync(configFile)) return validateConfig(JSON.parse(readFileSync(configFile, 'utf8')));
    if (unsavedConfig) return unsavedConfig;
    if (!ctx.hasUI) throw new Error(`Create a configuration file first: ${configFile}`);
    const choice = await ctx.ui.select('Council configuration is missing', [
      'Choose registered models interactively', 'Create a configuration template', 'Cancel',
    ]);
    if (!choice || choice === 'Cancel') return;
    if (choice === 'Create a configuration template') {
      const template = {
        participants: [
          { name: 'architect', model: 'PROVIDER/MODEL_ID', role: 'Propose the simplest viable design', thinking: 'medium' },
          { name: 'critic', model: 'PROVIDER/OTHER_MODEL_ID', role: 'Challenge assumptions, safety and test coverage', thinking: 'medium' },
        ], chair: 'architect', timeoutSeconds: 600, maxRounds: 10,
      };
      writeFileSync(configFile, JSON.stringify(template, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      show(`Created template: ${configFile}\nReplace placeholders with exact IDs from /council models. No model requests were made.`);
      return;
    }
    const models = available(ctx);
    if (!models.length) throw new Error('No models with configured authentication. Use /login first.');
    const participants: { name: string; model: string; role: string; thinking: string }[] = [];
    while (participants.length < 6) {
      const model = await ctx.ui.select(`Model for participant ${participants.length + 1}`,
        participants.length >= 2 ? ['Done choosing', ...models] : models);
      if (!model) return;
      if (model === 'Done choosing') break;
      const name = await ctx.ui.input('Participant name (letters, digits, _ and -)', `member${participants.length + 1}`);
      if (!name) return;
      const role = await ctx.ui.input('Role', participants.length ? 'Challenge assumptions, risks and verification' : 'Propose a simple design');
      if (!role) return;
      const thinking = await ctx.ui.select('Thinking (SDK adjusts to supported levels)', ['medium', 'low', 'high', 'off', 'minimal', 'xhigh', 'max']);
      if (!thinking) return;
      participants.push({ name, model, role, thinking });
    }
    const chair = await ctx.ui.select('Chair responsible for synthesis', participants.map(p => p.name));
    if (!chair) return;
    const config = validateConfig({ participants, chair });
    if (await ctx.ui.confirm('Save this configuration?', configFile)) {
      writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    }
    unsavedConfig = config;
    return config;
  }

  async function options(ctx: ExtensionCommandContext) {
    // Reuse pi's auth files and provider definitions, not arbitrary child extensions.
    const runtime = await sdk.ModelRuntime.create({
      authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json'),
      signal: AbortSignal.timeout(15000), allowModelNetwork: false,
    });
    for (const id of ctx.modelRegistry.getRegisteredProviderIds()) {
      const native = ctx.modelRegistry.getRegisteredNativeProvider(id);
      const config = ctx.modelRegistry.getRegisteredProviderConfig(id);
      if (native) runtime.registerNativeProvider(native);
      if (config) runtime.registerProvider(id, config);
    }
    return { runtime, registry: ctx.modelRegistry, trusted: ctx.isProjectTrusted() };
  }
  function launch(ctx: ExtensionCommandContext, work: () => Promise<string>) {
    if (operation) throw new Error('Council is running. Use /council stop to cancel.');
    if (!ctx.hasUI) throw new Error('Running a council requires interactive or RPC mode.');
    cancelRequested = false;
    ctx.ui.setStatus('pin-council', 'Council: running · /council stop');
    operation = (async () => {
      try { show(await work()); }
      catch (error) { show(`Council error: ${error instanceof Error ? error.message : String(error)}`); }
      finally {
        operation = undefined;
        if (!closing) ctx.ui.setStatus('pin-council', selected ? `Council: ${selected.slice(0, 8)} · idle` : undefined);
      }
    })();
  }
  async function run(ctx: ExtensionCommandContext, id: string, action: 'round' | 'finish', feedback = '') {
    const opts = await options(ctx);
    if (cancelRequested || closing) throw new Error('Council stopped');
    // Revalidate cwd immediately before every operation, including restored selections.
    council.load(id, ctx.cwd);
    if (action === 'finish') {
      const path = await council.finish(id, opts);
      const content = readFileSync(path, 'utf8');
      return `Saved draft (requires human approval): ${path}\n\n${content.slice(0, 18000)}${content.length > 18000 ? '\n[Full text in the file above]' : ''}`;
    }
    const { meeting, text } = await council.round(id, feedback, opts);
    const errors = meeting.rounds.at(-1).results.filter(r => r.status !== 'ok').length;
    const thinking = meeting.rounds.at(-1).results.map(r => `${r.name}: ${r.thinking ?? 'failed'}`).join(', ');
    return `Council ${id} · Round ${meeting.rounds.length} · ${errors ? `${errors} failed` : 'complete'}\n` +
      `Thinking (effective): ${thinking}\nRecord: ${council.directory(id)}/meeting.json\n\n` +
      text.slice(0, 18000) + (text.length > 18000 ? '\n[Full text in the file above]' : '') +
      '\n\nNext: /council round <feedback> or /council finish';
  }

  async function handler(args: string, ctx: ExtensionCommandContext, mode: 'plan' | 'discussion') {
    try {
      const [action = '', ...words] = args.trim().split(/\s+/);
      const rest = words.join(' ');
      if (!action || action === 'help') { show(help); return; }
      if (action === 'stop') {
        cancelRequested = true;
        await council.stop();
        await operation;
        show('Council stopped. Saved histories are retained.');
        return;
      }
      if (action === 'models') { show(available(ctx).join('\n') || 'No models available. Check /login.'); return; }
      if (action === 'list') {
        show(council.list(ctx.cwd).map(m => `${m.id} [${m.mode}] R${m.rounds.length} ${m.topic}`).join('\n') || 'No meetings for this working directory.');
        return;
      }
      if (action === 'status') {
        if (!selected) { show('No meeting selected. Use /council list or /council new <topic>'); return; }
        const m = council.load(selected, ctx.cwd);
        show(`${selected} [${m.mode}] ${operation ? 'running' : 'idle'}\n${m.topic}\nRounds: ${m.rounds.length}/${m.config.maxRounds}\n` +
          m.config.participants.map(p => `${p.name}: ${p.model} (${p.thinking})`).join('\n') + `\n${council.directory(selected)}`);
        return;
      }
      if (operation) throw new Error('Council is running. Use /council stop before changing meetings.');
      if (action === 'setup') {
        const config = await configure(ctx);
        if (config) show(`${existsSync(configFile) ? configFile : 'Unsaved configuration'}\n${JSON.stringify(config, null, 2)}`);
        return;
      }
      if (action === 'resume') {
        const m = council.load(rest, ctx.cwd);
        select(m.id);
        show(`Selected meeting: ${m.id}\n${m.topic}\nNo model requests made. Use /council round <feedback> to continue.`);
        return;
      }
      if (action === 'round' || action === 'finish') {
        if (!selected) throw new Error('No meeting selected. Use /council resume <id> or /council new <topic>');
        const id = selected;
        launch(ctx, () => run(ctx, id, action, rest));
        return;
      }
      if (mode === 'discussion' && action !== 'new') throw new Error('Unknown council action. Use /council help.');
      if (!ctx.hasUI) throw new Error('Running a council requires interactive or RPC mode.');
      const topic = action === 'new' ? rest : args.trim();
      if (!topic) throw new Error('Specify a meeting topic.');
      const config = await configure(ctx);
      if (!config || closing) return;
      if (operation) throw new Error('Another council operation started while configuring participants.');
      resolveParticipants(config, ctx.modelRegistry);
      const meeting = council.create({ cwd: ctx.cwd, config, mode, topic });
      select(meeting.id);
      show(`Created meeting: ${meeting.id}\n${config.participants.map(p => `${p.name}: ${p.model}`).join('\n')}\nStarting model requests for each participant. Use /council stop to cancel.`);
      launch(ctx, () => run(ctx, meeting.id, 'round'));
    } catch (error) {
      show(`Council error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  pi.registerCommand('council', {
    description: 'Persistent multi-model discussion: new / round / finish / resume / setup',
    handler: (args, ctx) => handler(args, ctx, 'discussion'),
  });
  pi.registerCommand('council-plan', {
    description: 'Create a PLAN through persistent multi-model council discussion (no implementation)',
    handler: (args, ctx) => handler(args, ctx, 'plan'),
  });
  pi.on('session_start', (_event, ctx) => {
    closing = false;
    selected = undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === 'custom' && entry.customType === 'pin-council-selection') {
        const id = (entry.data as { id?: string })?.id;
        if (id) selected = id;
      }
    }
  });
  pi.on('session_shutdown', async () => {
    closing = true;
    cancelRequested = true;
    await council.stop();
    await operation;
  });
}
