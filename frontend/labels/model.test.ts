import { describe, expect, it, vi } from "vitest";

import {
  clampCopies,
  debounce,
  emptyState,
  positionFor,
  printBody,
  requestBody,
} from "./model";

describe("requestBody", () => {
  it("sends only the computer fields for the computer template", () => {
    const state = {
      ...emptyState(),
      template: "computer" as const,
      hostname: "mec",
      mac: "aa:bb",
      ip: "10.0.0.1",
      title: "leak",
    };
    expect(requestBody(state)).toEqual({
      template: "computer",
      fields: { hostname: "mec", mac: "aa:bb", ip: "10.0.0.1" },
      logo: false,
      logo_position: "left",
    });
  });

  it("sends title, body and url for the general template", () => {
    const state = {
      ...emptyState(),
      template: "general" as const,
      title: "Box",
      body: "line 1\nline 2",
      url: "https://example.org",
      hostname: "leak",
    };
    expect(requestBody(state)).toEqual({
      template: "general",
      fields: { title: "Box", body: "line 1\nline 2", url: "https://example.org" },
      logo: false,
      logo_position: "left",
    });
  });

  it("carries the logo flag and position for either template", () => {
    expect(requestBody({ ...emptyState(), logo: true }).logo).toBe(true);
    const general = requestBody({
      ...emptyState(),
      template: "general",
      logo: true,
      logoPosition: "bottom_right",
    });
    expect(general.logo_position).toBe("bottom_right");
  });
});

describe("positionFor", () => {
  it("keeps a position the template supports and falls back to left otherwise", () => {
    expect(positionFor("general", "bottom_right")).toBe("bottom_right");
    expect(positionFor("computer", "bottom_right")).toBe("left");
    expect(positionFor("computer", "right")).toBe("right");
  });
});

describe("printBody", () => {
  it("adds the clamped copy count", () => {
    const state = { ...emptyState(), copies: 99 };
    expect(printBody(state).copies).toBe(20);
  });
});

describe("clampCopies", () => {
  it("keeps copies between 1 and 20 and drops fractions", () => {
    expect(clampCopies(0)).toBe(1);
    expect(clampCopies(2.7)).toBe(2);
    expect(clampCopies(50)).toBe(20);
    expect(clampCopies(Number.NaN)).toBe(1);
  });
});

describe("debounce", () => {
  it("fires once with the last arguments after the quiet period", () => {
    vi.useFakeTimers();
    const spy = vi.fn();
    const run = debounce(spy, 100);
    run("a");
    run("b");
    vi.advanceTimersByTime(99);
    expect(spy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("b");
    vi.useRealTimers();
  });

  it("can be cancelled", () => {
    vi.useFakeTimers();
    const spy = vi.fn();
    const run = debounce(spy, 100);
    run();
    run.cancel();
    vi.advanceTimersByTime(200);
    expect(spy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
