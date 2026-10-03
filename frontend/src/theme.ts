export type ThemeName = "default" | "lcars" | "litho" | "blueprint";

export const THEME_STORAGE_KEY = "autolab-theme";

/* "default" is a legacy value name: it is the original cream theme, shown as
   "Claude" in the picker. The out-of-the-box theme is Blueprint. */
export const THEMES: { value: ThemeName; label: string }[] = [
  { value: "blueprint", label: "Blueprint" },
  { value: "default", label: "Claude" },
  { value: "lcars", label: "Dark" },
  { value: "litho", label: "Litho" },
];

export function storedTheme(): ThemeName {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return THEMES.some((theme) => theme.value === stored)
      ? (stored as ThemeName)
      : "blueprint";
  } catch {
    return "blueprint";
  }
}

// Browser chrome (address bar, PWA title bar) color per theme; keep in sync
// with the page backgrounds in styles.css and themes/*.css.
const THEME_COLORS: Record<ThemeName, string> = {
  default: "#f4f1e9",
  lcars: "#000000",
  litho: "#000000",
  blueprint: "#e9eef3",
};

export function applyTheme(theme: ThemeName): void {
  if (theme === "default") {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = theme;
  }
  let meta = document.head.querySelector<HTMLMetaElement>(
    'meta[name="theme-color"]',
  );
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);
  }
  meta.content = THEME_COLORS[theme];
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Display preference only; losing it is harmless.
  }
}
