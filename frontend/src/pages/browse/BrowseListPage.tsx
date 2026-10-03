import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";

import {
  getEntity,
  listEntitiesPage,
  type Entity,
  type Pagination,
} from "../../api/client";
import { entityRoute } from "../entity/entityRoute";
import {
  PROJECT_MEMBER_TYPES,
  columnText,
  findBrowseItem,
  type BrowseItem,
} from "./browseSections";
import "./browse.css";

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 300;

type SortDirection = "ascending" | "descending";

export function BrowseListPage() {
  const { slug } = useParams();
  const item = findBrowseItem(slug);

  if (!item) {
    return (
      <section className="page-panel browser-page">
        <p className="eyebrow">Catalog browser</p>
        <h1>Unknown record list</h1>
        <p className="lede">This record list does not exist.</p>
        <Link className="text-button" to="/">
          ← Browse the catalog
        </Link>
      </section>
    );
  }

  // Keyed on the slug so every list starts from page 1 with a clear search.
  return <BrowseList item={item} key={item.slug} />;
}

// "?project=<id>" narrows a member list to one project (the project page's
// "See all" links). Ignored on lists whose type has no project column.
function ProjectFilterChip({ projectId }: { projectId: string }) {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    let isCurrent = true;
    getEntity("project", projectId)
      .then((response) => {
        if (isCurrent) {
          setName(response.data.name || response.data.accession);
        }
      })
      .catch(() => {
        if (isCurrent) {
          setName(null);
        }
      });
    return () => {
      isCurrent = false;
    };
  }, [projectId]);
  return (
    <p className="filter-chip">
      In project{" "}
      <Link to={entityRoute(projectId)}>{name ?? "…"}</Link>
      {" · "}
      <Link to="?">Clear</Link>
    </p>
  );
}

function BrowseList({ item }: { item: BrowseItem }) {
  const [searchParams] = useSearchParams();
  const projectId = PROJECT_MEMBER_TYPES.has(item.entityType)
    ? searchParams.get("project")
    : null;
  const [rows, setRows] = useState<Entity[]>([]);
  const [total, setTotal] = useState(0);
  // page and query change together (a new search resets to the first page),
  // so they live in one state object to trigger exactly one refetch.
  const [view, setView] = useState({ page: 0, query: "" });
  const [searchText, setSearchText] = useState("");
  const [sortDirection, setSortDirection] =
    useState<SortDirection>("descending");
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    const handle = setTimeout(() => {
      const query = searchText.trim();
      setView((current) =>
        current.query === query ? current : { page: 0, query },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [searchText]);

  useEffect(() => {
    let isCurrent = true;
    setIsLoading(true);
    const pagination: Pagination = {
      limit: PAGE_SIZE,
      offset: view.page * PAGE_SIZE,
      order: sortDirection === "ascending" ? "asc" : "desc",
      orderBy: "updated",
      ...(view.query ? { q: view.query } : {}),
      ...(item.serverFilter ?? {}),
    };
    if (projectId) {
      pagination.filters = { ...(pagination.filters ?? {}), project_id: projectId };
    }
    listEntitiesPage(item.entityType, pagination)
      .then((page) => {
        if (isCurrent) {
          setRows(page.rows);
          setTotal(page.total);
          setLoadError(null);
        }
      })
      .catch(() => {
        if (isCurrent) {
          setRows([]);
          setTotal(0);
          setLoadError(
            `The ${item.label.toLocaleLowerCase()} records could not be loaded.`,
          );
        }
      })
      .finally(() => {
        if (isCurrent) {
          setIsLoading(false);
        }
      });
    return () => {
      isCurrent = false;
    };
  }, [item, projectId, sortDirection, view]);

  // Instrument lists must keep uncategorized records visible in both
  // equipment sections; server equality filters cannot express that OR, so
  // those items fetch unfiltered pages and hide the other category here.
  // Trade-off: the page range and total below count ALL instruments, and the
  // caption states how many of the fetched records belong to this list.
  const visibleRows = useMemo(
    () => (item.match ? rows.filter(item.match) : rows),
    [item, rows],
  );

  const rangeStart = view.page * PAGE_SIZE + 1;
  const rangeEnd = view.page * PAGE_SIZE + rows.length;
  const hasNextPage = rangeEnd < total;
  const rangeText =
    total === 0
      ? "0 records"
      : item.match
        ? `Records ${rangeStart}–${rangeEnd} of ${total} instruments; ` +
          `${visibleRows.length} in this list (uncategorized equipment ` +
          `appears in both equipment lists)`
        : `${rangeStart}–${rangeEnd} of ${total}`;

  function toggleUpdatedSort() {
    setSortDirection((current) =>
      current === "ascending" ? "descending" : "ascending",
    );
    setView((current) => ({ ...current, page: 0 }));
  }

  function turnPage(step: number) {
    setView((current) => ({ ...current, page: current.page + step }));
  }

  return (
    <section className="page-panel browser-page">
      <Link className="text-button" to="/">
        ← Browse the catalog
      </Link>
      <p className="eyebrow">Catalog records</p>
      <h1>{item.label}</h1>
      {projectId ? <ProjectFilterChip projectId={projectId} /> : null}
      <p className="lede">
        {isLoading
          ? "Loading records…"
          : `${total} record${total === 1 ? "" : "s"}, ${
              sortDirection === "descending"
                ? "most recently updated first"
                : "least recently updated first"
            }. Click a row to open it.`}
      </p>

      <label className="table-filter" htmlFor="table-filter">
        Search this list
        <input
          id="table-filter"
          onChange={(event) => setSearchText(event.target.value)}
          placeholder="Search names and descriptions"
          type="search"
          value={searchText}
        />
      </label>

      {loadError ? <p className="notice notice--error">{loadError}</p> : null}
      {!isLoading && !loadError ? (
        <>
          <div className="catalog-table-wrap">
            <table className="catalog-table">
              <thead>
                <tr>
                  <th scope="col">Accession</th>
                  <th scope="col">Name</th>
                  {item.columns.map((column) => (
                    <th key={column.key} scope="col">
                      {column.label}
                    </th>
                  ))}
                  <th aria-sort={sortDirection} scope="col">
                    <button type="button" onClick={toggleUpdatedSort}>
                      Updated
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((entity) => (
                  <tr key={entity.id}>
                    <td>
                      <Link to={entityRoute(entity.id)}>
                        {entity.accession}
                      </Link>
                    </td>
                    <td>
                      <Link className="row-name" to={entityRoute(entity.id)}>
                        {entity.name || "Untitled"}
                      </Link>
                    </td>
                    {item.columns.map((column) => (
                      <td key={column.key}>{columnText(entity, column)}</td>
                    ))}
                    <td>{new Date(entity.updated_at).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {visibleRows.length === 0 ? (
              <p className="empty-state">
                {view.query
                  ? "No records match this search."
                  : rows.length === 0
                    ? "No records of this type yet."
                    : "No records in this list on this page."}
              </p>
            ) : null}
          </div>
          <nav aria-label="Pagination" className="table-pager">
            <button
              className="secondary-button"
              disabled={view.page === 0}
              onClick={() => turnPage(-1)}
              type="button"
            >
              Previous
            </button>
            <span className="table-pager__range">{rangeText}</span>
            <button
              className="secondary-button"
              disabled={!hasNextPage}
              onClick={() => turnPage(1)}
              type="button"
            >
              Next
            </button>
          </nav>
        </>
      ) : null}
    </section>
  );
}
