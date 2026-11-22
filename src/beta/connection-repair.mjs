import {randomUUID} from 'node:crypto';
import {canonical, digest} from '../harness/contracts.mjs';
import {ProviderRegistry} from '../harness/providers/registry.mjs';
import {isLoopbackProvider,workerEndpoint} from '../harness/worker-profile.mjs';
import {entry, jsonFile, withLock} from './files.mjs';
import {readHostConnection} from './hosts/connection-evidence.mjs';
import {formatHostRegistrationGuide, getHost} from './hosts/index.mjs';
import {validateMultiWorkerCredentials} from './multi-worker-setup.mjs';
import {applyPortableWorkerRepair, readPortableRepairBinding, resumePortableSetup} from './portable-setup.mjs';
import {SETUP_PROBE_MESSAGE, createProviderDiagnostic, discoverProvider, formatProviderDiagnostic, probeProvider} from './provider-diagnostics.mjs';
import {assertMaintenanceIdle, assertSettingsMaintenanceAllowed} from './service.mjs';
import {configuredPolicies, normalizeSettings, readCredentialsSync, readSettingsSync} from './settings.mjs';
import {askSession, codexRegistrations} from './setup.mjs';

const usage = 'Use mosaic repair [--host | --worker ID [--discover] [--probe] | --resume].';
const interruption = 'Repair interrupted. Run mosaic repair to check for an approved repair to resume.';
const approved = value => /^y(es)?$/i.test(value);
const credentialExists = (profile, credentials) => profile.credentialRef !== null && Object.hasOwn(credentials.entries, profile.credentialRef);
// Keep terminal formatting and prompts on single lines even for Unicode model IDs.
const quoted = value => JSON.stringify(value).replace(/[\p{C}\p{Zl}\p{Zp}]/gu, character => `\\u{${character.codePointAt(0).toString(16)}}`);

function parseArgs(args) {
  const [command, workerId, ...checks] = args;
  if (!args.length) return {command: 'diagnose'};
  if (args.length === 1 && ['--host', '--resume'].includes(command)) return {command};
  if (command !== '--worker' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(workerId ?? '') ||
      checks.some(check => !['--discover', '--probe'].includes(check)) || new Set(checks).size !== checks.length) throw Error(usage);
  return {command, workerId, discovery: checks.includes('--discover'), probe: checks.includes('--probe')};
}

async function diagnose(paths, settings, credentials, pending, options, {hostOnly = false} = {}) {
  const {output} = options;
  if (pending) output.write(pending.repair ? 'A previously approved worker repair is pending. Run mosaic repair --resume.\n' : 'Setup is pending. Run mosaic setup to resume.\n');
  if (!settings) {
    output.write('No Mosaic connection settings found. Run mosaic setup to connect a coding app or add a worker.\n');
    return [];
  }
  const host = getHost(settings.host?.id ?? 'codex');
  if (hostOnly) {
    output.write(formatHostRegistrationGuide(host.previewRegistration({paths, launcher: paths.launcher})));
    return [];
  }
  const connection = await readHostConnection(paths).catch(() => null);
  output.write(`Coding app: ${host.displayName}. ${connection ? 'A bridge call was recorded for these settings.' : 'No bridge call is recorded for these settings.'}\n`);
  output.write('Review the connection steps with mosaic repair --host.\n');
  if (!await entry(paths.launcher)) output.write('Mosaic launcher is missing. Run mosaic doctor to check the installation.\n');
  if (settings.schema === 1) {
    output.write('Worker repair uses portable settings. Run mosaic migrate to review the settings upgrade.\n');
    return [];
  }
  let canRepairWorker = !pending;
  if (!pending) {
    try {
      await readPortableRepairBinding(paths, settings, options);
      output.write('Saved coding app instructions are current with these settings.\n');
    } catch {
      canRepairWorker = false;
      output.write('The saved coding app binding needs attention. Review the app instructions or run mosaic setup to recover setup.\n');
    }
    try {
      await assertMaintenanceIdle(paths, {settingsChange: true});
    } catch (error) {
      canRepairWorker = false;
      if (/unresolved|stopped|revision/i.test(error.message)) output.write('Resolve the existing work in its coding app before saving a worker change.\n');
      else output.write('Run mosaic doctor to check the local coordinator and saved work.\n');
    }
  }
  if (!credentials) {
    output.write('Private worker settings or credentials could not be read safely. Run mosaic doctor to check the local setup.\n');
    return [];
  }
  const workers = settings.providers.filter(profile => profile.roles.includes('worker'));
  if (!workers.length) output.write('No API worker is configured. Run mosaic setup to add one.\n');
  for (const profile of workers) {
    const key = profile.credentialRef === null ? 'no bearer key configured' : credentialExists(profile, credentials) ? 'bearer key saved' : 'bearer key missing';
    output.write(`Worker ${profile.id}: ${quoted(profile.baseUrl)} · ${quoted(profile.model)} · ${key}.\n`);
    if (profile.roles.includes('reviewer')) output.write('This profile also handles API review. Run mosaic setup to review both roles together.\n');
    else if (canRepairWorker) output.write(`Edit this connection with mosaic repair --worker ${profile.id}.\n`);
  }
  output.write('Provider connectivity is unchecked. This diagnosis used local records.\n');
  return canRepairWorker ? workers.filter(profile => !profile.roles.includes('reviewer')) : [];
}

async function collectChange(profile, credentials, settings, ask) {
  const baseUrl = await ask(`API base URL [${quoted(profile.baseUrl)}]: `, {masked: true}) || profile.baseUrl;
  const sameUrl = workerEndpoint(baseUrl) === profile.baseUrl;
  const model = await ask(`Exact model ID [${quoted(profile.model)}]: `) || profile.model;
  const canKeep = sameUrl && credentialExists(profile, credentials);
  const choice = (await ask(canKeep
    ? 'Bearer key: keep [k], replace [r], or remove [n] [k]: '
    : 'Bearer key: enter a key [r] or use no key [n] [n]: ')).toLowerCase() || (canKeep ? 'k' : 'n');
  if (choice === 'k' && !canKeep) throw Error('A saved bearer key can only be kept for the same API base URL.');
  if (!['k', 'r', 'n'].includes(choice)) throw Error('Choose k, r or n from the available bearer key options.');
  const apiKey = choice === 'r' ? await ask('Bearer key (hidden): ', {secret: true}) : undefined;
  if (choice === 'r' && !apiKey) throw Error('Enter a bearer key or select no key.');
  const authChanged = choice === 'r' || choice === 'n' && profile.credentialRef !== null;
  const changed = !sameUrl || model !== profile.model || authChanged;
  const revision = changed ? randomUUID() : profile.revision;
  const credentialRef = choice === 'r' ? 'repair-'+revision : choice === 'k' ? profile.credentialRef : null;
  const rawProfile = {...profile, baseUrl, model, revision, credentialRef};
  const rawSettings = {...settings, providers: settings.providers.map(value => value.id === profile.id ? rawProfile : value)};
  const entries = {...credentials.entries};
  if (apiKey !== undefined) {
    if (Object.hasOwn(entries, credentialRef)) throw Error('The new credential reference is already in use. Run mosaic repair again.');
    entries[credentialRef] = apiKey;
  }
  const verificationCredentials = {schema: 1, entries};
  // Validate the raw entry as well as the normalized setting, with both retired and new secrets.
  await validateMultiWorkerCredentials(rawSettings, verificationCredentials);
  const nextSettings = normalizeSettings(rawSettings);
  await validateMultiWorkerCredentials(nextSettings, verificationCredentials);
  const nextCredentials = {schema: 1, entries: {...entries}};
  if (authChanged && profile.credentialRef !== null && !nextSettings.providers.some(value => value.credentialRef === profile.credentialRef)) {
    delete nextCredentials.entries[profile.credentialRef];
  }
  return {changed, settings: nextSettings, credentials: nextCredentials, profile: nextSettings.providers.find(value => value.id === profile.id), choice,
    secrets: Object.values(entries)};
}

async function runDiagnostics(paths, selection, change, context) {
  const {ask, output, signal, assertCurrent} = context;
  const {profile, settings, credentials, secrets} = change;
  if (!selection.discovery && !selection.probe) return;
  let report = createProviderDiagnostic(profile, {secrets});
  const registry = ProviderRegistry({profiles: settings.providers, credentialResolver: async ref => {
    await assertCurrent();
    return credentials.entries[ref];
  }});
  const client = registry.createClient({version: 1, providerId: profile.id, revision: profile.revision,
    profileHash: digest(registry.get(profile.id, profile.revision)), policyHash: digest(configuredPolicies(settings).providerPolicy)});
  const perform = action => withLock(paths, async () => {
    await assertCurrent();
    report = await action(client, profile, {previous: report, secrets, beforeRequest: assertCurrent, signal});
    await assertCurrent();
    output.write(formatProviderDiagnostic(report, {secrets}));
    return report;
  });
  const authentication = profile.credentialRef === null ? 'No bearer key will be sent.' : 'The proposed bearer key will be sent to this endpoint.';
  if (selection.discovery) {
    output.write(`\nModel discovery uses GET ${profile.baseUrl}/models. ${authentication} One request, up to 10 seconds.\n`);
    if (approved(await ask('Request the model list? [y/N] '))) await perform(discoverProvider);
  }
  if (selection.probe) {
    const membership = profile.capabilities.modelDiscovery === 'advertised' ? `First, Mosaic will request GET ${profile.baseUrl}/models to confirm the model is listed. ` : '';
    output.write(`\nThe inference test uses POST ${profile.baseUrl}/chat/completions with model ${quoted(profile.model)}. ${authentication}\n`+
      `${membership}One test prompt and up to 16 reply tokens within a total 10 seconds. Provider charges may apply.\n`+
      `Message: ${SETUP_PROBE_MESSAGE}\n`);
    if (approved(await ask('Send this test prompt? [y/N] '))) {
      const result = await perform(probeProvider);
      if (result.failed) throw Error('The inference test failed. Reopen repair to review the connection settings.');
    }
  }
}

async function repairWorker(paths, selection, settings, credentials, options, readSnapshot) {
  if (!settings) throw Error('Run mosaic setup before repairing a worker.');
  if (settings.schema !== 2) throw Error('Run mosaic migrate to review the portable settings upgrade before repairing a worker.');
  const profile = settings.providers.find(value => value.id === selection.workerId && value.roles.includes('worker'));
  if (!profile) throw Error('No worker has that ID. Run mosaic repair to list the configured workers.');
  if (profile.roles.includes('reviewer')) throw Error('This profile also handles API review. Use mosaic setup to review both roles together.');
  const binding = await readPortableRepairBinding(paths, settings, options);
  async function work(ask, signal) {
    const abortSignal = options.signal && signal ? AbortSignal.any([options.signal, signal]) : options.signal ?? signal;
    const assertCurrent = async () => {
      if (abortSignal?.aborted) throw Error(interruption);
      await assertSettingsMaintenanceAllowed(paths);
      await assertMaintenanceIdle(paths, {settingsChange: true});
      const currentBinding = await readPortableRepairBinding(paths, settings, options);
      if (!readSnapshot() || canonical(currentBinding) !== canonical(binding)) throw Error('Settings, credentials or the saved binding changed while repair was open. Reopen mosaic repair.');
      if (abortSignal?.aborted) throw Error(interruption);
    };
    const guardedAsk = async (...args) => {
      await assertCurrent();
      const answer = await ask(...args);
      await assertCurrent();
      return answer;
    };
    const change = await collectChange(profile, credentials, settings, guardedAsk);
    const {output} = options;
    await assertCurrent();
    const authentication = {k: 'Keep the saved bearer key for this URL', r: 'Use the newly entered bearer key (hidden)', n: 'Use no bearer key'}[change.choice];
    output.write(`\nWorker connection preview for ${profile.id}\n` +
      `  API base URL: ${quoted(change.profile.baseUrl)}\n  Model ID: ${quoted(change.profile.model)}\n  Authentication: ${authentication}\n`);
    output.write(isLoopbackProvider(change.profile.baseUrl)
      ? '  The worker URL connects to a loopback listener on this Mac.\n'
      : '  Approved task context goes to this endpoint off this Mac.\n');
    await runDiagnostics(paths, selection, change, {ask: guardedAsk, output, signal: abortSignal, assertCurrent});
    if (!change.changed) {
      output.write('The worker connection already matches this preview.\n');
      return true;
    }
    output.write('Saving this change gives the worker a new revision for future approvals.\n');
    if (!approved(await guardedAsk('Save this worker connection? [y/N] '))) {
      output.write('Worker repair cancelled.\n');
      return true;
    }
    await applyPortableWorkerRepair(paths, {...binding, settings: change.settings, nextCredentials: change.credentials,
      previousSettings: settings, previousCredentials: credentials, assertCurrent}, options);
    output.write('Worker connection saved. New work can use this revision after approval.\n');
    return true;
  }
  return options.ask ? work(options.ask) : askSession(options.input, options.output, work, {interruptMessage: interruption});
}

async function resumeApprovedRepair(paths, pending, options) {
  const {output} = options;
  if (!pending) { output.write('No worker repair is pending.\n'); return true; }
  if (pending.schema !== 2 || !pending.repair) throw Error('Setup is pending. Run mosaic setup to resume.');
  await resumePortableSetup(paths, pending, options);
  output.write('Resumed the approved worker repair.\n');
  return true;
}

async function validatedCredentials(paths, settings) {
  const credentials = readCredentialsSync(paths);
  if (settings?.schema === 2) await validateMultiWorkerCredentials(settings, credentials, {allowMissing: true});
  return credentials;
}

async function runRepairMenu(paths, settings, pending, options) {
  const credentials = await validatedCredentials(paths, settings).catch(() => null);
  const workers = await diagnose(paths, settings, credentials, pending, options);
  if (!settings) return true;
  const actions = [{label: 'Return without changes'}, {label: 'Review coding app connection', args: ['--host']}];
  if (pending?.schema === 2 && pending.repair) actions.push({label: 'Resume approved worker repair', resume: true});
  for (const profile of workers) actions.push({label: `Edit worker ${profile.id}`, args: ['--worker', profile.id]});
  const choices = actions.map(({label}, index) => ({value: String(index), label}));
  const title = 'Choose a connection to repair';
  const {input, output} = options;
  const work = async (ask, signal, choose) => {
    const answer = choose ? await choose(title, choices, {back: true}) : await ask(
      `\n${title}\n${choices.map(({value, label}) => `  ${value}. ${label}`).join('\n')}\nChoice [0] `
    );
    if (!answer) return true;
    const index = choices.findIndex(choice => choice.value === answer);
    if (index < 0) throw Error('Choose one of the connection repair options.');
    const action = actions[index];
    if (action.resume) return resumeApprovedRepair(paths, pending, options);
    if (action.args) return runConnectionRepair(paths, action.args, {...options, openMenu: false, ask,
      signal: options.signal && signal ? AbortSignal.any([options.signal, signal]) : options.signal ?? signal});
    return true;
  };
  return options.ask ? work(options.ask) : askSession(input, output, work, {enableMenus: true, interruptMessage: interruption});
}

export async function runConnectionRepair(paths, args = [], options = {}) {
  const selection = parseArgs(args);
  const io = {input: process.stdin, output: process.stdout, codexRegistrations: codexRegistrations(paths), ...options};
  const pending = await jsonFile(paths.setupIntent, {privateFile: true});
  if (selection.command === '--resume') return resumeApprovedRepair(paths, pending, io);
  if (pending && selection.command === '--worker') throw Error(pending.repair ? 'Run mosaic repair --resume to finish the approved repair.' : 'Run mosaic setup to resume the pending setup.');
  const settings = readSettingsSync(paths);
  if (selection.command === '--host') {
    await diagnose(paths, settings, null, pending, io, {hostOnly: true});
    return true;
  }
  if (selection.command === 'diagnose' && io.openMenu && (io.ask || io.input.isTTY && io.output.isTTY)) return runRepairMenu(paths, settings, pending, io);
  const credentials = await validatedCredentials(paths, settings);
  if (selection.command === 'diagnose') {
    await diagnose(paths, settings, credentials, pending, io);
    return true;
  }
  const readSnapshot = () => canonical(readSettingsSync(paths)) === canonical(settings) && canonical(readCredentialsSync(paths)) === canonical(credentials);
  return repairWorker(paths, selection, settings, credentials, io, readSnapshot);
}
