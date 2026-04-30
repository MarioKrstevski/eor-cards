import os
import time
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from backend.db import engine, Base
from backend.routers import documents, cards, generate, curriculum, rules, export, usage, chat, requests
from backend import models  # noqa

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")

SURGERY_CURRICULUM = [{"name":"Surgery","children":[{"name":"Gastrointestinal","children":[{"name":"Gastrointestinal diagnoses","children":[{"name":"Anal disorders","children":[]},{"name":"Appendicitis","children":[]},{"name":"Bowel obstruction","children":[]},{"name":"Cholecystitis/cholelithiasis","children":[]},{"name":"Diverticulitis","children":[]},{"name":"Gastrointestinal bleeding","children":[]},{"name":"Hiatal hernia","children":[]},{"name":"Ileus","children":[]},{"name":"Inflammatory bowel disease","children":[]},{"name":"Malignancy of the gastrointestinal tract","children":[]},{"name":"Obesity","children":[]},{"name":"Pancreatitis","children":[]},{"name":"Peritonitis","children":[]},{"name":"Toxic megacolon","children":[]},{"name":"Perioperative gastrointestinal risk assessment and complications","children":[]}]},{"name":"Gastrointestinal procedures","children":[{"name":"Abdominal drains","children":[]},{"name":"Colonoscopy","children":[]},{"name":"Endoscopic retrograde cholangiopancreatography","children":[]},{"name":"Endoscopy","children":[]},{"name":"Ileostomy","children":[]},{"name":"Nasogastric tubes","children":[]},{"name":"Parenteral nutrition","children":[]},{"name":"Percutaneous endoscopic gastronomy tube","children":[]}]}]},{"name":"Cardiovascular","children":[{"name":"Cardiovascular diagnoses","children":[{"name":"Acute arterial occlusion","children":[]},{"name":"Aortic aneurysm","children":[]},{"name":"Aortic dissection","children":[]},{"name":"Chronic arterial insufficiency","children":[]},{"name":"Chronic venous insufficiency","children":[]},{"name":"Compartment syndrome","children":[]},{"name":"Coronary artery disease","children":[]},{"name":"Carotid artery stenosis","children":[]},{"name":"Intestinal ischemia","children":[]},{"name":"Renal vascular disease","children":[]},{"name":"Valvular heart disease","children":[]},{"name":"Varicose veins","children":[]},{"name":"Perioperative cardiovascular risk assessment and complications","children":[]}]},{"name":"Cardiovascular procedures","children":[{"name":"Advanced cardiac life support","children":[]},{"name":"Arteriovenous fistula placement","children":[]},{"name":"Central line placement","children":[]},{"name":"Permacath/port placement","children":[]},{"name":"Vascular access","children":[]}]}]},{"name":"Pulmonary/Thoracic Surgery","children":[{"name":"Pulmonary/thoracic surgery diagnoses","children":[{"name":"Chylothorax","children":[]},{"name":"Empyema","children":[]},{"name":"Hemothorax","children":[]},{"name":"Lung malignancy","children":[]},{"name":"Mediastinal disorders","children":[]},{"name":"Pleural effusion","children":[]},{"name":"Pneumothorax","children":[]},{"name":"Pulmonary nodule","children":[]},{"name":"Perioperative pulmonary/thoracic surgery risk assessment and complications","children":[]}]},{"name":"Pulmonary/thoracic surgery procedures","children":[{"name":"Chest tube","children":[]},{"name":"Thoracentesis","children":[]}]}]},{"name":"Breast Surgery","children":[{"name":"Breast surgery diagnoses","children":[{"name":"Breast abscess","children":[]},{"name":"Benign breast disease","children":[]},{"name":"Carcinoma of the female breast","children":[]},{"name":"Carcinoma of the male breast","children":[]},{"name":"Disorders of the augmented breast","children":[]},{"name":"Fat necrosis","children":[]},{"name":"Mastitis","children":[]},{"name":"Phyllodes tumor","children":[]},{"name":"Perioperative breast surgery risk assessment and complications","children":[]}]},{"name":"Breast surgery procedures","children":[{"name":"Biopsy","children":[]}]}]},{"name":"Dermatologic","children":[{"name":"Dermatologic diagnoses","children":[{"name":"Burns","children":[]},{"name":"Cellulitis","children":[]},{"name":"Dermatologic neoplasms","children":[]},{"name":"Epidermal inclusion cyst","children":[]},{"name":"Hidradenitis suppurativa","children":[]},{"name":"Lipoma","children":[]},{"name":"Pressure ulcer","children":[]},{"name":"Perioperative dermatologic risk assessment and complications","children":[]}]},{"name":"Dermatologic procedures","children":[{"name":"Aspiration of seroma/hematoma","children":[]},{"name":"Incision and drainage of abscess","children":[]},{"name":"Skin biopsy","children":[]},{"name":"Skin graft and flap","children":[]},{"name":"Suturing","children":[]}]}]},{"name":"Renal/Genitourinary","children":[{"name":"Renal/genitourinary diagnoses","children":[{"name":"Benign prostatic hyperplasia","children":[]},{"name":"Nephrolithiasis","children":[]},{"name":"Paraphimosis/phimosis","children":[]},{"name":"Testicular torsion","children":[]},{"name":"Urethral stricture","children":[]},{"name":"Urologic/renal neoplasms","children":[]},{"name":"Perioperative renal/genitourinary risk assessment and complications","children":[]}]},{"name":"Renal/genitourinary procedures","children":[{"name":"Lithotripsy","children":[]},{"name":"Urinary catheterization","children":[]},{"name":"Vasectomy","children":[]}]}]},{"name":"Trauma/Acute Care","children":[{"name":"Trauma/acute care diagnoses","children":[{"name":"Acute abdomen","children":[]},{"name":"Alteration in consciousness","children":[]},{"name":"Compound fractures","children":[]},{"name":"Shock","children":[]},{"name":"Perioperative trauma/acute care risk assessment and complications","children":[]}]},{"name":"Trauma/acute care procedures","children":[{"name":"Transfusion","children":[]}]}]},{"name":"Neurologic/Neurosurgery","children":[{"name":"Neurologic/neurosurgery diagnoses","children":[{"name":"Carpal tunnel syndrome","children":[]},{"name":"Epidural hematoma","children":[]},{"name":"Neurologic neoplasms","children":[]},{"name":"Subarachnoid hemorrhage","children":[]},{"name":"Perioperative neurologic/neurosurgery risk assessment and complications","children":[]}]},{"name":"Neurologic/neurosurgery procedures","children":[{"name":"Lumbar puncture","children":[]}]}]},{"name":"Pain Medicine/Anesthesia","children":[{"name":"Pain medicine/anesthesia diagnoses","children":[{"name":"Acute pain","children":[]},{"name":"Chronic pain","children":[]},{"name":"Substance use disorder","children":[]},{"name":"Perioperative pain medicine/anesthesia risk assessment and complications","children":[]}]},{"name":"Pain medicine/anesthesia procedures","children":[{"name":"Endotracheal intubation","children":[]},{"name":"Intravenous line placement","children":[]},{"name":"Local and regional anesthesia","children":[]}]}]},{"name":"Endocrine","children":[{"name":"Endocrine diagnoses","children":[{"name":"Adrenal disorders","children":[]},{"name":"Endocrine neoplasms","children":[]},{"name":"Parathyroid disorders","children":[]},{"name":"Pituitary disorders","children":[]},{"name":"Thyroid disorders","children":[]},{"name":"Perioperative endocrine risk assessment and complications","children":[]}]},{"name":"Endocrine procedures","children":[{"name":"Fine needle biopsy","children":[]}]}]}]}]


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

        # v5 columns
        _add_col_if_missing(conn, insp, "chat_sessions", "app_version", "INTEGER DEFAULT 0")
        _add_col_if_missing(conn, insp, "chat_sessions", "updated_at", "DATETIME")
        _add_col_if_missing(conn, insp, "feature_requests", "app_version", "INTEGER DEFAULT 0")
        _add_col_if_missing(conn, insp, "feature_requests", "completed_at", "DATETIME")

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

        # Seed Surgery curriculum if not already present
        if not db.query(models.Curriculum).filter_by(name="Surgery", parent_id=None).first():
            _seed_curriculum(db, SURGERY_CURRICULUM, parent_id=None, level=0, parent_path="")
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
app.include_router(requests.router, prefix="/api/requests", tags=["requests"])

if os.path.exists(STATIC_DIR) and os.listdir(STATIC_DIR):
    app.mount("/assets", StaticFiles(directory=os.path.join(STATIC_DIR, "assets")), name="assets")

    @app.get("/{full_path:path}")
    async def spa_fallback(full_path: str):
        if full_path.startswith("api/"):
            raise HTTPException(status_code=404)
        return FileResponse(os.path.join(STATIC_DIR, "index.html"))
