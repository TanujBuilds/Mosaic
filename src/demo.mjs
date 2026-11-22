import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { FakeFrontier, FakeLocal } from './adapters/fake.mjs';
import { runJob } from './coordinator.mjs';
import { JsonlJobStore } from './store.mjs';

import { isEntry } from './harness/entry.mjs';

async function main(argv) {
  if (argv.length === 1 && argv[0] === '--help') {
    console.log('demo [goal text]');
    return;
  }
  const goal = argv.join(' ').trim() || 'Fix a small bug and explain the change';
  const store = new JsonlJobStore(path.resolve('.data/jobs'));

  console.log('FAKE MODEL DEMO — no model calls, file edits, or checks will run.');
  const result = await runJob({
    goal,
    frontier: new FakeFrontier(),
    local: new FakeLocal(),
    store,
    approvePlan: async (plan) => {
      console.log(`Plan: ${plan.summary}`);
      console.log('Demo mode accepts this plan automatically.');
      return true;
    },
  });

  console.log(`Job ${result.jobId}: ${result.status}`);
  const eventFile = path.join(store.directory, `${result.jobId}.jsonl`);
  const events = (await readFile(eventFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  console.log(events.map((event) => event.type).join(' → '));
  console.log(`Events: ${path.relative(process.cwd(), eventFile)}`);
}

if (isEntry(import.meta.url)) await main(process.argv.slice(2));
