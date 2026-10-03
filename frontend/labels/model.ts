// Pure state for the label station: what the form holds, and what the API
// receives. No DOM in here so it stays unit-testable.

export type TemplateName = "computer" | "general";
export type LogoPosition = "left" | "right" | "top_right" | "bottom_right";

/** Where the badge may go on each template, mirroring labcore.labeldesign. */
export const LOGO_POSITIONS: Record<TemplateName, readonly { value: LogoPosition; label: string }[]> = {
  computer: [
    { value: "left", label: "Left column" },
    { value: "right", label: "Right column" },
  ],
  general: [
    { value: "left", label: "Left column" },
    { value: "right", label: "Right column" },
    { value: "top_right", label: "Top right, small" },
    { value: "bottom_right", label: "Bottom right, small" },
  ],
};

/** The position to use after switching template, keeping it when valid. */
export function positionFor(template: TemplateName, current: LogoPosition): LogoPosition {
  return LOGO_POSITIONS[template].some((option) => option.value === current) ? current : "left";
}

export interface FormState {
  template: TemplateName;
  hostname: string;
  mac: string;
  ip: string;
  title: string;
  body: string;
  url: string;
  logo: boolean;
  logoPosition: LogoPosition;
  copies: number;
}

export const MAX_COPIES = 20;

export const TEMPLATE_FIELDS: Record<TemplateName, readonly (keyof FormState)[]> = {
  computer: ["hostname", "mac", "ip"],
  general: ["title", "body", "url"],
};

export function emptyState(): FormState {
  return {
    template: "computer",
    hostname: "",
    mac: "",
    ip: "",
    title: "",
    body: "",
    url: "",
    logo: false,
    logoPosition: "left",
    copies: 1,
  };
}

export interface RenderRequest {
  template: TemplateName;
  fields: Record<string, string>;
  logo: boolean;
  logo_position: LogoPosition;
}

export interface PrintRequest extends RenderRequest {
  copies: number;
}

export interface RenderResponse {
  svg: string;
  zpl: string;
  problems: string[];
}

export function requestBody(state: FormState): RenderRequest {
  const fields: Record<string, string> = {};
  for (const name of TEMPLATE_FIELDS[state.template]) {
    fields[name] = String(state[name]);
  }
  return { template: state.template, fields, logo: state.logo, logo_position: state.logoPosition };
}

export function clampCopies(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_COPIES, Math.max(1, Math.floor(value)));
}

export function printBody(state: FormState): PrintRequest {
  return { ...requestBody(state), copies: clampCopies(state.copies) };
}

export interface Debounced<A extends unknown[]> {
  (...args: A): void;
  cancel(): void;
}

export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  waitMs: number,
): Debounced<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = ((...args: A) => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      fn(...args);
    }, waitMs);
  }) as Debounced<A>;
  run.cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  return run;
}
