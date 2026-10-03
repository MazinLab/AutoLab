"""Result summaries: results on analyses, membership edges, the table endpoint."""

from __future__ import annotations

from fastapi.testclient import TestClient


def _project(client: TestClient, name: str = "Air Bridge") -> dict:
    return client.post("/api/project", json={"name": name}).json()


def _analysis(client: TestClient, project: dict, name: str, results: dict, **fields) -> dict:
    response = client.post(
        "/api/analysis_run",
        json={"name": name, "project_id": project["id"], "results": results, **fields},
    )
    assert response.status_code == 201, response.text
    return response.json()


def _summary(client: TestClient, name: str = "TLS noise", **fields) -> dict:
    response = client.post("/api/result_summary", json={"name": name, **fields})
    assert response.status_code == 201, response.text
    return response.json()


def _join(client: TestClient, analysis: dict, summary: dict) -> None:
    response = client.post(
        "/api/edges",
        json={"src_id": analysis["id"], "relation": "refers_to", "dst_id": summary["id"]},
    )
    assert response.status_code in (200, 201), response.text


def test_result_summary_is_an_entity_with_rs_accession(client: TestClient) -> None:
    summary = _summary(client, body="Meta-analysis notes")
    assert summary["accession"].startswith("RS-")
    assert summary["columns"] == []
    fetched = client.get(f"/api/result_summary/{summary['id']}").json()
    assert fetched["body"] == "Meta-analysis notes"
    schema = client.get("/api/schema").json()
    assert "columns" in schema["entity_types"]["result_summary"]["properties"]
    assert "results" in schema["entity_types"]["analysis_run"]["properties"]


def test_analysis_results_are_a_typed_column(client: TestClient) -> None:
    project = _project(client)
    analysis = _analysis(client, project, "Fit 1", {"tls_noise_1khz_hz2": 3.2e-17, "base_temp_mk": 100})
    fetched = client.get(f"/api/analysis_run/{analysis['id']}").json()
    assert fetched["results"] == {"tls_noise_1khz_hz2": 3.2e-17, "base_temp_mk": 100}
    assert "results" not in fetched["extra"]


def test_invalid_results_are_rejected(client: TestClient) -> None:
    project = _project(client)
    bad = [
        {"nested": {"a": 1}},
        {"flag": True},
        {"has space": 1},
        {"trailing\n": 1},
        {"": 1},
        ["not", "a", "map"],
    ]
    for results in bad:
        response = client.post(
            "/api/analysis_run",
            json={"name": "Bad", "project_id": project["id"], "results": results},
        )
        assert response.status_code == 422, results
    # Python's JSON parser turns 1e400 into inf, which no JSON encoder can emit back.
    response = client.post(
        "/api/analysis_run",
        content='{"name": "Bad", "results": {"q_i": 1e400}}',
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 422, response.text
    analysis = _analysis(client, project, "Good", {"q_i": 1.5e6})
    response = client.patch(
        f"/api/analysis_run/{analysis['id']}",
        json={"results": {"q_i": {"oops": 1}}},
    )
    assert response.status_code == 422


def test_invalid_columns_are_rejected(client: TestClient) -> None:
    summary = _summary(client)
    for columns in [
        {"key": "x"},
        [{"label": "no key"}],
        [{"key": "a", "label": "A"}, {"key": "a", "label": "again"}],
        [{"key": "a", "label": 3}],
    ]:
        response = client.patch(f"/api/result_summary/{summary['id']}", json={"columns": columns})
        assert response.status_code == 422, columns
    ok = client.patch(
        f"/api/result_summary/{summary['id']}",
        json={"columns": [{"key": "q_i", "label": "Qi"}, {"key": "t_mk"}]},
    )
    assert ok.status_code == 200
    assert ok.json()["columns"] == [{"key": "q_i", "label": "Qi"}, {"key": "t_mk", "label": ""}]


def test_table_endpoint_joins_members_and_is_idempotent(client: TestClient) -> None:
    alpha = _project(client, "Alpha")
    beta = _project(client, "Beta")
    summary = _summary(client)
    a = _analysis(client, alpha, "A", {"q_i": 1.0, "t_mk": 100})
    b = _analysis(client, beta, "B", {"t_mk": 120})
    _join(client, a, summary)
    _join(client, a, summary)  # duplicate membership is a no-op
    _join(client, b, summary)
    table = client.get(f"/api/result_summary/{summary['id']}/table")
    assert table.status_code == 200, table.text
    body = table.json()
    assert body["keys"] == ["q_i", "t_mk"]
    assert [r["analysis"]["accession"] for r in body["rows"]] == [a["accession"], b["accession"]]
    assert [r["project"]["name"] for r in body["rows"]] == ["Alpha", "Beta"]
    assert body["rows"][0]["analysis"]["created_at"].endswith("Z")
    # Removing the edge removes the row.
    removed = client.delete(
        "/api/edges",
        params={"src_id": a["id"], "relation": "refers_to", "dst_id": summary["id"]},
    )
    assert removed.status_code in (200, 204), removed.text
    remaining = client.get(f"/api/result_summary/{summary['id']}/table").json()["rows"]
    assert [r["analysis"]["name"] for r in remaining] == ["B"]


def test_table_endpoint_404s_for_other_types_and_keeps_generic_route(client: TestClient) -> None:
    wafer = client.post("/api/wafer", json={"name": "W"}).json()
    assert client.get(f"/api/result_summary/{wafer['id']}/table").status_code == 404
    summary = _summary(client)
    assert client.get(f"/api/result_summary/{summary['id']}").status_code == 200
