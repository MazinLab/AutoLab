from fastapi.testclient import TestClient


def test_search_orders_each_entity_type_before_limiting(
    client: TestClient,
) -> None:
    client.post("/api/wafer", json={"name": "zeta shared wafer"})
    client.post("/api/wafer", json={"name": "alpha shared wafer"})

    hits = client.get(
        "/api/search",
        params={"q": "shared wafer", "limit": 1},
    ).json()

    assert len(hits) == 1
    assert hits[0]["entity_type"] == "wafer"
    assert hits[0]["name"] == "alpha shared wafer"
