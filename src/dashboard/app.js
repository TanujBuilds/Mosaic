const byId = id => document.getElementById(id);
const initial = new URLSearchParams(location.search).get('job');
let selected = initial;
let lastRender = '';
let busy = false;

function node(tag, className, value) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (value !== undefined) item.textContent = value;
  return item;
}

function displayTime(iso) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(new Date(iso));
}

function setWatch(message, error = false) {
  byId('watchState').textContent = message;
  byId('watchState').parentElement.classList.toggle('error', error);
}

function renderJobs(jobs) {
  byId('jobCount').textContent = String(jobs.length);
  const list = byId('jobList');
  list.replaceChildren();
  if (!jobs.length) {
    list.append(node('p', 'empty', 'No saved jobs yet.'));
    return;
  }
  for (const job of jobs) {
    const button = node('button', 'job-link' + (job.id === selected ? ' active' : ''));
    button.type = 'button';
    button.append(node('strong', '', job.title));
    const meta = node('small');
    meta.append(node('span', '', job.type === 'coding' ? 'Coding' : 'Text handoff'));
    meta.append(node('span', '', job.mode !== 'live' ? job.mode.toUpperCase() : job.status.replaceAll('_', ' ')));
    button.append(meta);
    button.addEventListener('click', () => {
      selected = job.id;
      lastRender = '';
      history.replaceState(null, '', '?job=' + encodeURIComponent(selected));
      refresh();
    });
    list.append(button);
  }
}

function detailRow(name, values, code = false) {
  const row = node('div', 'detail-row');
  row.append(node('dt', '', name));
  const dd = node('dd');
  const items = Array.isArray(values) ? values : [values];
  if (items.length > 1) {
    const ul = node('ul');
    for (const value of items) {
      const li = node('li');
      li.append(node(code ? 'code' : 'span', '', String(value)));
      ul.append(li);
    }
    dd.append(ul);
  } else dd.append(node(code ? 'code' : 'span', '', String(items[0] ?? '—')));
  row.append(dd);
  return row;
}

function renderDetails(job) {
  const panel = byId('jobDetails');
  panel.replaceChildren();
  panel.append(detailRow('Job ID', job.id, true));
  if (job.type === 'coding') {
    panel.append(detailRow('Plan', job.description));
    panel.append(detailRow('Starting commit', job.baseCommit?.slice(0, 12), true));
    panel.append(detailRow('Source shared with Codex', job.permissions?.readPaths ?? [], true));
    panel.append(detailRow('Worker may edit', job.permissions?.writePaths ?? [], true));
    panel.append(detailRow('Approved checks', job.permissions?.checks?.map(check => check.argv.join(' ')) ?? [], true));
    panel.append(detailRow('Limits', [
      String(job.limits?.attempts) + ' DeepSeek attempts per stage',
      String(job.limits?.reviewRounds ?? 2) + ' Codex reviews per stage',
      String(job.limits?.hours) + ' hours',
    ]));
    panel.append(detailRow('Local branch', 'orchestrator/' + job.id, true));
  } else panel.append(detailRow('Plan version', job.planVersion ?? '—'));
}

function renderStages(job) {
  const list = byId('stageList');
  list.replaceChildren();
  byId('stageCount').textContent = String(job.stages.length) + (job.stages.length === 1 ? ' assignment' : ' ordered stages');
  if (!job.stages.length) {
    list.append(node('div', 'empty', 'Waiting for DeepSeek to propose the plan.'));
    return;
  }
  job.stages.forEach((stage, index) => {
    const card = node('article', 'stage-card ' + stage.status);
    card.append(node('span', 'stage-index', String(index + 1).padStart(2, '0')));
    const body = node('div');
    body.append(node('h3', '', stage.objective));
    if (stage.deliverable) body.append(node('p', '', stage.deliverable));
    if (stage.acceptance?.length) {
      const details = node('details');
      details.append(node('summary', '', 'Acceptance criteria'));
      const list = node('ul');
      stage.acceptance.forEach(item => list.append(node('li', '', item)));
      details.append(list);
      body.append(details);
    }
    if (stage.localAttempts !== undefined) body.append(node('p', '', stage.localAttempts + ' DeepSeek attempts · ' + (stage.codexReviews ?? 0) + ' Codex reviews'));
    card.append(body);
    card.append(node('span', 'stage-state', stage.status.replaceAll('_', ' ')));
    list.append(card);
  });
}

function screenshotsFor(event) {
  if (event.type !== 'operation.completed' || !event.data?.key?.endsWith('/checks')) return [];
  return (event.data.value ?? []).flatMap(check => check.screenshots ?? []);
}

function renderTimeline(job, events) {
  const timeline = byId('timeline');
  timeline.replaceChildren();
  byId('eventCount').textContent = events.length + ' visible handoffs';
  if (!events.length) {
    timeline.append(node('div', 'empty', 'No handoffs have been recorded yet.'));
    return;
  }
  for (const event of [...events].reverse()) {
    const card = node('article', 'event-card ' + event.kind);
    const head = node('div', 'event-head');
    const role = {
      codex: 'Codex CLI', deepseek: 'DeepSeek', check: 'Project check',
      workspace: 'Git worktree', warning: 'Attention', system: 'Coordinator',
    }[event.kind] ?? 'Coordinator';
    head.append(node('strong', '', role + ' · #' + event.sequence));
    const time = node('time', '', displayTime(event.at));
    time.dateTime = event.at;
    head.append(time);
    card.append(head, node('p', '', event.label));

    const images = screenshotsFor(event);
    if (images.length) {
      const strip = node('div', 'screenshots');
      for (const file of images) {
        const name = file.split(/[\\/]/).at(-1);
        const link = node('a', 'screenshot');
        link.href = '/api/artifacts/' + encodeURIComponent(job.id) + '/' + encodeURIComponent(name);
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        const image = node('img');
        image.src = link.href;
        image.alt = 'Check screenshot: ' + name;
        image.loading = 'lazy';
        link.append(image, node('span', '', name));
        strip.append(link);
      }
      card.append(strip);
    }
    const details = node('details');
    details.append(node('summary', '', 'Recorded data'));
    details.addEventListener('toggle', () => {
      if (details.open && !details.querySelector('pre')) {
        details.append(node('pre', '', JSON.stringify({
          jobId: event.jobId, sequence: event.sequence, at: event.at,
          type: event.type, data: event.data,
        }, null, 2)));
      }
    });
    card.append(details);
    timeline.append(card);
  }
}

function render(result) {
  const { job, events } = result;
  byId('jobTitle').textContent = job.title;
  byId('statusBadge').textContent = job.mode !== 'live' ? job.mode.toUpperCase() + ' · ' + job.status.replaceAll('_', ' ') : job.status.replaceAll('_', ' ');
  byId('statusBadge').dataset.state = job.status;
  byId('jobReason').textContent = job.reason ?? (job.status === 'approved'
    ? 'Plan approved. The runner has not started.'
    : job.status === 'awaiting_approval' ? 'Waiting for approval before any local work begins.'
      : job.status === 'running' ? 'The coordinator is working through the saved plan.'
        : 'This view comes from the coordinator’s saved job log.');
  const meta = byId('jobMeta');
  meta.replaceChildren();
  meta.append(node('span', '', job.type === 'coding' ? 'CODING JOB' : 'TEXT HANDOFF'));
  meta.append(node('span', '', 'PLAN v' + (job.planVersion ?? '—')));
  meta.append(node('span', '', 'UPDATED ' + displayTime(job.updatedAt)));
  if (job.mode !== 'live') meta.append(node('span', '', job.mode.toUpperCase() + ' PROVIDERS'));
  renderStages(job);
  renderTimeline(job, events);
  renderDetails(job);
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error('Local viewer returned HTTP ' + response.status);
  return response.json();
}

async function refresh() {
  if (busy) return;
  busy = true;
  try {
    const { jobs } = await fetchJson('/api/jobs');
    if (!selected || !jobs.some(job => job.id === selected)) selected = jobs[0]?.id ?? null;
    renderJobs(jobs);
    if (!selected) {
      setWatch('Waiting for a saved job');
      return;
    }
    const result = await fetchJson('/api/jobs/' + encodeURIComponent(selected));
    const fingerprint = selected + ':' + result.events.at(-1)?.sequence + ':' + result.job.status;
    if (fingerprint !== lastRender) {
      render(result);
      lastRender = fingerprint;
    }
    setWatch('Watching saved log · ' + displayTime(result.job.updatedAt));
  } catch (error) {
    setWatch(error.message, true);
  } finally {
    busy = false;
  }
}

refresh();
setInterval(refresh, 2000);
