"""Help chat endpoint — answers questions about how the platform works."""
import logging
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
import anthropic
from backend.db import get_db
from backend.models import ChatSession, utcnow
from backend.config import ANTHROPIC_API_KEY

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

## MAIN WORKFLOW

1. **Upload or Paste**: Upload a .docx file or paste HTML from Word/Google Docs/Pages. Images are extracted from .docx and stored as base64. Each upload becomes a "document" in the system.

2. **Semantic Chunking** (AI - Haiku, automatic): The document is split into meaningful chunks based on content structure. Each chunk gets a heading and content type. This step is WHY we can handle 100+ page documents — Claude Chat can't process that much at once.

3. **Topic Detection** (AI - Haiku, automatic): Each chunk is matched to the most relevant topic in the curriculum tree. Results are suggestions — the user reviews and adjusts them.

4. **Review Topics** (manual): See each chunk with its AI-suggested topic. Use the topic picker to adjust wrong assignments. Topics determine card tags and vignette/teaching case grouping.

5. **Generate Cards** (AI - configurable): Click "Generate now" to create Anki cloze cards. Or click "Later" to generate anytime from the document view.

6. **Generate Vignettes & Teaching Cases** (AI - configurable, optional): After card generation, optionally generate vignettes + teaching cases. Cards are grouped by condition (leaf topic). One shared vignette + teaching case per condition group. Can also be triggered later from the cards table.

7. **Review & Edit Cards** (manual): Edit front text, tags, vignettes, teaching cases inline. Toggle ref images. Mark reviewed, reject, regenerate individual cards. Preview in Ankify mode.

8. **Export to Anki**: CSV export with note_id for Anki deduplication on re-import.

## WHAT THE AI KNOWS AT EACH STEP

### During Card Generation:
- The chunk's source text and heading
- The topic path (e.g., "Emergency Medicine > Cardiovascular > Atrial Fibrillation")
- Sibling chunks under the same topic (read-only context, capped at ~8000 tokens)
- Your Generation Rules prompt
- A hardcoded anchor instruction: "never cloze the condition/disease name"
- It does NOT see other topics' content or previous cards

### During Vignette + Teaching Case Generation:
- All card front texts for the condition (grouped by leaf topic)
- The condition/topic name
- Your Vignette + Teaching Case Rules prompt
- It does NOT see the original chunk source text
- It uses its own medical knowledge to create clinical scenarios
- One API call per condition group — all cards in the group get identical vignette + teaching case

## CLAUDE CHAT vs EOR CARD STUDIO — KEY DIFFERENCES

### What's BETTER in the platform:
- Can handle 100+ page documents (Claude Chat has context limits)
- Automatic chunking and topic matching
- Structured workflow with review steps
- Cost tracking and model selection
- Cards stored in a database, editable, exportable
- Ankify preview mode, reference images, Anki-compatible note_ids

### What's DIFFERENT (may affect output):
- **Chunking splits content**: In Claude Chat, you paste everything at once. The platform splits into chunks first. The AI generates cards from ONE chunk at a time (with sibling context).
- **No conversation memory**: Claude Chat remembers the conversation. The platform sends each chunk as a fresh API call.
- **Vignette/TC generation is separate**: Card generation and vignette/TC generation are separate steps. The vignette/TC step only sees card fronts, NOT original source text.
- **Rules are fixed per generation**: No conversational refinement. Edit the rules prompt or regenerate with guidance.

### What to tell the client:
- The rules prompt is CRITICAL — it replaces the conversational guidance you give in Claude Chat
- If output quality differs from Claude Chat, the rules probably need adjustment
- Upload documents topic-by-topic for best results
- Vignettes and teaching cases are SHARED per condition

## SETTINGS & RULES

### Settings (gear icon, top-right):
- **Card Generation Model**: Default Sonnet
- **Vignette + Teaching Case Model**: Default Sonnet
- **Card Generation Rules**: Prompt template for cards
- **Vignette + TC Rules**: Prompt template for supplemental
- Chunking is fixed to Haiku

### Rules (Library > Rules):
- Two tabs: **Generation** and **Vignette + Teaching Case**
- Create multiple rule sets, set one as default per type
- Click a rule to edit inline. Create new with "+ New"

## CURRICULUM & TOPICS

- Hierarchical tree: Parent > Child > Leaf
- Leaf topics = conditions = vignette/TC grouping
- Edit mode: add, rename, delete topics
- Reassign: re-run AI topic detection under a topic
- Deleting a topic reassigns chunks to parent, removes tag from cards

## DOCUMENT MANAGEMENT

- Library > Documents: all docs with chunk/card counts
- Workspace sidebar: select docs, browse chunks
- Rename, delete documents

## CARD REVIEW

- Toggle optional columns: Ref Image, Vignette, Teaching Case
- Double-click to edit cells inline
- Ref images: toggle Front/Back per card
- Ankify: full-screen preview with cloze reveal
- Bulk: select cards → Generate Vignettes & Cases or Mark Reviewed

## EXACT API PROMPT STRUCTURE

### Card Generation prompt per chunk:
```
[Cached block]:
{ANCHOR_INSTRUCTION}
{USER'S GENERATION RULES}
---

[Chunk block]:
Now generate cards from the following study note content.
Curriculum context: {topic_path}
Section: {heading}
Source text: {chunk_text}
--- RELATED CONTENT (context only) ---
{sibling_chunks_text}
Generate cards in format: number|cloze card text
```

### Vignette + Teaching Case prompt per condition:
```
[Cached block]:
{FORMATTING_INSTRUCTION}
{USER'S VIGNETTE + TC RULES}

[Cards block]:
Condition: {leaf_topic_name}
Cards: Card 1: {text}, Card 2: {text}, ...
Generate vignette and teaching case.
Output: ===VIGNETTE=== ... ===TEACHING_CASE=== ...
```

Technical: prompt caching reduces cost ~90% for rules across chunks. 14 parallel workers process chunks/conditions simultaneously."""


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
    from frontend_version import get_app_version
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
    from frontend_version import get_app_version

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
    messages = list(session.messages or [])
    messages.append({"role": "user", "content": body.message})

    # Call Claude
    try:
        client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
        response = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=1024,
            system=SYSTEM_PROMPT,
            messages=messages,
        )
        reply = response.content[0].text
    except Exception as e:
        logger.exception("Chat failed")
        reply = f"Sorry, I encountered an error: {str(e)[:200]}"

    # Add assistant reply
    messages.append({"role": "assistant", "content": reply})
    session.messages = messages
    session.updated_at = utcnow()

    # Auto-name after first exchange
    if len(messages) == 2 and session.name == "New chat":
        # Use first ~50 chars of user message as name
        session.name = body.message[:50] + ("..." if len(body.message) > 50 else "")

    db.commit()
    db.refresh(session)

    return {
        "content": reply,
        "session_id": session.id,
        "session_name": session.name,
    }
