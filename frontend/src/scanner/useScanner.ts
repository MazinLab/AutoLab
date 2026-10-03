import { useEffect, useRef, useState, type RefObject } from "react";

import { parseAccession } from "./parse";

const SCAN_INTERVAL_MS = 300;

interface DetectedBarcode {
  rawValue?: string;
}

interface BarcodeDetectorInstance {
  detect(source: HTMLVideoElement): Promise<DetectedBarcode[]>;
}

interface BarcodeDetectorConstructor {
  new (options?: { formats?: string[] }): BarcodeDetectorInstance;
}

interface ScannerWindow extends Window {
  BarcodeDetector?: BarcodeDetectorConstructor;
}

interface Decoder {
  decode(video: HTMLVideoElement): Promise<string[]>;
}

type ZxingReader = typeof import("zxing-wasm/reader");

let zxingReaderPromise: Promise<ZxingReader> | undefined;

export type ScannerStatus =
  | "starting"
  | "scanning"
  | "unavailable"
  | "error";

export interface ScannerState {
  videoRef: RefObject<HTMLVideoElement | null>;
  status: ScannerStatus;
  error: string | null;
}

async function loadZxingReader(): Promise<ZxingReader> {
  if (!zxingReaderPromise) {
    const pendingReader = Promise.all([
      import("zxing-wasm/reader"),
      import("zxing-wasm/reader/zxing_reader.wasm?url"),
    ]).then(([reader, wasmAsset]) => {
      reader.prepareZXingModule({
        overrides: {
          locateFile: (path: string, prefix: string) =>
            path.endsWith(".wasm") ? wasmAsset.default : `${prefix}${path}`,
        },
      });
      return reader;
    });
    zxingReaderPromise = pendingReader.catch((error: unknown) => {
      zxingReaderPromise = undefined;
      throw error;
    });
  }
  return zxingReaderPromise;
}

async function createDecoder(): Promise<Decoder> {
  const BarcodeDetector = (window as ScannerWindow).BarcodeDetector;
  if (BarcodeDetector) {
    try {
      const detector = new BarcodeDetector({ formats: ["qr_code"] });
      return {
        async decode(video: HTMLVideoElement): Promise<string[]> {
          const results = await detector.detect(video);
          return results.flatMap((result) =>
            result.rawValue ? [result.rawValue] : [],
          );
        },
      };
    } catch {
      // A partial native implementation should fall back to the WASM reader.
    }
  }

  const { readBarcodes } = await loadZxingReader();
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("This browser cannot prepare camera frames for scanning.");
  }

  return {
    async decode(video: HTMLVideoElement): Promise<string[]> {
      const width = video.videoWidth;
      const height = video.videoHeight;
      if (width === 0 || height === 0) {
        return [];
      }
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      context.drawImage(video, 0, 0, width, height);
      const results = await readBarcodes(
        context.getImageData(0, 0, width, height),
        { formats: ["QRCode"], maxNumberOfSymbols: 1, tryHarder: true },
      );
      return results.map((result) => result.text);
    },
  };
}

function scannerErrorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return "Camera access was denied. Enter the accession manually instead.";
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "The camera scanner could not be started.";
}

export function useScanner(onCode: (accession: string) => void): ScannerState {
  const videoRef = useRef<HTMLVideoElement>(null);
  const onCodeRef = useRef(onCode);
  const [status, setStatus] = useState<ScannerStatus>("starting");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    onCodeRef.current = onCode;
  }, [onCode]);

  useEffect(() => {
    let cancelled = false;
    let intervalId: number | undefined;
    let stream: MediaStream | undefined;

    function stopCamera(): void {
      if (intervalId !== undefined) {
        window.clearInterval(intervalId);
        intervalId = undefined;
      }
      stream?.getTracks().forEach((track) => track.stop());
      stream = undefined;
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
    }

    async function start(): Promise<void> {
      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus("unavailable");
        setError("Camera scanning is unavailable. Enter the accession manually.");
        return;
      }

      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: "environment" } },
        });
        if (cancelled) {
          stopCamera();
          return;
        }

        const video = videoRef.current;
        if (!video) {
          stopCamera();
          return;
        }
        video.srcObject = stream;
        await video.play();
        if (cancelled) {
          return;
        }

        const decoder = await createDecoder();
        if (cancelled) {
          return;
        }

        let decoding = false;
        let lastAccession: string | null = null;
        setStatus("scanning");
        setError(null);
        intervalId = window.setInterval(() => {
          if (
            cancelled ||
            decoding ||
            video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
          ) {
            return;
          }

          decoding = true;
          void decoder
            .decode(video)
            .then((codes) => {
              if (cancelled) {
                return;
              }
              let detectedAccession: string | null = null;
              for (const code of codes) {
                const accession = parseAccession(code);
                if (accession) {
                  detectedAccession = accession;
                  break;
                }
              }
              if (!detectedAccession) {
                lastAccession = null;
              } else if (detectedAccession !== lastAccession) {
                lastAccession = detectedAccession;
                onCodeRef.current(detectedAccession);
              }
            })
            .catch((decodeError: unknown) => {
              if (!cancelled) {
                setStatus("error");
                setError(scannerErrorMessage(decodeError));
                stopCamera();
              }
            })
            .finally(() => {
              decoding = false;
            });
        }, SCAN_INTERVAL_MS);
      } catch (startError) {
        if (!cancelled) {
          setStatus("error");
          setError(scannerErrorMessage(startError));
          stopCamera();
        }
      }
    }

    void start();

    return () => {
      cancelled = true;
      stopCamera();
    };
  }, []);

  return { videoRef, status, error };
}
