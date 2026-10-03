import { useEffect, useState } from "react";

import { applyTheme, storedTheme, THEMES, type ThemeName } from "../theme";

export function ThemeToggle() {
  const [theme, setTheme] = useState<ThemeName>(() => storedTheme());

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  return (
    <select
      aria-label="Display theme"
      className="theme-toggle"
      onChange={(event) => setTheme(event.target.value as ThemeName)}
      title="Display theme. Litho is red-only for the lithography bay: no blue emission near photoresist."
      value={theme}
    >
      {THEMES.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
