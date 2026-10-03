import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { ApiError, resolveAccession } from "../../api/client";
import { entityRoute } from "../entity/entityRoute";

type ResolverState = "loading" | "not-found" | "error";

export function AccessionResolverPage() {
  const { accession } = useParams();
  const navigate = useNavigate();
  const [state, setState] = useState<ResolverState>("loading");

  useEffect(() => {
    if (!accession) {
      setState("not-found");
      return;
    }
    let isCurrent = true;
    setState("loading");
    resolveAccession(accession)
      .then(({ data }) => {
        if (isCurrent) {
          navigate(entityRoute(data.id), {
            replace: true,
            state: { entity: data },
          });
        }
      })
      .catch((error: unknown) => {
        if (!isCurrent) {
          return;
        }
        setState(error instanceof ApiError && error.status === 404 ? "not-found" : "error");
      });
    return () => {
      isCurrent = false;
    };
  }, [accession, navigate]);

  return (
    <section className="page-panel">
      <p className="eyebrow">Accession resolver</p>
      {state === "loading" ? (
        <>
          <h1>Opening record</h1>
          <p className="lede">Resolving {accession ?? "this accession"}…</p>
        </>
      ) : null}
      {state === "not-found" ? (
        <>
          <h1>Record not found</h1>
          <p className="lede">
            No AutoLab entity has accession {accession ?? "in this link"}.
          </p>
        </>
      ) : null}
      {state === "error" ? (
        <>
          <h1>Could not open record</h1>
          <p className="lede">The resolver is unavailable. Try again shortly.</p>
        </>
      ) : null}
    </section>
  );
}
