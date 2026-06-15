import "./styles.css";
import { Tiktoken } from "js-tiktoken/lite";
import o200kBase from "js-tiktoken/ranks/o200k_base";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";

type SourceKind = "paste" | "file";
type SourceStatus = "ok" | "no_text" | "unsupported" | "error";

interface ModelScenario {
  id: string;
  name: string;
  costPerMillionInputTokens: number;
  draftCost: string;
}

interface InputSource {
  id: string;
  name: string;
  kind: SourceKind;
  bytes: number;
  text: string;
  status: SourceStatus;
  notes: string;
}

interface EstimateRow {
  id: string;
  name: string;
  kind: SourceKind;
  bytes: number;
  extractedChars: number;
  inputTokens: number;
  status: SourceStatus;
  notes: string;
  costsByModelId: Record<string, number>;
}

interface SummaryRow {
  modelId: string;
  modelName: string;
  costPerMillionInputTokens: number;
  totalInputTokens: number;
  estimatedCostUsd: number;
  sourcesCounted: number;
  sourcesWithoutText: number;
  sourcesWithErrors: number;
}

const SUPPORTED_EXTENSIONS = new Set([".txt", ".text", ".md", ".markdown", ".pdf"]);
const DEFAULT_MODELS = [
  { name: "Claude Sonnet", costPerMillionInputTokens: 7.8 },
  { name: "Gemma 4", costPerMillionInputTokens: 3.4 },
];

const tokenizer = new Tiktoken(o200kBase);
const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("App root was not found.");
}

let modelScenarios: ModelScenario[] = DEFAULT_MODELS.map(createScenario);
let fileSources: InputSource[] = [];
let pasteText = "";
let renderTimer: number | undefined;
let pdfjsPromise: Promise<typeof import("pdfjs-dist")> | undefined;

app.innerHTML = `
  <div class="app-shell">
    <header class="app-header">
      <div>
        <h1 class="app-title">Token Cost Estimator</h1>
      </div>
      <div class="app-note">GitHub Pages app. Files stay in this browser session.</div>
    </header>

    <main class="app-grid">
      <div class="column">
        <section class="section" aria-labelledby="sources-heading">
          <div class="section-header">
            <h2 class="section-title" id="sources-heading">Sources</h2>
          </div>
          <div class="section-body stack">
            <div class="dropzone" id="dropzone" tabindex="0">
              <div class="dropzone-main">
                <div class="dropzone-text">
                  <div class="dropzone-title">Drop files here</div>
                  <div class="hint">Markdown, text, and PDFs with selectable text.</div>
                </div>
                <button class="button-with-icon" type="button" id="choose-files">
                  ${iconUpload()}
                  <span>Choose files</span>
                </button>
              </div>
              <input
                class="sr-only"
                id="file-input"
                type="file"
                multiple
                accept=".txt,.text,.md,.markdown,.pdf,text/plain,text/markdown,application/pdf"
              />
            </div>

            <div>
              <label for="paste-input">Pasted text</label>
              <textarea
                id="paste-input"
                placeholder="Paste text to estimate alongside uploaded files."
                spellcheck="false"
              ></textarea>
            </div>

            <div>
              <div class="section-title">Loaded sources</div>
              <div class="source-list" id="source-list"></div>
            </div>
          </div>
        </section>

        <section class="section" aria-labelledby="models-heading">
          <div class="section-header">
            <h2 class="section-title" id="models-heading">Model prices</h2>
            <div class="control-row">
              <button class="button-with-icon" type="button" id="reset-models">
                ${iconRefresh()}
                <span>Reset</span>
              </button>
              <button class="button-with-icon primary" type="button" id="add-model">
                ${iconPlus()}
                <span>Add model</span>
              </button>
            </div>
          </div>
          <div class="section-body">
            <div class="model-table" id="model-list"></div>
          </div>
        </section>
      </div>

      <section class="section" aria-labelledby="results-heading">
        <div class="section-header">
          <h2 class="section-title" id="results-heading">Results</h2>
          <button class="button-with-icon" type="button" id="download-csv" disabled>
            ${iconDownload()}
            <span>Download CSV</span>
          </button>
        </div>
        <div class="section-body" id="results"></div>
      </section>
    </main>
  </div>
`;

const dropzone = query<HTMLDivElement>("#dropzone");
const fileInput = query<HTMLInputElement>("#file-input");
const chooseFilesButton = query<HTMLButtonElement>("#choose-files");
const pasteInput = query<HTMLTextAreaElement>("#paste-input");
const sourceList = query<HTMLDivElement>("#source-list");
const modelList = query<HTMLDivElement>("#model-list");
const addModelButton = query<HTMLButtonElement>("#add-model");
const resetModelsButton = query<HTMLButtonElement>("#reset-models");
const results = query<HTMLDivElement>("#results");
const downloadCsvButton = query<HTMLButtonElement>("#download-csv");

chooseFilesButton.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  void processFiles(fileInput.files);
  fileInput.value = "";
});

dropzone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropzone.classList.add("dragging");
});

dropzone.addEventListener("dragleave", () => {
  dropzone.classList.remove("dragging");
});

dropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropzone.classList.remove("dragging");
  void processFiles(event.dataTransfer?.files ?? null);
});

dropzone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    fileInput.click();
  }
});

pasteInput.addEventListener("input", () => {
  pasteText = pasteInput.value;
  scheduleRender();
});

addModelButton.addEventListener("click", () => {
  modelScenarios = [
    ...modelScenarios,
    createScenario({ name: "New model", costPerMillionInputTokens: 1 }),
  ];
  renderModelRows();
  renderResults();
});

resetModelsButton.addEventListener("click", () => {
  modelScenarios = DEFAULT_MODELS.map(createScenario);
  renderModelRows();
  renderResults();
});

downloadCsvButton.addEventListener("click", () => {
  const rows = buildEstimateRows();
  if (!rows.length) {
    return;
  }
  downloadCsv(rows);
});

renderModelRows();
renderSources();
renderResults();

function createScenario(input: { name: string; costPerMillionInputTokens: number }): ModelScenario {
  return {
    id: crypto.randomUUID(),
    name: input.name,
    costPerMillionInputTokens: input.costPerMillionInputTokens,
    draftCost: String(input.costPerMillionInputTokens),
  };
}

function query<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing element: ${selector}`);
  }
  return element;
}

function scheduleRender() {
  window.clearTimeout(renderTimer);
  renderTimer = window.setTimeout(() => {
    renderSources();
    renderResults();
  }, 120);
}

async function processFiles(files: FileList | null) {
  if (!files?.length) {
    return;
  }

  const incoming = await Promise.all(Array.from(files).map(readFileSource));
  fileSources = [...fileSources, ...incoming];
  renderSources();
  renderResults();
}

async function readFileSource(file: File): Promise<InputSource> {
  const extension = getExtension(file.name);
  const base = {
    id: crypto.randomUUID(),
    name: file.name,
    kind: "file" as const,
    bytes: file.size,
  };

  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    return {
      ...base,
      text: "",
      status: "unsupported",
      notes: "Unsupported file type.",
    };
  }

  try {
    const text = extension === ".pdf" ? await readPdfText(file) : await file.text();
    return {
      ...base,
      text,
      status: text.trim() ? "ok" : "no_text",
      notes: text.trim()
        ? ""
        : extension === ".pdf"
          ? "No extractable text found. Scanned PDFs need OCR."
          : "No text content found.",
    };
  } catch (error) {
    return {
      ...base,
      text: "",
      status: "error",
      notes: error instanceof Error ? error.message : "Unable to read this file.",
    };
  }
}

async function readPdfText(file: File): Promise<string> {
  const pdfjsLib = await loadPdfJs();
  const data = new Uint8Array(await file.arrayBuffer());
  const document = await pdfjsLib.getDocument({ data }).promise;
  const pages: string[] = [];

  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ")
      .trim();
    pages.push(pageText);
  }

  return pages.join("\n\n");
}

async function loadPdfJs() {
  pdfjsPromise ??= import("pdfjs-dist").then((pdfjsLib) => {
    pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
    return pdfjsLib;
  });
  return pdfjsPromise;
}

function getExtension(fileName: string) {
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex >= 0 ? fileName.slice(dotIndex).toLowerCase() : "";
}

function getActiveSources(): InputSource[] {
  const trimmedPaste = pasteText.trim();
  const pasteSource: InputSource[] = trimmedPaste
    ? [
        {
          id: "paste",
          name: "Pasted text",
          kind: "paste",
          bytes: new Blob([pasteText]).size,
          text: pasteText,
          status: "ok",
          notes: "",
        },
      ]
    : [];

  return [...pasteSource, ...fileSources];
}

function renderSources() {
  const sources = getActiveSources();
  if (!sources.length) {
    sourceList.innerHTML = `<div class="empty-state">No sources loaded yet.</div>`;
    return;
  }

  sourceList.innerHTML = sources
    .map(
      (source) => `
        <div class="source-row">
          <div>
            <div class="source-name">${escapeHtml(source.name)}</div>
            <div class="source-meta">
              ${source.kind === "paste" ? "Pasted text" : formatBytes(source.bytes)}
              · ${formatStatus(source.status)}
              ${source.notes ? `· ${escapeHtml(source.notes)}` : ""}
            </div>
          </div>
          ${
            source.kind === "file"
              ? `<button class="icon-button danger" type="button" data-remove-source="${source.id}" aria-label="Remove ${escapeHtml(source.name)}">${iconX()}</button>`
              : ""
          }
        </div>
      `,
    )
    .join("");

  sourceList.querySelectorAll<HTMLButtonElement>("[data-remove-source]").forEach((button) => {
    button.addEventListener("click", () => {
      fileSources = fileSources.filter((source) => source.id !== button.dataset.removeSource);
      renderSources();
      renderResults();
    });
  });
}

function renderModelRows() {
  modelList.innerHTML = modelScenarios
    .map(
      (model) => `
        <div class="model-row" data-model-row="${model.id}">
          <div>
            <label for="model-name-${model.id}">Model name</label>
            <input
              id="model-name-${model.id}"
              type="text"
              value="${escapeAttribute(model.name)}"
              data-model-name="${model.id}"
            />
          </div>
          <div>
            <label for="model-cost-${model.id}">USD / 1M</label>
            <input
              id="model-cost-${model.id}"
              type="number"
              min="0"
              step="0.000001"
              value="${escapeAttribute(model.draftCost)}"
              data-model-cost="${model.id}"
            />
          </div>
          <div>
            <label aria-hidden="true">&nbsp;</label>
            <button
              class="icon-button danger"
              type="button"
              data-remove-model="${model.id}"
              aria-label="Remove ${escapeAttribute(model.name)}"
              ${modelScenarios.length === 1 ? "disabled" : ""}
            >
              ${iconX()}
            </button>
          </div>
          <div class="field-error" data-model-error="${model.id}"></div>
        </div>
      `,
    )
    .join("");

  modelList.querySelectorAll<HTMLInputElement>("[data-model-name]").forEach((input) => {
    input.addEventListener("input", () => {
      const model = findModel(input.dataset.modelName);
      if (!model) {
        return;
      }
      model.name = input.value;
      validateModelRows();
      renderResults();
    });
  });

  modelList.querySelectorAll<HTMLInputElement>("[data-model-cost]").forEach((input) => {
    input.addEventListener("input", () => {
      const model = findModel(input.dataset.modelCost);
      if (!model) {
        return;
      }
      model.draftCost = input.value;
      const parsed = Number(input.value);
      if (Number.isFinite(parsed) && parsed >= 0) {
        model.costPerMillionInputTokens = parsed;
      }
      validateModelRows();
      renderResults();
    });
  });

  modelList.querySelectorAll<HTMLButtonElement>("[data-remove-model]").forEach((button) => {
    button.addEventListener("click", () => {
      if (modelScenarios.length <= 1) {
        return;
      }
      modelScenarios = modelScenarios.filter((model) => model.id !== button.dataset.removeModel);
      renderModelRows();
      renderResults();
    });
  });

  validateModelRows();
}

function validateModelRows() {
  modelScenarios.forEach((model) => {
    const costInput = modelList.querySelector<HTMLInputElement>(`[data-model-cost="${model.id}"]`);
    const nameInput = modelList.querySelector<HTMLInputElement>(`[data-model-name="${model.id}"]`);
    const error = modelList.querySelector<HTMLDivElement>(`[data-model-error="${model.id}"]`);
    const messages = getModelErrors(model);

    costInput?.setAttribute("aria-invalid", String(messages.some((message) => message.includes("cost"))));
    nameInput?.setAttribute("aria-invalid", String(messages.some((message) => message.includes("name"))));

    if (error) {
      error.textContent = messages.join(" ");
    }
  });
}

function getModelErrors(model: ModelScenario) {
  const messages: string[] = [];
  if (!model.name.trim()) {
    messages.push("Add a model name.");
  }
  const parsedCost = Number(model.draftCost);
  if (!Number.isFinite(parsedCost) || parsedCost < 0) {
    messages.push("Add a valid non-negative cost.");
  }
  return messages;
}

function findModel(id: string | undefined) {
  return modelScenarios.find((model) => model.id === id);
}

function getValidModels() {
  return modelScenarios.filter((model) => getModelErrors(model).length === 0);
}

function buildEstimateRows(): EstimateRow[] {
  const validModels = getValidModels();
  return getActiveSources().map((source) => {
    const inputTokens = source.status === "ok" ? countTokens(source.text) : 0;
    return {
      id: source.id,
      name: source.name,
      kind: source.kind,
      bytes: source.bytes,
      extractedChars: source.text.length,
      inputTokens,
      status: source.status,
      notes: source.notes,
      costsByModelId: Object.fromEntries(
        validModels.map((model) => [
          model.id,
          (inputTokens / 1_000_000) * model.costPerMillionInputTokens,
        ]),
      ),
    };
  });
}

function buildSummaryRows(estimateRows: EstimateRow[]): SummaryRow[] {
  const totalInputTokens = estimateRows.reduce((sum, row) => sum + row.inputTokens, 0);
  const sourcesCounted = estimateRows.length;
  const sourcesWithoutText = estimateRows.filter((row) => row.status === "no_text").length;
  const sourcesWithErrors = estimateRows.filter(
    (row) => row.status === "error" || row.status === "unsupported",
  ).length;

  return getValidModels().map((model) => ({
    modelId: model.id,
    modelName: model.name.trim(),
    costPerMillionInputTokens: model.costPerMillionInputTokens,
    totalInputTokens,
    estimatedCostUsd: (totalInputTokens / 1_000_000) * model.costPerMillionInputTokens,
    sourcesCounted,
    sourcesWithoutText,
    sourcesWithErrors,
  }));
}

function renderResults() {
  const estimateRows = buildEstimateRows();
  const summaryRows = buildSummaryRows(estimateRows);
  const hasValidModels = getValidModels().length > 0;

  downloadCsvButton.disabled = estimateRows.length === 0 || !hasValidModels;

  if (!estimateRows.length) {
    results.innerHTML = `<div class="empty-state">Add pasted text or files to see estimates.</div>`;
    return;
  }

  if (!hasValidModels) {
    results.innerHTML = `<div class="empty-state">Add at least one valid model price to calculate costs.</div>`;
    return;
  }

  results.innerHTML = `
    <div class="results-tools">
      <div class="summary-line">
        ${estimateRows.length} source${estimateRows.length === 1 ? "" : "s"} ·
        ${formatInteger(estimateRows.reduce((sum, row) => sum + row.inputTokens, 0))} input tokens
      </div>
    </div>

    <div class="results-block">
      <h3 class="section-title">Total cost by model</h3>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Model</th>
              <th class="numeric">USD / 1M</th>
              <th class="numeric">Input tokens</th>
              <th class="numeric">Estimated cost</th>
              <th class="numeric">Sources</th>
              <th class="numeric">No text</th>
              <th class="numeric">Errors</th>
            </tr>
          </thead>
          <tbody>
            ${summaryRows.map(renderSummaryRow).join("")}
          </tbody>
        </table>
      </div>
    </div>

    <div class="results-block">
      <h3 class="section-title">Source details</h3>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Source</th>
              <th>Type</th>
              <th class="numeric">Bytes</th>
              <th class="numeric">Characters</th>
              <th class="numeric">Tokens</th>
              <th>Status</th>
              ${getValidModels().map((model) => `<th class="numeric">${escapeHtml(model.name || "Model")}</th>`).join("")}
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            ${estimateRows.map(renderEstimateRow).join("")}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderSummaryRow(row: SummaryRow) {
  return `
    <tr>
      <td>${escapeHtml(row.modelName)}</td>
      <td class="numeric nowrap">${formatCurrency(row.costPerMillionInputTokens)}</td>
      <td class="numeric">${formatInteger(row.totalInputTokens)}</td>
      <td class="numeric nowrap">${formatCurrency(row.estimatedCostUsd)}</td>
      <td class="numeric">${formatInteger(row.sourcesCounted)}</td>
      <td class="numeric">${formatInteger(row.sourcesWithoutText)}</td>
      <td class="numeric">${formatInteger(row.sourcesWithErrors)}</td>
    </tr>
  `;
}

function renderEstimateRow(row: EstimateRow) {
  return `
    <tr>
      <td>${escapeHtml(row.name)}</td>
      <td>${row.kind === "paste" ? "Paste" : "File"}</td>
      <td class="numeric">${formatInteger(row.bytes)}</td>
      <td class="numeric">${formatInteger(row.extractedChars)}</td>
      <td class="numeric">${formatInteger(row.inputTokens)}</td>
      <td>${formatStatus(row.status)}</td>
      ${getValidModels()
        .map((model) => `<td class="numeric nowrap">${formatCurrency(row.costsByModelId[model.id] ?? 0)}</td>`)
        .join("")}
      <td>${escapeHtml(row.notes)}</td>
    </tr>
  `;
}

function countTokens(text: string) {
  if (!text) {
    return 0;
  }
  return tokenizer.encode(text).length;
}

function downloadCsv(rows: EstimateRow[]) {
  const validModels = getValidModels();
  const headers = [
    "Source",
    "Type",
    "Bytes",
    "Characters",
    "Input tokens",
    "Status",
    "Notes",
    ...validModels.map((model) => `Cost USD: ${model.name}`),
  ];
  const csvRows = rows.map((row) => [
    row.name,
    row.kind,
    String(row.bytes),
    String(row.extractedChars),
    String(row.inputTokens),
    row.status,
    row.notes,
    ...validModels.map((model) => String(row.costsByModelId[model.id] ?? 0)),
  ]);

  const csv = [headers, ...csvRows]
    .map((cells) => cells.map(formatCsvCell).join(","))
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "token-cost-estimates.csv";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function formatCsvCell(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatInteger(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value >= 1 ? 2 : 6,
    maximumFractionDigits: value >= 1 ? 2 : 6,
  }).format(value);
}

function formatStatus(status: SourceStatus) {
  const label = status === "no_text" ? "No text" : status[0].toUpperCase() + status.slice(1);
  return `<span class="status ${status}">${label}</span>`;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[char];
  });
}

function escapeAttribute(value: string) {
  return escapeHtml(value);
}

function iconUpload() {
  return `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none"><path d="M12 15V4m0 0 4 4m-4-4L8 8M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function iconDownload() {
  return `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none"><path d="M12 4v11m0 0 4-4m-4 4-4-4M5 20h14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function iconPlus() {
  return `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
}

function iconRefresh() {
  return `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none"><path d="M20 11a8 8 0 0 0-14.3-4.9L4 8m0 0h5M4 8V3m0 10a8 8 0 0 0 14.3 4.9L20 16m0 0h-5m5 0v5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function iconX() {
  return `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none"><path d="m6 6 12 12M18 6 6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
}
