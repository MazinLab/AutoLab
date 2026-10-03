import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ArtifactCard, ImageLightbox } from "./EntityPage";
import type { Entity } from "../../api/client";

function artifact(overrides: Partial<Entity>): Entity {
  return {
    id: "01900000-0000-7000-8000-000000000021",
    accession: "ART-2026-0001",
    entity_type: "artifact",
    name: "C1 broadband S21",
    description: "",
    extra: {},
    source_key: null,
    created_by_id: null,
    created_at: "2026-07-20T00:00:00Z",
    updated_at: "2026-07-20T00:00:00Z",
    version: 0,
    media_type: "image/png",
    data_format: "png",
    size_bytes: 27663,
    ...overrides,
  };
}

afterEach(cleanup);

describe("ArtifactCard", () => {
  it("renders image artifacts inline at full size", () => {
    render(<ArtifactCard artifact={artifact({})} />);

    const image = screen.getByRole("img", { name: "C1 broadband S21" });
    expect(image.getAttribute("src")).toBe(
      "/api/artifacts/01900000-0000-7000-8000-000000000021/download",
    );
    expect(screen.getByRole("link", { name: "Download" })).toBeDefined();
  });

  it("zooms on click", async () => {
    const onZoom = vi.fn();
    const user = userEvent.setup();
    const subject = artifact({});
    render(<ArtifactCard artifact={subject} onZoom={onZoom} />);

    await user.click(
      screen.getByRole("button", {
        name: "View C1 broadband S21 full screen",
      }),
    );

    expect(onZoom).toHaveBeenCalledWith(subject);
  });

  it("keeps the compact card for non-image artifacts", () => {
    render(
      <ArtifactCard
        artifact={artifact({
          name: "C1 IQ power-sweep cube",
          media_type: "application/x-hdf5",
          data_format: "hdf5",
        })}
      />,
    );

    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("C1 IQ power-sweep cube")).toBeDefined();
    expect(screen.getByRole("link", { name: "Download" })).toBeDefined();
  });
});

describe("ImageLightbox", () => {
  it("shows the full image and closes on Escape or click", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<ImageLightbox artifact={artifact({})} onClose={onClose} />);

    expect(
      screen.getByRole("img", { name: "C1 broadband S21" }),
    ).toBeDefined();

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("dialog"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
