import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactElement, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { Markdown } from "./Markdown";
import { MarkdownEditor } from "./MarkdownEditor";

function Harness({ initial = "" }: { initial?: string }): ReactElement {
  const [value, setValue] = useState(initial);
  return (
    <MarkdownEditor id="editor" onChange={setValue} value={value} />
  );
}

afterEach(cleanup);

describe("MarkdownEditor", () => {
  it("wraps the selection when a formatting tool is used", async () => {
    const user = userEvent.setup();
    render(<Harness initial="make this bold" />);

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    textarea.setSelectionRange(10, 14);
    await user.click(screen.getByRole("button", { name: "Bold" }));

    expect(textarea.value).toBe("make this **bold**");
  });

  it("prefixes selected lines for list formatting", async () => {
    const user = userEvent.setup();
    render(<Harness initial={"alpha\nbeta"} />);

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    textarea.setSelectionRange(0, textarea.value.length);
    await user.click(screen.getByRole("button", { name: "Bulleted list" }));

    expect(textarea.value).toBe("- alpha\n- beta");
  });

  it("renders the note as markdown in preview mode", async () => {
    const user = userEvent.setup();
    render(<Harness initial={"## Cooldown 18\n- base reached"} />);

    await user.click(screen.getByRole("button", { name: "Preview" }));

    expect(
      screen.getByRole("heading", { level: 2, name: "Cooldown 18" }),
    ).toBeDefined();
    expect(screen.getByRole("listitem").textContent).toBe("base reached");
    expect(screen.queryByRole("textbox")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Write" }));
    expect(screen.getByRole("textbox")).toBeDefined();
  });
});

describe("Markdown", () => {
  it("renders tables, code, and links without injecting raw HTML", () => {
    const source = [
      "| Ch | Device |",
      "| --- | --- |",
      "| 1 | ON1 A2 |",
      "",
      "`code` and [docs](https://example.org)",
      "<script>alert(1)</script>",
    ].join("\n");
    const { container } = render(<Markdown source={source} />);

    expect(screen.getByRole("table")).toBeDefined();
    expect(screen.getByRole("cell", { name: "ON1 A2" })).toBeDefined();
    expect(screen.getByRole("link", { name: "docs" }).getAttribute("href")).toBe(
      "https://example.org",
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
  });
});
