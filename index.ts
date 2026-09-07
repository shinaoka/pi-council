import * as sdk from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { StringEnum } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Council, validateConfig } from './core.mjs';

const help = `Council / Council Plan
/council-plan <topic> — start an automatically iterated planning discussion
/council <topic> — start an automatically iterated general discussion
/council setup — choose models interactively or create a config template
/council models — list models with configured authentication
/council stop — cancel active discussion (Esc also cancels a running tool)
/council help — show this help
The chair synthesizes after each iteration and decides whether further discussion would help.
Default limits: 10 iterations per request, 600 seconds per response.
Afterward, use natural language, e.g. "Have the council reconsider rollback safety."
No separate meeting files are saved. Exit or /reload discards the council.`;

export default function (pi: ExtensionAPI) {
  const agentDir = sdk.getAgentDir();
  const configFile = join(agentDir, 'council.json');
  const council = new Council({ sdk, agentDir });
  let unsavedConfig: ReturnType<typeof validateConfig> | undefined;
  let working = false, closing = false, cancelled = false;
  const show = (content: string) => {
    if (!closing) pi.sendMessage({ customType: 'pi-council', content, display: true }, { triggerTurn: false });
  };
  const available = (ctx: ExtensionContext) => ctx.modelRegistry.getAvailable().map(m => `${m.provider}/${m.id}`).sort();

  async function configure(ctx: ExtensionContext) {
    if (existsSync(configFile)) return validateConfig(JSON.parse(readFileSync(configFile, 'utf8')));
    if (unsavedConfig) return unsavedConfig;
    if (!ctx.hasUI) throw new Error(`Create a configuration file first: ${configFile}`);
    const choice = await ctx.ui.select('Council configuration is missing', [
      'Choose registered models interactively', 'Create a configuration template', 'Cancel',
    ]);
    if (!choice || choice === 'Cancel') return;
    if (choice === 'Create a configuration template') {
      writeFileSync(configFile, JSON.stringify({ participants: [
        { name: 'architect', model: 'PROVIDER/MODEL_ID', role: 'Propose the simplest viable design', thinking: 'medium' },
        { name: 'critic', model: 'PROVIDER/OTHER_MODEL_ID', role: 'Challenge assumptions, safety and test coverage', thinking: 'medium' },
      ], chair: 'architect', timeoutSeconds: 600, maxRounds: 10 }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
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
    return (unsavedConfig = config);
  }

  pi.registerTool({
    name: 'council', label: 'Council',
    description: 'Run a multi-model discussion with automatic peer criticism and chair synthesis, stopping when the chair recommends review or the configured iteration limit is reached. Set newMeeting to true to start; otherwise requires and reuses the current in-memory council. Exit/reload discards that council. No separate meeting or PLAN files are saved. Output is limited to 48,000 characters.',
    promptSnippet: 'Ask multiple models to discuss a task, or reconsider the active council with new feedback.',
    promptGuidelines: [
      'Use council when the user explicitly requests a multi-model discussion or asks to revisit the active council. Natural-language feedback goes in task.',
      'The council tool iterates automatically. Do not call council again just to continue its loop, retry an error, or bypass its limit without a new user request.',
      'Treat council synthesis as advice, not proof of agreement or correctness. Do not implement a council plan unless the user asks.',
    ],
    parameters: Type.Object({
      task: Type.String({ description: 'Topic for a new council, or user feedback for the current council' }),
      newMeeting: Type.Optional(Type.Boolean({ description: 'Discard the current in-memory council and start a new one' })),
      mode: Type.Optional(StringEnum(['plan', 'discussion'] as const)),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      if (working || closing) throw new Error('Council is busy or shutting down');
      if (!params.task.trim()) throw new Error('Specify a topic or feedback');
      if (params.task.length > 16000) throw new Error('Task exceeds 16,000 characters');
      if (signal?.aborted) throw new Error('Council cancelled');
      working = true;
      cancelled = false;
      const abort = () => { cancelled = true; void council.stop(); };
      signal?.addEventListener('abort', abort, { once: true });
      try {
        const fresh = params.newMeeting === true;
        if (!fresh && !council.meeting) throw new Error('No active council. Start a new one with newMeeting: true and the complete topic.');
        if (fresh) {
          const config = await configure(ctx);
          if (!config) return { content: [{ type: 'text', text: 'Council not started. Finish configuration or request a new discussion when ready.' }], details: {} };
          const runtime = await sdk.ModelRuntime.create({
            authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json'),
            signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]), allowModelNetwork: false,
          });
          for (const id of ctx.modelRegistry.getRegisteredProviderIds()) {
            const native = ctx.modelRegistry.getRegisteredNativeProvider(id);
            const provider = ctx.modelRegistry.getRegisteredProviderConfig(id);
            if (native) runtime.registerNativeProvider(native);
            if (provider) runtime.registerProvider(id, provider);
          }
          if (closing || cancelled) throw new Error('Council cancelled');
          council.start({ cwd: ctx.cwd, config, mode: params.mode ?? 'discussion', topic: params.task },
            { runtime, registry: ctx.modelRegistry, trusted: ctx.isProjectTrusted() });
        } else {
          if (ctx.cwd !== council.meeting.cwd) throw new Error('Working directory changed; start a new council');
          if (params.mode && params.mode !== council.meeting.mode) throw new Error('Use newMeeting to change council mode');
        }
        if (closing || cancelled) throw new Error('Council cancelled');
        const result = await council.run(fresh ? '' : params.task, text => {
          onUpdate?.({ content: [{ type: 'text', text }], details: {} });
        });
        return { content: [{ type: 'text', text: result.slice(0, 48000) + (result.length > 48000 ? '\n[Output truncated; request a shorter synthesis.]' : '') }], details: {} };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(message.slice(0, 48000) + (message.length > 48000 ? '\n[Error output truncated.]' : ''));
      } finally {
        signal?.removeEventListener('abort', abort);
        working = false;
      }
    },
  });

  for (const [command, mode] of [['council', 'discussion'], ['council-plan', 'plan']] as const) {
    pi.registerCommand(command, {
      description: mode === 'plan' ? 'Create a PLAN through automatic multi-model discussion' : 'Discuss a topic with multiple models; help / setup / models / stop',
      handler: async (args, ctx) => {
        try {
          const input = args.trim();
          if (!input || input === 'help') { show(help); return; }
          if (input === 'models') { show(available(ctx).join('\n') || 'No models available. Check /login.'); return; }
          if (input === 'stop') { cancelled = true; await council.stop(); show('Council stop requested.'); return; }
          if (working) throw new Error('Council is running. Use Esc or /council stop to cancel.');
          if (input === 'setup') {
            const config = await configure(ctx);
            if (config) show(`${existsSync(configFile) ? configFile : 'Unsaved configuration'}\n${JSON.stringify(config, null, 2)}`);
            return;
          }
          pi.sendUserMessage(`Use the council tool once with these arguments (start a new council). Return its synthesis without implementing it:\n${JSON.stringify({ task: input, newMeeting: true, mode })}`,
            ctx.isIdle() ? undefined : { deliverAs: 'followUp' });
        } catch (error) { show(`Council error: ${error instanceof Error ? error.message : String(error)}`); }
      },
    });
  }
  pi.on('session_shutdown', async () => { closing = true; cancelled = true; await council.dispose(); });
}
