import {
  type ChangeEvent,
  type ReactElement,
  useEffect,
  useState,
} from "react";

import {
  getPrinters,
  printLabel,
  type LabelFormat,
} from "../api/client";

interface PrintLabelProps {
  entityId: string;
}

interface PrintMessage {
  kind: "error" | "success";
  text: string;
}

export function PrintLabel({ entityId }: PrintLabelProps): ReactElement | null {
  const [printers, setPrinters] = useState<string[] | null>(null);
  const [selectedPrinter, setSelectedPrinter] = useState("");
  const [labelFormat, setLabelFormat] = useState<LabelFormat>("qr");
  const [isPrinting, setIsPrinting] = useState(false);
  const [message, setMessage] = useState<PrintMessage | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getPrinters()
      .then((configuredPrinters) => {
        if (!cancelled) {
          setPrinters(configuredPrinters);
          setSelectedPrinter(configuredPrinters[0] ?? "");
        }
      })
      .catch(() => {
        // A transient network failure should not clutter the page; the
        // control simply stays hidden for this visit.
        if (!cancelled) {
          setLoadFailed(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  function choosePrinter(event: ChangeEvent<HTMLSelectElement>): void {
    setSelectedPrinter(event.target.value);
    setMessage(null);
  }

  function chooseFormat(event: ChangeEvent<HTMLSelectElement>): void {
    setLabelFormat(event.target.value as LabelFormat);
    setMessage(null);
  }

  async function submitPrint(): Promise<void> {
    setIsPrinting(true);
    setMessage(null);
    try {
      await printLabel(entityId, {
        printer: selectedPrinter,
        labelFormat,
      });
      setMessage({
        kind: "success",
        text: `Label sent to ${selectedPrinter}.`,
      });
    } catch (error: unknown) {
      setMessage({
        kind: "error",
        text: error instanceof Error ? error.message : "Label could not be printed.",
      });
    } finally {
      setIsPrinting(false);
    }
  }

  if (loadFailed || printers === null) {
    return null;
  }

  if (printers.length === 0) {
    return (
      <p
        className="print-label-hint"
        title="Set AUTOLAB_PRINTERS on the server to enable label printing."
      >
        No label printers configured
      </p>
    );
  }

  return (
    <div className="print-label-control">
      <div className="print-label-fields">
        <label>
          <span className="visually-hidden">Printer</span>
          <select
            disabled={isPrinting}
            onChange={choosePrinter}
            value={selectedPrinter}
          >
            {printers.map((printer) => (
              <option key={printer} value={printer}>
                {printer}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="visually-hidden">Format</span>
          <select
            disabled={isPrinting}
            onChange={chooseFormat}
            value={labelFormat}
          >
            <option value="qr">QR label</option>
            <option value="text">Text label</option>
          </select>
        </label>
        <button
          className="secondary-button"
          disabled={isPrinting}
          onClick={() => void submitPrint()}
          type="button"
        >
          {isPrinting ? "Printing…" : "Print label"}
        </button>
      </div>
      {message ? (
        <p
          aria-live="polite"
          className={`form-message form-message--${message.kind}`}
        >
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
