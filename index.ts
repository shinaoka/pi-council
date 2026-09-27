import * as sdk from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { StringEnum } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { Council, applyParticipantOverride, validateConfig } from './core.mjs';

const thinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

const rolePresets = [
  { name: 'chair', role: 'Requirements-first design chair. Establish detailed requirements, testable acceptance criteria and non-goals before discussing implementation. Do not propose implementation steps or code until the design is complete.' },
  { name: 'critic', role: 'Adversarial requirements reviewer. Find ambiguity, missing acceptance criteria, edge cases, unsafe assumptions and unnecessary scope. Do not implement.' },
  { name: 'minimalist', role: 'Minimal-scope advocate. Reject speculative features and abstractions, and prefer the smallest verifiable design. Do not implement.' },
];

const help = `Council / Council Plan
/council-plan <topic> — discuss and synthesize a design/spec
/council <topic> — start an automatically iterated general discussion
/council setup — choose models and optional inspection tools, edit existing tool permissions, or create a config template
/council models — list models with configured authentication
/council stop — cancel active discussion (Esc also cancels a running tool)
/council help — show this help
The chair synthesizes after each iteration and decides whether further discussion would help.
Default limits: 10 iterations per request, 600 seconds per response.
Afterward, use natural language, e.g. "Have the council reconsider rollback safety."
After reviewing the design: "I approve this design. Expand it into a detailed implementation plan."
Keep extra requirements and constraints concise in the council tool's context field (16,000 characters).
For large documents or background context, pass absolute file paths and ask participants to read them;
participants have configured inspection tools (read is available by default). Reuse existing files.
Configure participant tools and additional extension paths in council.json; no provider-specific wiring is needed.
When a specific roster is wanted, pass the council tool's participants and chair fields with
model ids from /council models; they start a new council and override both council.json and the setup UI.
That second stage uses the chair model only, without another debate or implementation.
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

  async function chooseTools(ctx: ExtensionContext, config: ReturnType<typeof validateConfig>) {
    const candidates = pi.getAllTools().filter(tool =>
      isAbsolute(tool.sourceInfo.path) && !['council', 'council_implementation_plan'].includes(tool.name));
    if (!candidates.length) return config;
    const selected = new Set<string>(config.tools ?? sdk.createReadOnlyTools(ctx.cwd).map(tool => tool.name));
    const labels = candidates.map(tool => `${tool.name} — ${tool.description.slice(0, 100)}`);
    while (true) {
      const choices = labels.map((label, i) => `${selected.has(candidates[i].name) ? '[x]' : '[ ]'} ${label}`);
      const choice = await ctx.ui.select('Council inspection tools: select to toggle (only permit trusted tools)', ['Done selecting tools', ...choices, 'Cancel']);
      if (!choice || choice === 'Cancel') return;
      if (choice === 'Done selecting tools') break;
      const name = candidates[choices.indexOf(choice)]?.name;
      if (name) { if (selected.has(name)) selected.delete(name); else selected.add(name); }
    }
    const discoveredPaths = new Set(candidates.map(tool => tool.sourceInfo.path));
    const extensions = new Set<string>((config.extensions ?? []).filter((path: string) => !discoveredPaths.has(path)));
    for (const tool of candidates) if (selected.has(tool.name)) extensions.add(tool.sourceInfo.path);
    return validateConfig({ ...config, tools: [...selected], extensions: [...extensions] });
  }

  async function configure(ctx: ExtensionContext, editTools = false) {
    const existing = existsSync(configFile) ? validateConfig(JSON.parse(readFileSync(configFile, 'utf8'))) : unsavedConfig;
    if (existing) {
      if (!editTools || !ctx.hasUI) return existing;
      const updated = await chooseTools(ctx, existing);
      if (!updated) return;
      if (JSON.stringify(updated) === JSON.stringify(existing)) return existing;
      if (!await ctx.ui.confirm('Save council tool permissions?', `${configFile}\nTools: ${(updated.tools ?? []).join(', ')}\nExtensions: ${(updated.extensions ?? []).join(', ')}\nSelected extensions execute trusted code at startup/shutdown; tool selection is not a sandbox.`)) return existing;
      writeFileSync(configFile, JSON.stringify(updated, null, 2) + '\n', { mode: 0o600 });
      return (unsavedConfig = updated);
    }
    if (!ctx.hasUI) throw new Error(`Create a configuration file first: ${configFile}`);
    const choice = await ctx.ui.select('Council configuration is missing', [
      'Choose registered models interactively', 'Create a configuration template', 'Cancel',
    ]);
    if (!choice || choice === 'Cancel') return;
    if (choice === 'Create a configuration template') {
      writeFileSync(configFile, JSON.stringify({ participants: [
        { name: rolePresets[0].name, model: 'PROVIDER/MODEL_ID', role: rolePresets[0].role, thinking: 'medium' },
        { name: rolePresets[1].name, model: 'PROVIDER/OTHER_MODEL_ID', role: rolePresets[1].role, thinking: 'medium' },
      ], chair: rolePresets[0].name, timeoutSeconds: 600, maxRounds: 10 }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      show(`Created template: ${configFile}\nReplace placeholders with exact IDs from /council models. No model requests were made.`);
      return;
    }
    const models = available(ctx);
    if (!models.length) throw new Error('No models with configured authentication. Use /login first.');
    const participants: { name: string; model: string; role: string; thinking: string }[] = [];
    while (participants.length < 6) {
      const preset = rolePresets[participants.length] ?? { name: `member${participants.length + 1}`, role: 'Bring an independent perspective without expanding scope or implementing.' };
      const model = await ctx.ui.select(`Model for ${preset.name}`,
        participants.length >= 2 ? ['Done choosing', ...models] : models);
      if (!model) return;
      if (model === 'Done choosing') break;
      const thinking = await ctx.ui.select('Thinking (SDK adjusts to supported levels)', ['medium', 'low', 'high', 'off', 'minimal', 'xhigh', 'max']);
      if (!thinking) return;
      participants.push({ ...preset, model, thinking });
    }
    const chair = await ctx.ui.select('Chair responsible for synthesis', participants.map(p => p.name));
    if (!chair) return;
    const config = await chooseTools(ctx, validateConfig({ participants, chair }));
    if (!config) return;
    if (await ctx.ui.confirm('Save this configuration?', `${configFile}\nTools: ${(config.tools ?? sdk.createReadOnlyTools(ctx.cwd).map(tool => tool.name)).join(', ')}\nExtensions: ${(config.extensions ?? []).join(', ')}\nSelected extensions execute trusted code at startup/shutdown; tool selection is not a sandbox.`)) {
      writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    }
    return (unsavedConfig = config);
  }

  async function withOperation<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
    if (working || closing) throw new Error('Council is busy or shutting down');
    if (signal?.aborted) throw new Error('Council cancelled');
    working = true;
    cancelled = false;
    const abort = () => { cancelled = true; void council.stop(); };
    signal?.addEventListener('abort', abort, { once: true });
    try { return await work(); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(message.slice(0, 48000) + (message.length > 48000 ? '\n[Error output truncated.]' : ''));
    } finally {
      signal?.removeEventListener('abort', abort);
      working = false;
    }
  }

  pi.registerTool({
    name: 'council', label: 'Council',
    description: 'Run a multi-model discussion with automatic peer criticism and chair synthesis, stopping when the chair recommends review or the configured iteration limit is reached. Set newMeeting to true to start; otherwise requires and reuses the current in-memory council. Keep context concise (16,000 characters maximum); for large documents or background context, pass absolute file paths and ask participants to read them with their configured inspection tools rather than pasting the contents. Pass participants (and optional chair) to run a new council on specific models instead of the configured roster. Exit/reload discards that council. No separate meeting or PLAN files are saved. Output is limited to 48,000 characters.',
    promptSnippet: 'Ask multiple models to discuss a task, or reconsider the active council with new feedback.',
    promptGuidelines: [
      'Use council when the user explicitly requests a multi-model discussion or asks to revisit the active council. Natural-language feedback goes in task.',
      'The council tool iterates automatically. Do not call council again just to continue its loop, retry an error, or bypass its limit without a new user request.',
      'Treat council synthesis as a design proposal, not proof of agreement or correctness. Present it for user review. Do not automatically call council_implementation_plan or implement anything.',
      'When starting a new council, pass concise parent-provided requirements, constraints and known facts in context; do not copy the full parent conversation.',
      'For large documents or background context, pass absolute file paths in task/context and explicitly ask participants to read them with their configured inspection tools (read is available by default). Reuse existing files; if the material exists only in conversation, save the relevant material to a local file first. Keep task and context within 16,000 characters each; do not paste large contents into either field.',
      'Prepare oversized single-line artifacts as readable multiline files before dispatch (for example, pretty-printed JSON). Shell access is not enabled by default; ask participants to continue paginated reads when truncated and report any unread material rather than claim a complete review.',
      'Pass participants (2–6 objects with model, optional name, role and thinking) and optional chair to choose the models for a new council; both require newMeeting and override the configured roster for that council.',
      'Models are selected from the local registry; do not assume or require a specific provider or model name unless the user asks for one. The parent model is the currently active pi session and is not configured here.'
    ],
    parameters: Type.Object({
      task: Type.String({ description: 'Topic for a new council, or user feedback for the current council' }),
      context: Type.Optional(Type.String({ maxLength: 16000, description: 'Concise requirements, constraints and known facts; for large context, supply absolute file paths and ask participants to read them instead of pasting contents' })),
      newMeeting: Type.Optional(Type.Boolean({ description: 'Discard the current in-memory council and start a new one' })),
      mode: Type.Optional(StringEnum(['plan', 'discussion'] as const)),
      participants: Type.Optional(Type.Array(Type.Object({
        name: Type.Optional(Type.String({ maxLength: 64, description: 'Display name; defaults to the model id tail' })),
        model: Type.String({ maxLength: 300, description: 'provider/exact-model-id, as listed by /council models' }),
        role: Type.Optional(Type.String({ maxLength: 4000, description: 'Role instruction; defaults to the configured role in this position' })),
        thinking: Type.Optional(StringEnum(thinkingLevels)),
      }, { additionalProperties: false }), { minItems: 2, maxItems: 6, description: 'Roster for this new council, replacing the configured participants; requires newMeeting' })),
      chair: Type.Optional(Type.String({ maxLength: 64, description: 'Participant name that synthesizes; defaults to the configured chair when it is among the new participants' })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      if (!params.task.trim()) throw new Error('Specify a topic or feedback');
      if (params.task.length > 16000) throw new Error('Task exceeds 16,000 characters');
      if (params.context !== undefined && params.context.length > 16000) throw new Error('Context exceeds 16,000 characters');
      return withOperation(signal, async () => {
        const fresh = params.newMeeting === true;
        const override = params.participants !== undefined || params.chair !== undefined
          ? { participants: params.participants, chair: params.chair }
          : undefined;
        if (!fresh && params.context !== undefined) throw new Error('Context can only be supplied when starting a new council');
        if (!fresh && override) throw new Error('participants and chair can only be supplied when starting a new council (newMeeting: true)');
        if (!fresh && !council.meeting) throw new Error('No active council. Start a new one with newMeeting: true and the complete topic.');
        if (fresh) {
          const baseConfig = await configure(ctx);
          if (!baseConfig) return { content: [{ type: 'text', text: 'Council not started. Finish configuration or request a new discussion when ready.' }], details: {} };
          const config = applyParticipantOverride(baseConfig, override);
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
          await council.start({ cwd: ctx.cwd, config, mode: params.mode ?? 'discussion', topic: params.task, context: params.context },
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
      });
    },
  });

  pi.registerTool({
    name: 'council_implementation_plan', label: 'Implementation Plan',
    description: 'Expand the latest completed council design into a detailed implementation plan using only the configured chair model. Requires explicit user approval of that design. Does not rerun the council, save files, or implement code. Returns the full plan or an error if it exceeds 48,000 UTF-8 bytes / 2,000 lines.',
    promptSnippet: 'After user approval, expand the current council design into a detailed single-model implementation plan.',
    promptGuidelines: [
      'Call council_implementation_plan only after the user explicitly approves the latest council design and asks for detailed planning. Set approved to true only on that basis; chair DONE is not user approval.',
      'Do not plan from an incomplete design: the plan-mode chair must establish concrete requirements, testable acceptance criteria and the other required design sections first.',
      'Do not call council_implementation_plan automatically after council. Do not repeat it to retry an error or bypass a timeout without a new user request.',
      'Pass requested planning detail in instructions. Material design changes must go back to council for review, not be silently added to an approved design.',
      'Return the detailed plan without implementing it. Approval for planning is not approval for implementation.',
    ],
    parameters: Type.Object({
      approved: Type.Boolean({ description: 'True only if the user explicitly approved the latest design and requested detailed planning' }),
      instructions: Type.Optional(Type.String({ description: 'Additional planning instructions or requested task scope' })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      return withOperation(signal, async () => {
        if (council.meeting && ctx.cwd !== council.meeting.cwd) throw new Error('Working directory changed; start a new council');
        const result = await council.implementationPlan(params);
        return { content: [{ type: 'text', text: result }], details: {} };
      });
    },
  });

  for (const [command, mode] of [['council', 'discussion'], ['council-plan', 'plan']] as const) {
    pi.registerCommand(command, {
      description: mode === 'plan' ? 'Discuss a design/spec before detailed implementation planning' : 'Discuss a topic with multiple models; help / setup / models / stop',
      handler: async (args, ctx) => {
        try {
          const input = args.trim();
          if (!input || input === 'help') { show(help); return; }
          if (input === 'models') { show(available(ctx).join('\n') || 'No models available. Check /login.'); return; }
          if (input === 'stop') { cancelled = true; await council.stop(); show('Council stop requested.'); return; }
          if (working) throw new Error('Council is running. Use Esc or /council stop to cancel.');
          if (input === 'setup') {
            const config = await configure(ctx, true);
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
