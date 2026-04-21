# tests/test_cards_router.py


def test_list_cards_empty(client):
    r = client.get("/api/cards")
    assert r.status_code == 200
    assert r.json() == []


def test_list_cards_includes_topic_path(client, seeded_card):
    r = client.get("/api/cards")
    assert r.status_code == 200
    cards = r.json()
    assert len(cards) == 1
    assert "topic_path" in cards[0]
    assert cards[0]["topic_path"] == "Root"


def test_reject_card(client, seeded_card):
    r = client.post(f"/api/cards/{seeded_card['id']}/reject")
    assert r.status_code == 200
    assert r.json()["status"] == "rejected"


def test_patch_card_updates_front_text(client, seeded_card):
    new_html = "{{c1::AFib}} causes tachycardia."
    r = client.patch(f"/api/cards/{seeded_card['id']}",
                     json={"front_html": new_html})
    assert r.status_code == 200
    assert r.json()["front_text"] == "AFib causes tachycardia."
