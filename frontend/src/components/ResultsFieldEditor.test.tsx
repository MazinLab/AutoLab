import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseResultValue, ResultsFieldEditor } from "./ResultsFieldEditor";

afterEach(cleanup);

describe("ResultsFieldEditor", () => {
  it("parses numeric literals and keeps other text", () => {
    expect(parseResultValue("3.2e-17")).toBe(3.2e-17);
    expect(parseResultValue(" 100 ")).toBe(100);
    expect(parseResultValue("Al/Ti")).toBe("Al/Ti");
    expect(parseResultValue("NaN")).toBe("NaN");
  });

  it("adds a row, edits a value in place, and removes a row", async () => {
    const onChange = vi.fn();
    render(<ResultsFieldEditor value={{ q_i: 1.5e6 }} onChange={onChange} />);
    await userEvent.type(screen.getByLabelText("New result key"), "t_mk");
    await userEvent.type(screen.getByLabelText("New result value"), "100");
    await userEvent.click(screen.getByRole("button", { name: "Add result" }));
    expect(onChange).toHaveBeenLastCalledWith({ q_i: 1.5e6, t_mk: 100 });
    const value = screen.getByLabelText("Value for q_i") as HTMLInputElement;
    await userEvent.clear(value);
    await userEvent.type(value, "2");
    expect(value.value).toBe("2");
    expect(onChange).toHaveBeenLastCalledWith({ q_i: 2, t_mk: 100 });
    await userEvent.click(screen.getByRole("button", { name: "Remove q_i" }));
    expect(onChange).toHaveBeenLastCalledWith({ t_mk: 100 });
  });

  it("rejects a bad key and a duplicate key", async () => {
    const onChange = vi.fn();
    render(<ResultsFieldEditor value={{ q_i: 1 }} onChange={onChange} />);
    await userEvent.type(screen.getByLabelText("New result key"), "bad key");
    await userEvent.type(screen.getByLabelText("New result value"), "1");
    await userEvent.click(screen.getByRole("button", { name: "Add result" }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText(/letters, digits/)).toBeTruthy();
    await userEvent.clear(screen.getByLabelText("New result key"));
    await userEvent.type(screen.getByLabelText("New result key"), "q_i");
    await userEvent.click(screen.getByRole("button", { name: "Add result" }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText(/already/)).toBeTruthy();
  });
});
