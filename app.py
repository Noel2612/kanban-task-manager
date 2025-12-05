import sqlite3
import uuid
import json
from flask import Flask, g, jsonify, request, send_from_directory, render_template
from flask_cors import CORS
from pathlib import Path
import datetime

DB_PATH = Path(__file__).with_name("kanban.db")

app = Flask(__name__, static_folder='static', template_folder='templates')
CORS(app)

def get_db():
    db = getattr(g, "_database", None)
    if db is None:
        db = g._database = sqlite3.connect(str(DB_PATH))
        db.row_factory = sqlite3.Row
    return db

def init_db():
    conn = get_db()
    cur = conn.cursor()
    cur.execute("""
    CREATE TABLE IF NOT EXISTS cards (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL,
        priority TEXT,
        tags TEXT,
        created_at TEXT,
        due_date TEXT,
        order_idx INTEGER
    )""")
    conn.commit()

def setup_once():
    init_db()
    cur = get_db().cursor()
    cur.execute("SELECT COUNT(1) as c FROM cards")
    if cur.fetchone()["c"] == 0:
        sample = [
            {"title":"Finish lab report","description":"Add graphs and references","status":"todo","priority":"high","tags":"study,lab","order_idx":1},
            {"title":"Prepare slides","description":"Slides for presentation","status":"in-progress","priority":"medium","tags":"presentation","order_idx":1},
            {"title":"Submit assignment","description":"Upload to portal","status":"done","priority":"low","tags":"submission","order_idx":1}
        ]
        for c in sample:
            add_card_to_db(c)
        get_db().commit()

def add_card_to_db(data):
    conn = get_db()
    cur = conn.cursor()
    card_id = data.get("id", str(uuid.uuid4()))
    now = datetime.datetime.utcnow().isoformat()
    cur.execute("""
        INSERT INTO cards (id, title, description, status, priority, tags, created_at, due_date, order_idx)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (card_id, data.get("title"), data.get("description",""), data.get("status","todo"),
          data.get("priority","medium"), data.get("tags",""), now, data.get("due_date",""), data.get("order_idx", 0)))
    return card_id

def row_to_dict(row):
    d = dict(row)
    # tags stored as comma-separated string
    d["tags"] = d.get("tags","").split(",") if d.get("tags") else []
    return d

# Serve main page
@app.route("/")
def index():
    return render_template("index.html")

# API endpoints
@app.route("/api/cards", methods=["GET"])
def get_cards():
    cur = get_db().cursor()
    cur.execute("SELECT * FROM cards ORDER BY status, order_idx")
    rows = cur.fetchall()
    cards = [row_to_dict(r) for r in rows]
    return jsonify(cards)

@app.route("/api/card", methods=["POST"])
def create_card():
    payload = request.json or {}
    payload["status"] = payload.get("status","todo")
    # find max order in that column
    cur = get_db().cursor()
    cur.execute("SELECT COALESCE(MAX(order_idx), 0) as m FROM cards WHERE status=?", (payload["status"],))
    m = cur.fetchone()["m"] or 0
    payload["order_idx"] = m + 1
    card_id = add_card_to_db(payload)
    get_db().commit()
    cur = get_db().cursor()
    cur.execute("SELECT * FROM cards WHERE id=?", (card_id,))
    return jsonify(row_to_dict(cur.fetchone())), 201

@app.route("/api/card/<card_id>", methods=["PATCH"])
def update_card(card_id):
    payload = request.json or {}
    cur = get_db().cursor()
    # apply simple updateable fields
    allowed = ["title","description","status","priority","tags","due_date","order_idx"]
    set_parts = []
    values = []
    for k in allowed:
        if k in payload:
            if k == "tags" and isinstance(payload[k], list):
                values.append(",".join(payload[k]))
            else:
                values.append(payload[k])
            set_parts.append(f"{k} = ?")
    if not set_parts:
        return jsonify({"error":"nothing to update"}), 400
    values.append(card_id)
    sql = f"UPDATE cards SET {', '.join(set_parts)} WHERE id = ?"
    cur.execute(sql, values)
    get_db().commit()
    cur.execute("SELECT * FROM cards WHERE id=?", (card_id,))
    row = cur.fetchone()
    if not row:
        return jsonify({"error":"not found"}), 404
    return jsonify(row_to_dict(row))

@app.route("/api/card/<card_id>", methods=["DELETE"])
def delete_card(card_id):
    cur = get_db().cursor()
    cur.execute("DELETE FROM cards WHERE id=?", (card_id,))
    get_db().commit()
    return jsonify({"deleted": True})

@app.route("/api/reorder", methods=["POST"])
def reorder():
    """
    Accepts either:
      { "orders": { "todo": ["id1","id2"], "in-progress": [...], "done":[...] } }
    or the older format:
      { "column": "todo", "order": ["id1","id2"] }

    Behaviour change: if a card in the provided list was previously in a different status,
    we treat it as "moved into" the column and place it at the end of that column.
    Cards that were already in the column keep their relative ordering from the provided list
    (but moved-in cards are appended).
    """
    payload = request.json or {}
    cur = get_db().cursor()

    def process_orders(orders):
        # preload current status for all involved ids
        all_ids = [cid for ids in orders.values() for cid in ids]
        if not all_ids:
            return

        placeholders = ",".join("?" for _ in all_ids)
        cur.execute(f"SELECT id, status, order_idx FROM cards WHERE id IN ({placeholders})", all_ids)
        rows = {r["id"]: {"status": r["status"], "order_idx": r["order_idx"]} for r in cur.fetchall()}

        # For each target status, compute:
        # - existing_in_col: ids that already have status == target (preserve relative order as given)
        # - moved_here: ids whose current status != target (append to end)
        for status, ids in orders.items():
            existing = [cid for cid in ids if rows.get(cid, {}).get("status") == status]
            moved_here = [cid for cid in ids if rows.get(cid, {}).get("status") != status]

            # reindex existing first (start from 1)
            idx = 1
            for cid in existing:
                cur.execute("UPDATE cards SET status=?, order_idx=? WHERE id=?", (status, idx, cid))
                idx += 1

            # find current max order for this column to append moved_here after it
            cur.execute("SELECT COALESCE(MAX(order_idx), 0) as m FROM cards WHERE status=?", (status,))
            current_max = cur.fetchone()["m"] or 0
            # start appending either after current_max or after the existing we've just written,
            # whichever is greater. This avoids collisions.
            append_idx = max(idx, current_max + 1)

            for cid in moved_here:
                cur.execute("UPDATE cards SET status=?, order_idx=? WHERE id=?", (status, append_idx, cid))
                append_idx += 1

    if "orders" in payload:
        process_orders(payload["orders"])
    elif "column" in payload and "order" in payload:
        process_orders({payload["column"]: payload["order"]})
    else:
        return jsonify({"error": "invalid payload"}), 400

    get_db().commit()
    return jsonify({"ok": True})


# static files route (if needed)
@app.route("/static/<path:filename>")
def static_files(filename):
    return send_from_directory("static", filename)

@app.teardown_appcontext
def close_connection(exception):
    db = getattr(g, "_database", None)
    if db is not None:
        db.close()

if __name__ == "__main__":
    # create DB file if missing (local)
    if not DB_PATH.exists():
        DB_PATH.touch()

    # Run one-time setup (create tables and seed sample data) inside app context,
    # but don't let errors here kill the process — log them instead.
    with app.app_context():
        try:
            setup_once()
        except Exception as e:
            # print stack trace to stdout so Render logs capture it
            import traceback
            print("WARNING: setup_once() failed during startup; continuing so service can run.")
            traceback.print_exc()

    app.run(host="0.0.0.0", port=5000, debug=True)
