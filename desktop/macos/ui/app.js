(() => {
  "use strict";
  const $ = (selector) => document.querySelector(selector);
  const lanes = [
    { id: "working", label: "Working", icon: "working" },
    { id: "attention", label: "Needs attention", icon: "attention" },
    { id: "finished", label: "Finished", icon: "check" },
  ];
  const paths = {
    project: '<path d="M2.5 5.5h6l1.5 2h11.5v12H2.5z"/>',
    projects:
      '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 12 9 5 9-5m-18 4 9 5 9-5"/>',
    attention: '<path d="m12 3 9.2 16H2.8z"/><path d="M12 8v5m0 3h.01"/>',
    pulse: '<path d="M2 12h5l2-6 4 13 3-8 2 1h4"/>',
    working: '<circle cx="12" cy="12" r="8.5" stroke-dasharray="39 15"/>',
    check: '<circle cx="12" cy="12" r="8.7"/><path d="m8 12 2.5 2.5L16 9"/>',
    connections: '<path d="M8 2v5m8-5v5M5 7h14v4a7 7 0 0 1-14 0zM12 18v4"/>',
    settings:
      '<path d="M3 6h5m4 0h9M3 12h10m4 0h4M3 18h2m4 0h12"/><circle cx="10" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="7" cy="18" r="2"/>',
    search: '<circle cx="10" cy="10" r="6.5"/><path d="m15.3 15.3 5.7 5.7"/>',
    refresh: '<path d="M20 9a8 8 0 1 0 .3 5M20 3v6h-6"/>',
    host: '<rect x="2" y="4" width="20" height="16" rx="3"/><path d="m6 9 2.5 2.5L6 14m5 0h5"/>',
    worker:
      '<rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M6 7h.01m0 10h.01"/>',
    arrow: '<path d="m8 5 7 7-7 7"/>',
    back: '<path d="m14 5-7 7 7 7"/>',
    pin: '<path d="m12 3 8 8-4 1-3 5-6-6 5-3zM9 15l-6 6"/>',
    history: '<path d="M4 7a9 9 0 1 1-1 8M3 3v5h5m4-2v6l4 2"/>',
    external: '<path d="M13 4h7v7m0-7-10 10m-1-8H5v13h13v-4"/>',
    copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M15 8V3H3v13h5"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  };
  function icon(name) {
    return `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || ""}</svg>`;
  }
  function esc(value) {
    return String(value ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  }
  function friendlyHost(value) {
    if (value === "claude-code") return "Claude Code";
    if (value === "codex") return "Codex";
    if (value === "cursor") return "Cursor";
    if (value === "antigravity") return "Antigravity";
    return typeof value === "string" && value.trim()
      ? value.trim()
      : "Coding app";
  }
  const sourceLabels = { preview: "Shared workspace", installed: "Coding core history", legacy: "Earlier desktop history" };
  const prefKey = "mosaic.desktop.workspace.v1";
  function readPrefs() {
    try {
      const value = JSON.parse(localStorage.getItem(prefKey) || "{}");
      return value && typeof value === "object" ? value : {};
    } catch {
      return {};
    }
  }
  const prefs = readPrefs();
  const sourcePrefs = (source) => {
    if (
      !prefs[source] ||
      typeof prefs[source] !== "object" ||
      Array.isArray(prefs[source])
    )
      prefs[source] = {};
    if (!Array.isArray(prefs[source].pins)) prefs[source].pins = [];
    return prefs[source];
  };
  function persist() {
    try {
      localStorage.setItem(prefKey, JSON.stringify(prefs));
    } catch {
      /* Private stores can be unavailable. */
    }
  }
  const state = {
    view: "loading",
    directoryLimit: 0,
    source: ["installed", "legacy"].includes(prefs.source) ? prefs.source : "preview",
    project: null,
    id: null,
    backView: "board",
    board: null,
    detail: null,
    boardError: "",
    detailError: "",
    boardAt: 0,
    boardRequest: 0,
    detailRequest: 0,
    boardBusy: false,
    detailBusy: false,
    settings: null,
    settingsLoad: 0,
    settingsError: "",
    dirty: false,
    saving: false,
    formMessage: "",
    formTone: "",
    hostVisible: true,
  };
  const srcName = () =>
    sourceLabels[state.source];
  const surface = $("#surface");
  const nav = $("#navigation");
  const utilities = $("#utilities");
  const form = () => $("#connections-form");
  async function call(method, payload = {}) {
    const bridge = window.webkit?.messageHandlers?.mosaic;
    if (!bridge?.postMessage)
      throw new Error(
        "Open Mosaic Desktop on your Mac to connect to the coordinator.",
      );
    return bridge.postMessage({ method, payload });
  }
  function reason(error, secrets = []) {
    let message = typeof error === "string" ? error : error?.message;
    if (typeof message !== "string" || !message.trim())
      message = "Mosaic could not complete this request.";
    for (const key of secrets)
      if (key) message = message.split(key).join("••••");
    return message.slice(0, 700);
  }
  function stamp(value) {
    if (!value) return "";
    let n = Number(value);
    if (!Number.isFinite(n)) n = Date.parse(value);
    if (!Number.isFinite(n)) return "";
    const date = new Date(n);
    if (Number.isNaN(date.valueOf())) return "";
    return date.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }
  function timeTag(value) {
    const date = stamp(value);
    return date ? `<time>${esc(date)}</time>` : "";
  }
  function announce(message) {
    $("#announcement").textContent = message;
  }
  function labelBtn(action, label, style = "button", extra = "") {
    return `<button type="button" class="${style}" data-action="${action}" ${extra}>${esc(label)}</button>`;
  }
  function attrId(id) {
    return `data-id="${esc(id)}"`;
  }
  function setHtml(el, html) {
    if (el._lastMarkup === html) return;
    const active = el.contains(document.activeElement)
      ? document.activeElement
      : null;
    const focus = active?.id || null;
    const action = active?.dataset?.action;
    const id = active?.dataset?.id ?? "";
    const scroll = el.scrollTop;
    el.innerHTML = html;
    el._lastMarkup = html;
    el.scrollTop = scroll;
    if (active) {
      const target = focus
        ? document.getElementById(focus)
        : Array.from(el.querySelectorAll("[data-action]")).find(
            (x) => x.dataset.action === action && (x.dataset.id ?? "") === id,
          );
      target?.focus({ preventScroll: true });
    }
  }
  function currentProject() {
    return state.board?.projects?.find((p) => p.id === state.project);
  }
  function sortedProjects() {
    const pins = sourcePrefs(state.source).pins;
    return [...(state.board?.projects || [])].sort((a, b) => {
      const order = Number(pins.includes(b.id)) - Number(pins.includes(a.id));
      return (
        order ||
        String(a.name).localeCompare(String(b.name)) ||
        String(a.id).localeCompare(String(b.id))
      );
    });
  }
  function navItem(action, label, glyph, current, id = "", trailing = "") {
    return `<button type="button" class="nav-row" data-action="${action}" ${id ? attrId(id) : ""}${current ? ' aria-current="page"' : ""}>${icon(glyph)}<span class="text">${esc(label)}</span>${trailing}</button>`;
  }
  function paintNav() {
    const total =
      state.board?.cards?.filter((c) => c.lane === "attention").length || 0;
    const pins = sourcePrefs(state.source).pins;
    const shortcuts = sortedProjects().filter((p) => pins.includes(p.id));
    const onBoard = state.view === "board" || state.view === "detail";
    setHtml(
      nav,
      navItem("all", "Projects", "projects", state.view === "all") +
        navItem("attention", "Needs attention", "pulse", state.view === "attention", "",
          total ? `<span class="count">${total}</span>` : "") +
        (shortcuts.length
          ? '<p class="rail-label">Pinned</p>' + shortcuts.map((p) =>
              navItem("project", p.name, "pin", onBoard && state.project === p.id, p.id)).join("")
          : ""),
    );
    setHtml(
      utilities,
      `${navItem("connections", "Connections", "connections", state.view === "connections")}${navItem("settings", "Settings", "settings", state.view === "settings")}${state.view === "all" ? "" : `<div class="rail-hint">${icon("host")} ${esc(srcName())}</div>`}`,
    );
  }
  function crumb() {
    if (state.view === "detail")
      return [currentProject()?.name || "Workspace", "Handoffs"];
    if (state.view === "board")
      return ["Projects", currentProject()?.name || "Board"];
    return [
      "Workspace",
      {
        all: "Projects",
        attention: "Needs attention",
        connections: "Connections",
        settings: "Settings",
        loading: "Opening",
      }[state.view],
    ];
  }
  function paintNotice() {
    let text = "";
    if (!["loading", "connections"].includes(state.view) && state.boardError)
      text = state.board
        ? `Disconnected. Showing the last update${state.boardAt ? " from " + stamp(state.boardAt) : ""}. ${state.boardError}`
        : `Couldn’t load ${srcName()}. ${state.boardError}`;
    if (state.view === "connections" && state.settingsError)
      text = state.settingsError;
    setHtml(
      $("#notice"),
      text
        ? `<div class="notice">${icon("attention")}<span>${esc(text)}</span>${labelBtn(state.view === "connections" && state.dirty ? "reload-settings" : "refresh", state.view === "connections" && state.dirty ? "Reload saved" : "Retry")}</div>`
        : "",
    );
  }
  function paintChrome() {
    paintNav();
    paintNotice();
    const [a, b] = crumb();
    setHtml(
      $("#crumb"),
      state.view === "all" ? `<span>${esc(srcName())}</span>` : `${state.view === "detail" ? labelBtn("back", `Back to ${state.backView === "attention" ? "needs attention" : state.backView === "all" ? "projects" : "board"}`, "text-button crumb-back") : ""}<span>${esc(a)}</span><span aria-hidden="true" class="slash">/</span><strong>${esc(b || "")}</strong>`,
    );
    document.title = `${b || "Workspace"} — Mosaic Preview`;
  }
  function emptyPanel(title, body, action = "", label = "") {
    return `<section class="empty">${icon("projects")}<h2>${esc(title)}</h2><p>${esc(body)}</p>${action ? labelBtn(action, label) : ""}</section>`;
  }
  function selectedAttrs(value, selected) {
    return value === selected ? " selected" : "";
  }
  function routeItem(label, value, glyph) {
    return `<div class="route-item">${icon(glyph)}<span>${esc(label)}</span><strong>${esc(value)}</strong></div>`;
  }
  function laneOf(card) {
    return lanes.find((l) => l.id === card.lane) || lanes[0];
  }
  function statusLine(card) {
    return `<span class="card-status"><span class="dot ${laneOf(card).id}" aria-hidden="true"></span>${esc(card.status || laneOf(card).label)}</span>`;
  }
  function taskCard(card, { projectLabel = false } = {}) {
    const name = state.board.projects.find(
      (p) => p.id === card.projectId,
    )?.name;
    const extra = card.action === "connection" && state.source === "preview";
    return `<article class="task-card${card.action === "host" ? " actionable" : ""}"><button type="button" data-action="detail" ${attrId(card.id)} class="card-main"><span class="card-title">${esc(card.title || "Untitled handoff")}</span>${statusLine(card)}${projectLabel && name ? `<span class="card-meta">${icon("project")}${esc(name)}</span>` : card.worker ? `<span class="card-meta">${icon("worker")}${esc(card.worker)}</span>` : ""}</button>${extra ? labelBtn("connections", "View connection", "text-button card-extra") : ""}</article>`;
  }
  function limitedBoard() {
    return state.board?.truncated
      ? '<p class="hint">Showing the coordinator’s recent history. Older handoffs may be outside this view.</p>'
      : "";
  }
  function pinButton(project) {
    const yes = sourcePrefs(state.source).pins.includes(project.id);
    return `<button type="button" class="icon-button pin-control" data-action="pin" ${attrId(project.id)} aria-pressed="${yes}" aria-label="${yes ? "Unpin" : "Pin"} ${esc(project.name)}" title="${yes ? "Unpin project" : "Pin project"}">${icon("pin")}</button>`;
  }
  function skeleton() {
    return `<p class="loading">${state.boardError ? "No saved view in this session." : "Reading handoffs…"}</p>`;
  }
  function boardMarkup() {
    if (!state.board)
      return `<div class="page-head"><h1>Project board</h1></div>${skeleton()}`;
    const project = currentProject();
    if (!project)
      return `<div class="page-head"><h1>Project board</h1></div>${emptyPanel("Waiting for a handoff", state.source === "preview" ? "Ask your coding app to use Mosaic on a project. Its handoff will appear here." : "Projects appear here when the installed coordinator records a handoff.", state.source === "preview" ? "connections" : "settings", state.source === "preview" ? "View connections" : "Dashboard settings")}${limitedBoard()}`;
    const cards = state.board.cards.filter((x) => x.projectId === project.id);
    const hosts = [...new Set(cards.map((c) => c.host).filter(Boolean))].map(
      friendlyHost,
    );
    const workers = [...new Set(cards.map((c) => c.worker).filter(Boolean))];
    const route = [
      hosts.length
        ? routeItem(
            hosts.length === 1 ? "Coding app" : "Coding apps",
            hosts.join(", "),
            "host",
          )
        : "",
      workers.length
        ? routeItem(
            workers.length === 1 ? "Worker" : "Workers",
            workers.join(", "),
            "worker",
          )
        : "",
    ]
      .filter(Boolean)
      .join("");
    const updatedAt = cards.find((c) => c.updatedAt)?.updatedAt;
    return `<div class="page-head"><h1>${esc(project.name)}</h1>${pinButton(project)}</div>${route ? `<div class="route" aria-label="Recorded connections">${route}</div>` : ""}<div class="lanes">${lanes
      .map((l) => {
        const items = cards.filter((c) => c.lane === l.id);
        return `<section class="lane" aria-label="${l.label}"><div class="lane-heading"><span class="${l.id}">${icon(l.icon)}</span><h2>${l.label}</h2><span class="lane-count">${items.length}</span></div>${items.length ? items.map((c) => taskCard(c)).join("") : '<p class="lane-empty">No handoffs</p>'}</section>`;
      })
      .join(
        "",
      )}</div>${limitedBoard()}${updatedAt ? `<footer class="latest">Last project activity ${timeTag(updatedAt)}</footer>` : ""}`;
  }
  function projectRow(project, cards) {
    const latest = cards[0];
    const waiting = cards.filter((c) => c.lane === "attention").length;
    const working = cards.filter((c) => c.lane === "working").length;
    let status = cards.length === 1 ? (latest.status || "1 handoff") : `${cards.length} handoffs`;
    if (cards.length > 1 && waiting) status = waiting === 1 ? "1 handoff needs attention" : `${waiting} need attention`;
    else if (cards.length > 1 && working) status = `${working} ongoing`;
    return `<div class="project-item">
      <button type="button" data-action="project" ${attrId(project.id)} class="project-open" aria-label="Open project ${esc(project.name)}">
        <span class="folder-mark">${icon("project")}</span>
        <span class="project-caption"><strong>${esc(project.name)}</strong><small>${esc(status)}</small></span>
        ${timeTag(latest?.updatedAt)}
      </button>${pinButton(project)}</div>`;
  }
  function overviewMarkup() {
    const heading = '<div class="page-head"><h1>Projects</h1></div>';
    if (!state.board) return heading + skeleton();
    const projects = sortedProjects();
    if (!projects.length) return heading + emptyPanel("Waiting for a handoff",
      "Projects appear here when your coding app hands work to Mosaic.", "connections", "View connections") + limitedBoard();
    const groups = new Map(projects.map((p) => [p.id, []]));
    for (const card of state.board.cards) groups.get(card.projectId)?.push(card);
    const activity = (c) => Number(c?.updatedAt) || Date.parse(c?.updatedAt) || 0;
    for (const cards of groups.values()) cards.sort((a,b) => activity(b) - activity(a));
    const recent = projects.filter((p) => !p.history || sourcePrefs(state.source).pins.includes(p.id))
      .sort((a,b) => activity(groups.get(b.id)[0]) - activity(groups.get(a.id)[0]));
    const expanded = state.directoryLimit > 0;
    const shown = expanded ? projects.slice(0, state.directoryLimit) : recent.slice(0, 5);
    const rows = shown.map((p) => projectRow(p, groups.get(p.id))).join("");
    const browse = expanded ? labelBtn("recent-projects", "Back to recent", "text-button")
      : projects.length > shown.length ? labelBtn("browse-projects", `Browse all ${projects.length}`, "text-button") : "";
    return `<div class="project-directory">${heading}
      <section aria-label="${expanded ? "All projects" : "Recent projects"}">
        <div class="directory-heading"><h2>${expanded ? "All projects" : "Recent projects"}</h2>${browse}</div>
        ${rows || '<p class="hint">Your saved handoffs are in the full project list.</p>'}
        ${expanded && shown.length < projects.length ? labelBtn("more-projects","Show more projects","text-button more-projects") : ""}
      </section>${limitedBoard()}</div>`;
  }
  function attentionMarkup() {
    const cards = state.board?.cards.filter((c) => c.lane === "attention");
    return `<div class="page-head"><h1>Needs attention</h1></div>${!cards ? skeleton() : cards.length ? `<div class="project-list">${cards.map((c) => taskCard(c, { projectLabel: true })).join("")}</div>` : emptyPanel("Nothing waiting on you", "Handoffs that need a review, an answer, or a connection repair will appear here.")}${limitedBoard()}`;
  }

  function detailMarkup() {
    const items = (state.board?.cards || []).filter(
      (c) => c.projectId === state.project,
    );
    const list = items
      .map(
        (card) =>
          `<button type="button" class="handoff-row" data-action="detail" ${attrId(card.id)} aria-current="${state.id === card.id}"><strong>${esc(card.title)}</strong>${statusLine(card)}</button>`,
      )
      .join("");
    const d = state.detail,
      card = items.find((c) => c.id === state.id);
    const error = state.detailError
      ? `<div class="notice"><span>${esc(state.detailError)}</span>${labelBtn("refresh", "Retry")}</div>`
      : "";
    const hostName = friendlyHost(d?.host || card?.host);
    const info = d
      ? [d.host ? hostName : "", d.worker, d.status]
          .filter(Boolean)
          .map(esc)
          .join(' <span aria-hidden="true">·</span> ')
      : "";
    const timeline = d?.events?.length
      ? `<ol class="timeline" data-lane="${esc(card?.lane || "")}">${d.events.map((e) => `<li><div class="timeline-head"><strong>${esc(e.title)}</strong>${timeTag(e.at)}</div>${e.detail ? `<p>${esc(e.detail)}</p>` : ""}</li>`).join("")}</ol>`
      : '<p class="hint">No events recorded for this handoff.</p>';
    const checks = d?.checks || [];
    const evidence = d
      ? `${checks.length ? `<details class="disclosure" data-ref="checks"><summary>Checks <span class="lane-count">${checks.length}</span></summary>${checks.map((c) => `<div class="check-item"><div class="check-line"><strong>${esc(c.name)}</strong><span>${esc(c.status)}</span></div>${c.output ? `<pre>${esc(c.output)}</pre>` : ""}</div>`).join("")}</details>` : ""}${d.diff ? `<details class="disclosure" data-ref="diff"><summary>Diff</summary><pre>${esc(d.diff)}</pre></details>` : ""}${d.limited ? '<p class="hint">Some history or output is outside the available evidence.</p>' : ""}`
      : "";
    return `<div class="detail-layout"><aside class="handoff-list" aria-label="Project handoffs"><h2>Recent handoffs</h2>${list}</aside><article class="detail-body"><header><h1>${esc(d?.title || card?.title || "Handoff")}</h1>${d?.mode ? `<span class="mode">${esc(d.mode)}</span>` : ""}</header>${error}${d ? `<p class="detail-meta">${info}</p><h2 class="timeline-label">Handoff timeline</h2>${timeline}${evidence}<div class="detail-actions">${hasSession(d) ? labelBtn("open-host", `Open in ${hostName}`, "button primary") : ""}${d.followup ? labelBtn("copy-followup", "Copy follow-up") : ""}</div><p id="handoff-feedback" role="status" class="form-status"></p>` : state.detailError ? "" : '<p class="loading">Reading handoff…</p>'}</article></div>`;
  }
  function hasSession(detail) {
    return (
      detail?.canOpenHost === true ||
      (detail?.canOpenHost == null &&
        typeof detail?.sessionId === "string" &&
        detail.sessionId.length > 0)
    );
  }
  const providers = {
    local: "Local endpoint",
    openrouter: "OpenRouter",
    custom: "Custom endpoint",
  };
  const endpoints = {
    local: "http://127.0.0.1:8080/v1",
    openrouter: "https://openrouter.ai/api/v1",
    custom: "",
  };
  function selectField(id, label, options, value) {
    return `<div class="field"><label for="${id}">${esc(label)}</label><select id="${id}" name="${id}">${Object.entries(
      options,
    )
      .map(
        ([v, l]) =>
          `<option value="${v}"${selectedAttrs(v, value)}>${esc(l)}</option>`,
      )
      .join("")}</select></div>`;
  }
  function inputField(id, label, value, placeholder = "", type = "text") {
    return `<div class="field"><label for="${id}">${esc(label)}</label><input id="${id}" name="${id}" type="${type}" value="${esc(value)}" placeholder="${esc(placeholder)}" spellcheck="false" autocomplete="off"></div>`;
  }
  function keyField(id, saved) {
    return `<div class="field wide key-field"><label for="${id}">API key</label><div class="inline-actions" id="${id}-controls"><span class="saved-state">${saved ? "Key saved" : "No key saved"}</span>${labelBtn("edit-key", saved ? "Replace key" : "Add key", "button", attrId(id))}${saved ? labelBtn("remove-key", "Remove", "text-button", attrId(id)) : ""}</div><input hidden id="${id}" type="password" placeholder="Enter API key" spellcheck="false" autocapitalize="off" autocomplete="new-password"></div>`;
  }
  function routeMarkup(host, model, reviewTarget, reviewerModel) {
    const arrow = `<span class="route-arrow">${icon("arrow")}</span>`;
    return [
      routeItem("Coding app", friendlyHost(host), "host"),
      routeItem("Worker", model.trim() || "Not configured", "worker"),
      routeItem(
        "Reviewer",
        reviewTarget === "api"
          ? reviewerModel.trim() || "API model"
          : friendlyHost(host),
        "check",
      ),
    ].join(arrow);
  }
  function receiptMarkup(s) {
    const t = stamp(s.firstCallAt);
    if (t)
      return `<span class="dot finished"></span><span>First MCP call received · ${esc(t)}</span>`;
    return `<span class="dot ${s.configured ? "attention" : "working"}"></span><span>${s.configured ? "Waiting for the first MCP call" : "Save connections to get your setup command."}</span>`;
  }
  function serviceMarkup(s) {
    return s.configured && s.serviceReady === false
      ? `<div class="notice">${icon("attention")}<span>${esc(s.serviceMessage || "The shared coordinator is unavailable.")}</span></div>`
      : "";
  }

  function connectionsMarkup() {
    const s = state.settings;
    const title = '<div class="page-head"><h1>Connections</h1></div>';
    if (!s)
      return `<div class="connection">${title}<p class="loading">${state.settingsError ? "Settings are unavailable." : "Reading connections…"}</p></div>`;
    const host = s.host || "codex",
      provider = s.provider || "local",
      target = s.reviewTarget || "host";
    if (s.readOnlyReason) return `<div class="connection">${title}<div class="card-panel"><h2>Shared setup</h2><p>${esc(s.readOnlyReason)}</p>${labelBtn("settings", "Dashboard settings")}</div></div>`;
    const install = s.configured
      ? labelBtn("connect-host", `Install in ${friendlyHost(host)}`, "button")
      : "";
    const registration =
      s.registration && s.configured
        ? `
    <details class="registration" data-ref="registration">
      <summary>Host setup command</summary>
      <pre>${esc(s.registration)}</pre>${labelBtn("copy-registration", "Copy setup command")}
    </details>`
        : "";
    const setupNotice =
      !s.configured && s.installedAvailable
        ? `
    <div class="setup-intro">
      <span>Your earlier coding core has saved handoffs.</span>
      ${labelBtn("installed", "View coding core history")}
    </div>`
        : "";
    return `
    <div class="connection">
      ${title}${setupNotice}
      ${state.source !== "preview" ? '<p class="setup-intro">You’re browsing earlier handoffs. These settings apply to your shared workspace.</p>' : '<p class="setup-intro">Terminal and Mosaic Desktop use these connections.</p>'}
      <div class="route" id="connection-route" aria-label="Handoff route">
        ${routeMarkup(host, s.model || "", target, s.reviewerModel || "")}
      </div>
      <div id="service-state">${serviceMarkup(s)}</div>
      <form id="connections-form">
        <section class="form-block">
          <h2>Coding app</h2>
          <div class="card-panel host-panel">
            ${selectField("host", "Start work in", { codex: "Codex", "claude-code": "Claude Code" }, host)}
            <div class="field"><span>MCP connection</span><div class="row-status" id="receipt">${receiptMarkup(s)}</div></div>
            <div class="registration-actions">${install}${registration}</div>
            <p class="form-status wide" role="status" id="host-result" hidden></p>
            ${s.configured && !s.firstCallAt ? '<p id="host-instruction" class="hint wide">After installing, open a new chat in your coding app and ask it to call the mosaic-beta registry_list tool.</p>' : ""}
          </div>
        </section>
        <section class="form-block">
          <div class="form-head"><h2>Worker</h2>${s.configured ? labelBtn("test-worker", "Test saved worker", "text-button", s.model ? "" : "disabled") : ""}</div>
          <div class="card-panel form-rows">
            ${selectField("provider", "Provider", providers, provider)}
            ${inputField("model", "Model", s.model, "Model ID")}
            ${inputField("baseUrl", "Endpoint URL", s.baseUrl || endpoints[provider], "https://…/v1", "url")}
            ${keyField("key", s.hasKey)}
            <p class="form-status" role="status" id="worker-result" hidden></p>
          </div>
        </section>
        <section class="form-block">
          <h2>Reviewer</h2>
          <div class="card-panel form-rows">
            ${selectField("reviewTarget", "Review with", { host: "Coding app", api: "API model" }, target)}
            <fieldset id="reviewer-fields" class="reviewer-fields" ${target === "api" ? "" : "hidden disabled"}>
              <legend class="sr-only">API reviewer</legend>
              ${inputField("reviewerModel", "Reviewer model", s.reviewerModel, "Model ID")}
              ${inputField("reviewerBaseUrl", "Reviewer endpoint URL", s.reviewerBaseUrl, "https://…/v1", "url")}
              ${keyField("reviewerKey", s.reviewerHasKey)}
            </fieldset>
          </div>
        </section>
        <div class="form-actions">
          <p class="form-status" role="status" id="form-message"></p>
          <div class="inline-actions">
            ${s.configured ? labelBtn("board", "View board") : ""}
            <button type="submit" id="save" class="button primary">Save connections</button>
          </div>
        </div>
      </form>
    </div>`;
  }
  function settingsMarkup() {
    const s = state.settings,
      pins = sourcePrefs(state.source).pins;
    const pinned = sortedProjects().filter((p) => pins.includes(p.id));
    return `<div class="prefs"><div class="page-head"><h1>Settings</h1></div><section class="form-block"><h2>Dashboard source</h2><div class="card-panel"><div class="source-choice">${selectField("source", "Show work from", { preview: sourceLabels.preview, ...(s?.installedAvailable || state.source === "installed" ? {installed: sourceLabels.installed} : {}), ...(s?.legacyAvailable || state.source === "legacy" ? {legacy: sourceLabels.legacy} : {}) }, state.source)}${labelBtn("board", "View board")}</div><p class="hint">${state.source !== "preview" ? "Earlier history is read-only. Connection changes apply to your shared workspace." : "Terminal and Desktop show handoffs from the same coordinator."}</p></div></section><section class="form-block"><h2>Pinned projects</h2><div class="card-panel">${pinned.length ? pinned.map((p) => `<div class="mini-row"><span>${esc(p.name)}</span>${pinButton(p)}</div>`).join("") : '<p class="hint">Use the pin on a project board to keep it at the top of your sidebar.</p>'}</div></section></div>`;
  }
  function formStatus(message, tone = "") {
    state.formMessage = message;
    state.formTone = tone;
    writeStatus("#form-message", message, tone);
  }
  function writeStatus(selector, message, tone = "") {
    const el = $(selector);
    if (!el) return;
    el.textContent = message;
    el.classList.remove("success", "error");
    if (tone) el.classList.add(tone);
    el.hidden = !message;
  }
  function updateReceipt(s) {
    const hostChanged = state.dirty && $("#host").value !== s.host;
    setHtml(
      $("#receipt"),
      hostChanged
        ? "<span>Save the new coding app to get its setup instructions.</span>"
        : receiptMarkup(s),
    );
    if ($("#host-instruction"))
      $("#host-instruction").hidden = !!s.firstCallAt || hostChanged;
    const registration = form()?.querySelector(".registration-actions");
    if (registration) registration.hidden = hostChanged;
  }
  function paint({ force = false, reset = false } = {}) {
    paintChrome();
    if (state.view === "connections" && form() && !force) {
      const s = state.settings;
      if (s) {
        updateReceipt(s);
        setHtml($("#service-state"), serviceMarkup(s));
      }
      return;
    }
    const page = {
      board: boardMarkup,
      all: overviewMarkup,
      attention: attentionMarkup,
      detail: detailMarkup,
      connections: connectionsMarkup,
      settings: settingsMarkup,
      loading: () => '<p class="loading">Opening Mosaic…</p>',
    }[state.view];
    const summary = reset
      ? null
      : surface.contains(document.activeElement) &&
          document.activeElement.matches("summary")
        ? document.activeElement.parentElement.dataset.ref
        : null;
    const evidenceOffsets = reset
      ? []
      : Array.from(
          surface.querySelectorAll("details[open] pre"),
          (e) => e.scrollTop,
        );
    const open = reset
      ? []
      : [...surface.querySelectorAll("details[open][data-ref]")].map(
          (d) => d.dataset.ref,
        );
    const scrolls = [".detail-body", ".handoff-list"].map((s) =>
      reset ? 0 : surface.querySelector(s)?.scrollTop || 0,
    );
    const html = page();
    surface.className = `surface ${state.view}-surface`;
    if (force || reset) delete surface._lastMarkup;
    setHtml(surface, html);
    if (reset) surface.scrollTop = 0;
    surface.querySelectorAll("details[data-ref]").forEach((d) => {
      if (open.includes(d.dataset.ref)) d.open = true;
    });
    surface.querySelectorAll("details[open] pre").forEach((e, i) => {
      if (evidenceOffsets[i] != null) e.scrollTop = evidenceOffsets[i];
    });
    if (summary)
      Array.from(surface.querySelectorAll("details[data-ref]"))
        .find((d) => d.dataset.ref === summary)
        ?.querySelector("summary")
        ?.focus({ preventScroll: true });
    [".detail-body", ".handoff-list"].forEach((s, i) => {
      const el = surface.querySelector(s);
      if (el) el.scrollTop = scrolls[i];
    });
    if (form()) formStatus(state.formMessage, state.formTone);
  }

  async function readBoard() {
    if (state.boardBusy) return;
    const request = ++state.boardRequest,
      source = state.source;
    state.boardBusy = true;
    try {
      const board = await call("observer.board", { source });
      if (request !== state.boardRequest) return;
      if (!Array.isArray(board?.projects) || !Array.isArray(board?.cards))
        throw new Error("The coordinator returned an incomplete board.");
      state.board = board;
      state.boardAt = Date.now();
      state.boardError = "";
      if (!board.projects.some((p) => p.id === state.project)) {
        const last = sourcePrefs(source).lastProject;
        const active = board.cards.find((c) =>
          board.projects.some((p) => p.id === c.projectId),
        );
        state.project =
          (board.projects.find((p) => p.id === last)?.id ||
            active?.projectId ||
            sortedProjects()[0]?.id) ??
          null;
      }
    } catch (e) {
      if (request !== state.boardRequest) return;
      state.boardError = reason(e);
    } finally {
      if (request === state.boardRequest) {
        state.boardBusy = false;
        paint();
        if ($("#search-dialog").open) searchResults();
      }
    }
  }
  async function readDetail() {
    if (state.detailBusy || state.view !== "detail" || !state.id) return;
    const request = ++state.detailRequest,
      id = state.id,
      source = state.source;
    state.detailBusy = true;
    try {
      const d = await call("observer.detail", { source, id });
      if (request !== state.detailRequest) return;
      if (!Array.isArray(d?.events) || !Array.isArray(d?.checks))
        throw new Error("The coordinator returned incomplete handoff details.");
      state.detail = d;
      state.detailError = "";
    } catch (e) {
      if (request !== state.detailRequest) return;
      state.detailError = `${state.detail ? "Showing the last handoff update. " : ""}${reason(e)}`;
    } finally {
      if (request === state.detailRequest) {
        state.detailBusy = false;
        paint();
      }
    }
  }
  let settingsPending = false;
  async function readSettings() {
    if (settingsPending || state.saving) return;
    settingsPending = true;
    const request = ++state.settingsLoad;
    try {
      const value = await call("settings.get");
      if (request !== state.settingsLoad) return;
      if (typeof value?.configured !== "boolean")
        throw new Error("Mosaic returned incomplete settings.");
      const changed = state.settings?.revision !== value.revision || state.settings?.readOnlyReason !== value.readOnlyReason;
      if (state.dirty && changed) {
        state.settingsError =
          "Connections changed elsewhere. Reload saved connections before saving your edits.";
        return;
      }
      state.settings = value;
      state.settingsError = "";
      if (state.view === "loading") {
        state.view =
          value.configured ||
          (state.source === "installed" && value.installedAvailable) ||
          (state.source === "legacy" && value.legacyAvailable)
            ? (sourcePrefs(state.source).landing === "board" ? "board" : "all")
            : "connections";
      }
      paint({ force: changed && state.view === "connections" && !state.dirty });
    } catch (e) {
      if (request !== state.settingsLoad) return;
      state.settingsError = `Couldn’t read shared connections. ${reason(e)}`;
      if (state.view === "loading") state.view = "connections";
    } finally {
      if (request === state.settingsLoad) {
        settingsPending = false;
        paint();
      }
    }
  }
  function refresh() {
    if (
      state.view === "connections" ||
      state.view === "loading" ||
      state.view === "settings"
    ) {
      return Promise.all([readSettings(), readBoard()]);
    }
    return Promise.all([readBoard(), readDetail()]);
  }
  function switchSource(source) {
    if (source === state.source) return;
    state.source = source;
    state.directoryLimit = 0;
    prefs.source = source;
    persist();
    state.boardRequest++;
    state.detailRequest++;
    state.board = null;
    state.boardBusy = false;
    state.boardAt = 0;
    state.boardError = "";
    state.project = null;
    state.id = null;
    state.detail = null;
    state.detailBusy = false;
    state.detailError = "";
  }
  function selectProject(id) {
    state.project = id;
    sourcePrefs(state.source).lastProject = id;
    persist();
  }
  function go(view, { id, source } = {}) {
    if (source) switchSource(source);
    if (view === "detail") {
      const card = state.board?.cards.find((c) => c.id === id);
      if (!card) return;
      if (state.view !== "detail")
        state.backView = ["board", "all", "attention"].includes(state.view)
          ? state.view
          : "board";
      if (state.view === "detail" && state.id === id) return;
      selectProject(card.projectId);
    }
    if (view === "board" && id != null) {
      if (!state.board?.projects.some((p) => p.id === id)) return;
      selectProject(id);
    }
    state.detailRequest++;
    state.detailBusy = false;
    state.id = view === "detail" ? id : null;
    state.detail = null;
    state.detailError = "";
    if (view === "all" || view === "board") {
      sourcePrefs(state.source).landing = view;
      persist();
      state.directoryLimit = 0;
    }
    state.view = view;
    state.dirty = false;
    state.formMessage = "";
    state.formTone = "";
    paint({ reset: true, force: true });
    $("#content").focus({ preventScroll: true });
    refresh();
  }
  let discardAction = null;
  function guard(action) {
    if (state.saving) return;
    if (!state.dirty) {
      action();
      return;
    }
    if ($("#discard-dialog").open) return;
    discardAction = action;
    $("#discard-dialog").returnValue = "keep";
    $("#discard-dialog").showModal();
  }
  function togglePin(id) {
    if (!state.board?.projects.some((p) => p.id === id)) return;
    const p = sourcePrefs(state.source);
    const pinned = p.pins.includes(id);
    p.pins = pinned ? p.pins.filter((i) => i !== id) : [...p.pins, id];
    persist();
    paint();
    announce(pinned ? "Project unpinned" : "Project pinned");
  }
  function searchResults() {
    const query = $("#query").value.trim().toLocaleLowerCase();
    const includes = (text) =>
      String(text || "")
        .toLocaleLowerCase()
        .includes(query);
    const projects = sortedProjects().filter((p) => includes(p.name));
    const cards = (state.board?.cards || []).filter((c) => includes(c.title));
    const items = [
      ...projects.map((p) => ({
        id: p.id,
        label: p.name,
        kind: "Project",
        action: "project",
      })),
      ...cards.map((c) => ({
        id: c.id,
        label: c.title,
        kind: "Handoff",
        action: "detail",
      })),
    ];
    setHtml(
      $("#results"),
      items
        .slice(0, 45)
        .map(
          (it) =>
            `<button type="button" class="search-result" data-action="${it.action}" ${attrId(it.id)}>${icon(it.action === "project" ? "project" : "history")}<span>${esc(it.label)}</span><small>${it.kind}</small></button>`,
        )
        .join("") ||
        `<p class="hint">${state.board ? "No matching projects or handoffs." : state.boardError ? "Search is unavailable while disconnected." : "Reading this workspace…"}</p>`,
    );
  }
  function openSearch() {
    if ($("#search-dialog").open) return;
    $("#query").value = "";
    searchResults();
    $("#search-dialog").showModal();
    $("#query").focus();
    if (!state.board) readBoard();
  }
  function showKey(id, remove) {
    if (!["key", "reviewerKey"].includes(id)) return;
    const input = document.getElementById(id),
      controls = document.getElementById(`${id}-controls`);
    const saved =
      id === "key" ? state.settings.hasKey : state.settings.reviewerHasKey;
    input.value = "";
    input.hidden = remove;
    input.dataset.operation = remove ? "remove" : "replace";
    controls.innerHTML = `<span class="saved-state">${remove ? "Key will be removed on save" : "Enter the new key below"}</span>${labelBtn("undo-key", saved ? "Keep saved key" : "Cancel", "text-button", attrId(id))}`;
    if (!remove) input.focus();
    markDirty();
  }
  function undoKey(id) {
    if (!["key", "reviewerKey"].includes(id)) return;
    const input = document.getElementById(id),
      saved =
        id === "key" ? state.settings.hasKey : state.settings.reviewerHasKey;
    input.closest(".key-field").outerHTML = keyField(id, saved);
    markDirty();
  }
  function markDirty() {
    state.dirty = Array.from(form().querySelectorAll("input, select")).some(
      (el) => {
        if (el.type === "password") return !!el.dataset.operation;
        if (el.tagName === "SELECT")
          return !el.selectedOptions[0]?.defaultSelected;
        return el.value !== el.defaultValue;
      },
    );
    const test = form().querySelector('[data-action="test-worker"]');
    if (test) test.disabled = state.dirty || !state.settings.model;
    const install = form().querySelector('[data-action="connect-host"]');
    if (install) install.disabled = state.dirty || registering;
    formStatus(state.dirty ? "Unsaved changes" : "");
    writeStatus("#host-result", "");
    writeStatus("#worker-result", "");
    updateReceipt(state.settings);
    setHtml(
      $("#connection-route"),
      routeMarkup(
        $("#host").value,
        $("#model").value,
        $("#reviewTarget").value,
        $("#reviewerModel").value,
      ),
    );
  }
  function connectionInput(e) {
    if (!e.target.closest("#connections-form")) return;
    if (e.target.id === "provider" && e.type === "change")
      $("#baseUrl").value = endpoints[e.target.value] || "";
    if (e.target.id === "reviewTarget") {
      const fields = $("#reviewer-fields");
      fields.hidden = fields.disabled = e.target.value !== "api";
    }
    markDirty();
  }
  function settingsPayload() {
    const get = (id) => document.getElementById(id).value.trim();
    const p = {
      revision: state.settings.revision,
      host: get("host"),
      provider: get("provider"),
      model: get("model"),
      baseUrl: get("baseUrl"),
      reviewTarget: get("reviewTarget"),
      reviewerModel: get("reviewerModel"),
      reviewerBaseUrl: get("reviewerBaseUrl"),
    };
    for (const id of ["key", "reviewerKey"]) {
      if (id === "reviewerKey" && p.reviewTarget !== "api") continue;
      const el = document.getElementById(id);
      if (el.dataset.operation === "remove") p[id] = "";
      if (el.dataset.operation === "replace") {
        if (!el.value.trim())
          throw new Error("Enter the new API key or cancel its replacement.");
        p[id] = el.value.trim();
      }
    }
    if (p.model && !p.baseUrl)
      throw new Error("Enter an endpoint URL for the worker.");
    if (p.reviewTarget === "api" && (!p.reviewerModel || !p.reviewerBaseUrl))
      throw new Error("Enter the API reviewer’s model and endpoint URL.");
    return p;
  }
  function setSaving(value) {
    state.saving = value;
    if (!form()) return;
    for (const el of form().elements) {
      if (value) {
        el.dataset.wasDisabled = String(el.disabled);
        el.disabled = true;
      } else if (el.dataset.wasDisabled != null) {
        el.disabled = el.dataset.wasDisabled === "true";
        delete el.dataset.wasDisabled;
      }
    }
  }
  async function saveConnections() {
    if (state.saving || !state.settings || state.settings.readOnlyReason) return;
    let payload;
    try {
      payload = settingsPayload();
    } catch (e) {
      formStatus(reason(e), "error");
      return;
    }
    state.settingsLoad++;
    settingsPending = false;
    setSaving(true);
    formStatus(state.settings.configured ? "Saving connections…" : "Preparing the shared runtime and saving connections…");
    try {
      const value = await call("settings.save", payload);
      if (typeof value?.configured !== "boolean")
        throw new Error(
          "Read connections again to confirm whether the save completed.",
        );
      state.settings = value;
      state.settingsError = "";
      state.dirty = false;
      setSaving(false);
      paint({ force: true });
      formStatus(
        value.serviceReady === false
          ? value.serviceMessage ||
              "Saved. The shared coordinator is unavailable."
          : "Connections saved.",
        value.serviceReady === false ? "error" : "success",
      );
    } catch (e) {
      setSaving(false);
      formStatus(reason(e, [payload.key, payload.reviewerKey]), "error");
      readSettings();
    }
  }
  let testing = false;
  async function testWorker() {
    if (
      testing ||
      state.dirty ||
      !state.settings?.configured ||
      !state.settings.model ||
      state.saving
    )
      return;
    const revision = state.settings.revision;
    testing = true;
    writeStatus("#worker-result", "Checking the saved worker…");
    try {
      const result = await call("worker.test");
      if (
        state.view === "connections" &&
        state.settings.revision === revision &&
        !state.dirty
      )
        writeStatus(
          "#worker-result",
          result?.message || "Worker test returned no message.",
          result?.ok ? "success" : "error",
        );
    } catch (e) {
      if (
        state.view === "connections" &&
        state.settings.revision === revision &&
        !state.dirty
      )
        writeStatus("#worker-result", reason(e), "error");
    } finally {
      testing = false;
    }
  }
  let registering = false;
  async function connectHost() {
    if (
      registering ||
      state.dirty ||
      state.saving ||
      !state.settings?.configured
    )
      return;
    const revision = state.settings.revision,
      action = form()?.querySelector('[data-action="connect-host"]');
    registering = true;
    if (action) action.disabled = true;
    writeStatus(
      "#host-result",
      `Installing in ${friendlyHost(state.settings.host)}…`,
    );
    try {
      const result = await call("host.connect");
      if (
        state.view === "connections" &&
        revision === state.settings.revision &&
        !state.dirty
      )
        writeStatus(
          "#host-result",
          result?.message ||
            (result?.ok
              ? "Registration installed."
              : "Couldn’t install registration. Use the setup command."),
          result?.ok ? "success" : "error",
        );
    } catch (e) {
      if (
        state.view === "connections" &&
        revision === state.settings.revision &&
        !state.dirty
      )
        writeStatus(
          "#host-result",
          `${reason(e)} You can copy the host setup command.`,
          "error",
        );
    } finally {
      registering = false;
      if (action && !state.dirty) action.disabled = false;
    }
  }
  async function copyText(value, context) {
    if (!value) return;
    const id = state.id,
      source = state.source,
      view = state.view;
    let msg;
    try {
      await call("clipboard.copy", { text: value });
      msg =
        context === "handoff" ? "Follow-up copied." : "Setup command copied.";
    } catch (e) {
      msg = reason(e);
    }
    if (id !== state.id || source !== state.source || view !== state.view)
      return;
    if (context === "handoff" && $("#handoff-feedback"))
      $("#handoff-feedback").textContent = msg;
    else if (view === "connections") writeStatus("#host-result", msg);
    announce(msg);
  }
  async function openHost() {
    const id = state.id,
      source = state.source;
    if (!hasSession(state.detail)) return;
    try {
      await call("host.open", { source, id });
    } catch (e) {
      if (id !== state.id || source !== state.source) return;
      const msg = `${reason(e)}${state.detail?.followup ? " Use Copy follow-up to continue in your coding app." : ""}`;
      if ($("#handoff-feedback")) $("#handoff-feedback").textContent = msg;
      announce(msg);
    }
  }

  document.addEventListener("click", (event) => {
    const el = event.target.closest("button[data-action]");
    if (!el || el.disabled) return;
    const { action, id } = el.dataset;
    if (el.closest("#search-dialog")) $("#search-dialog").close();
    switch (action) {
      case "refresh":
        refresh();
        break;
      case "reload-settings":
        guard(() => {
          state.dirty = false;
          go("connections");
        });
        break;
      case "browse-projects":
      case "more-projects":
      case "recent-projects":
        state.directoryLimit = action === "recent-projects" ? 0 : state.directoryLimit + 12;
        paint();
        if (action !== "more-projects") surface.scrollTop = 0;
        surface.querySelector(action === "recent-projects" ? '[data-action="browse-projects"]' : '[data-action="recent-projects"]')?.focus({preventScroll:true});
        break;
      case "project":
        guard(() => go("board", { id }));
        break;
      case "back":
        guard(() => go(state.backView));
        break;
      case "installed":
        guard(() => go("all", { source: "installed" }));
        break;
      case "board":
      case "all":
      case "attention":
      case "connections":
      case "settings":
        if (action !== state.view) guard(() => go(action));
        break;
      case "detail":
        guard(() => go("detail", { id }));
        break;
      case "pin":
        togglePin(id);
        break;
      case "search":
        openSearch();
        break;
      case "copy-followup":
        copyText(state.detail?.followup, "handoff");
        break;
      case "copy-registration":
        copyText(state.settings?.registration, "registration");
        break;
      case "test-worker":
        testWorker();
        break;
      case "connect-host":
        connectHost();
        break;
      case "edit-key":
        showKey(id, false);
        break;
      case "remove-key":
        showKey(id, true);
        break;
      case "undo-key":
        undoKey(id);
        break;
      case "open-host":
        openHost();
        break;
    }
  });
  document.addEventListener("input", (e) => {
    if (e.target.id === "query") searchResults();
    else connectionInput(e);
  });
  document.addEventListener("change", (e) => {
    if (e.target.id === "source") go("settings", { source: e.target.value });
    else connectionInput(e);
  });
  document.addEventListener("submit", (e) => {
    if (e.target.id === "connections-form") {
      e.preventDefault();
      saveConnections();
    }
  });
  $("#discard-dialog").addEventListener("close", () => {
    const action = discardAction;
    discardAction = null;
    if ($("#discard-dialog").returnValue === "discard" && action) {
      state.dirty = false;
      action();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (
      !(e.metaKey || e.ctrlKey) ||
      e.shiftKey ||
      e.altKey ||
      $("#discard-dialog").open
    )
      return;
    if (e.key.toLowerCase() === "k") {
      e.preventDefault();
      openSearch();
    }
    if (e.key.toLowerCase() === "r") {
      e.preventDefault();
      refresh();
    }
  });
  $("#query").addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "Enter") {
      const first = $("#results button");
      if (first) {
        e.preventDefault();
        if (e.key === "Enter") first.click();
        else first.focus();
      }
    }
  });
  function setHostVisible(visible) {
    const was = state.hostVisible;
    state.hostVisible = visible === true;
    if (state.hostVisible && !was) refresh();
  }
  window.MosaicRuntime = { refresh, setHostVisible };
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.hostVisible) refresh();
  });
  window.setInterval(() => {
    if (state.hostVisible && !document.hidden) refresh();
  }, 8000);
  $("#search-button").insertAdjacentHTML("afterbegin", icon("search"));
  $("#refresh-button").innerHTML = icon("refresh");
  paint();
  refresh();
})();
