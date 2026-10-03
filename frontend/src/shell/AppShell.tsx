import { useEffect, useState, type ReactNode } from "react";
import { NavLink } from "react-router-dom";

import { countOpenReviewTasks, getWhoami } from "../api/client";
import autolabMark from "../assets/autolab-mark.svg";
import { ActorPicker } from "../components/ActorPicker";
import { OutboxIndicator } from "../components/OutboxIndicator";
import { ThemeToggle } from "../components/ThemeToggle";

interface AppShellProps {
  children: ReactNode;
}

interface NavigationItem {
  label: string;
  shortLabel: string;
  to: string;
  symbol: string;
}

const navigation: readonly NavigationItem[] = [
  { label: "Scan", shortLabel: "Scan", to: "/scan", symbol: "⌗" },
  { label: "New record", shortLabel: "New", to: "/new", symbol: "+" },
  { label: "Search", shortLabel: "Search", to: "/", symbol: "⌕" },
  { label: "Activity", shortLabel: "Latest", to: "/activity", symbol: "◷" },
  { label: "Queue", shortLabel: "Queue", to: "/queue", symbol: "≡" },
];

const QUEUE_BADGE_REFRESH_MS = 60_000;
const STATUS_REFRESH_MS = 60_000;

type ApiStatus = "checking" | "offline" | "read-only" | "connected";

const STATUS_TEXT: Record<ApiStatus, string> = {
  checking: "Checking API…",
  offline: "Offline — writes will queue",
  "read-only": "Connected — read only",
  connected: "Connected — full access",
};

/* Live replacement for the old static "Same-origin API" line: is the API
   reachable from here, and will this network path be allowed to write? */
function ApiStatusLine(): ReactNode {
  const [status, setStatus] = useState<ApiStatus>("checking");

  useEffect(() => {
    let cancelled = false;
    function refresh(): void {
      getWhoami()
        .then((whoami) => {
          if (!cancelled) {
            setStatus(whoami.can_write === false ? "read-only" : "connected");
          }
        })
        .catch(() => {
          if (!cancelled) {
            setStatus("offline");
          }
        });
    }
    refresh();
    const timer = window.setInterval(refresh, STATUS_REFRESH_MS);
    const onOnline = (): void => refresh();
    const onOffline = (): void => setStatus("offline");
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  return (
    <div className={`sidebar-status sidebar-status--${status}`} role="status">
      <span className="status-dot" aria-hidden="true" />
      {STATUS_TEXT[status]}
    </div>
  );
}

export function AppShell({ children }: AppShellProps) {
  const [queueCount, setQueueCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    function refresh(): void {
      countOpenReviewTasks()
        .then((count) => {
          if (!cancelled) {
            setQueueCount(count);
          }
        })
        .catch(() => {
          // On any error the badge simply hides.
          if (!cancelled) {
            setQueueCount(0);
          }
        });
    }
    refresh();
    const timer = window.setInterval(refresh, QUEUE_BADGE_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <div className="app-shell">
      <header className="mobile-header">
        <NavLink className="brand" to="/" aria-label="AutoLab home">
          <img alt="" aria-hidden="true" className="brand-mark" src={autolabMark} />
          <span>AutoLab</span>
        </NavLink>
        <span className="environment-label">Mazin Lab</span>
      </header>

      <aside className="sidebar">
        <NavLink className="brand" to="/" aria-label="AutoLab home">
          <img alt="" aria-hidden="true" className="brand-mark" src={autolabMark} />
          <span>AutoLab</span>
        </NavLink>
        <p className="sidebar-kicker">Mazin Lab Archive</p>
        <nav className="primary-navigation" aria-label="Primary navigation">
          {navigation.map((item) => (
            <NavLink
              className={({ isActive }) =>
                ["navigation-link", isActive ? "navigation-link--active" : ""]
                  .filter(Boolean)
                  .join(" ")
              }
              end={item.to === "/"}
              key={item.to}
              to={item.to}
            >
              <span className="navigation-symbol" aria-hidden="true">
                {item.symbol}
              </span>
              <span className="navigation-label">{item.label}</span>
              <span className="navigation-short-label">{item.shortLabel}</span>
              {item.to === "/queue" && queueCount > 0 ? (
                <span
                  aria-label={`${queueCount} open review tasks`}
                  className="nav-badge"
                >
                  {queueCount}
                </span>
              ) : null}
            </NavLink>
          ))}
        </nav>
        <ApiStatusLine />
      </aside>

      <div className="shell-actor-picker">
        <ThemeToggle />
        <ActorPicker />
      </div>
      <OutboxIndicator />
      <main className="main-content">{children}</main>
    </div>
  );
}
