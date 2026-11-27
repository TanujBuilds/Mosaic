import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const { chromium } = createRequire(import.meta.url)("playwright");
const ui = new URL("../index.html", import.meta.url).href;
const captured = process.env.MOSAIC_UI_SCREENSHOTS;
const fixtureSettings = {
  configured: true,
  host: "claude-code",
  provider: "openrouter",
  model: "Qwen Coder",
  baseUrl: "https://openrouter.ai/api/v1",
  hasKey: true,
  reviewTarget: "host",
  reviewerModel: "",
  reviewerBaseUrl: "",
  reviewerHasKey: false,
  firstCallAt: null,
  registration: "codex mcp add fixture-mosaic -- /fixture/mcp",
  installedAvailable: true,
  serviceReady: true,
  revision: 1,
};
function board(source) {
  if (source === "installed")
    return {
      projects: [{ id: "a", name: "Installed work" }],
      cards: [
        {
          id: "shared",
          projectId: "a",
          title: "Installed handoff",
          lane: "finished",
          status: "Integrated",
          host: "codex",
          worker: "Local worker",
          updatedAt: 1770000000000,
        },
      ],
      latest: null,
      truncated: false,
    };
  return {
    projects: [
      { id: "a", name: "Little Ledger" },
      { id: "b", name: "Field Notes" },
    ],
    cards: [
      {
        id: "shared",
        projectId: "a",
        title: "Add monthly totals",
        lane: "working",
        status: "Worker editing",
        host: "claude-code",
        worker: "Qwen Coder",
      },
      {
        id: "csv",
        projectId: "a",
        title: "Fix CSV export",
        lane: "attention",
        status: "Waiting for Claude Code review",
        host: "claude-code",
        worker: "Qwen Coder",
        action: "host",
      },
      {
        id: "key",
        projectId: "a",
        title: "Import bank statement",
        lane: "attention",
        status: "Worker key rejected",
        host: "claude-code",
        worker: "Qwen Coder",
        action: "connection",
      },
      {
        id: "sort",
        projectId: "a",
        title: "Restore date sorting",
        lane: "finished",
        status: "Integrated",
        host: "claude-code",
        worker: "Qwen Coder",
      },
    ],
    latest: {
      title: "Fix CSV export · Ready for Claude Code review",
      at: 1770000000000,
    },
    truncated: false,
  };
}
const detail = {
  title: "Fix CSV export",
  host: "claude-code",
  worker: "Qwen Coder",
  mode: "Collaborative",
  status: "Waiting for review",
  canOpenHost: false,
  events: [
    {
      title: "Work requested in Claude Code",
      detail: "Repair the CSV export in Little Ledger.",
      at: 1770000000000,
    },
    {
      title: "Worker submitted changes",
      detail: "Quoted fields now preserve embedded line breaks.",
      at: 1770000010000,
    },
    {
      title: "Checks completed",
      detail: "CSV parser and export tests passed.",
      at: 1770000015000,
    },
    {
      title: "Ready for Claude Code review",
      detail: "Return to the coding app to review the changes.",
      at: 1770000020000,
    },
  ],
  checks: [
    {
      name: "Export tests",
      status: "passed",
      output: "fixture 4/4 passed <img src=x>",
    },
  ],
  diff: "+ new export",
  followup: "Review the CSV export handoff in Little Ledger.",
  limited: true,
};
let browser;
before(async () => {
  browser = await chromium.launch({
    channel: process.env.FRONTIER_BROWSER_CHANNEL || "chrome",
    headless: true,
  });
  if (captured) await mkdir(captured, { recursive: true });
});
after(async () => {
  await browser?.close();
});
async function open(t, { settings = fixtureSettings, prefs, boards } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 1220, height: 790 },
    reducedMotion: "reduce",
  });
  t.after(() => ctx.close());
  await ctx.addInitScript(
    ({ settings, prefs, boards, detail }) => {
      if (prefs && !localStorage.getItem("mosaic.desktop.workspace.v1"))
        localStorage.setItem(
          "mosaic.desktop.workspace.v1",
          JSON.stringify(prefs),
        );
      window.testState = { settings, boards, detail, calls: [] };
      window.webkit = {
        messageHandlers: {
          mosaic: {
            async postMessage({ method, payload }) {
              const s = window.testState;
              if (method === "settings.save") {
                s.saved = payload;
                const { key, reviewerKey, ...plain } = payload;
                s.settings = {
                  ...s.settings,
                  ...plain,
                  configured: true,
                  revision: Number(s.settings.revision) + 1,
                  hasKey: key === undefined ? s.settings.hasKey : !!key,
                  reviewerHasKey:
                    reviewerKey === undefined
                      ? s.settings.reviewerHasKey
                      : !!reviewerKey,
                };
              }
              s.calls.push({ method, source: payload.source, id: payload.id });
              if (s.fail === method)
                throw new Error("Cannot reach fixture coordinator.");
              if (method === "observer.board" && s.hold === payload.source)
                await new Promise((resolve) => {
                  s.resume = resolve;
                });
              switch (method) {
                case "observer.board":
                  return structuredClone(s.boards[payload.source]);
                case "observer.detail":
                  return structuredClone({
                    ...s.detail,
                    ...(payload.source === "installed"
                      ? { title: "Installed handoff" }
                      : {}),
                  });
                case "settings.get":
                case "settings.save":
                  return structuredClone(s.settings);
                case "worker.test":
                  return { ok: true, message: "Saved endpoint responded." };
                case "host.connect":
                  return { ok: true, message: "Registration installed." };
                case "clipboard.copy":
                  s.clipboard = payload.text;
                  return true;
                case "host.open":
                  throw new Error("Session is no longer available.");
                default:
                  throw new Error("Unexpected request");
              }
            },
          },
        },
      };
    },
    {
      settings,
      prefs,
      boards: boards || {
        preview: board("preview"),
        installed: board("installed"),
      },
      detail,
    },
  );
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  t.after(() => assert.deepEqual(errors, []));
  page.setDefaultTimeout(3500);
  await page.goto(ui);
  return page;
}
const click = (p, name) => p.getByRole("button", { name, exact: true }).click();
const heading = (p, name) =>
  p.getByRole("heading", { name, exact: true }).waitFor();
const refresh = (p) => p.evaluate(() => window.MosaicRuntime.refresh());
const screenshot = (p, name) =>
  captured
    ? p.screenshot({ path: path.join(captured, name + ".png") })
    : undefined;
test("first run permits a keyless host setup, explicit registration and proof from the host", async (t) => {
  const page = await open(t, {
    settings: {
      ...fixtureSettings,
      configured: false,
      hasKey: false,
      model: "",
      baseUrl: "http://127.0.0.1:8080/v1",
      provider: "local",
      host: "codex",
    },
  });
  await heading(page, "Connections");
  await page.getByRole("button", { name: "View coding core history" }).waitFor();
  assert.equal(await page.locator("input[type=password]:visible").count(), 0);
  await click(page, "Save connections");
  await page.getByText("Connections saved.", { exact: true }).waitFor();
  await click(page, "Install in Codex");
  await page.getByText("Registration installed.", { exact: true }).waitFor();
  await page
    .getByText("Waiting for the first MCP call", { exact: true })
    .waitFor();
  await page.getByText("Host setup command", { exact: true }).click();
  await click(page, "Copy setup command");
  assert.equal(
    await page.evaluate(() => testState.clipboard),
    fixtureSettings.registration,
  );
  await page.evaluate(() => {
    testState.settings.firstCallAt = 1770000000000;
  });
  await refresh(page);
  await page.getByText(/First MCP call received/).waitFor();
  const calls = await page.evaluate(() =>
    testState.calls
      .map((c) => c.method)
      .filter((m) => !["settings.get", "observer.board"].includes(m)),
  );
  assert.deepEqual(calls, ["settings.save", "host.connect", "clipboard.copy"]);
});
test("worker and reviewer changes preserve drafts during refresh and handle independent key rotation", async (t) => {
  const p = await open(t);
  await click(p, "Connections");
  await heading(p, "Connections");
  await click(p, "Test saved worker");
  await p.getByText("Saved endpoint responded.", { exact: true }).waitFor();
  await screenshot(p, "connections");
  await p.getByLabel("Start work in").selectOption("codex");
  await p.getByLabel("Provider", { exact: true }).selectOption("custom");
  await p.locator("#baseUrl").fill("http://localhost:3222/v1");
  await click(p, "Replace key");
  await p.locator("#key").fill("fixture-worker-key");
  await p.getByLabel("Review with").selectOption("api");
  await p.locator("#reviewerModel").fill("Review fixture");
  await p.locator("#reviewerBaseUrl").fill("http://localhost:4333/v1");
  await p
    .locator("#reviewer-fields")
    .getByRole("button", { name: "Add key" })
    .click();
  await p.locator("#reviewerKey").fill("fixture-review-key");
  await refresh(p);
  assert.equal(await p.locator("#key").inputValue(), "fixture-worker-key");
  assert.equal(
    await p.getByRole("button", { name: "Test saved worker" }).isEnabled(),
    false,
  );
  await click(p, "Projects");
  await click(p, "Keep editing");
  assert.equal(
    await p.locator("#reviewerKey").inputValue(),
    "fixture-review-key",
  );
  await click(p, "Save connections");
  await p.getByText("Connections saved.", { exact: true }).waitFor();
  assert.equal(await p.locator("input[type=password]:visible").count(), 0);
  assert.equal(
    await p.evaluate(() =>
      document.documentElement.innerHTML.includes("fixture-worker-key"),
    ),
    false,
  );
  assert.equal(
    await p.evaluate(() =>
      JSON.stringify(localStorage).includes("fixture-review-key"),
    ),
    false,
  );
  assert.deepEqual(
    await p.evaluate(() => [
      testState.saved.key,
      testState.saved.reviewerKey,
      testState.saved.revision,
    ]),
    ["fixture-worker-key", "fixture-review-key", 1],
  );
  await p.getByRole("button", { name: "Remove", exact: true }).first().click();
  await click(p, "Save connections");
  await p.getByText("Connections saved.", { exact: true }).waitFor();
  assert.deepEqual(
    await p.evaluate(() => [
      testState.saved.key,
      Object.hasOwn(testState.saved, "reviewerKey"),
    ]),
    ["", false],
  );
});
test("project board, searchable handoffs, evidence, disconnect and scoped selections", async (t) => {
  const p = await open(t, {
    prefs: { source: "preview", preview: { lastProject: "a", pins: [] } },
  });
  await heading(p, "Projects");
  await click(p, "Open project Little Ledger");
  await heading(p, "Little Ledger");
  await screenshot(p, "board");
  await p
    .getByRole("button", {
      name: "Fix CSV export Waiting for Claude Code review Qwen Coder",
    })
    .click();
  await heading(p, "Handoff timeline");
  await screenshot(p, "handoff");
  assert.equal(
    await p.getByRole("button", { name: "Open in Claude Code" }).count(),
    0,
  );
  await p
    .getByText("Checks", { exact: false })
    .filter({ has: p.locator("span.lane-count") })
    .last()
    .click();
  await p
    .getByText("fixture 4/4 passed <img src=x>", { exact: true })
    .waitFor();
  assert.equal(await p.locator(".check-item img").count(), 0);
  await p.evaluate(() => {
    testState.detail.canOpenHost = true;
    testState.detail.diff = "+ verified edit";
  });
  await refresh(p);
  assert.equal(
    await p.locator('details[data-ref="checks"]').evaluate((e) => e.open),
    true,
  );
  await click(p, "Open in Claude Code");
  await p
    .getByText(/Use Copy follow-up/)
    .first()
    .waitFor();
  await click(p, "Copy follow-up");
  assert.equal(await p.evaluate(() => testState.clipboard), detail.followup);
  await p.evaluate(() => {
    testState.fail = "observer.board";
  });
  await refresh(p);
  await p.getByText(/Disconnected. Showing the last update/).waitFor();
  await heading(p, "Handoff timeline");
  await p.evaluate(() => {
    testState.fail = null;
  });
  await refresh(p);
  assert.equal(
    await p.getByText(/Disconnected. Showing the last update/).count(),
    0,
  );
  await click(p, "Back to board");
  await p
    .getByRole("button", { name: "Pin Little Ledger", exact: true })
    .click();
  await p.keyboard.press("Control+k");
  await p.getByRole("searchbox").fill("field");
  await p.keyboard.press("Enter");
  await heading(p, "Field Notes");
  await p.reload();
  await heading(p, "Field Notes");
  await click(p, "Settings");
  await p.getByLabel("Show work from").selectOption("installed");
  await click(p, "View board");
  await heading(p, "Installed work");
  assert.equal(
    await p.getByRole("button", { name: "Unpin Installed work" }).count(),
    0,
  );
  assert.equal(await p.getByText("Fix CSV export", { exact: true }).count(), 0);
  await click(p, "Settings");
  await p.getByLabel("Show work from").selectOption("preview");
  await click(p, "View board");
  await heading(p, "Field Notes");
  await click(p, "Little Ledger");
  await p.getByRole("button", { name: "Unpin Little Ledger" }).waitFor();
  await p.getByRole("button", { name: /Needs attention 2/ }).click();
  await heading(p, "Needs attention");
  assert.equal(await p.locator(".task-card").count(), 2);
  assert.equal(
    await p.evaluate(() =>
      testState.calls.some((c) =>
        ["worker.test", "host.connect", "settings.save"].includes(c.method),
      ),
    ),
    false,
  );
});
test("source changes ignore late reads, empty workspaces never acquire examples and compact layouts fit", async (t) => {
  const p = await open(t, {
    settings: { ...fixtureSettings, configured: false },
    boards: {
      preview: { projects: [], cards: [], latest: null, truncated: false },
      installed: board("installed"),
    },
  });
  await heading(p, "Connections");
  await p.evaluate(() => {
    testState.hold = "preview";
    void MosaicRuntime.refresh();
  });
  await p.waitForFunction(() => !!testState.resume);
  await click(p, "View coding core history");
  await heading(p, "Projects");
  await click(p, "Open project Installed work");
  await heading(p, "Installed work");
  await p.evaluate(() => {
    testState.hold = null;
    testState.resume();
  });
  await heading(p, "Installed work");
  await click(p, "Settings");
  await p.getByLabel("Show work from").selectOption("preview");
  await click(p, "View board");
  await heading(p, "Waiting for a handoff");
  await p.setViewportSize({ width: 390, height: 750 });
  assert.equal(
    await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
  );
  await click(p, "Connections");
  assert.equal(
    await p.evaluate(
      () =>
        document.querySelector("#surface").scrollWidth <=
        document.querySelector("#surface").clientWidth,
    ),
    true,
  );
});

test("refresh keeps keyboard focus and per-pane evidence scroll when the handoff receives a new event", async (t) => {
  const p = await open(t);
  await click(p, "Open project Little Ledger");
  await p.locator('.card-main[data-id="csv"]').click();
  await heading(p, "Handoff timeline");
  await p.evaluate(() => {
    testState.detail.checks[0].output = "many lines\n".repeat(180);
  });
  await refresh(p);
  const summary = p.locator('details[data-ref="checks"] summary');
  await summary.click();
  await summary.focus();
  await p.locator(".check-item pre").evaluate((el) => {
    el.scrollTop = 160;
  });
  await p.evaluate(() => {
    testState.detail.events.push({
      title: "Review received",
      detail: "Recorded during refresh",
      at: 1770000040000,
    });
  });
  await refresh(p);
  assert.equal(
    await summary.evaluate((el) => document.activeElement === el),
    true,
  );
  assert.equal(
    await p.locator(".check-item pre").evaluate((el) => el.scrollTop),
    160,
  );
  await p.getByText("Recorded during refresh").waitFor();
});
test("concurrent settings edits can be reloaded, and an unavailable service is visible", async (t) => {
  const p = await open(t);
  await click(p, "Connections");
  await p.locator("#model").fill("My unsaved model");
  await p.evaluate(() => {
    Object.assign(testState.settings, {
      revision: 2,
      model: "Externally saved model",
      serviceReady: false,
      serviceMessage: "Preview restart required.",
    });
  });
  await refresh(p);
  assert.equal(await p.locator("#model").inputValue(), "My unsaved model");
  await click(p, "Reload saved");
  await click(p, "Discard changes");
  await p.waitForFunction(
    () => document.querySelector("#model")?.value === "Externally saved model",
  );
  await p.getByText("Preview restart required.", { exact: true }).waitFor();
  await p.evaluate(() => {
    Object.assign(testState.settings, {
      serviceReady: true,
      serviceMessage: "",
    });
  });
  await refresh(p);
  assert.equal(
    await p.getByText("Preview restart required.", { exact: true }).count(),
    0,
  );
  const wrote = await p.evaluate(() =>
    testState.calls.filter((c) => c.method === "settings.save"),
  );
  assert.equal(wrote.length, 0);
});
test("network and history strings are inert text and handoff disconnect offers a retry", async (t) => {
  const p = await open(t);
  await click(p, "Open project Little Ledger");
  await p.evaluate(() => {
    const poison = '<img src=x onerror="window.injection=true">';
    testState.boards.preview.cards[0].title = poison;
    testState.detail.events[0].detail = poison;
    testState.detail.diff = "<script>window.injection=true</script>";
    testState.boards.preview.projects[0].name = poison;
  });
  await refresh(p);
  assert.equal(await p.locator("#surface img, #navigation img").count(), 0);
  await p.locator(".card-main").first().click();
  await heading(p, "Handoff timeline");
  await p.locator('details[data-ref="diff"] summary').click();
  assert.equal(
    await p.locator('details[data-ref="diff"] pre').textContent(),
    "<script>window.injection=true</script>",
  );
  assert.equal(await p.evaluate(() => window.injection), undefined);
  await p.evaluate(() => {
    testState.fail = "observer.detail";
  });
  await refresh(p);
  await p.getByText(/Showing the last handoff update/).waitFor();
  await p.evaluate(() => {
    testState.fail = null;
  });
  await click(p, "Retry");
  await p.waitForFunction(
    () => !document.querySelector(".detail-body .notice"),
  );
});

test("large workspaces open on five recent projects with a complete history and pin shortcuts", async t => {
  const projects=Array.from({length:38},(_,i)=>({id:String(i),name:"Project "+i,history:i<28}));
  const cards=projects.map((p,i)=>({id:"h"+i,projectId:p.id,title:"Handoff "+i,lane:"finished",updatedAt:1000-i}));
  const p=await open(t,{boards:{preview:{projects,cards},installed:board("installed")}});
  await heading(p,"Recent projects");
  assert.equal(await p.locator(".project-open").count(),5);
  assert.equal(await p.locator("#navigation [data-action=project]").count(),0);
  assert.equal(await p.locator(".project-open").first().getAttribute("aria-label"),"Open project Project 28");
  await click(p,"Browse all 38");
  await heading(p,"All projects");
  assert.equal(await p.locator(".project-open").count(),12);
  await click(p,"Show more projects");
  assert.equal(await p.locator(".project-open").count(),24);
  await click(p,"Open project Project 0");
  await click(p,"Pin Project 0");
  await click(p,"Projects");
  await heading(p,"Recent projects");
  assert.equal(await p.locator("#navigation [data-action=project]").count(),1);
  await p.reload();
  await heading(p,"Recent projects");
  await p.keyboard.press("Control+k");
  await p.getByRole("searchbox").fill("Project 27");
  await p.keyboard.press("Enter");
  await heading(p,"Project 27");
});

test("terminal-only setups explain how to edit and earlier desktop handoffs stay selectable", async t => {
  const message = "Manage this existing setup in Terminal.";
  const page = await open(t, {
    settings: {...fixtureSettings, legacyAvailable:true, readOnlyReason:message},
    boards: {preview:board("preview"), installed:board("installed"), legacy:board("installed")}
  });
  await click(page, "Connections");
  await page.getByText(message, {exact:true}).waitFor();
  assert.equal(await page.getByRole("button",{name:"Save connections"}).count(),0);
  await click(page, "Dashboard settings");
  await page.getByLabel("Show work from").selectOption("legacy");
  await click(page, "View board");
  await page.getByText("Installed handoff").first().waitFor();
  const calls = await page.evaluate(() => testState.calls);
  assert.ok(calls.some(call => call.method === "observer.board" && call.source === "legacy"));
  assert.ok(!calls.some(call => call.method === "settings.save"));
});
