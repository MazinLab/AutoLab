import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useScanner } from "./useScanner";

function ScannerHarness({ onCode }: { onCode: (accession: string) => void }) {
  const scanner = useScanner(onCode);
  return (
    <div>
      <video ref={scanner.videoRef} />
      <span>{scanner.status}</span>
      <span>{scanner.error}</span>
    </div>
  );
}

let mediaDevicesDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  mediaDevicesDescriptor = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (mediaDevicesDescriptor) {
    Object.defineProperty(navigator, "mediaDevices", mediaDevicesDescriptor);
  } else {
    Reflect.deleteProperty(navigator, "mediaDevices");
  }
  Reflect.deleteProperty(window, "BarcodeDetector");
});

describe("useScanner", () => {
  it("keeps manual entry available when camera APIs are absent", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: undefined,
    });

    render(<ScannerHarness onCode={vi.fn()} />);

    expect(await screen.findByText("unavailable")).toBeTruthy();
    expect(screen.getByText(/Enter the accession manually/)).toBeTruthy();
  });

  it("uses the native detector and stops every camera track on cleanup", async () => {
    const onCode = vi.fn();
    const stopFirstTrack = vi.fn();
    const stopSecondTrack = vi.fn();
    const stream = {
      getTracks: () => [{ stop: stopFirstTrack }, { stop: stopSecondTrack }],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });

    const detectedCode = {
      rawValue: "https://labels.example/e/DEV-2026-0417",
    };
    const detect = vi
      .fn()
      .mockResolvedValueOnce([detectedCode])
      .mockResolvedValueOnce([])
      .mockResolvedValue([detectedCode]);
    class NativeBarcodeDetector {
      detect = detect;
    }
    Object.defineProperty(window, "BarcodeDetector", {
      configurable: true,
      value: NativeBarcodeDetector,
    });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);

    const rendered = render(<ScannerHarness onCode={onCode} />);
    const video = rendered.container.querySelector("video");
    if (!video) {
      throw new Error("test harness did not render a video element");
    }
    Object.defineProperty(video, "readyState", {
      configurable: true,
      value: HTMLMediaElement.HAVE_CURRENT_DATA,
    });

    await waitFor(() => expect(onCode).toHaveBeenCalledTimes(2), { timeout: 1_500 });
    expect(onCode).toHaveBeenNthCalledWith(1, "DEV-2026-0417");
    expect(onCode).toHaveBeenNthCalledWith(2, "DEV-2026-0417");
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: false,
      video: { facingMode: { ideal: "environment" } },
    });

    rendered.unmount();
    expect(stopFirstTrack).toHaveBeenCalledOnce();
    expect(stopSecondTrack).toHaveBeenCalledOnce();
  });

  it("stops an acquired camera stream when startup fails", async () => {
    const stop = vi.fn();
    const stream = {
      getTracks: () => [{ stop }],
    } as unknown as MediaStream;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
    });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockRejectedValue(
      new Error("video playback failed"),
    );

    render(<ScannerHarness onCode={vi.fn()} />);

    expect(await screen.findByText("error")).toBeTruthy();
    expect(screen.getByText("video playback failed")).toBeTruthy();
    expect(stop).toHaveBeenCalledOnce();
  });
});
