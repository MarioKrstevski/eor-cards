from backend.services.generator import strip_card_html, extract_cloze_terms, parse_card_output

def test_strip_card_html():
    html = '<b><span style="color:#d62728;">{{c1::AFib}}</span></b> is caused by {{c1::reentry}}.'
    result = strip_card_html(html)
    assert result == "AFib is caused by reentry."

def test_extract_cloze_terms():
    html = '{{c1::AFib}} leads to {{c1::tachycardia}}.'
    terms = extract_cloze_terms(html)
    assert terms == ["AFib", "tachycardia"]

def test_parse_card_output_detects_needs_review():
    raw = "1|Card one text\n2|Card two text\nNEEDS_REVIEW"
    cards, needs_review = parse_card_output(raw)
    assert len(cards) == 2
    assert needs_review is True

def test_parse_card_output_normal():
    raw = "1|First card\n2|Second card"
    cards, needs_review = parse_card_output(raw)
    assert len(cards) == 2
    assert needs_review is False
