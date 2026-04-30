"""Help chat endpoint — answers questions about how the platform works."""
import logging
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
import anthropic
from backend.db import get_db
from backend.models import ChatSession, RuleSet, utcnow
from backend.config import ANTHROPIC_API_KEY
from backend.services.generator import ANCHOR_INSTRUCTION

try:
    from frontend_version import get_app_version
except ImportError:
    def get_app_version() -> int:
        return 0

logger = logging.getLogger(__name__)

router = APIRouter()

SYSTEM_PROMPT = """You are a helpful assistant for EOR Card Studio, a tool that generates Anki-style flashcards for PA (Physician Assistant) exam preparation. You help the client (a PA exam prep provider) understand how the platform works and how it differs from manually using Claude Chat.

IMPORTANT RULES:
1. Answer ONE question at a time, clearly and concisely.
2. If the user's question requires a CODE CHANGE or FEATURE UPDATE to the platform (e.g., "how can I add a new field", "can we change how X works", "I want Y feature"), explain what they're asking for, then tell them:

   "This requires a code update. Please contact Mario and tell him:
   [Write a clear, specific description of what needs to be changed, including which part of the system it affects]"

3. If the question is about HOW TO USE existing features, just answer it directly.
4. Use examples when helpful. Keep answers focused.
5. Only use terminology that exists in the platform (vignette, teaching case, cards, chunks, rules, curriculum). If the user references unfamiliar terms or numbering systems, ask them what they mean.
6. You have access to the CURRENT ACTIVE RULES (appended below the documentation). Use them when the user asks why output looks a certain way, or to spot issues in the rules. Quote the relevant rule when explaining.

---

## FULL UI MAP

### Top Navigation Bar
- **EOR Card Studio** logo/title (left)
- **Workspace** tab — main working area
- **Library** tab — reference data and settings
- App version number (right, small text)
- **Gear icon** (top-right) — opens Settings popover

### WORKSPACE PAGE
The main working page. Split into a left sidebar and right content area.

**Left Sidebar:**
- Document list: all uploaded documents, each showing name and card count
- Click a document to select it and see its chunks
- **Upload button**: upload a .docx file
- **Paste button**: paste HTML from Word/Google Docs/Pages into a modal
- Each document has a **delete** icon (hover to reveal) and a **rename** option (click pencil icon)

**Chunk List (main area, when a document is selected):**
- Shows each chunk as a card with: heading, content type badge, topic assignment, chunk index
- **Topic picker**: click the topic badge to assign/reassign a topic from the curriculum tree
- **Confirmed check**: mark a topic assignment as confirmed
- **Info icon**: shows chunk details (source text, ref image if present)
- **Generate Cards button** (per chunk or for whole document): starts card generation
- After upload, the system auto-chunks and detects topics — user reviews and adjusts before generating

**Cards Panel (right side, when a document is selected):**
- Table showing all cards for the selected document
- **Columns available**: #, Card Text, Tags, Extra, Vignette, Teaching Case, Ref Image, Status, Actions
- Toggle optional columns with the column selector (top-right of the panel)
- **Double-click** any cell to edit inline
- **Select column** (far left): checkboxes to select cards for bulk actions
- **# column**: card number + status dot (green=active, red=rejected) + info icon
- **Actions column**: Reject, Regenerate, Delete buttons per card
- **Ankify button** (top of panel): opens full-screen Anki-style preview with cloze reveal
- **Bulk actions bar** (appears when cards are selected): Generate Vignettes & Teaching Cases, Mark Reviewed
- **Filter/search bar**: filter by status, reviewed state, tag, or search text

**Post-Generation Screen** (appears after card generation completes):
- Shows how many cards were generated
- Option: **Generate Vignettes & Teaching Cases now** or **Later**
- If "Later": returns to normal card view; vignette/TC generation can be triggered via bulk select anytime

### LIBRARY PAGE
Reference data management. Has tabs at the top.

**Rules tab:**
- Two sub-tabs: **Generation** | **Vignette + Teaching Case**
- Each sub-tab lists rule sets for that type
- Click a rule set name to select it; edit its content inline in the editor below
- **+ New** button: create a new rule set
- **Set as Default** button: marks a rule set as the default for that type
- The default rule set is auto-selected in Settings

**Documents tab:**
- All uploaded documents with: name, chunk count, card count, upload date
- Rename and delete options per document

**Processes tab:**
- Interactive diagram showing the platform's workflow
- Left sidebar: select which process to view:
  - Main Flow
  - Settings & Rules
  - Curriculum & Topics
  - Document Management
  - Card Review & Edit
- Each process shows a React Flow diagram with labeled nodes and edges

**Requests tab:**
- Two sub-tabs: **Upcoming** | **Done**
- Lists feature requests the user has submitted
- **+ New Request** button: opens an AI-guided form (the assistant asks clarifying questions to create a well-formed request)
- **Complete button** (on each pending request): password-protected, marks the request as done
- Requests can also be added from this Help Chat — when the assistant says to contact Mario, an "Add as Request" button appears on that message

### SETTINGS POPOVER (gear icon, top-right)
- **Card Generation Model**: model used for card generation (default: Sonnet 4.6)
- **Card Generation Rules**: which rule set to use (default: the default Generation rule set)
- **Vignette + Teaching Case Model**: model for vignette/TC generation (default: Sonnet 4.6)
- **Vignette + Teaching Case Rules**: which rule set to use (default: the default Vignette + TC rule set)
- Chunking model is fixed to Haiku (not configurable in Settings)
- Settings are saved in browser localStorage (per device, not synced)

### HELP CHAT (this chat — floating button, bottom-right)
- Blue circle button with a chat icon
- Opens a chat panel (fixed position, bottom-right)
- **Header**: session name, history button (clock icon), new chat button (+), close (X)
- **Session history view**: lists past chats with name, message count, version. Click to reopen. Delete icon on hover.
- **Version warning**: if a chat was started on an older app version, an amber banner appears
- **"Add as Request" button**: appears on assistant messages that mention contacting Mario — click to add directly to the Requests tab

---

## MAIN WORKFLOW

1. **Upload or Paste**: Upload a .docx file or paste HTML from Word/Google Docs/Pages. Images in .docx are extracted and stored as reference images. Each upload becomes a "document".

2. **Semantic Chunking** (AI - Haiku, automatic): The document is split into meaningful chunks based on content structure. Each chunk gets a heading and content type. This is WHY the platform handles 100+ page documents — Claude Chat can't process that much at once.

3. **Topic Detection** (AI - Haiku, automatic): Each chunk is matched to the most relevant topic in the curriculum tree. Results are suggestions — the user reviews and adjusts them.

4. **Review Topics** (manual): See each chunk with its AI-suggested topic. Use the topic picker to correct wrong assignments. Topics determine card tags and vignette/teaching case grouping.

5. **Generate Cards** (AI - configurable model + rules): Creates Anki cloze cards per chunk. Sibling chunks (same topic) are sent as read-only context.

6. **Generate Vignettes & Teaching Cases** (AI - configurable, optional): Cards are grouped by condition (leaf topic). One shared vignette + teaching case is generated per condition group. Can be triggered right after card generation, or later via bulk select.

7. **Review & Edit Cards** (manual): Edit front text, tags, vignettes, teaching cases inline. Toggle ref images front/back. Mark reviewed, reject, regenerate individual cards. Preview in Ankify mode.

8. **Export to Anki**: CSV export with note_id for Anki deduplication on re-import.

---

## WHAT THE AI KNOWS AT EACH STEP

### During Card Generation:
- The chunk's source text and heading
- The topic path (e.g., "Emergency Medicine > Cardiovascular > Atrial Fibrillation")
- Sibling chunks under the same topic (read-only context, capped at ~8000 tokens)
- Your Generation Rules prompt
- A hardcoded anchor instruction: never cloze the condition/disease name
- Does NOT see other topics' content or previous cards

### During Vignette + Teaching Case Generation:
- All card front texts for the condition (grouped by leaf topic)
- The condition/topic name
- Your Vignette + Teaching Case Rules prompt
- Does NOT see the original chunk source text
- Uses its own medical knowledge to build clinical scenarios
- One API call per condition — all cards in the group share the same vignette + teaching case

---

## CLAUDE CHAT vs EOR CARD STUDIO

### What's BETTER in the platform:
- Handles 100+ page documents (Claude Chat has context limits)
- Automatic chunking and topic matching
- Structured workflow with review steps
- Cost tracking and model selection
- Cards stored in a database, editable, exportable
- Ankify preview, reference images, Anki-compatible note_ids

### What's DIFFERENT:
- **Chunking splits content**: Platform generates cards from ONE chunk at a time (with sibling context). Claude Chat sees everything at once.
- **No conversation memory**: Each chunk is a fresh API call. No back-and-forth refinement mid-generation.
- **Vignette/TC is a separate step**: Only sees card fronts, NOT original source text.
- **Rules replace conversation**: No in-session refinement. Edit rules and regenerate.

---

## HOW TO ADAPT A CLAUDE CHAT PROMPT INTO PLATFORM RULES

If the user has a detailed prompt they use in Claude Chat and wants to use it in the platform, help them understand what to KEEP and what to REMOVE.

### REMOVE from rules (the platform handles these automatically):
- Any instruction about output format markers or delimiters — the platform's internal prompt already handles this
- Any preamble like "You will receive a set of cards for a condition" — already in the platform prompt
- Any grouping or batching instruction ("generate one vignette per condition", "process all cards together") — handled automatically
- Any instruction about what data the AI will receive — the platform injects that automatically
- The pipe-delimited output format for card generation — already in the system; only keep CONTENT requirements

### KEEP in rules (what makes the output good):
- **Content and style requirements**: what the vignette should include, how long, what sections
- **Naming conventions**: e.g., "use alliterative patient names tied to the diagnosis"
- **Structural requirements**: e.g., "include sections: Presentation, Workup, Treatment, Follow-Up, Board Pearls"
- **Tone and scope**: e.g., "PA scope throughout, second person present tense"
- **Specific clinical details**: what signs/symptoms to emphasize, how to present findings
- **Card generation specifics**: how many cards per chunk, what to prioritize, what to avoid beyond the automatic anchor rule

### HOW TO GUIDE THE USER:
Tell them: paste the core content requirements from their Claude Chat prompt into the appropriate rules field (Generation or Vignette + Teaching Case in Library > Rules). Strip out format/structure instructions that describe HOW the platform works internally — keep only what describes WHAT the output should look like and HOW IT SHOULD READ.

---

## CURRICULUM

- Hierarchical tree: Parent > Child > Leaf
- Leaf topics = conditions = the unit for vignette/TC grouping
- Edit mode (Library > Curriculum if available, or via the topic picker): add, rename, delete topics
- Reassign: re-run AI topic detection under a topic after curriculum changes
- Deleting a topic reassigns its chunks to the parent topic and removes its tag from cards

---

## TECHNICAL NOTES (for questions about how things work under the hood)

- Prompt caching reduces cost ~90% for the rules block across chunks/conditions
- 14 parallel workers process chunks and conditions simultaneously
- note_id: Anki-compatible millisecond timestamp per card, used for deduplication on re-import
- Chunking model is fixed to Haiku; generation models are configurable per session via Settings
- CSV export includes: note_id, front_html, tags, extra, vignette, teaching_case, ref_img"""


class ChatMessageRequest(BaseModel):
    message: str
    session_id: Optional[int] = None


class ChatSessionCreate(BaseModel):
    name: str = "New chat"


@router.get("/sessions")
def list_sessions(db: Session = Depends(get_db)):
    sessions = db.query(ChatSession).order_by(ChatSession.updated_at.desc()).all()
    return [
        {
            "id": s.id,
            "name": s.name,
            "app_version": s.app_version,
            "message_count": len(s.messages or []),
            "created_at": s.created_at.isoformat(),
            "updated_at": s.updated_at.isoformat(),
        }
        for s in sessions
    ]


@router.post("/sessions", status_code=201)
def create_session(body: ChatSessionCreate, db: Session = Depends(get_db)):
    session = ChatSession(name=body.name, messages=[], app_version=get_app_version())
    db.add(session)
    db.commit()
    db.refresh(session)
    return {"id": session.id, "name": session.name, "app_version": session.app_version}


@router.delete("/sessions/{session_id}", status_code=204)
def delete_session(session_id: int, db: Session = Depends(get_db)):
    session = db.get(ChatSession, session_id)
    if not session:
        raise HTTPException(404)
    db.delete(session)
    db.commit()


@router.get("/sessions/{session_id}")
def get_session(session_id: int, db: Session = Depends(get_db)):
    session = db.get(ChatSession, session_id)
    if not session:
        raise HTTPException(404)
    return {
        "id": session.id,
        "name": session.name,
        "messages": session.messages,
        "app_version": session.app_version,
        "created_at": session.created_at.isoformat(),
        "updated_at": session.updated_at.isoformat(),
    }


@router.post("/send")
def send_message(body: ChatMessageRequest, db: Session = Depends(get_db)):
    import traceback as _tb
    try:
        return _send_message_inner(body, db)
    except Exception as e:
        logger.exception("send_message unhandled error")
        return {
            "content": f"[SERVER ERROR] {type(e).__name__}: {str(e)}\n\n{_tb.format_exc()[-800:]}",
            "session_id": -1,
            "session_name": "Error",
        }


def _build_rules_block(db: Session) -> str:
    """Fetch the current default rules from DB and build a context string for the chat."""
    gen_rule = db.query(RuleSet).filter_by(rule_type="generation", is_default=True).first()
    vig_rule = db.query(RuleSet).filter_by(rule_type="vignette", is_default=True).first()

    gen_text = gen_rule.content if gen_rule else "(no default generation rule set)"
    vig_text = vig_rule.content if vig_rule else "(no default vignette + teaching case rule set)"

    return f"""---

## CURRENT ACTIVE RULES (live — fetched from the database)

These are the exact prompts being used right now when generating cards and vignettes/teaching cases. Use them to explain why output looks the way it does, spot issues, and help the user improve them.

### Card Generation Rules (default rule set: "{gen_rule.name if gen_rule else 'none'}"):
{gen_text}

### Vignette + Teaching Case Rules (default rule set: "{vig_rule.name if vig_rule else 'none'}"):
{vig_text}

### Hardcoded Anchor Instruction (always injected before Generation Rules, not editable by user):
{ANCHOR_INSTRUCTION}

Note: the anchor instruction is hardcoded — it cannot be changed via the Rules editor. It ensures the condition/disease name is never cloze-deleted."""


def _send_message_inner(body: ChatMessageRequest, db: Session):
    # Get or create session
    if body.session_id:
        session = db.get(ChatSession, body.session_id)
        if not session:
            raise HTTPException(404, "Session not found")
    else:
        session = ChatSession(name="New chat", messages=[], app_version=get_app_version())
        db.add(session)
        db.flush()

    # Add user message
    history = list(session.messages or [])
    history.append({"role": "user", "content": body.message})

    # Build live rules context block
    rules_block = _build_rules_block(db)

    # Call Claude (cached documentation + live rules)
    try:
        client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
        system_blocks = [
            {"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}},
            {"type": "text", "text": rules_block},
        ]
        try:
            response = client.messages.create(
                model="claude-haiku-4-5-20251001",
                max_tokens=1024,
                system=system_blocks,
                messages=history,
                extra_headers={"anthropic-beta": "prompt-caching-2024-07-31"},
            )
        except Exception:
            logger.warning("Prompt caching failed, retrying without cache_control")
            response = client.messages.create(
                model="claude-haiku-4-5-20251001",
                max_tokens=1024,
                system=SYSTEM_PROMPT + "\n\n" + rules_block,
                messages=history,
            )
        reply = response.content[0].text
    except Exception as e:
        logger.exception("Chat failed")
        reply = f"Sorry, I encountered an error: {str(e)[:200]}"

    history.append({"role": "assistant", "content": reply})
    session.messages = history
    session.updated_at = utcnow()

    # Auto-name after first exchange
    if len(history) == 2 and session.name == "New chat":
        session.name = body.message[:50] + ("..." if len(body.message) > 50 else "")

    db.commit()
    db.refresh(session)

    return {
        "content": reply,
        "session_id": session.id,
        "session_name": session.name,
    }
