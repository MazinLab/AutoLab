import "@fontsource/barlow-semi-condensed/700.css";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "../src/themes/blueprint.css";
import "./labels.css";

import {
  clampCopies,
  debounce,
  emptyState,
  LOGO_POSITIONS,
  positionFor,
  printBody,
  requestBody,
  type FormState,
  type LogoPosition,
  type RenderResponse,
  type TemplateName,
} from "./model";

const state: FormState = emptyState();

const form = document.querySelector<HTMLFormElement>("#label-form")!;
const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-template]"));
const fieldsets = Array.from(form.querySelectorAll<HTMLFieldSetElement>("fieldset[data-for]"));
const preview = document.querySelector<HTMLElement>("#preview")!;
const problemsList = document.querySelector<HTMLUListElement>("#problems")!;
const zplOutput = document.querySelector<HTMLElement>("#zpl")!;
const status = document.querySelector<HTMLElement>("#status")!;
const printButton = document.querySelector<HTMLButtonElement>("#print")!;
const copiesInput = form.elements.namedItem("copies") as HTMLInputElement;
const printerLine = document.querySelector<HTMLElement>("#printer")!;
const logoToggle = form.elements.namedItem("logo") as HTMLInputElement;
const positionField = document.querySelector<HTMLElement>("#logo-position")!;
const positionSelect = form.elements.namedItem("logo_position") as HTMLSelectElement;

function syncPositionOptions(): void {
  state.logoPosition = positionFor(state.template, state.logoPosition);
  positionSelect.replaceChildren(
    ...LOGO_POSITIONS[state.template].map((option) => {
      const element = document.createElement("option");
      element.value = option.value;
      element.textContent = option.label;
      element.selected = option.value === state.logoPosition;
      return element;
    }),
  );
  positionField.hidden = !state.logo;
}

let printerAvailable = false;
let renderSequence = 0;

function setStatus(text: string, tone: "" | "ok" | "err" | "busy" = ""): void {
  status.textContent = text;
  status.dataset.tone = tone;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const data = (await response.json()) as { detail?: unknown };
      if (typeof data.detail === "string") detail = data.detail;
    } catch {
      /* non-JSON error body */
    }
    if (response.status === 403) {
      detail = "Printing only works from the lab tailnet.";
    }
    throw new Error(detail);
  }
  return (await response.json()) as T;
}

async function render(): Promise<void> {
  const sequence = ++renderSequence;
  preview.classList.add("is-rendering");
  try {
    const result = await postJson<RenderResponse>("/api/labels/render", requestBody(state));
    if (sequence !== renderSequence) return; // a newer keystroke won
    preview.innerHTML = result.svg;
    zplOutput.textContent = result.zpl;
    problemsList.replaceChildren(
      ...result.problems.map((problem) => {
        const item = document.createElement("li");
        item.textContent = problem;
        return item;
      }),
    );
    problemsList.hidden = result.problems.length === 0;
  } catch (error) {
    if (sequence !== renderSequence) return;
    setStatus(error instanceof Error ? error.message : "Preview failed", "err");
  } finally {
    if (sequence === renderSequence) preview.classList.remove("is-rendering");
  }
}

const renderSoon = debounce(() => void render(), 120);

function selectTemplate(template: TemplateName): void {
  state.template = template;
  for (const tab of tabs) {
    const active = tab.dataset.template === template;
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  }
  for (const fieldset of fieldsets) {
    fieldset.hidden = fieldset.dataset.for !== template;
  }
  const first = fieldsets.find((f) => !f.hidden)?.querySelector<HTMLElement>("input,textarea");
  first?.focus();
  syncPositionOptions();
  setStatus("");
  renderSoon.cancel();
  void render();
}

for (const tab of tabs) {
  tab.addEventListener("click", () => selectTemplate(tab.dataset.template as TemplateName));
}

form.addEventListener("input", (event) => {
  const target = event.target as HTMLInputElement | HTMLTextAreaElement;
  const name = target.name;
  if (name === "copies") {
    state.copies = clampCopies(Number(target.value));
    return;
  }
  if (name === "logo") {
    state.logo = logoToggle.checked;
    positionField.hidden = !state.logo;
    setStatus("");
    renderSoon.cancel();
    void render();
    return;
  }
  if (name === "logo_position") {
    state.logoPosition = positionSelect.value as LogoPosition;
    setStatus("");
    renderSoon.cancel();
    void render();
    return;
  }
  if (name in state && typeof state[name as keyof FormState] === "string") {
    (state as unknown as Record<string, string>)[name] = target.value;
    setStatus("");
    renderSoon();
  }
});

copiesInput.addEventListener("change", () => {
  state.copies = clampCopies(copiesInput.valueAsNumber);
  copiesInput.value = String(state.copies);
});

for (const step of form.querySelectorAll<HTMLButtonElement>("[data-step]")) {
  step.addEventListener("click", () => {
    state.copies = clampCopies(state.copies + Number(step.dataset.step));
    copiesInput.value = String(state.copies);
  });
}

// Enter in a text field must not print a label by accident; Cmd/Ctrl+Enter
// is the deliberate shortcut.
form.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  if (event.metaKey || event.ctrlKey) {
    event.preventDefault();
    void print();
  } else if ((event.target as HTMLElement).tagName !== "TEXTAREA") {
    event.preventDefault();
  }
});

async function print(): Promise<void> {
  if (!printerAvailable || printButton.disabled) return;
  printButton.disabled = true;
  const copies = clampCopies(state.copies);
  setStatus(copies === 1 ? "Printing…" : `Printing ${copies} labels…`, "busy");
  try {
    const result = await postJson<{ printer: string; copies: number }>(
      "/api/labels/print",
      printBody(state),
    );
    setStatus(
      result.copies === 1
        ? `Printed on ${result.printer}.`
        : `Printed ${result.copies} labels on ${result.printer}.`,
      "ok",
    );
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Print failed", "err");
  } finally {
    printButton.disabled = false;
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void print();
});

async function loadPrinters(): Promise<void> {
  try {
    const response = await fetch("/api/printers");
    const printers = (await response.json()) as string[];
    printerAvailable = printers.length > 0;
    printerLine.textContent = printerAvailable
      ? `Printer · ${printers.join(", ")} · 2.00 × 1.25 in`
      : "No printer configured";
    printerLine.dataset.tone = printerAvailable ? "ok" : "err";
  } catch {
    printerAvailable = false;
    printerLine.textContent = "Printer status unavailable";
    printerLine.dataset.tone = "err";
  }
  printButton.disabled = !printerAvailable;
}

void loadPrinters();
selectTemplate("computer");
