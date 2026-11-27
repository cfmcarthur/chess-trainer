#!/usr/bin/env python3
"""Chess Trainer: standalone LAN site. Flask static frontend + JSON API.

Run: .venv/bin/python3 server.py  (set CHESS_HOST/CHESS_PORT to override)
"""
import json, os, re, sqlite3, threading, time, uuid, urllib.request, urllib.error
import math
from pathlib import Path
from flask import Flask, jsonify, request, send_file, abort

ROOT = Path(__file__).resolve().parent

# Load .env from the project dir if present (stdlib-only, no extra deps)
def _load_env():
    env_file = ROOT / '.env'
    if not env_file.exists():
        return
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        k, _, v = line.partition('=')
        k = k.strip()
        v = v.strip().strip('"').strip("'")
        if k and k not in os.environ:
            os.environ[k] = v
_load_env()

STATIC = ROOT / 'static'
DATA = Path(os.environ.get('CHESS_DATA_DIR', str(Path.home() / '.local' / 'share' / 'chess-trainer')))
HOST = os.environ.get('CHESS_HOST', '192.168.1.88')
PORT = int(os.environ.get('CHESS_PORT', '3050'))
MAX_BODY = 65536

# LLM config for chat answers (OpenAI-compatible chat completions)
LLM_BASE = os.environ.get('CHESS_LLM_BASE', 'http://192.168.1.45:8018/v1')
LLM_TIMEOUT = float(os.environ.get('CHESS_LLM_TIMEOUT', '60'))
LLM_MODEL = os.environ.get('CHESS_LLM_MODEL', '')  # empty = auto-detect

def _resolve_model():
    # env override wins; otherwise ask the live endpoint for a model id
    if LLM_MODEL:
        return LLM_MODEL
    try:
        req = urllib.request.Request(LLM_BASE.rstrip('/') + '/models', method='GET')
        with urllib.request.urlopen(req, timeout=5) as resp:
            body = json.loads(resp.read())
            ids = [m.get('id') for m in body.get('data', []) if m.get('id')]
            # prefer the Splash/local model over Ollama MLX duplicates
            for pref in ('unsloth/', 'Inkling', 'inkling'):
                for mid in ids:
                    if pref.lower() in mid.lower():
                        return mid
            return ids[0] if ids else ''
    except Exception:
        return 'inkling-native:latest'  # last-resort default

app = Flask(__name__)

# ---------- data ----------
def db():
    DATA.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(DATA / 'chess.sqlite', timeout=10)
    c.execute('CREATE TABLE IF NOT EXISTS documents (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    c.execute('''CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY, question TEXT NOT NULL, answer TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'queued', created REAL NOT NULL, updated REAL NOT NULL)''')
    c.execute('''CREATE TABLE IF NOT EXISTS games (
        id TEXT PRIMARY KEY, date TEXT NOT NULL, opponent TEXT NOT NULL,
        result TEXT NOT NULL, rating_after REAL NOT NULL, rating_before REAL NOT NULL,
        moves INTEGER NOT NULL, fen TEXT NOT NULL DEFAULT '')''')
    c.execute('''CREATE TABLE IF NOT EXISTS puzzle_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, puzzle_id TEXT NOT NULL,
        solved INTEGER NOT NULL, rating REAL, created REAL NOT NULL)''')
    return c

def load_doc(c, key, default):
    row = c.execute('SELECT value FROM documents WHERE key=?', (key,)).fetchone()
    return json.loads(row[0]) if row else default

def save_doc(c, key, value):
    c.execute('INSERT INTO documents VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
              (key, json.dumps(value)))

def get_rating(c):
    return load_doc(c, 'rating', {'glicko2': {'mu': 1500.0, 'phi': 350.0, 'sigma': 0.06}, 'count': 0, 'history': []})

# Glicko-2 update (canonical reference implementation: the `glicko2` package).
from glicko2 import Player as _GlickoPlayer

def glicko2_update(mu, phi, sigma, opponent_mu, result):
    """Return (new_mu, new_phi, new_sigma) in 1500-scale. `result` is 1/0.5/0."""
    p = _GlickoPlayer(float(mu), float(phi), float(sigma))
    p.update_player([float(opponent_mu)], [float(phi)], [float(result)])
    new_mu = p.rating
    new_phi = p.rd
    new_sigma = p.vol
    new_mu = max(400, min(2400, new_mu))
    new_phi = max(30, min(300, new_phi))
    return new_mu, new_phi, new_sigma

def llm_answer(question, context):
    system = "You are Hermes, a patient chess coach. Answer the player's question about chess — moves, strategies, openings, ratings. Be clear, concrete and encouraging. Keep answers under 150 words."
    payload = {
        'model': _resolve_model(),
        'messages': [
            {'role': 'system', 'content': system},
            {'role': 'user', 'content': (context + '\n\nQuestion: ' + question).strip()},
        ],
        'temperature': 0.4,
        'max_tokens': 400,
    }
    data = json.dumps(payload).encode()
    req = urllib.request.Request(LLM_BASE.rstrip('/') + '/chat/completions', data=data,
                                 headers={'Content-Type': 'application/json'}, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=LLM_TIMEOUT) as resp:
            body = json.loads(resp.read())
            return body['choices'][0]['message']['content'].strip()
    except Exception as e:
        return f'(LLM unavailable: {e})'

# ---------- routes ----------
@app.route('/')
def index():
    return send_file(STATIC / 'index.html')

@app.route('/static/<path:rel>')
def static_file(rel):
    safe = (STATIC / rel).resolve()
    if not str(safe).startswith(str(STATIC.resolve())) or not safe.is_file():
        abort(404)
    return send_file(safe)

@app.route('/api/health')
def health():
    return jsonify({'ok': True, 'service': 'chess-trainer', 'time': time.time()})

@app.route('/api/puzzles')
def puzzles():
    try:
        with open(ROOT / 'data' / 'puzzles.json') as f:
            return jsonify({'puzzles': json.load(f).get('puzzles', [])})
    except Exception:
        return jsonify({'puzzles': []})

@app.route('/api/education')
def education():
    try:
        with open(ROOT / 'data' / 'education.json') as f:
            return jsonify({'sections': json.load(f).get('sections', [])})
    except Exception:
        return jsonify({'sections': []})

@app.route('/api/rating', methods=['GET', 'POST'])
def rating():
    if request.method == 'GET':
        with db() as c:
            return jsonify(get_rating(c))
    body = request.get_json(silent=True) or {}
    with db() as c:
        rating = get_rating(c)
        rating.update(body)
        save_doc(c, 'rating', rating)
        return jsonify(rating)

@app.route('/api/games', methods=['GET', 'POST'])
def games():
    if request.method == 'GET':
        with db() as c:
            rows = c.execute('SELECT id, date, opponent, result, rating_after, rating_before, moves, fen FROM games ORDER BY date DESC LIMIT 100').fetchall()
            cols = [d[0] for d in c.execute('PRAGMA table_info(games)').fetchall()]
            return jsonify({'games': [dict(zip(cols, r)) for r in rows]})
    body = request.get_json(silent=True) or {}
    result = body.get('result')
    if result not in ('win', 'loss', 'draw'):
        return jsonify({'error': 'result must be win/loss/draw'}), 400
    with db() as c:
        rating = get_rating(c)
        g2 = rating.get('glicko2', {'mu': 1500.0, 'phi': 350.0, 'sigma': 0.06})
        opp_mu = float(body.get('opponent_rating', 1500))
        res = 1.0 if result == 'win' else (0.5 if result == 'draw' else 0.0)
        new_mu, new_phi, new_sigma = glicko2_update(g2['mu'], g2['phi'], g2['sigma'], opp_mu, res)
        game_id = body.get('id') or uuid.uuid4().hex[:12]
        rating_before = g2['mu']
        rating['glicko2'] = {'mu': new_mu, 'phi': new_phi, 'sigma': new_sigma}
        rating['count'] = rating.get('count', 0) + 1
        history = rating.get('history', [])
        history.append({'date': body.get('date') or time.strftime('%Y-%m-%d'), 'result': result,
                        'mu_before': rating_before, 'mu_after': new_mu})
        rating['history'] = history[-50:]
        save_doc(c, 'rating', rating)
        c.execute(
            'INSERT OR REPLACE INTO games (id, date, opponent, result, rating_after, rating_before, moves, fen) VALUES (?,?,?,?,?,?,?,?)',
            (game_id, body.get('date') or time.strftime('%Y-%m-%d'), body.get('opponent', 'Stockfish'),
             result, new_mu, rating_before, int(body.get('moves', 0)), body.get('fen', '')))
        return jsonify({'ok': True, 'id': game_id, 'rating': rating})

@app.route('/api/chat', methods=['POST'])
def chat_post():
    body = request.get_json(silent=True) or {}
    q = (body.get('question') or '').strip()
    if not q or len(q) > 4000:
        return jsonify({'error': 'question must be 1-4000 chars'}), 400
    rid = body.get('id') or uuid.uuid4().hex[:32]
    if not re.fullmatch(r'[a-f0-9]{32}', rid):
        return jsonify({'error': 'invalid message id'}), 400
    ctx = (body.get('context') or '').strip()[:2000]
    with db() as c:
        existing = c.execute('SELECT id FROM chat_messages WHERE id=?', (rid,)).fetchone()
        if existing:
            return jsonify({'id': rid, 'status': 'duplicate'})
        now = time.time()
        c.execute('INSERT INTO chat_messages (id, question, status, created, updated) VALUES (?,?,?,?,?)',
                  (rid, q, 'queued', now, now))
    # Answer synchronously via the local LLM (bounded by timeout)
    answer = llm_answer(q, ctx)
    with db() as c:
        c.execute('UPDATE chat_messages SET answer=?, status=?, updated=? WHERE id=?',
                  (answer, 'done' if not answer.startswith('(LLM unavailable') else 'error', time.time(), rid))
    return jsonify({'id': rid, 'status': 'done', 'answer': answer})

@app.route('/api/chat', methods=['GET'])
def chat_get():
    with db() as c:
        rows = c.execute('SELECT id, question, answer, status, created, updated FROM chat_messages ORDER BY created DESC LIMIT 60').fetchall()
        msgs = [dict(zip(('id', 'question', 'answer', 'status', 'created', 'updated'), r)) for r in reversed(rows)]
        return jsonify({'messages': msgs})

@app.route('/api/puzzle_attempts', methods=['POST'])
def puzzle_attempts_post():
    body = request.get_json(silent=True) or {}
    pid = body.get('puzzle_id')
    if not isinstance(pid, str):
        return jsonify({'error': 'puzzle_id required'}), 400
    with db() as c:
        c.execute('INSERT INTO puzzle_attempts (puzzle_id, solved, rating, created) VALUES (?,?,?,?)',
                  (pid, 1 if body.get('solved') else 0, body.get('rating'), time.time()))
        return jsonify({'ok': True})

@app.route('/api/puzzle_attempts', methods=['GET'])
def puzzle_attempts_get():
    with db() as c:
        rows = c.execute('SELECT puzzle_id, solved, rating, created FROM puzzle_attempts ORDER BY created DESC LIMIT 100').fetchall()
        return jsonify({'attempts': [dict(zip(('puzzle_id', 'solved', 'rating', 'created'), r)) for r in rows]})

if __name__ == '__main__':
    app.run(host=HOST, port=PORT, debug=False, threaded=True)
