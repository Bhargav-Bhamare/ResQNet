import { ApiError, apiPaths, clearSession, createApiClient, readSession } from "./api.mjs";
import { login, logout, restoreSession } from "./session.mjs";

const state = {
  session: null,
  view: "overview",
  reporting: null,
  reportingError: null,
  investigations: [],
  investigationPagination: null,
  investigationError: null,
  investigationFilter: {},
  investigationLoading: false,
  investigationDetail: null,
  detailError: null,
  detailLoading: false,
  previewEvidence: null,
  previewError: null,
  previewLoading: false,
  creatingInvestigation: false,
  previewSourceCode: "",
  interpretationHistory: [],
  interpretationPagination: null,
  selectedInterpretation: null,
  aiError: null,
  aiErrorKind: "history",
  aiGenerating: false,
};

const loginScreen = document.getElementById("login-screen");
const workspace = document.getElementById("workspace");
const content = document.getElementById("page-content");
const loginForm = document.getElementById("login-form");
const loginError = document.getElementById("login-error");
const loginButton = document.getElementById("login-submit");
const toast = document.getElementById("toast");
let toastTimer;

const api = createApiClient({
  onUnauthorized() {
    clearSession();
    state.session = null;
    showLogin("Your session has expired. Sign in again to continue.");
  },
});

function node(tag, text = "", className = "") {
  const element = document.createElement(tag);
  if (text !== null && text !== undefined) element.textContent = String(text);
  if (className) element.className = className;
  return element;
}

function button(text, onClick, className = "button") {
  const element = node("button", text, className);
  element.type = "button";
  element.addEventListener("click", onClick);
  return element;
}

function panel(title, children = [], className = "") {
  const section = node("section", "", `panel ${className}`.trim());
  const header = node("div", "", "panel-header");
  header.append(node("h2", title));
  section.append(header);
  for (const child of children) section.append(child);
  return section;
}

function emptyState(title, message, action) {
  const box = node("div", "", "empty-state");
  box.append(node("strong", title), node("span", message));
  if (action) box.append(action);
  return box;
}

function notice(message, kind = "warning") {
  return node("p", message, `notice notice-${kind}`);
}

function formatDate(value) {
  if (!value) return "Not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? String(value)
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}

function formatValue(value) {
  if (value === null || value === undefined || value === "") return "Unavailable";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function humanize(value) {
  return typeof value === "string"
    ? value.replaceAll("_", " ")
    : "Unavailable";
}

function statusClass(status) {
  if (["complete", "reviewed", "closed", "available", "normal_variation"].includes(status)) return "status-good";
  if (["reporting_gap", "in_progress", "under_review", "requires_more_information", "unknown", "insufficient_history"].includes(status)) return "status-warning";
  if (["channel_unavailable", "unavailable", "anomaly"].includes(status)) return "status-critical";
  return "status-info";
}

function statusBadge(status) {
  return node("span", humanize(status), `status ${statusClass(status)}`);
}

function heading(kicker, title, description, actions = []) {
  const section = node("section", "", "page-heading");
  const text = node("div");
  text.append(node("p", kicker, "eyebrow"), node("h1", title), node("p", description));
  section.append(text);
  if (actions.length) {
    const actionRow = node("div", "", "action-row");
    actions.forEach((action) => actionRow.append(action));
    section.append(actionRow);
  }
  return section;
}

function dataList(entries) {
  const list = node("dl", "", "data-list");
  for (const [label, value] of entries) {
    list.append(node("dt", label), node("dd", formatValue(value)));
  }
  return list;
}

function table(headers, rows) {
  const wrap = node("div", "", "table-wrap");
  const tableElement = node("table");
  const thead = node("thead");
  const headRow = node("tr");
  headers.forEach((label) => headRow.append(node("th", label)));
  thead.append(headRow);
  const tbody = node("tbody");
  rows.forEach((cells) => {
    const row = node("tr");
    cells.forEach((cell) => {
      const td = node("td");
      if (cell instanceof Node) td.append(cell);
      else td.textContent = formatValue(cell);
      row.append(td);
    });
    tbody.append(row);
  });
  tableElement.append(thead, tbody);
  wrap.append(tableElement);
  return wrap;
}

function setToast(message, isError = false) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.toggle("toast-error", isError);
  toast.hidden = false;
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 5500);
}

function showLogin(message = "") {
  loginScreen.hidden = false;
  workspace.hidden = true;
  loginError.textContent = message;
  loginError.hidden = !message;
  loginForm.reset();
}

function showWorkspace() {
  if (!state.session?.investigator) {
    showLogin();
    return;
  }
  loginScreen.hidden = true;
  workspace.hidden = false;
  document.getElementById("investigator-name").textContent =
    state.session.investigator.name || state.session.investigator.email || "Investigator";
  document.getElementById("investigator-role").textContent =
    state.session.investigator.role || "unknown role";
  document.getElementById("topbar-caption").textContent =
    `${state.session.investigator.email || ""} · ${humanize(state.session.investigator.role)}`;
  renderNavigation();
  renderCurrentView();
}

function renderNavigation() {
  for (const item of document.querySelectorAll("[data-view]")) {
    const active = item.dataset.view === state.view ||
      (state.view.startsWith("detail:") && item.dataset.view === "investigations");
    item.setAttribute("aria-current", active ? "page" : "false");
  }
}

function navigate(view) {
  state.view = view;
  state.detailError = null;
  state.previewError = null;
  history.replaceState(null, "", `#${view}`);
  renderNavigation();
  renderCurrentView();
  document.getElementById("sidebar").classList.remove("sidebar-open");
  document.getElementById("menu-toggle").setAttribute("aria-expanded", "false");
  content.focus({ preventScroll: true });

  if (view === "overview") loadOverview();
  if (view === "reporting") loadReporting();
  if (view === "investigations") loadInvestigations();
  if (view === "preview") loadReporting();
}

function renderCurrentView() {
  if (!state.session) return showLogin();
  content.replaceChildren();
  if (state.view.startsWith("detail:")) {
    renderDetail();
    return;
  }
  if (state.view === "reporting") return renderReporting();
  if (state.view === "investigations") return renderInvestigations();
  if (state.view === "preview") return renderPreview();
  renderOverview();
}

function reportingTable(sources) {
  if (!sources.length) {
    return emptyState(
      "No configured sources are visible",
      "No reporting sources are currently assigned or configured for this account. This is not evidence of improved public-health conditions.",
      button("Refresh reporting data", loadReporting),
    );
  }
  const rows = sources.map((source) => {
    const completeness = source.completenessPercent;
    const cell = node("div");
    cell.append(node("span", completeness === null ? "Unavailable" : `${formatValue(completeness)}%`));
    if (typeof completeness === "number") {
      const track = node("div", "", "progress-track");
      const fill = node("div", "", "progress-fill");
      fill.style.width = `${Math.max(0, Math.min(100, completeness))}%`;
      track.append(fill);
      cell.append(track);
    }
    return [
      source.sourceCode,
      source.frequency || "Not supplied",
      `${formatValue(source.period?.start)} – ${formatValue(source.period?.end)}`,
      source.expectedReports,
      source.eligibleReceivedReports,
      cell,
      statusBadge(source.channelAvailability),
      statusBadge(source.status),
    ];
  });
  return table(
    ["Source", "Frequency", "Current period", "Expected", "Trusted received", "Completeness", "Channel", "Status"],
    rows,
  );
}

function renderOverview() {
  content.replaceChildren(
    heading(
      "OPERATIONS OVERVIEW",
      "Reporting continuity",
      "A reporting gap is an observation about the reporting process. It does not establish a change in real-world public-health activity.",
      [button("Refresh overview", loadOverview)],
    ),
  );
  if (state.reportingError || state.investigationError) {
    const errors = node("div", "", "grid grid-2");
    if (state.reportingError) {
      errors.append(notice(`Reporting completeness: ${state.reportingError.message}`, "error"));
    }
    if (state.investigationError) {
      errors.append(notice(`Investigation history: ${state.investigationError.message}`, "error"));
    }
    content.append(errors);
  }
  if (!state.reporting && !state.investigations.length && state.investigationLoading) {
    content.append(node("p", "Loading source-scoped reporting and investigation data…", "skeleton"));
    return;
  }
  const sources = state.reporting?.sources || [];
  const investigations = state.investigations;
  const metrics = node("div", "", "metric-grid");
  const gapCount = sources.filter((source) =>
    ["reporting_gap", "channel_unavailable", "incomplete_channel_unavailable"].includes(source.status),
  ).length;
  for (const [label, value, noteText] of [
    ["Visible sources", state.reporting ? state.reporting.count : "Unavailable", "Authorized source scope"],
    ["Reporting gaps", state.reporting ? gapCount : "Unavailable", "Requires verification"],
    ["Investigations", state.investigationPagination?.total ?? (state.investigationError ? "Unavailable" : investigations.length), "Persisted records"],
    ["Latest evaluation", state.reporting ? formatDate(state.reporting.evaluatedAt) : "Unavailable", "Server evaluation time"],
  ]) {
    const metric = node("div", "", "metric");
    metric.append(node("div", label, "metric-label"), node("div", value, "metric-value"), node("div", noteText, "metric-note"));
    metrics.append(metric);
  }
  content.append(metrics);
  if (state.reporting) {
    content.append(panel("Reporting status", [
      reportingTable(sources),
      ...(Array.isArray(state.reporting.limitations)
        ? [node("p", state.reporting.limitations.join(" "), "help-text")]
        : []),
    ]));
  } else if (state.reportingError) {
    content.append(emptyState("Reporting data unavailable", "The dashboard did not receive a completeness response.", button("Retry", loadReporting)));
  }
  const recent = panel("Recent investigations");
  if (investigationLoadingOrError()) {
    recent.append(node("p", state.investigationLoading ? "Loading recent investigations…" : state.investigationError.message, "muted"));
  } else if (!investigations.length) {
    recent.append(emptyState("No investigations found", "No records are available in your authorized scope. A lack of records is not a real-world health signal."));
  } else {
    recent.append(investigationTable(investigations));
    recent.append(button("View investigation history", () => navigate("investigations"), "button button-quiet"));
  }
  content.append(recent);
  const sourceNotice = notice("Completeness is calculated from trusted attributed reports. Missing trusted reports do not prove that no cases or public-health activity exist.", "warning");
  content.append(sourceNotice);
}

function investigationLoadingOrError() {
  return state.investigationLoading || Boolean(state.investigationError);
}

function investigationTable(records) {
  return table(
    ["Investigation", "Source", "Created", "Creator ID", "Assigned investigator ID", "Evaluation", "Periods", "Status"],
    records.map((item) => {
      const open = button(item.investigationId, () => openDetail(item.investigationId), "table-link");
      return [
        open,
        item.sourceCode,
        formatDate(item.createdAt),
        item.createdBy,
        item.assignedTo || "Unassigned",
        formatDate(item.evaluatedAt),
        item.periods,
        statusBadge(item.status),
      ];
    }),
  );
}

function renderReporting() {
  content.replaceChildren(
    heading(
      "MONITORING",
      "Reporting completeness",
      "Completeness describes trusted reports received against the expected reporting schedule—not disease incidence or the absence of cases.",
      [button("Refresh", loadReporting)],
    ),
  );
  if (state.reportingError) {
    content.append(emptyState("Could not load reporting data", state.reportingError.message, button("Try again", loadReporting)));
    return;
  }
  if (!state.reporting) {
    content.append(node("p", "Loading source-scoped reporting data…", "skeleton"));
    return;
  }
  const info = node("div", "", "metric-grid");
  for (const [label, value, noteText] of [
    ["Visible sources", state.reporting.count, "Source-scoped by server"],
    ["Evaluated at", formatDate(state.reporting.evaluatedAt), "Server timestamp"],
    ["Reporting gaps", state.reporting.sources.filter((source) => source.status === "reporting_gap").length, "Cause not established"],
    ["Channel unknown", state.reporting.sources.filter((source) => source.channelAvailability === "unknown").length, "Not independently verified"],
  ]) {
    const metric = node("div", "", "metric");
    metric.append(node("div", label, "metric-label"), node("div", value, "metric-value"), node("div", noteText, "metric-note"));
    info.append(metric);
  }
  content.append(info);
  content.append(panel("Current source status", [reportingTable(state.reporting.sources)]));
  content.append(panel("Interpretation and limitations", [
    notice("A 0% completeness value means no trusted attributed reports were counted for this period. It does not prove that no public-health activity occurred.", "warning"),
    ...(Array.isArray(state.reporting.limitations)
      ? state.reporting.limitations.map((text) => node("p", text, "help-text"))
      : []),
  ]));
}

async function loadOverview() {
  if (!state.session) return;
  state.reporting = null;
  state.reportingError = null;
  state.investigationError = null;
  state.investigationLoading = true;
  renderOverview();
  const results = await Promise.allSettled([
    api.request(apiPaths.reporting),
    api.request(`${apiPaths.investigations}?page=1&limit=5&sort=desc`),
  ]);
  if (results[0].status === "fulfilled") {
    state.reporting = results[0].value;
  } else {
    state.reportingError = results[0].reason;
  }
  if (results[1].status === "fulfilled") {
    state.investigations = results[1].value?.investigations || [];
    state.investigationPagination = results[1].value?.pagination || null;
  } else {
    state.investigationError = results[1].reason;
  }
  state.investigationLoading = false;
  if (state.view === "overview") renderOverview();
}

async function loadReporting() {
  if (!state.session) return;
  state.reporting = null;
  state.reportingError = null;
  if (state.view === "reporting") renderReporting();
  if (state.view === "preview") renderPreview();
  try {
    state.reporting = await api.request(apiPaths.reporting);
  } catch (error) {
    state.reportingError = error;
  }
  if (state.view === "reporting") renderReporting();
  if (state.view === "preview") renderPreview();
}

function renderInvestigations() {
  content.replaceChildren(
    heading(
      "CASEWORK",
      "Investigation history",
      "Browse persisted evidence reviews in your authorized scope. Filters and pagination are applied by the server.",
      [button("Refresh", () => loadInvestigations())],
    ),
  );
  const form = node("form", "", "filter-form");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(form);
    state.investigationFilter = Object.fromEntries(
      ["sourceCode", "status", "createdBy", "assignedTo"]
        .map((key) => [key, String(data.get(key) || "").trim()])
        .filter(([, value]) => value),
    );
    loadInvestigations(1);
  });
  form.append(
    selectField("Status", "status", [
      ["", "All statuses"],
      ["generated", "Generated"],
      ["under_review", "Under review"],
      ["requires_more_information", "Requires more information"],
      ["reviewed", "Reviewed"],
      ["closed", "Closed"],
    ], state.investigationFilter.status || ""),
    textField("Source code", "sourceCode", state.investigationFilter.sourceCode || "", "Filter by exact authorized code"),
    textField("Creator ID", "createdBy", state.investigationFilter.createdBy || "", "Investigator ID"),
    textField("Assignee ID", "assignedTo", state.investigationFilter.assignedTo || "", "Investigator ID"),
    submitButton("Apply filters"),
    button("Clear", () => {
      state.investigationFilter = {};
      loadInvestigations(1);
    }, "button button-quiet"),
  );
  content.append(panel("Server-side filters", [form]));
  if (state.investigationLoading) {
    content.append(node("p", "Loading investigation records…", "skeleton"));
    return;
  }
  if (state.investigationError) {
    content.append(emptyState("History request failed", state.investigationError.message, button("Retry", () => loadInvestigations())));
    return;
  }
  const records = state.investigations;
  if (!records.length) {
    const anyFilters = Object.keys(state.investigationFilter).length > 0;
    content.append(emptyState(
      anyFilters ? "No investigations match these filters" : "No investigations in your scope",
      anyFilters
        ? "Try changing or clearing the server-side filters."
        : "No accessible investigation records were returned. This is not evidence of an improvement in health conditions.",
      anyFilters ? button("Clear filters", () => {
        state.investigationFilter = {};
        loadInvestigations(1);
      }) : null,
    ));
    return;
  }
  content.append(panel("Investigation records", [
    investigationTable(records),
    paginationControls(state.investigationPagination, loadInvestigations),
  ]));
}

function selectField(label, name, options, value) {
  const wrapper = node("label", "", "field");
  wrapper.append(node("span", label));
  const select = node("select");
  select.name = name;
  options.forEach(([optionValue, text]) => {
    const option = node("option", text);
    option.value = optionValue;
    option.selected = optionValue === value;
    select.append(option);
  });
  wrapper.append(select);
  return wrapper;
}

function textField(label, name, value = "", hint = "") {
  const wrapper = node("label", "", "field");
  wrapper.append(node("span", label));
  const input = node("input");
  input.name = name;
  input.value = value;
  input.autocomplete = "off";
  if (hint) input.placeholder = hint;
  wrapper.append(input);
  return wrapper;
}

function submitButton(text) {
  const submit = node("button", text, "button button-primary");
  submit.type = "submit";
  return submit;
}

function paginationControls(pagination, onPage) {
  const wrapper = node("div", "", "pagination");
  if (!pagination) return wrapper;
  wrapper.append(
    button("Previous", () => onPage(pagination.page - 1), "button button-quiet"),
    node("p", `Page ${pagination.page} of ${Math.max(1, pagination.pages)} · ${pagination.total} total records`),
    button("Next", () => onPage(pagination.page + 1), "button button-quiet"),
  );
  wrapper.querySelector("button").disabled = pagination.page <= 1;
  wrapper.querySelectorAll("button")[1].disabled =
    pagination.pages === 0 || pagination.page >= pagination.pages;
  return wrapper;
}

async function loadInvestigations(page = 1) {
  if (!state.session) return;
  state.investigationLoading = true;
  state.investigationError = null;
  state.investigationPage = page;
  if (state.view === "investigations") renderInvestigations();
  const params = new URLSearchParams({ page: String(page), limit: "25", sort: "desc" });
  for (const [key, value] of Object.entries(state.investigationFilter)) {
    if (value) params.set(key, value);
  }
  try {
    const result = await api.request(`${apiPaths.investigations}?${params}`);
    state.investigations = result?.investigations || [];
    state.investigationPagination = result?.pagination || null;
  } catch (error) {
    state.investigationError = error;
    state.investigations = [];
    state.investigationPagination = null;
  } finally {
    state.investigationLoading = false;
    if (state.view === "investigations") renderInvestigations();
  }
}

function renderPreview() {
    content.replaceChildren(
      heading(
        "EVIDENCE WORKFLOW",
        "Preview before creating",
        "Previewing is read-only. A persistent investigation is created only after you choose Create Investigation.",
      ),
    );
    const sources = state.reporting?.sources || [];
    if (!state.reporting && !state.reportingError) {
      content.append(node("p", "Loading authorized source list…", "skeleton"));
      return;
    }
    if (state.reportingError) {
      content.append(emptyState("Authorized sources unavailable", state.reportingError.message, button("Retry", loadReporting)));
      return;
    }
    if (!sources.length) {
      content.append(emptyState("No authorized reporting sources", "There is no source available to preview. Source codes are not hardcoded in this interface."));
      return;
    }
    const form = node("form", "", "inline-form");
    const sourceSelect = selectField(
      "Reporting source",
      "sourceCode",
      sources.map((source) => [source.sourceCode, source.sourceCode]),
      state.previewSourceCode || sources[0].sourceCode,
    );
    sourceSelect.querySelector("select").required = true;
    const previewButton = submitButton(
      state.previewLoading ? "Loading preview…" : "Preview evidence",
    );
    previewButton.disabled = state.previewLoading;
    form.append(sourceSelect, previewButton);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      state.previewSourceCode = String(new FormData(form).get("sourceCode") || "");
      loadEvidencePreview(state.previewSourceCode);
    });
    content.append(panel("Select an authorized source", [form]));
    if (state.previewLoading) {
      content.append(node("p", "Generating a read-only evidence preview…", "skeleton"));
      return;
    }
    if (state.previewError) {
      content.append(emptyState("Evidence preview failed", state.previewError.message, button("Retry preview", () => loadEvidencePreview(state.previewSourceCode))));
      return;
    }
    if (!state.previewEvidence) {
      content.append(emptyState("No preview requested", "Choose a source and request its current deterministic evidence. No investigation is created by previewing."));
      return;
    }
    content.append(renderEvidence(state.previewEvidence));
    const createPanel = panel("Create persistent investigation", [
      notice("This action persists an immutable evidence snapshot and creates a review-history record. It does not run AI interpretation.", "warning"),
      ...(state.session.investigator.role === "viewer"
        ? [notice("Viewer access is read-only. You may preview evidence but cannot create an investigation.", "warning")]
        : [button(
            state.creatingInvestigation ? "Creating…" : "Create Investigation",
            createInvestigation,
            "button button-primary create-investigation-button",
          )]),
    ]);
    content.append(createPanel);
  }

  async function loadEvidencePreview(sourceCode) {
    if (!sourceCode) return;
    state.previewLoading = true;
    state.previewError = null;
    state.previewEvidence = null;
    renderPreview();
    try {
      const encoded = encodeURIComponent(sourceCode);
      state.previewEvidence = await api.request(`${apiPaths.investigations}/${encoded}/evidence`);
    } catch (error) {
      state.previewError = error;
    } finally {
      state.previewLoading = false;
      if (state.view === "preview") renderPreview();
    }
  }

  async function createInvestigation() {
      if (!state.previewSourceCode || !state.previewEvidence || state.creatingInvestigation) return;
    if (!window.confirm("Create a persistent investigation from this evidence snapshot?")) return;
      state.creatingInvestigation = true;
      const sourceCode = encodeURIComponent(state.previewSourceCode);
      const createButton = content.querySelector(".create-investigation-button");
      if (createButton) createButton.disabled = true;
    try {
      const result = await api.request(`${apiPaths.investigations}/${sourceCode}`, {
        method: "POST",
        body: {},
      });
      if (!result?.investigationId || result.status !== "generated") {
        throw new ApiError("The server did not confirm investigation creation.", {
          code: "INVALID_RESPONSE",
        });
      }
      state.previewEvidence = null;
      state.creatingInvestigation = false;
      state.investigationFilter = {};
      loadInvestigations(1);
      setToast(`Investigation ${result.investigationId} created with status ${result.status}.`);
      await openDetail(result.investigationId);
    } catch (error) {
      state.creatingInvestigation = false;
      setToast(error.message, true);
      if (createButton) createButton.disabled = false;
    }
  }

  function renderEvidence(snapshot) {
    const container = node("section", "", "panel");
    container.append(node("div", "DETERMINISTIC SOURCE SNAPSHOT", "eyebrow"));
    const meta = snapshot?.metadata || {};
    const observed = snapshot?.observedFacts || {};
    const calculated = snapshot?.calculatedFindings || {};
    const completeness = calculated.completeness || {};
    const baseline = calculated.historicalBaseline || {};
    const anomaly = calculated.anomaly || {};
    const period = meta.period || {};
    const blocks = node("div", "", "evidence-grid");

    blocks.append(evidenceBlock("Current reporting period", [
      ["Source code", meta.sourceCode || snapshot?.summary?.sourceCode],
      ["Reporting frequency", meta.frequency],
      ["Period start (source timestamp)", period.start],
      ["Period end (source timestamp)", period.end],
      ["Evaluated at (source timestamp)", meta.evaluatedAt],
      ["Evidence version", snapshot?.schemaVersion],
    ], "evidence-period"));
    blocks.append(evidenceBlock("Observed facts", [
      ["Expected reports", observed.expectedReports],
      ["Trusted reports received", observed.eligibleReceivedReports],
      ["Period status", observed.periodStatus],
      ["Channel availability", observed.channelAvailability],
      ["Historical observation count", observed.historicalObservationCount],
    ], "evidence-observed"));
    blocks.append(evidenceBlock("Calculated completeness", [
      ["Status", completeness.status],
      ["Completeness percent", completeness.percent === null || completeness.percent === undefined ? completeness.percent : `${formatValue(completeness.percent)}%`],
    ], "evidence-completeness"));
    blocks.append(evidenceBlock("Historical baseline", [
      ["Status", baseline.status],
      ["Minimum observations", baseline.minimumObservations],
      ["Valid historical periods", baseline.validHistoricalPeriods],
      ["Mean eligible reports", baseline.meanEligibleReports],
      ["Median eligible reports", baseline.medianEligibleReports],
      ["Minimum eligible reports", baseline.minimumEligibleReports],
      ["Maximum eligible reports", baseline.maximumEligibleReports],
      ["Population standard deviation", baseline.populationStandardDeviation],
    ], "evidence-baseline"));
    blocks.append(evidenceBlock("Anomaly findings", [
      ["Status", anomaly.status],
      ["Type", anomaly.type],
      ["Deviation category", anomaly.deviationCategory],
      ["Absolute difference", anomaly.absoluteDifference],
      ["Percentage deviation", anomaly.percentageDeviation],
    ], "evidence-anomaly"));

    const limitations = snapshot?.limitationsAndUnknowns || {};
    blocks.append(evidenceBlock("Limitations and unknowns", [
      ["Limitations", limitations.limitations],
      ["Unknowns", limitations.unknowns],
      ["Possible explanations", limitations.possibleExplanations],
    ], "evidence-limitations"));
    if (Array.isArray(snapshot?.interpretationBoundaries)) {
      blocks.append(evidenceBlock("Interpretation boundaries", [
        ["Boundaries", snapshot.interpretationBoundaries],
      ], "evidence-boundaries"));
    }
    container.append(blocks);
    container.append(notice("Reporting anomalies and reduced report counts do not prove an outbreak, its end, improved public health, or intentional suppression. Preserve unavailable values as unavailable.", "warning"));
    return container;
  }

  function evidenceBlock(title, entries, id) {
    const section = node("section", "", "evidence-section");
    if (id) section.id = id;
    section.append(node("h3", title));
    const list = node("dl", "", "data-list");
    for (const [label, value] of entries) {
      list.append(node("dt", label));
      const dd = node("dd");
      if (Array.isArray(value)) {
        if (!value.length) dd.textContent = "None supplied";
        else {
          const ul = node("ul", "", "list-clean");
          value.forEach((item) => ul.append(node("li", item)));
          dd.append(ul);
        }
      } else {
        dd.textContent = formatValue(value);
      }
      list.append(dd);
    }
    section.append(list);
    return section;
  }

  async function openDetail(investigationId) {
    state.view = `detail:${investigationId}`;
    state.detailLoading = true;
    state.detailError = null;
    state.investigationDetail = null;
    state.interpretationHistory = [];
    state.interpretationPagination = null;
    state.selectedInterpretation = null;
    state.aiError = null;
    state.aiErrorKind = "history";
    history.replaceState(null, "", `#investigation/${encodeURIComponent(investigationId)}`);
    renderNavigation();
    renderCurrentView();
    const id = encodeURIComponent(investigationId);
    const results = await Promise.allSettled([
      api.request(`${apiPaths.investigations}/${id}`),
      api.request(`${apiPaths.investigations}/${id}/interpretations?limit=25&page=1`),
    ]);
    if (results[0].status === "fulfilled") {
      state.investigationDetail = results[0].value;
    } else {
      state.detailError = results[0].reason;
    }
    if (results[1].status === "fulfilled") {
      state.interpretationHistory = (results[1].value?.interpretations || [])
        .filter((record) => record.validationStatus === "validated");
      state.interpretationPagination = results[1].value?.pagination || null;
      state.selectedInterpretation = state.interpretationHistory[0] || null;
    } else {
      state.aiError = results[1].reason;
      state.aiErrorKind = "history";
    }
    state.detailLoading = false;
    if (state.view === `detail:${investigationId}`) renderDetail();
  }

  function renderDetail() {
    if (!state.session) return showLogin();
    content.replaceChildren(
      heading(
        "INVESTIGATION WORKSPACE",
        "Investigation detail",
        "Immutable deterministic evidence, append-only review history, and optional AI assistance.",
        [button("Back to investigations", () => navigate("investigations"), "button button-quiet")],
      ),
    );
    if (state.detailLoading) {
      content.append(node("p", "Loading investigation and interpretation history…", "skeleton"));
      return;
    }
    if (state.detailError) {
      content.append(emptyState("Investigation unavailable", state.detailError.message, button("Retry", () => openDetail(state.view.slice("detail:".length)))));
      return;
    }
    const detail = state.investigationDetail;
    const investigation = detail?.investigation;
    if (!investigation) {
      content.append(emptyState("Investigation not found", "The server did not return an authorized investigation record."));
      return;
    }
    const header = panel("Investigation record", [
      dataList([
        ["Investigation ID", investigation.investigationId],
        ["Source code", investigation.sourceCode],
        ["Status", humanize(investigation.status)],
        ["Created by (ID)", investigation.createdBy],
        ["Assigned investigator (ID)", investigation.assignedTo || "Unassigned"],
        ["Created", formatDate(investigation.createdAt)],
        ["Evaluated", formatDate(investigation.evaluatedAt)],
        ["Periods", investigation.periods],
        ["Evidence version", investigation.evidenceVersion],
      ]),
    ]);
    content.append(header);
    content.append(renderEvidence(investigation.evidenceSnapshot));
    content.append(renderReviewHistory(detail.reviewHistory || [], detail.reviewHistoryTruncated));
    content.append(renderWorkflow(investigation));
    content.append(renderAI(investigation));
  }

  function renderReviewHistory(reviews, truncated) {
    const section = panel("Review history");
    if (truncated) section.append(notice("The server indicates that older review history is not included in this response.", "warning"));
    if (!reviews.length) {
      section.append(emptyState("No review events", "No review entries were returned."));
      return section;
    }
    const timeline = node("ol", "", "timeline");
    reviews.forEach((review) => {
      const item = node("li");
      item.append(node("strong", humanize(review.action)));
      const detailParts = [
        `Reviewer ${review.reviewerId || "unknown"}`,
        formatDate(review.createdAt),
      ];
      if (review.previousStatus || review.newStatus) {
        detailParts.push(`${humanize(review.previousStatus)} → ${humanize(review.newStatus)}`);
      }
      if (review.decision) detailParts.push(`Decision: ${humanize(review.decision)}`);
      item.append(node("p", detailParts.join(" · ")));
      if (review.note) item.append(node("p", review.note));
      if (review.previousAssigneeId || review.newAssigneeId) {
        item.append(node("p", `Assignment: ${review.previousAssigneeId || "unassigned"} → ${review.newAssigneeId || "unassigned"}`));
      }
      timeline.append(item);
    });
    section.append(timeline);
    return section;
  }

  function renderWorkflow(investigation) {
    const section = panel("Investigator review actions");
    const readOnly = state.session.investigator.role === "viewer";
    if (readOnly) {
      section.append(notice("Viewer access is read-only. Notes, decisions, status changes, and AI generation are disabled.", "warning"));
      return section;
    }
    const closed = investigation.status === "closed";
    if (closed) section.append(notice("This investigation is closed. The API does not permit further status transitions or AI generation.", "warning"));

    const transitions = {
      generated: ["under_review"],
      under_review: ["requires_more_information", "reviewed"],
      requires_more_information: ["under_review"],
      reviewed: ["closed"],
    }[investigation.status] || [];
    if (transitions.length) {
      const statusForm = node("form", "", "inline-form");
      statusForm.append(selectField("Transition to", "status", transitions.map((value) => [value, humanize(value)]), transitions[0]));
      statusForm.append(submitButton("Update status"));
      statusForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const newStatus = String(new FormData(statusForm).get("status"));
        if (newStatus === "closed" && !window.confirm("Close this reviewed investigation? It cannot be reopened.")) return;
        const submit = statusForm.querySelector('button[type="submit"]');
        submit.disabled = true;
        try {
          await api.request(`${apiPaths.investigations}/${encodeURIComponent(investigation.investigationId)}/status`, {
            method: "PATCH",
            body: { status: newStatus },
          });
          setToast(`Investigation status changed to ${humanize(newStatus)}.`);
          await openDetail(investigation.investigationId);
        } catch (error) {
          setToast(error.message, true);
          submit.disabled = false;
        }
      });
      section.append(statusForm);
    } else {
      section.append(node("p", "No further status transition is available from the current status.", "help-text"));
    }

    if (!closed) {
      const noteForm = node("form", "", "form-stack");
      noteForm.append(node("h3", "Add review note"));
      const noteLabel = node("label", "Note");
      const note = node("textarea");
      note.name = "note";
      note.maxLength = 5000;
      note.required = true;
      noteLabel.append(note);
      noteForm.append(noteLabel, node("small", "Required; up to 5,000 characters.", "help-text"), submitButton("Save note"));
      noteForm.addEventListener("submit", (event) => submitReviewForm(event, noteForm, investigation.investigationId, "note"));
      section.append(noteForm);

      const decisionForm = node("form", "", "form-stack");
      decisionForm.append(node("h3", "Record investigator assessment"));
      decisionForm.append(node("p", "This is a human review decision, not an automatic AI conclusion.", "help-text"));
      decisionForm.append(selectField("Decision", "decision", [
        ["reporting_discontinuity_observed", "Reporting discontinuity observed"],
        ["channel_availability_concern", "Channel availability concern"],
        ["insufficient_evidence", "Insufficient evidence"],
        ["no_significant_discontinuity", "No significant discontinuity"],
        ["other", "Other"],
      ], "insufficient_evidence"));
      const reasonLabel = node("label", "Reason / note (required for “Other”)", "field");
      const reason = node("textarea");
      reason.name = "note";
      reason.maxLength = 5000;
      reasonLabel.append(reason);
      decisionForm.append(reasonLabel, submitButton("Record assessment"));
      decisionForm.addEventListener("submit", (event) => submitReviewForm(event, decisionForm, investigation.investigationId, "decision"));
      section.append(decisionForm);
    }
    if (state.session.investigator.role === "admin") {
      section.append(notice("Assignment changes are not shown: the backend has no API to list eligible investigators for this source. No investigator IDs are hardcoded.", "warning"));
    }
    return section;
  }

  async function submitReviewForm(event, form, investigationId, action) {
    event.preventDefault();
    const submit = form.querySelector('button[type="submit"]');
    if (submit.disabled) return;
    const values = new FormData(form);
    let path;
    let body;
    if (action === "note") {
      const note = String(values.get("note") || "").trim();
      if (!note || note.length > 5000) {
        setToast("A note must contain 1 to 5,000 characters.", true);
        return;
      }
      path = `${apiPaths.investigations}/${encodeURIComponent(investigationId)}/notes`;
      body = { note };
    } else {
      const decision = String(values.get("decision") || "");
      const note = String(values.get("note") || "").trim();
      if (decision === "other" && !note) {
        setToast("A reason is required for the Other decision.", true);
        return;
      }
      path = `${apiPaths.investigations}/${encodeURIComponent(investigationId)}/decision`;
      body = { decision, ...(note ? { note } : {}) };
    }
    submit.disabled = true;
    try {
      await api.request(path, { method: "POST", body });
      setToast(action === "note" ? "Review note saved." : "Investigator assessment recorded.");
      await openDetail(investigationId);
    } catch (error) {
      setToast(error.message, true);
      submit.disabled = false;
    }
  }

function renderAI(investigation) {
      const section = panel("AI-assisted interpretation — NVIDIA Nemotron", [], "ai-panel");
      section.append(
        node("p", "Deterministic evidence remains authoritative. AI interpretation is optional, uses an external provider, may consume inference credits, and is displayed only when the backend confirms strict validation and persistence.", "ai-disclosure"),
      );
      const viewer = state.session.investigator.role === "viewer";
      const closed = investigation.status === "closed";
      if (viewer) {
        section.append(notice("Viewer role: interpretation history is readable, but generation is not permitted.", "warning"));
      } else if (closed) {
        section.append(notice("Closed investigations cannot generate a new interpretation.", "warning"));
      } else {
        const generate = button(
          state.aiGenerating ? "Generating interpretation…" : "Generate AI Interpretation",
          () => generateAIInterpretation(investigation.investigationId),
          "button button-primary",
        );
        generate.disabled = state.aiGenerating;
        section.append(generate);
      }
      if (state.aiError) {
        const label = state.aiErrorKind === "generation"
          ? "Generation failed"
          : "Interpretation history request failed";
        section.append(notice(`${label}: ${state.aiError.message}`, "error"));
      }
      if (!state.interpretationHistory.length && !state.aiError && !state.detailLoading) {
        section.append(emptyState("No saved interpretations", "No validated interpretation records exist for this investigation."));
      }
      if (state.aiGenerating) {
        section.append(notice("The backend is requesting and validating a response. No output is shown before validation succeeds.", "warning"));
      }
      if (state.selectedInterpretation) {
        if (state.selectedInterpretation.validationStatus === "validated") {
          section.append(renderInterpretation(state.selectedInterpretation));
        } else {
          section.append(notice("A stored response did not identify itself as validated. It is not displayed.", "error"));
        }
      }
      if (state.interpretationHistory.length) {
        const historyPanel = node("div", "", "interpretation-card");
        historyPanel.append(node("h3", "Validated interpretation history"));
        historyPanel.append(table(
          ["Created", "Provider / model", "Versions", "Evidence hash", "Usage", "Open"],
          state.interpretationHistory.map((record) => {
            const open = button("Open", () => loadInterpretation(investigation.investigationId, record.id), "table-link");
            const hash = node("span", record.evidenceHash || "Unavailable");
            hash.title = record.evidenceHash || "";
            return [
              formatDate(record.createdAt),
              `${record.provider || "Unknown"} / ${record.model || "Unknown"}`,
              `Prompt ${record.promptVersion || "?"} · Schema ${record.schemaVersion || "?"} · Evidence ${record.evidenceVersion || "?"}`,
              hash,
              record.usage
                ? `Prompt ${formatValue(record.usage.promptTokens)} · Completion ${formatValue(record.usage.completionTokens)} tokens`
                : "Usage unavailable",
              open,
            ];
          }),
        ));
        if (state.interpretationPagination?.pages > 1) {
          historyPanel.append(paginationControls(
            state.interpretationPagination,
            (page) => loadInterpretationHistory(investigation.investigationId, page),
          ));
        }
        section.append(historyPanel);
      }
      return section;
}

function renderInterpretation(record) {
      const interpretation = record.interpretation;
      if (!interpretation || record.validationStatus !== "validated") {
        return notice("No validated interpretation is available to display.", "error");
      }
      const wrapper = node("article", "", "interpretation-card");
      wrapper.append(
        node("h3", interpretation.headline),
        node("p", interpretation.executiveSummary),
        node("p", interpretation.explanation),
        dataList([
          ["Finding type", humanize(interpretation.findingType)],
          ["Evidence strength", humanize(interpretation.evidenceStrength)],
          ["Provider / model", `${record.provider} / ${record.model}`],
          ["Prompt / schema / evidence versions", `${record.promptVersion} / ${record.schemaVersion} / ${record.evidenceVersion}`],
          ["Created", formatDate(record.createdAt)],
          ["Latency", record.latencyMs == null ? "Unavailable" : `${record.latencyMs} ms`],
        ]),
        notice("Evidence strength describes the quality of supplied evidence. It is not an outbreak probability or statistical confidence.", "warning"),
      );
      wrapper.append(renderFactGroup("Observed facts", interpretation.observedFacts || []));
      wrapper.append(renderFactGroup("Supporting evidence", interpretation.supportingEvidence || []));
      wrapper.append(renderTextList("Unknowns", interpretation.unknowns || []));
      wrapper.append(renderTextList("Alternative explanations", interpretation.alternativeExplanations || []));
      const followUps = node("section");
      followUps.append(node("h4", "Recommended follow-ups"));
      if (!interpretation.recommendedFollowUps?.length) {
        followUps.append(node("p", "None supplied.", "muted"));
      } else {
        const list = node("ul", "", "list-clean");
        interpretation.recommendedFollowUps.forEach((item) => {
          const line = node("li");
          line.append(
            node("strong", `${item.priority}: ${item.question}`),
            node("p", item.reason),
          );
          list.append(line);
        });
        followUps.append(list);
      }
      wrapper.append(followUps);
      wrapper.append(renderTextList("Limitations", interpretation.limitations || []));
      wrapper.append(node("p", interpretation.interpretationBoundary, "notice notice-warning"));
      wrapper.append(node("p", `Evidence hash: ${record.evidenceHash || "Unavailable"}`, "help-text"));
      return wrapper;
}

function renderFactGroup(title, facts) {
      const section = node("section");
      section.append(node("h4", title));
      if (!facts.length) {
        section.append(node("p", "None cited.", "muted"));
        return section;
      }
      facts.forEach((fact) => {
        const row = node("div", "", "fact-row");
        row.append(
          node("strong", humanize(fact.factCode)),
          node("p", `Validated value: ${formatValue(fact.value)}`),
        );
        for (const reference of fact.evidenceRefs || []) {
          const jump = button(reference, () => {
            const target = evidenceSectionForReference(reference);
            document.getElementById(target)?.scrollIntoView({ behavior: "smooth", block: "start" });
          }, "reference-button");
          jump.title = "Jump to deterministic evidence";
          row.append(jump);
        }
        section.append(row);
      });
      return section;
}

function evidenceSectionForReference(reference) {
      if (reference.startsWith("observedFacts.")) return "evidence-observed";
      if (reference.includes("completeness")) return "evidence-completeness";
      if (reference.includes("historicalBaseline")) return "evidence-baseline";
      if (reference.includes("anomaly")) return "evidence-anomaly";
      return "evidence-period";
}

function renderTextList(title, values) {
      const section = node("section");
      section.append(node("h4", title));
      if (!values.length) {
        section.append(node("p", "None supplied.", "muted"));
        return section;
      }
      const list = node("ul", "", "list-clean");
      values.forEach((value) => list.append(node("li", value)));
      section.append(list);
      return section;
}

async function loadInterpretationHistory(investigationId, page = 1) {
      state.aiError = null;
      state.aiErrorKind = "history";
      try {
        const query = new URLSearchParams({ page: String(page), limit: "25" });
        const result = await api.request(
          `${apiPaths.investigations}/${encodeURIComponent(investigationId)}/interpretations?${query}`,
        );
        state.interpretationHistory = (result?.interpretations || [])
          .filter((record) => record.validationStatus === "validated");
        state.interpretationPagination = result?.pagination || null;
        state.selectedInterpretation = state.interpretationHistory[0] || null;
      } catch (error) {
        state.aiError = error;
      }
      if (state.view === `detail:${investigationId}`) renderDetail();
}

async function loadInterpretation(investigationId, interpretationId) {
      state.aiErrorKind = "history";
      try {
        const result = await api.request(
          `${apiPaths.investigations}/${encodeURIComponent(investigationId)}/interpretations/${encodeURIComponent(interpretationId)}`,
        );
        const record = result?.interpretation;
        if (record?.validationStatus !== "validated") {
          state.selectedInterpretation = null;
          state.aiError = new ApiError("The record was not marked as validated by the backend.", {
            code: "INVALID_STORED_INTERPRETATION",
          });
        } else {
          state.selectedInterpretation = record;
          state.aiError = null;
        }
      } catch (error) {
        state.aiError = error;
      }
      renderDetail();
}

function aiFailureMessage(error) {
      const known = {
        PROVIDER_UNAVAILABLE: "The AI provider is temporarily unavailable.",
        PROVIDER_NETWORK_ERROR: "The AI provider could not be reached.",
        PROVIDER_AUTHENTICATION_FAILED: "The AI provider rejected its configured credentials.",
        PROVIDER_NOT_CONFIGURED: "AI interpretation is not configured on the server.",
        PROVIDER_REQUEST_REJECTED: "The provider rejected the inference request.",
        MODEL_UNAVAILABLE: "The configured model is unavailable.",
        PROVIDER_RATE_LIMITED: "The provider rate-limited the request. Retry later.",
        PROVIDER_QUOTA_EXCEEDED: "The provider account has insufficient quota.",
        PROVIDER_TIMEOUT: "The interpretation request timed out.",
        REQUEST_ABORTED: "The interpretation request was cancelled.",
        INVALID_PROVIDER_RESPONSE: "The provider returned an invalid response.",
        INVALID_MODEL_JSON: "Nemotron returned invalid structured output.",
        INVALID_MODEL_OUTPUT: "Nemotron output failed schema validation.",
        INVALID_EVIDENCE_REFERENCE: "Nemotron cited unavailable evidence.",
        UNSUPPORTED_CONCLUSION: "Nemotron output exceeded its permitted scope.",
        UNSUPPORTED_NUMERIC_CLAIM: "Nemotron output contained unsupported numeric claims.",
        EVIDENCE_CONTRADICTION: "Nemotron output conflicted with deterministic evidence.",
        AUDIT_PERSISTENCE_FAILED: "The interpretation audit could not be confirmed.",
        INTERPRETATION_UNAVAILABLE: "Interpretation is temporarily unavailable.",
        AUTHENTICATION_REQUIRED: "Your session is no longer authorized. Sign in again.",
        ACCESS_DENIED: "Your role is not permitted to perform this action.",
      };
      if (known[error.code]) return `${known[error.code]} No validated interpretation was saved.`;
      if (error.status === 409) {
        return `${error.message} No new validated interpretation was saved.`;
      }
      return `${error.message} No validated interpretation was saved.`;
}

async function generateAIInterpretation(investigationId) {
      if (
        state.session.investigator.role === "viewer" ||
        state.investigationDetail?.investigation?.status === "closed" ||
        state.aiGenerating
      ) return;
      const accepted = window.confirm(
        "Send this investigation's sanitized evidence to NVIDIA Nemotron through Nebius Token Factory? This external inference may consume credits. Only validated output will be saved.",
      );
      if (!accepted) return;
      state.aiGenerating = true;
      state.aiError = null;
      state.aiErrorKind = "generation";
      renderDetail();
      try {
        const result = await api.request(
          `${apiPaths.investigations}/${encodeURIComponent(investigationId)}/interpretations`,
          { method: "POST", body: {} },
        );
        const record = result?.interpretation;
        if (!record || record.validationStatus !== "validated") {
          throw new ApiError("The server did not confirm a validated interpretation.", {
            code: "INVALID_MODEL_OUTPUT",
          });
        }
        state.selectedInterpretation = record;
        setToast("A validated interpretation was saved by the backend.");
        await loadInterpretationHistory(investigationId);
      } catch (error) {
        state.aiError = new ApiError(aiFailureMessage(error), {
          status: error.status,
          code: error.code,
        });
        state.aiErrorKind = "generation";
      } finally {
        state.aiGenerating = false;
        if (state.view === `detail:${investigationId}`) renderDetail();
      }
}

loginForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (loginButton.disabled) return;
      const values = new FormData(loginForm);
      loginError.hidden = true;
      loginButton.disabled = true;
      loginButton.textContent = "Signing in…";
      try {
        state.session = await login(
          api,
          String(values.get("email") || "").trim(),
          String(values.get("password") || ""),
        );
        loginForm.reset();
        state.view = "overview";
        history.replaceState(null, "", "#overview");
        showWorkspace();
        loadOverview();
      } catch (error) {
        loginError.textContent = error.message;
        loginError.hidden = false;
      } finally {
        loginButton.disabled = false;
        loginButton.textContent = "Sign in";
      }
});

document.getElementById("logout-button").addEventListener("click", async () => {
      const logoutButton = document.getElementById("logout-button");
      logoutButton.disabled = true;
      let message = "";
      try {
        await logout(api);
      } catch (error) {
        message = `Local session cleared. The server could not confirm logout: ${error.message}`;
      } finally {
        state.session = null;
        clearTimeout(sessionExpiryTimer);
        showLogin(message);
        logoutButton.disabled = false;
      }
});

document.getElementById("primary-navigation").addEventListener("click", (event) => {
      const view = event.target.closest("[data-view]")?.dataset.view;
      if (view) navigate(view);
});

document.getElementById("menu-toggle").addEventListener("click", (event) => {
      const sidebar = document.getElementById("sidebar");
      const open = sidebar.classList.toggle("sidebar-open");
      event.currentTarget.setAttribute("aria-expanded", String(open));
});

async function initialize() {
      const cachedSession = readSession();
      if (!cachedSession) return showLogin();
      try {
        state.session = await restoreSession(api);
        if (!state.session) return showLogin();
        const hash = decodeURIComponent(location.hash.slice(1));
        if (hash.startsWith("investigation/")) {
          showWorkspace();
          await openDetail(hash.slice("investigation/".length));
          return;
        }
        state.view = ["overview", "reporting", "investigations", "preview"].includes(hash)
          ? hash
          : "overview";
        showWorkspace();
        if (state.view === "overview") loadOverview();
        if (state.view === "reporting" || state.view === "preview") loadReporting();
        if (state.view === "investigations") loadInvestigations();
      } catch (error) {
        state.session = null;
        showLogin(`Could not verify the saved session: ${error.message}`);
      }
}

initialize();
