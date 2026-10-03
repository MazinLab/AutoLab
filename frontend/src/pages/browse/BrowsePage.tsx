import { FormEvent, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import {
  getProjectReport,
  listEntities,
  parseAccessionUrl,
  searchEntities,
  type Entity,
  type EntityType,
  type ProjectProgress,
  type SearchResult,
} from "../../api/client";
import { statusLabel } from "../project/ProjectPage";
import "../project/project.css";
import { ACCESSION_PREFIXES } from "../../accessionPrefixes";
import { entityRoute } from "../entity/entityRoute";
import { BROWSE_SECTIONS } from "./browseSections";
import "./browse.css";

function readableType(entityType: EntityType): string {
  return entityType.replaceAll("_", " ");
}

function sinceLabel(startedAt: unknown): string | null {
  if (typeof startedAt !== "string" || !startedAt) {
    return null;
  }
  const started = new Date(startedAt);
  if (Number.isNaN(started.getTime())) {
    return null;
  }
  const sameYear = started.getFullYear() === new Date().getFullYear();
  return `since ${started.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  })}`;
}

export function BrowsePage() {
  const navigate = useNavigate();
  const [accession, setAccession] = useState("");
  const [accessionError, setAccessionError] = useState<string | null>(null);
  const [searchText, setSearchText] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [activeSetups, setActiveSetups] = useState<Entity[]>([]);
  const [projects, setProjects] = useState<Entity[]>([]);
  const [projectProgress, setProjectProgress] = useState<
    Record<string, ProjectProgress>
  >({});

  // Active projects lead the home page; on-hold ones follow, completed ones
  // stay behind the Projects list link.
  useEffect(() => {
    let cancelled = false;
    listEntities("project", { limit: 100, order: "desc" })
      .then((rows) => {
        if (cancelled) {
          return;
        }
        const rank = (status: unknown): number =>
          status === "on_hold" ? 1 : status === "completed" ? 2 : 0;
        const shown = rows
          .filter((row) => row.status !== "completed")
          .sort(
            (a, b) =>
              rank(a.status) - rank(b.status) ||
              String(a.name).localeCompare(String(b.name)),
          )
          .slice(0, 8);
        setProjects(shown);
        return Promise.allSettled(
          shown.map((row) =>
            getProjectReport(row.id).then((report) => [row.id, report.progress] as const),
          ),
        ).then((results) => {
          if (cancelled) {
            return;
          }
          const progress: Record<string, ProjectProgress> = {};
          for (const result of results) {
            if (result.status === "fulfilled") {
              progress[result.value[0]] = result.value[1];
            }
          }
          setProjectProgress(progress);
        });
      })
      .catch(() => {
        // Cards are a convenience; the Projects list link still works.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    listEntities("experiment_setup", { limit: 100, order: "desc" })
      .then((setups) => {
        if (!cancelled) {
          setActiveSetups(setups.filter((setup) => !setup.ended_at));
        }
      })
      .catch(() => {
        // The strip is a convenience; the browser works without it.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const query = searchText.trim();
    if (!query) {
      setSearchResults([]);
      setIsSearching(false);
      return;
    }

    let isCurrent = true;
    setIsSearching(true);
    const timer = window.setTimeout(() => {
      searchEntities(query, 20)
        .then((results) => {
          if (isCurrent) {
            setSearchResults(results);
          }
        })
        .catch(() => {
          if (isCurrent) {
            setSearchResults([]);
          }
        })
        .finally(() => {
          if (isCurrent) {
            setIsSearching(false);
          }
        });
    }, 300);

    return () => {
      isCurrent = false;
      window.clearTimeout(timer);
    };
  }, [searchText]);

  function submitAccession(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsedAccession = parseAccessionUrl(accession);
    if (!parsedAccession) {
      setAccessionError("Enter an accession or an AutoLab entity link.");
      return;
    }
    setAccessionError(null);
    navigate(`/e/${encodeURIComponent(parsedAccession)}`);
  }

  return (
    <section className="page-panel browser-page">
      <p className="eyebrow">Catalog browser</p>
      <h1>Find a lab record</h1>
      <p className="lede">
        Open an accession directly, search across the catalog, or browse every
        record of a type.
      </p>

      <div className="browser-tools">
        <form className="browser-tool" onSubmit={submitAccession}>
          <label htmlFor="accession">Accession or AutoLab link</label>
          <div className="compact-field-row">
            <input
              autoComplete="off"
              id="accession"
              onChange={(event) => setAccession(event.target.value)}
              placeholder="W-2026-0001"
              spellCheck={false}
              value={accession}
            />
            <button type="submit">Open record</button>
          </div>
          {accessionError ? <p className="field-error">{accessionError}</p> : null}
        </form>

        <div className="browser-tool global-search">
          <label htmlFor="global-search">Search names and descriptions</label>
          <input
            autoComplete="off"
            id="global-search"
            onChange={(event) => setSearchText(event.target.value)}
            placeholder="resonator, wafer, sputter…"
            type="search"
            value={searchText}
          />
          {searchText.trim() ? (
            <div className="search-results" aria-live="polite">
              {isSearching ? <p>Searching…</p> : null}
              {!isSearching && searchResults.length === 0 ? (
                <p>No matching records.</p>
              ) : null}
              {!isSearching
                ? searchResults.map((result) => (
                    <Link key={result.id} to={entityRoute(result.id)}>
                      <span>{result.name || result.accession}</span>
                      <small>
                        {result.accession} · {readableType(result.entity_type)}
                      </small>
                    </Link>
                  ))
                : null}
            </div>
          ) : null}
        </div>
      </div>

      {projects.length > 0 ? (
        <section className="active-setups" aria-labelledby="projects-heading">
          <p className="eyebrow">Projects</p>
          <h2 id="projects-heading">Current projects</h2>
          <div className="project-cards">
            {projects.map((project) => {
              const progress = projectProgress[project.id];
              return (
                <Link
                  className="active-setup-chip project-card"
                  key={project.id}
                  to={entityRoute(project.id)}
                >
                  <span className="active-setup-name project-card-name">
                    {project.name || project.accession}
                  </span>
                  <span className={`pill pill--status-${String(project.status ?? "active")}`}>
                    {statusLabel(project.status)}
                  </span>
                  <small className="active-setup-meta">
                    {progress
                      ? progress.milestones_total === 0
                        ? "No milestones yet"
                        : `${progress.milestones_done}/${progress.milestones_total} milestones`
                      : project.accession}
                  </small>
                </Link>
              );
            })}
          </div>
          <Link className="text-button" to="/browse/projects">
            See all projects
          </Link>
        </section>
      ) : null}

      {activeSetups.length > 0 ? (
        <section className="active-setups" aria-labelledby="active-setups-heading">
          <p className="eyebrow">In progress</p>
          <h2 id="active-setups-heading">Active setups</h2>
          <div className="active-setup-chips">
            {activeSetups.map((setup) => {
              const since = sinceLabel(setup.started_at);
              return (
                <Link
                  className="active-setup-chip"
                  key={setup.id}
                  to={entityRoute(setup.id)}
                >
                  <span className="active-setup-name">
                    {setup.name || setup.accession}
                  </span>
                  <small className="active-setup-meta">
                    {setup.accession}
                    {since ? ` · ${since}` : ""}
                  </small>
                </Link>
              );
            })}
          </div>
        </section>
      ) : null}

      <section className="catalog-section" aria-labelledby="catalog-heading">
        <p className="eyebrow">By record type</p>
        <h2 id="catalog-heading">Browse the catalog</h2>
        <div className="template-groups browse-groups" aria-label="Record lists">
          {BROWSE_SECTIONS.map((section) => (
            <section
              aria-labelledby={`browse-group-${section.key}`}
              className={`template-group template-group--${section.key}`}
              key={section.key}
            >
              <h2 id={`browse-group-${section.key}`}>{section.title}</h2>
              <div className="template-chooser">
                {section.items.map((item) => (
                  <Link
                    className="template-choice"
                    key={item.slug}
                    to={`/browse/${item.slug}`}
                  >
                    <span>{item.label}</span>
                    <small
                      aria-hidden="true"
                      className="template-prefix"
                      title={readableType(item.entityType)}
                    >
                      {ACCESSION_PREFIXES[item.entityType] ?? "?"}-
                    </small>
                  </Link>
                ))}
              </div>
            </section>
          ))}
        </div>
      </section>
    </section>
  );
}
