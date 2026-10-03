import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import templates from "../../../app/data/templates.json";
import { type EntityTemplate } from "../api/client";
import { TemplateForm, resetDropdownOptionsCache } from "./TemplateForm";

const apiMocks = vi.hoisted(() => ({
  createEntity: vi.fn(),
  getPrinters: vi.fn().mockResolvedValue([]),
  listAllEntities: vi.fn().mockResolvedValue([]),
  listEntities: vi.fn().mockResolvedValue([]),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, ...apiMocks };
});

const analysis = (templates as EntityTemplate[]).find((t) => t.name === "Analysis")!;
const summary = (templates as EntityTemplate[]).find((t) => t.name === "Result Summary")!;

afterEach(() => {
  cleanup();
  resetDropdownOptionsCache();
  vi.clearAllMocks();
});

describe("result summary templates", () => {
  it("declares the Result Summary template under Testing with a body", () => {
    expect(summary.entity_type).toBe("result_summary");
    expect(summary.group).toBe("testing");
    expect(summary.body).toBe(true);
  });

  it("renders the Analysis form with Results rows and a Result Summary picker", async () => {
    render(<TemplateForm template={analysis} onCreated={vi.fn()} />);
    expect(await screen.findByText("Results")).toBeTruthy();
    expect(screen.getByLabelText("Result Summary")).toBeTruthy();
  });

  it("submits results as a map and links the picked summary", async () => {
    apiMocks.listAllEntities.mockResolvedValue([
      { id: "project-1", entity_type: "project", accession: "PROJ-2026-0001", name: "Alpha", status: "active" },
    ]);
    apiMocks.listEntities.mockResolvedValue([
      { id: "rs-1", entity_type: "result_summary", accession: "RS-2026-0001", name: "TLS noise" },
    ]);
    apiMocks.createEntity.mockResolvedValue({ id: "ar-1", accession: "AR-2026-0001", entity_type: "analysis_run" });
    render(<TemplateForm template={analysis} onCreated={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/Analysis Title/), "Fit 1");
    const project = await screen.findByLabelText(/Project/);
    await waitFor(() => expect(within(project).getByText(/Alpha/)).toBeTruthy());
    await userEvent.selectOptions(project, "project-1");
    await userEvent.type(screen.getByLabelText("New result key"), "t_mk");
    await userEvent.type(screen.getByLabelText("New result value"), "100");
    await userEvent.click(screen.getByRole("button", { name: "Add result" }));
    const summary = await screen.findByLabelText(/Result Summary/);
    await waitFor(() => expect(within(summary).getByText(/TLS noise/)).toBeTruthy());
    await userEvent.selectOptions(summary, "rs-1");
    await userEvent.click(screen.getByRole("button", { name: "Create analysis" }));
    await waitFor(() => expect(apiMocks.createEntity).toHaveBeenCalled());
    const [entityType, payload] = apiMocks.createEntity.mock.calls[0];
    expect(entityType).toBe("analysis_run");
    // buildPayloads() flattens fields and appends `links`.
    expect(payload.results).toEqual({ t_mk: 100 });
    expect(payload.links).toContainEqual({ relation: "refers_to", dst_id: "rs-1" });
  });

  it("prefills results when cloning", async () => {
    render(<TemplateForm template={analysis} onCreated={vi.fn()} initialResults={{ q_i: 1.5e6 }} />);
    expect(((await screen.findByLabelText("Value for q_i")) as HTMLInputElement).value).toBe("1500000");
  });
});
