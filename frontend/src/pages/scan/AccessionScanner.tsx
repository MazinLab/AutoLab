import { FormEvent, useCallback, useId, useState } from "react";

import { parseAccession } from "../../scanner/parse";
import { useScanner } from "../../scanner/useScanner";
import "./scanner.css";

interface AccessionScannerProps {
  inputLabel: string;
  submitLabel: string;
  onAccession: (accession: string) => void;
  disabled?: boolean;
}

const STATUS_MESSAGES = {
  starting: "Starting camera…",
  scanning: "Point the camera at an AutoLab QR label.",
  unavailable: "Camera unavailable — manual entry is ready below.",
  error: "Camera scanner stopped — manual entry is still available.",
} as const;

export function AccessionScanner({
  inputLabel,
  submitLabel,
  onAccession,
  disabled = false,
}: AccessionScannerProps) {
  const inputId = useId();
  const errorId = `${inputId}-error`;
  const [manualEntry, setManualEntry] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const handleCameraCode = useCallback(
    (accession: string) => {
      if (!disabled) {
        onAccession(accession);
      }
    },
    [disabled, onAccession],
  );
  const scanner = useScanner(handleCameraCode);

  function submitManualEntry(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const accession = parseAccession(manualEntry);
    if (!accession) {
      setInputError("Enter a valid AutoLab accession or /e/ link.");
      return;
    }
    setInputError(null);
    onAccession(accession);
  }

  return (
    <div className="scanner-control">
      <div className="scanner-viewport">
        <video
          aria-label="QR camera preview"
          autoPlay
          muted
          playsInline
          ref={scanner.videoRef}
        />
        <div className="scanner-frame" aria-hidden="true" />
      </div>
      <p className="scanner-status" role="status">
        {STATUS_MESSAGES[scanner.status]}
      </p>
      {scanner.error ? <p className="scanner-detail">{scanner.error}</p> : null}

      <form className="accession-form scanner-manual" onSubmit={submitManualEntry}>
        <label htmlFor={inputId}>{inputLabel}</label>
        <div className="field-row">
          <input
            aria-describedby={inputError ? errorId : undefined}
            aria-invalid={inputError ? true : undefined}
            autoCapitalize="characters"
            autoComplete="off"
            disabled={disabled}
            id={inputId}
            onChange={(event) => {
              setManualEntry(event.target.value);
              setInputError(null);
            }}
            placeholder="DEV-2026-0417"
            spellCheck={false}
            value={manualEntry}
          />
          <button disabled={disabled} type="submit">
            {disabled ? "Working…" : submitLabel}
          </button>
        </div>
        {inputError ? (
          <p className="field-error" id={errorId} role="alert">
            {inputError}
          </p>
        ) : null}
      </form>
    </div>
  );
}
