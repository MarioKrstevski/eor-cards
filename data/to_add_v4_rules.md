# What to add from v4 to the existing rules (v1.1)
# These are sections/rules present in v4 that are missing from v1.1.
# Add these to the existing rule set in the dashboard.

---

## ADD 1 — Priority Order (add near the top, after the opening paragraph)

When rules conflict, apply them in the following priority order:
1. Content Integrity and Clinical Relevance Rules
2. Structural Orientation Rules
3. Cloze Construction Rules
4. Language and Formatting Rules

Medical accuracy and contextual clarity always take precedence over cloze formatting.

---

## ADD 2 — Completeness Statement (add near the top, after the opening instruction)

These cards are designed to fully replace the source study guide. Every piece of clinical information present in the source must be accounted for in the card output without exception. No detail, qualifier, mechanism, alternate name, or clinical nuance may be omitted on the grounds that it is secondary or not directly testable. The card deck must be complete enough that a student who studies only these cards has access to every piece of information contained in the original study guide, framed in a way that prepares them for EOR exam performance.

---

## ADD 3 — Source Conversion Rules (new section — for tables, diagrams, images)

When working from images (including tables, diagrams, flowcharts, or bullet hierarchies), first convert the visual layout into structured textual form while preserving all original medical content, relationships, and hierarchy exactly, without reproducing sentence-level phrasing verbatim. Interpret columns, rows, and spatial groupings as hierarchical or relational structure. Treat table headers as headings, row labels as subjects, and cell contents as dependent modifiers. Do not infer relationships beyond those visually indicated. Once converted to structured text, apply all granularity, bullet, and cloze rules as written.

---

## ADD 4 — Sibling Card Pattern (replaces/expands the bundling rule in v1.1)

When a list of items appears under a shared heading across all source formats including bulleted lists, numbered lists, table rows, and enumerated items embedded in prose, apply the following decision rule. When all items are bare labels without attached explanation content, bundle all items into a single card as a tightly linked clinical set using the same cloze index. When two or fewer items carry short qualifiers of three words or fewer and the combined card content produces no more than three cloze targets and remains scannable in a single pass, bundling is permitted. When items carry explanation content defined as any attached clause, sentence, sub-bullet, or qualifier of four or more words, apply the sibling card pattern.

The sibling card pattern applies only when items share the same conceptual category, meaning they are all treatment elements, all physical exam findings, all symptoms, all diagnostic steps, or all members of another single defined category. Two sentences appearing in the same bullet or paragraph do not qualify as parallel list members unless they belong to the same conceptual category. A standalone clinical finding, sign, named test result, or complication belongs to a different conceptual category than a treatment list and must always be generated as an independent card regardless of its proximity to other content in the source.

Under the sibling card pattern, generate one card per item. Every item in the set must appear as the active cloze target on its own dedicated card. No item may appear only in the footer without also having its own active card in the sibling set. The complete sibling set must contain exactly as many cards as there are items in the source list. When a single sentence contains multiple distinct items connected by logical connectors such as and or or, each item must be counted as a separate member of the sibling set and must receive its own dedicated active card. Do not treat a compound sentence as a single sibling set item.

The active card tests that item and its full explanation as the primary cloze target. All remaining items in the set with their full explanations exactly as present in the source are carried in the additional context field of every sibling card. This pattern applies universally to any list type under any heading regardless of content category, including symptoms, findings, risk factors, complications, diagnostic criteria, and management steps. When the source format is a table, treat each row with explanation content as an item and apply the sibling card pattern across rows.

The additional context field of every card in the sibling set must contain a labeled footer presenting all other items in the set with their full explanations exactly as present in the source, without summarizing, abbreviating, or omitting any content regardless of length. The footer label must be derived from the parent heading and must reflect the categorical identity of the list using language already present in the source (e.g., "Other symptoms:", "Other findings:", "Other risk factors:", "Other treatment elements:", "Other diagnostic criteria:"). Do not introduce label language that is not derivable from the source. The parent heading must appear as an explicit anchor in the stem of every sibling card. When a sibling set is derived from a sub-heading that itself falls under a higher parent heading, both the sub-heading and the higher parent heading must be present in the card stem when both contribute to the testable meaning of the card.

---

## ADD 5 — Language and Abbreviation Rules (new section)

Abbreviations may be expanded only when the expansion is a direct and exact equivalent of the original term; do not substitute or reinterpret terms in a way that changes meaning, category, or clinical context. Do not abbreviate common English words (e.g., years, with, without, before, after). Use standard medical abbreviations where appropriate. On first occurrence, present the full term followed by the abbreviation in parentheses; subsequent uses may use the abbreviation alone. Universally recognized medical abbreviations (e.g., CBC, BMP, ECG, EKG, CT, MRI) may be used without expansion. Do not introduce nonstandard, ambiguous, or uncommon abbreviations.

---

## ADD 6 — Source Attribution Removal Rule (new section)

Do not include, preserve, or reproduce any reference to source names, platforms, publishers, or third-party materials (e.g., Smartypance, UWorld, Rosh, etc.) in the output. This applies to headings, structural orientation labels, and inline text. Cards must be written as standalone clinical knowledge statements without attribution.

---

## ADD 7 — Third-Party Test Prep Source Rule (new section)

When content originates from third-party test preparation sources or includes instructional or conversational phrasing (e.g., think of, buzzwords, classic presentation), remove the instructional phrasing and re-express the content as a neutral, clinically structured statement. Preserve all underlying medical facts, mechanisms, relationships, and qualifiers exactly.

---

## ADD 8 — Style additions (add to existing Content Integrity / Style section)

Do not use em dashes (—) or double hyphens (--) anywhere in the output.

Do not make cards longer than necessary; maintain maximal concision while preserving full meaning and exam-relevant detail.

When applicable, cards should reflect clinical decision-making patterns (e.g., indications, contraindications, next steps, thresholds, or red-flag triggers) rather than isolated facts.

---

## CONFLICT — Wording preservation vs. rewording

v1.1 says: "Preserve the original wording exactly outside of inserting the cloze."
v4 says: "Rewording is expected and required to produce clean neutral clinical language."

These directly contradict. Decide which applies:
- If source materials are from commercial/copyrighted third-party prep (UWorld, Smartypance) → use v4's rewording rule
- If source materials are the client's own original notes → v1.1's preserve rule is safer for medical accuracy

Whichever you choose, remove the other from the final rule set.

---

## NOT NEEDED — Already in v1.1

- Mechanism splitting with examples ✓
- Symptom clusters bundling ✓
- Clinical decision trees ✓
- Tight cloze boundaries ✓
- Subject never clozed ✓
- Treatment cards split vs bundle ✓
- No duplicate cards ✓
- Validation checklist ✓
- 5-color styling system ✓
- Cloze numbering rule (card N uses cN) ✓
- Mental shortcut ✓
