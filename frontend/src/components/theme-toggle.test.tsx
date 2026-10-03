import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { THEME_STORAGE_KEY } from "../theme";
import { ThemeToggle } from "./ThemeToggle";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function themeColorMeta(): HTMLMetaElement | null {
  return document.head.querySelector('meta[name="theme-color"]');
}

beforeEach(() => {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: new MemoryStorage(),
  });
  delete document.documentElement.dataset.theme;
  themeColorMeta()?.remove();
});

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
  themeColorMeta()?.remove();
});

describe("ThemeToggle", () => {
  it("switches between the themes and persists the choice", () => {
    render(<ThemeToggle />);

    const picker = screen.getByRole("combobox", {
      name: "Display theme",
    }) as HTMLSelectElement;
    // Blueprint is the out-of-the-box theme when nothing is stored.
    expect(picker.value).toBe("blueprint");
    expect(document.documentElement.dataset.theme).toBe("blueprint");
    // applyTheme on mount creates the meta tag when it is missing.
    expect(themeColorMeta()?.content).toBe("#e9eef3");

    fireEvent.change(picker, { target: { value: "lcars" } });
    expect(document.documentElement.dataset.theme).toBe("lcars");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("lcars");
    expect(themeColorMeta()?.content).toBe("#000000");

    fireEvent.change(picker, { target: { value: "litho" } });
    expect(document.documentElement.dataset.theme).toBe("litho");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("litho");
    expect(themeColorMeta()?.content).toBe("#000000");

    // "default" is the legacy value name for the cream theme, shown as
    // "Claude" in the picker; it still clears the data-theme attribute.
    fireEvent.change(picker, { target: { value: "default" } });
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("default");
    expect(themeColorMeta()?.content).toBe("#f4f1e9");

    fireEvent.change(picker, { target: { value: "blueprint" } });
    expect(document.documentElement.dataset.theme).toBe("blueprint");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("blueprint");
    expect(themeColorMeta()?.content).toBe("#e9eef3");
  });

  it("labels the cream theme Claude and lists Blueprint first", () => {
    render(<ThemeToggle />);

    const picker = screen.getByRole("combobox", {
      name: "Display theme",
    }) as HTMLSelectElement;
    const labels = Array.from(picker.options).map((option) => [
      option.value,
      option.textContent,
    ]);
    expect(labels).toEqual([
      ["blueprint", "Blueprint"],
      ["default", "Claude"],
      ["lcars", "Dark"],
      ["litho", "Litho"],
    ]);
  });

  it("updates an existing theme-color meta tag in place", () => {
    const meta = document.createElement("meta");
    meta.name = "theme-color";
    meta.content = "#153c36";
    document.head.appendChild(meta);
    window.localStorage.setItem(THEME_STORAGE_KEY, "lcars");

    render(<ThemeToggle />);

    expect(
      document.head.querySelectorAll('meta[name="theme-color"]'),
    ).toHaveLength(1);
    expect(meta.content).toBe("#000000");
  });

  it("starts in the stored theme", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "litho");

    render(<ThemeToggle />);

    expect(
      (
        screen.getByRole("combobox", {
          name: "Display theme",
        }) as HTMLSelectElement
      ).value,
    ).toBe("litho");
    expect(document.documentElement.dataset.theme).toBe("litho");
  });
});
