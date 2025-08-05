#!/usr/bin/env python3
from flask import (
    Flask, render_template, request, jsonify, Response,
    redirect, url_for, session
)
import json, os, threading, queue as _q
import portalocker
from datetime import timedelta
from werkzeug.security import generate_password_hash, check_password_hash

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "dev-change-me")
app.permanent_session_lifetime = timedelta(days=30)

import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_FILE  = os.path.join(BASE_DIR, "data.json")
USERS_FILE = os.path.join(BASE_DIR, "users.json")


# ─────────────────────────────
# Users
# ─────────────────────────────
def _ensure_users_file():
    if not os.path.exists(USERS_FILE):
        with open(USERS_FILE, "w") as f:
            json.dump({"users": []}, f, indent=2)

def read_users():
    _ensure_users_file()
    with portalocker.Lock(USERS_FILE, "r", flags=portalocker.LOCK_SH) as f:
        return json.load(f)

def write_users(data):
    with portalocker.Lock(USERS_FILE, "w", flags=portalocker.LOCK_EX) as f:
        json.dump(data, f, indent=2)

def find_user(username):
    for u in read_users().get("users", []):
        if u.get("username") == username:
            return u
    return None

def is_admin(username: str) -> bool:
    u = find_user(username)
    return bool(u and u.get("role") == "admin")

def participants_count() -> int:
    return len(read_users().get("users", []))

def all_usernames():
    return [u.get("username") for u in read_users().get("users", [])]

# ─────────────────────────────
# Data (itinerary + packing)
# ─────────────────────────────
def _ensure_data_file():
    if not os.path.exists(DATA_FILE):
        with open(DATA_FILE, "w") as f:
            json.dump({"days": [], "packing": {"items": [], "next_id": 1}}, f, indent=2)

def _ensure_packing(data):
    if "packing" not in data:
        data["packing"] = {"items": [], "next_id": 1}
    if "next_id" not in data["packing"]:
        data["packing"]["next_id"] = 1

def read_data():
    _ensure_data_file()
    with portalocker.Lock(DATA_FILE, "r", flags=portalocker.LOCK_SH) as f:
        d = json.load(f)
    _ensure_packing(d)
    return d

def _time_key(tstr: str) -> int:
    try:
        hh, mm = map(int, (tstr or "").split(":"))
        return hh * 60 + mm
    except Exception:
        return 24 * 60 + 1

def _sort_day_events(day):
    day["events"].sort(key=lambda e: (_time_key(e.get("time","")), (e.get("title") or "").lower()))

def _pack_itinerary(data):
    return {"days": data.get("days", []), "_meta": {"participants": participants_count()}}

def _pack_packing(data):
    users = [{"username": u["username"], "role": u.get("role","user")} for u in read_users().get("users", [])]
    return {"items": data["packing"]["items"], "users": users, "_meta": {"participants": participants_count()}}

def _update_data(mutator, *, broadcast_itinerary=False, broadcast_packing=False):
    with portalocker.Lock(DATA_FILE, "r+", flags=portalocker.LOCK_EX) as f:
        f.seek(0)
        data = json.load(f)
        _ensure_packing(data)
        mutator(data)
        f.seek(0)
        json.dump(data, f, indent=2)
        f.truncate()
        f.flush()
        os.fsync(f.fileno())
    if broadcast_itinerary:
        _broadcast({"type": "data", "data": _pack_itinerary(data)})
    if broadcast_packing:
        _broadcast({"type": "packing", "data": _pack_packing(data)})
    return data

# ─────────────────────────────
# SSE
# ─────────────────────────────
_subscribers = set()
_sub_lock = threading.Lock()

def _broadcast(obj):
    payload = json.dumps(obj)
    with _sub_lock:
        dead = []
        for q in list(_subscribers):
            try:
                q.put_nowait(payload)
            except Exception:
                dead.append(q)
        for q in dead:
            _subscribers.discard(q)

def _broadcast_all_snapshots():
    d = read_data()
    _broadcast({"type": "data",    "data": _pack_itinerary(d)})
    _broadcast({"type": "packing", "data": _pack_packing(d)})

@app.route("/stream")
def stream():
    if "user" not in session:
        return Response("unauthorized", status=401)
    q = _q.Queue(maxsize=200)
    with _sub_lock:
        _subscribers.add(q)

    d = read_data()
    try:
        q.put_nowait(json.dumps({"type": "data",    "data": _pack_itinerary(d)}))
        q.put_nowait(json.dumps({"type": "packing", "data": _pack_packing(d)}))
    except Exception:
        pass

    def gen():
        try:
            while True:
                try:
                    msg = q.get(timeout=30)
                    yield f"data: {msg}\n\n"
                except _q.Empty:
                    yield ": keep-alive\n\n"
        finally:
            with _sub_lock:
                _subscribers.discard(q)

    return Response(gen(), headers={
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
    })

# ─────────────────────────────
# Auth
# ─────────────────────────────
@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "GET":
        if "user" in session:
            return redirect(url_for("index"))
        return render_template("login.html")

    username = (request.form.get("username") or "").strip()
    password = (request.form.get("password") or "")
    u = find_user(username)
    if not u or not check_password_hash(u.get("password_hash",""), password):
        return render_template("login.html", error="Invalid username or password."), 401
    session.permanent = True
    session["user"] = username
    return redirect(url_for("index"))

@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))

# ─────────────────────────────
# Admin (add/delete/reset users)
# ─────────────────────────────
@app.route("/admin", methods=["GET"])
def admin_page():
    if "user" not in session or not is_admin(session["user"]):
        return redirect(url_for("index"))
    users = read_users().get("users", [])
    safe_users = [{"username": u["username"], "role": u.get("role","user")} for u in users]
    return render_template("admin.html", users=safe_users, me=session["user"])

@app.route("/admin/add_user", methods=["POST"])
def admin_add_user():
    if "user" not in session or not is_admin(session["user"]):
        return redirect(url_for("index"))

    username = (request.form.get("username") or "").strip()
    password = (request.form.get("password") or "")
    role     = (request.form.get("role") or "user").strip().lower()
    if role not in ("user","admin"): role = "user"
    if not username or not password: return redirect(url_for("admin_page"))

    data = read_users()
    if any(u.get("username")==username for u in data.get("users", [])):
        return redirect(url_for("admin_page"))

    data["users"].append({
        "username": username,
        "password_hash": generate_password_hash(password),
        "role": role
    })
    write_users(data)
    _broadcast_all_snapshots()
    return redirect(url_for("admin_page"))

@app.route("/admin/delete_user", methods=["POST"])
def admin_delete_user():
    if "user" not in session or not is_admin(session["user"]):
        return redirect(url_for("index"))
    username = (request.form.get("username") or "").strip()
    data = read_users()
    users = data.get("users", [])
    if username == session["user"]:
        return redirect(url_for("admin_page"))
    admins = [u for u in users if u.get("role")=="admin"]
    if any(u.get("username")==username and u.get("role")=="admin" for u in users):
        if len(admins) <= 1:
            return redirect(url_for("admin_page"))

    users = [u for u in users if u.get("username") != username]
    data["users"] = users
    write_users(data)
    _broadcast_all_snapshots()
    return redirect(url_for("admin_page"))

@app.route("/admin/reset_password", methods=["POST"])
def admin_reset_password():
    if "user" not in session or not is_admin(session["user"]):
        return redirect(url_for("index"))
    username = (request.form.get("username") or "").strip()
    new_pw   = (request.form.get("password") or "")
    if not username or not new_pw:
        return redirect(url_for("admin_page"))

    data = read_users()
    for u in data.get("users", []):
        if u.get("username")==username:
            u["password_hash"] = generate_password_hash(new_pw)
            break
    write_users(data)
    return redirect(url_for("admin_page"))

# ─────────────────────────────
# Pages & API (itinerary)
# ─────────────────────────────
def require_user():
    if "user" not in session:
        return None, (jsonify({"error":"unauthorized"}), 401)
    return session["user"], None

@app.route("/")
def index():
    if "user" not in session:
        return redirect(url_for("login"))
    return render_template("index.html",
                           username=session["user"],
                           is_admin=is_admin(session["user"]))

@app.route("/api/me")
def api_me():
    u, err = require_user()
    if err: return err
    return jsonify({"user": u, "is_admin": is_admin(u)})

@app.route("/api/data")
def get_data():
    u, err = require_user()
    if err: return err
    return jsonify(_pack_itinerary(read_data()))

@app.route("/api/day/<int:di>/event", methods=["POST"])
def add_event(di):
    user, err = require_user()
    if err: return err
    p = request.get_json(force=True) or {}
    def mutator(data):
        day = data["days"][di]
        ev = {
            "time": p.get("time",""),
            "title": (p.get("title") or "").strip(),
            "desc": (p.get("desc") or "").strip(),
            "location": (p.get("location") or "").strip(),
            "link": (p.get("link") or "").strip(),
            "creator": user,
            "ups": 0,
            "downs": 0,
            "vote_users": {}
        }
        day.setdefault("events", []).append(ev)
        _sort_day_events(day)
    _update_data(mutator, broadcast_itinerary=True)
    return jsonify(_pack_itinerary(read_data()))

@app.route("/api/day/<int:di>/event/<int:ei>", methods=["POST"])
def update_event(di, ei):
    user, err = require_user()
    if err: return err
    p = request.get_json(force=True) or {}

    data = read_data()
    try:
        ev = data["days"][di]["events"][ei]
    except Exception:
        return jsonify({"error": "not found"}), 404
    if user != (ev.get("creator") or "") and not is_admin(user):
        return jsonify({"error": "only the creator or an admin can edit this event"}), 403

    def mutator(data):
        day = data["days"][di]
        evm = day["events"][ei]
        for k in ("time","title","desc","location","link"):
            if k in p: evm[k] = (p[k] or "").strip()
        _sort_day_events(day)
    _update_data(mutator, broadcast_itinerary=True)
    return jsonify(_pack_itinerary(read_data()))

@app.route("/api/day/<int:di>/event/<int:ei>/vote", methods=["POST"])
def vote_event(di, ei):
    user, err = require_user()
    if err: return err
    p = request.get_json(force=True) or {}
    action = "up" if int(p.get("delta", 1)) >= 0 else "down"

    def mutator(data):
        ev = data["days"][di]["events"][ei]
        vu = ev.get("vote_users") or {}
        prev = vu.get(user)
        ups  = int(ev.get("ups", 0))
        dwn  = int(ev.get("downs", 0))
        if action == "up":
            if prev == "u": ups -= 1; vu.pop(user, None)
            elif prev == "d": dwn -= 1; ups += 1; vu[user] = "u"
            else: ups += 1; vu[user] = "u"
        else:
            if prev == "d": dwn -= 1; vu.pop(user, None)
            elif prev == "u": ups -= 1; dwn += 1; vu[user] = "d"
            else: dwn += 1; vu[user] = "d"
        ev["ups"] = max(0, ups)
        ev["downs"] = max(0, dwn)
        ev["vote_users"] = vu
    _update_data(mutator, broadcast_itinerary=True)
    return jsonify({"ok": True})

@app.route("/api/day/<int:di>/event/<int:ei>/delete", methods=["POST"])
def delete_event(di, ei):
    user, err = require_user()
    if err: return err

    data = read_data()
    try:
        ev = data["days"][di]["events"][ei]
    except Exception:
        return jsonify({"error":"not found"}), 404

    creator = ev.get("creator") or ""
    # Everyone except the creator must have downvoted to unlock delete-for-anyone.
    non_creator_users = set(all_usernames()) - {creator}
    downvoters = {u for (u, mark) in (ev.get("vote_users") or {}).items() if mark == "d"}
    all_others_down = non_creator_users.issubset(downvoters)

    # Allowed if: creator OR admin OR (all non-creator users downvoted)
    if not (user == creator or is_admin(user) or all_others_down):
        return jsonify({
            "error": "delete blocked",
            "reason": "needs downvotes from every non-creator user, or creator/admin",
            "required_count": len(non_creator_users),
            "downs_count": len(downvoters)
        }), 403

    def mutator(d):
        d["days"][di]["events"].pop(ei)
    _update_data(mutator, broadcast_itinerary=True)
    return jsonify(_pack_itinerary(read_data()))

# ─────────────────────────────
# Pages & API (packing — shared list)
# ─────────────────────────────
@app.route("/packing")
def packing_page():
    if "user" not in session:
        return redirect(url_for("login"))
    return render_template("packing.html",
                           username=session["user"],
                           is_admin=is_admin(session["user"]))

@app.route("/api/packing")
def api_packing():
    u, err = require_user()
    if err: return err
    return jsonify(_pack_packing(read_data()))

@app.route("/api/packing/add", methods=["POST"])
def packing_add():
    user, err = require_user()
    if err: return err
    p = request.get_json(force=True) or {}
    cat = (p.get("category") or "").lower()
    if cat not in ("items","snacks","other"):
        cat = "items"
    text = (p.get("text") or "").strip()
    qty  = int(p.get("qty") or 1)
    if not text:
        return jsonify({"error":"text required"}), 400

    def mutator(data):
        pid = data["packing"]["next_id"]
        data["packing"]["next_id"] = pid + 1
        data["packing"]["items"].append({
            "id": pid,
            "user": user,
            "category": cat,
            "text": text,
            "qty": max(1, qty),
            "hearts_by": {}
        })
    _update_data(mutator, broadcast_packing=True)
    return jsonify({"ok": True})

@app.route("/api/packing/toggle_heart/<int:pid>", methods=["POST"])
def packing_toggle_heart(pid):
    user, err = require_user()
    if err: return err

    def mutator(data):
        for it in data["packing"]["items"]:
            if it.get("id")==pid:
                hb = it.get("hearts_by") or {}
                if user in hb: hb.pop(user, None)
                else: hb[user] = 1
                it["hearts_by"] = hb
                break
    _update_data(mutator, broadcast_packing=True)
    return jsonify({"ok": True})

@app.route("/api/packing/delete/<int:pid>", methods=["POST"])
def packing_delete(pid):
    user, err = require_user()
    if err: return err

    data = read_data()
    target = None
    for it in data["packing"]["items"]:
        if it.get("id")==pid:
            target = it; break
    if not target:
        return jsonify({"error":"not found"}), 404

    if user != target.get("user") and not is_admin(user):
        return jsonify({"error":"only owner or admin can delete"}), 403

    def mutator(d):
        d["packing"]["items"] = [it for it in d["packing"]["items"] if it.get("id")!=pid]
    _update_data(mutator, broadcast_packing=True)
    return jsonify({"ok": True})

# ─────────────────────────────
# Utilities
# ─────────────────────────────
@app.route("/_hash", methods=["POST"])
def _hash_util():
    pw = (request.json or {}).get("password", "")
    return jsonify({"hash": generate_password_hash(pw)})

if __name__ == "__main__":
    app.run(debug=True)
