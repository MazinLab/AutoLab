import { useCallback, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { AccessionScanner } from "./AccessionScanner";

const RECENT_SCANS_KEY = "autolab.recent-scans";
const MAX_RECENT_SCANS = 5;

function loadRecentScans(): string[] {
  try {
    const stored = window.sessionStorage.getItem(RECENT_SCANS_KEY);
    const parsed: unknown = stored ? JSON.parse(stored) : [];
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    // Scanning must remain usable when session storage is disabled or corrupt.
    return [];
  }
}

function storeRecentScans(accessions: string[]): void {
  try {
    window.sessionStorage.setItem(RECENT_SCANS_KEY, JSON.stringify(accessions));
  } catch {
    // Recent history is optional; navigation must still complete.
  }
}

export function ScanPage() {
  const navigate = useNavigate();
  const [recentScans, setRecentScans] = useState(loadRecentScans);

  const openAccession = useCallback(
    (accession: string) => {
      setRecentScans((current) => {
        const next = [accession, ...current.filter((item) => item !== accession)].slice(
          0,
          MAX_RECENT_SCANS,
        );
        storeRecentScans(next);
        return next;
      });
      navigate(`/e/${encodeURIComponent(accession)}`);
    },
    [navigate],
  );

  return (
    <section className="page-panel scan-page">
      <p className="eyebrow">Scanner</p>
      <h1>Scan a label</h1>
      <p className="lede">
        Open any AutoLab record from its QR label or printed accession.
      </p>

      <AccessionScanner
        inputLabel="Accession or AutoLab link"
        onAccession={openAccession}
        submitLabel="Open record"
      />

      <p className="mount-shortcut">
        Mounting hardware? <Link to="/mount">Start the two-scan mount flow</Link>.
      </p>

      <section className="recent-scans" aria-labelledby="recent-scans-heading">
        <h2 id="recent-scans-heading">Recent scans</h2>
        {recentScans.length === 0 ? (
          <p>No labels scanned in this session.</p>
        ) : (
          <ul>
            {recentScans.map((accession) => (
              <li key={accession}>
                <Link to={`/e/${encodeURIComponent(accession)}`}>{accession}</Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
