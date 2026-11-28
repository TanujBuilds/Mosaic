import path from 'node:path';
import {ElicitResultSchema, ErrorCode} from '@modelcontextprotocol/sdk/types.js';
import {keys} from '../harness/contracts.mjs';
import {getHost} from './hosts/index.mjs';

const modes = ['collaborative', 'codex_only', 'deepseek_only', 'overnight_review'];
export const pickerTool = {
  name: 'choose_workflow',
  description: 'Start here when someone says “use Mosaic” in their project chat. Ask the user to choose a workflow, or pass their explicit choice. Choosing a workflow starts no work.',
  inputSchema: {type: 'object', additionalProperties: false, properties: {
    repo: {type: 'string', description: 'Current project’s absolute Git root, when known, to look up an owner-saved workflow.'},
    mode: {type: 'string', enum: modes, description: 'Supply only a workflow explicitly chosen by the user or saved by the owner for this project. Omit to ask.'},
  }},
  annotations: {title: 'Choose a Mosaic workflow', readOnlyHint: true, openWorldHint: false},
};

export const pickerInstructions = [
  'When a user says “use Mosaic” for a new task, start with choose_workflow in the current project chat. Pass the current repository root if known.',
  'Use their explicit mode, then a related active goal’s pinned mode, then an explicitly owner-saved project preference. Continue an active goal directly. An explicit change of mode on active work requires the supported transition or a separate approved goal.',
  'If no mode is known, omit mode. Never infer a mode from the task, the host, or the absence of a worker.',
  'If choose_workflow returns choice_required, present its question and choices once using the host’s native choice control when available, otherwise in chat. Wait for the answer and pass the selected mode. On cancellation stop.',
  'If setup_required is returned, explain how to connect a worker or let the user choose app-only. After selection, keep the original project and request. Use assignment_prepare for a new draft. Explain the scope, checks and limits in ordinary language and use the existing approval flow before activation.',
].join(' ');

function workflowChoices(host, worker) {
  return [
    {mode: 'collaborative', label: 'Collaborative', description: host + ' and your API worker share the coding work.'},
    {mode: 'codex_only', label: host + ' only', description: host + ' does the coding. No API worker is needed.'},
    {mode: 'deepseek_only', label: 'API worker only', description: 'Your worker plans and implements. Protected checks evaluate the result.'},
    {mode: 'overnight_review', label: 'Overnight review', description: 'Your worker implements in stages. Review follows passing checks.'},
  ].map(choice => ({...choice, requiresSetup: !worker && choice.mode !== 'codex_only'}));
}

export async function chooseWorkflow(input, request, {readSettings, readPreset}) {
  keys(input, ['mode', 'repo'], 'workflow choice');
  if (input.mode !== undefined && !modes.includes(input.mode)) throw Error('Choose one of the four Mosaic workflows.');
  if (input.repo !== undefined && (typeof input.repo !== 'string' || !path.isAbsolute(input.repo) || /[\x00-\x1f\x7f]/u.test(input.repo))) {
    throw Error('Use the absolute path of the current Git project or omit repo.');
  }
  const settings = await readSettings();
  const host = settings?.host?.id ? getHost(settings.host.id).displayName : 'Coding app';
  const worker = settings?.schema === 2 ? settings.providers.some(p => p.roles.includes('worker')) : Boolean(settings?.worker);
  const choices = workflowChoices(host, worker);
  const selected = (mode, source) => {
    const choice = choices.find(item => item.mode === mode);
    if (!choice) throw Error('The selected Mosaic workflow is unavailable.');
    return choice.requiresSetup
      ? {status: 'setup_required', mode, label: choice.label, source,
        next: 'Connect an API worker in Mosaic setup, then continue this task with the chosen workflow. You can also choose ' + host + ' only.'}
      : {status: 'selected', mode, label: choice.label, source,
        next: 'Inspect the current project and call assignment_prepare with an idempotencyKey and a manifest. Include submissionId, objective, acceptance (a list), the selected mode, project (repo, readPaths, writePaths, checks), and limits (hours, maxTasks, reviewAgentRuns). For each check use an object such as {"id":"tests","argv":["node","--test"]} with the actual command from this project. Show the resulting draft for approval.'};
  };
  if (input.mode !== undefined) return selected(input.mode, 'host_context');
  let presetNotice = '';
  if (input.repo !== undefined) {
    try {
      const preset = await readPreset(input.repo);
      if (preset) return selected(preset.mode, 'project_preset');
    } catch {
      presetNotice = 'Mosaic could not read a saved workflow for this project. ';
    }
  }
  const question = 'Which workflow would you like to use for this task?';
  const recommendedMode = worker ? 'collaborative' : 'codex_only';
  const labels = choices.map(choice => choice.label + (choice.mode === recommendedMode ? ' (recommended)' : choice.requiresSetup ? ' (set up a worker)' : ''));
  const fallback = {status: 'choice_required', question, choices, recommendedMode,
    ...(presetNotice ? {notice: presetNotice.trim()} : {}),
    next: 'Ask the question once in this chat, wait for the user, then call choose_workflow with their selected mode.'};

  // Older MCP clients advertise form support with an empty elicitation object.
  const capability = request.capabilities?.elicitation;
  if (!capability || (!capability.form && capability.url)) return fallback;
  let answer;
  try {
    answer = await request.sendRequest({method: 'elicitation/create', params: {
      message: presetNotice + question,
      requestedSchema: {type: 'object', properties: {workflow: {type: 'string', title: 'Workflow',
        description: choices.map(choice => choice.label + ' — ' + choice.description).join('\n'),
        enum: labels}}, required: ['workflow']},
    }}, ElicitResultSchema, {signal: request.signal});
  } catch (error) {
    if (error.code === ErrorCode.MethodNotFound) return fallback;
    throw error;
  }
  if (answer.action !== 'accept') return {status: 'cancelled', next: 'Stop here until the user asks to continue.'};
  const choice = choices[labels.indexOf(answer.content?.workflow)];
  if (!choice) throw Error('The app did not return a valid workflow choice.');
  return selected(choice.mode, 'picker');
}
