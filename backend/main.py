import os
import time
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from backend.db import engine, Base
from backend.routers import documents, cards, generate, curriculum, rules, export, usage, chat
from backend import models  # noqa

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")


def _run_migrations():
    from sqlalchemy import text, inspect as sa_inspect
    insp = sa_inspect(engine)
    cols = [c['name'] for c in insp.get_columns('cards')]
    with engine.connect() as conn:
        if 'is_reviewed' not in cols:
            conn.execute(text("ALTER TABLE cards ADD COLUMN is_reviewed BOOLEAN NOT NULL DEFAULT 0"))
            conn.commit()
        if 'vignette' not in cols:
            conn.execute(text("ALTER TABLE cards ADD COLUMN vignette TEXT"))
            conn.commit()
        if 'teaching_case' not in cols:
            conn.execute(text("ALTER TABLE cards ADD COLUMN teaching_case TEXT"))
            conn.commit()

        # v4 columns
        _add_col_if_missing(conn, insp, "rule_sets", "rule_type", "VARCHAR(20) DEFAULT 'generation'")
        _add_col_if_missing(conn, insp, "chunks", "ref_img", "TEXT")
        _add_col_if_missing(conn, insp, "cards", "ref_img", "TEXT")
        _add_col_if_missing(conn, insp, "cards", "ref_img_position", "VARCHAR(10) DEFAULT 'front'")
        _add_col_if_missing(conn, insp, "cards", "note_id", "BIGINT")
        _add_col_if_missing(conn, insp, "generation_jobs", "job_type", "VARCHAR(20) DEFAULT 'cards'")

        # Backfill note_id for existing cards
        cursor = conn.execute(text("SELECT id FROM cards WHERE note_id IS NULL ORDER BY created_at, id"))
        rows = cursor.fetchall()
        if rows:
            base_ts = int(time.time() * 1000) - len(rows)
            for i, row in enumerate(rows):
                conn.execute(text("UPDATE cards SET note_id = :nid WHERE id = :cid"), {"nid": base_ts + i, "cid": row[0]})
            conn.commit()


def _add_col_if_missing(conn, insp, table, column, col_def):
    from sqlalchemy import text
    cols = [c['name'] for c in insp.get_columns(table)]
    if column not in cols:
        conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {col_def}"))
        conn.commit()


def seed_data():
    from sqlalchemy.orm import Session
    from backend.config import DATA_DIR
    from backend.models import RuleSet
    with Session(engine) as db:
        if db.query(RuleSet).filter_by(rule_type="generation").count() == 0:
            rules_path = os.path.join(DATA_DIR, "ai-rules.md")
            if os.path.exists(rules_path):
                with open(rules_path) as f:
                    content = f.read()
                db.add(RuleSet(name="Default (ai-rules v1.1)", rule_type="generation", content=content, is_default=True))
                db.commit()

        if not db.query(RuleSet).filter_by(rule_type="vignette").first():
            db.add(RuleSet(
                name="Default Vignette + Teaching Case Rules",
                rule_type="vignette",
                content="""You will receive a set of finished Anki cloze cards for a single condition. Generate both a clinical vignette (COLUMN 5) and a teaching case (COLUMN 6) for this condition.

For COLUMN 5 (Vignette): Write a 4-6 sentence clinical vignette that serves as a memorable anchor. Begin with a patient presentation using a memorable alliterative name tied to the diagnosis. Include hallmark signs, symptoms, and a key diagnostic finding. End with a clinical decision-making pearl.

For COLUMN 6 (Teaching Case): Write a comprehensive clinical teaching case using the same patient name. Include sections: Patient Presentation, Physical Examination, Workup and Diagnosis, Treatment, Follow Up and Monitoring, and PA EOR Board Pearls (5-8 numbered items).

STYLE: Second person present tense. Bold key clinical terms using <b> tags. Use <br> for line breaks. Do NOT use markdown. PA scope throughout.""",
                is_default=True,
            ))
        db.commit()

        if db.query(models.Curriculum).count() == 0:
            import json
            curr_path = os.path.join(DATA_DIR, "curriculum.json")
            if os.path.exists(curr_path):
                with open(curr_path) as f:
                    tree = json.load(f)
                _seed_curriculum(db, tree, parent_id=None, level=0, parent_path="")
                db.commit()

def _seed_curriculum(db, nodes, parent_id, level, parent_path):
    from backend.models import Curriculum
    for node in nodes:
        path = f"{parent_path} > {node['name']}" if parent_path else node["name"]
        c = Curriculum(parent_id=parent_id, name=node["name"], level=level, path=path)
        db.add(c)
        db.flush()
        if node.get("children"):
            _seed_curriculum(db, node["children"], c.id, level + 1, path)


@asynccontextmanager
async def lifespan(app: FastAPI):
    os.makedirs(os.path.join(os.path.dirname(__file__), "..", "data", "uploads"), exist_ok=True)
    Base.metadata.create_all(bind=engine)
    _run_migrations()
    seed_data()
    yield

app = FastAPI(title="EOR Card Studio", lifespan=lifespan)

app.include_router(documents.router, prefix="/api/documents", tags=["documents"])
app.include_router(cards.router, prefix="/api/cards", tags=["cards"])
app.include_router(generate.router, prefix="/api/generate", tags=["generate"])
app.include_router(curriculum.router, prefix="/api/curriculum", tags=["curriculum"])
app.include_router(rules.router, prefix="/api/rules", tags=["rules"])
app.include_router(export.router, prefix="/api/export", tags=["export"])
app.include_router(usage.router, prefix="/api/usage", tags=["usage"])
app.include_router(chat.router, prefix="/api/chat", tags=["chat"])

if os.path.exists(STATIC_DIR) and os.listdir(STATIC_DIR):
    app.mount("/assets", StaticFiles(directory=os.path.join(STATIC_DIR, "assets")), name="assets")

    @app.get("/{full_path:path}")
    async def spa_fallback(full_path: str):
        if full_path.startswith("api/"):
            raise HTTPException(status_code=404)
        return FileResponse(os.path.join(STATIC_DIR, "index.html"))
