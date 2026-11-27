// Chess Trainer — main app
import { Chess } from 'chess.js';

// ---------- helpers ----------
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const COLORS = {
  light: '#e8d5b7', dark: '#8a6b4f',
  light3d: 0xe8d5b7, dark3d: 0x8a6b4f,
  white: 0xf5f0e6, black: 0x2b2b2b,
  accent: 0xf0b429,
};

// ---------- state ----------
const state = {
  game: new Chess(),
  viewIndex: 0,          // how many plies to show (0 = start)
  history: [],           // verbose move objects
  level: 2,              // difficulty 1-4
  orientation: 'w',      // board orientation
  engine: null,
  engineReady: false,
  engineBusy: false,
  lastEval: null,        // {cp, depth, move}
  lastBestMove: null,
  feedback: null,
  puzzleIndex: 0,
  puzzleSolved: false,
  puzzleAttempts: 0,
};

// ---------- routing ----------
function route() {
  const hash = location.hash.replace(/^#\/?/, '') || 'play';
  const page = hash.split('/')[0];
  $$('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + page));
  $$('.nav a').forEach(a => a.classList.toggle('active', a.dataset.route === page));
  if (page === 'puzzles') renderPuzzles();
  if (page === 'learn') renderLearn();
  if (page === 'ratings') renderRatings();
}
window.addEventListener('hashchange', route);
window.addEventListener('load', () => { route(); initBoard(); resetGame(); initEngine(); initChat(); initPuzzlesData(); });

// ---------- 3D board ----------
let scene, camera, renderer, boardGroup, pieceMeshes = [], tiles = [], boardSize = 1;
const SQ = 1 / 8;

function initBoard() {
  const canvas = $('#board-canvas');
  if (!canvas) return;
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  scene = new THREE.Scene();
  scene.background = null;

  camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(0, 1.9, 2.2);
  camera.lookAt(0, 0, 0);

  const key = new THREE.DirectionalLight(0xffffff, 1.35);
  key.position.set(2, 4, 2);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.left = -2; key.shadow.camera.right = 2;
  key.shadow.camera.top = 2; key.shadow.camera.bottom = -2;
  scene.add(key);
  scene.add(new THREE.AmbientLight(0x8899aa, 0.75));

  boardGroup = new THREE.Group();
  scene.add(boardGroup);

  buildBoardTiles();
  resizeBoard();
  window.addEventListener('resize', resizeBoard);
  animate();
}

function buildBoardTiles() {
  // clear old
  for (const t of tiles) boardGroup.remove(t);
  tiles = [];
  const gap = 0.012;
  const size = 1 / 8 - gap;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const light = (r + c) % 2 === 0;
      const geo = new THREE.BoxGeometry(size, 0.06, size);
      const mat = new THREE.MeshStandardMaterial({
        color: light ? COLORS.light3d : COLORS.dark3d,
        roughness: 0.85, metalness: 0.05,
      });
      const mesh = new THREE.Mesh(geo, mat);
      const x = (c - 3.5) * (1 / 8);
      const z = (r - 3.5) * (1 / 8);
      mesh.position.set(x, -0.03, z);
      mesh.receiveShadow = true;
      mesh.userData = { r, c, light };
      boardGroup.add(mesh);
      tiles.push(mesh);
    }
  }
  // base frame
  const frameGeo = new THREE.BoxGeometry(1.02, 0.08, 1.02);
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x2a2118, roughness: 0.6, metalness: 0.2 });
  const frame = new THREE.Mesh(frameGeo, frameMat);
  frame.position.y = -0.08;
  frame.receiveShadow = true;
  boardGroup.add(frame);
}

function resizeBoard() {
  const canvas = $('#board-canvas');
  if (!canvas || !renderer) return;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (w === 0 || h === 0) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

function animate() {
  requestAnimationFrame(animate);
  if (renderer && scene && camera) {
    renderer.render(scene, camera);
  }
}

// ---------- 3D pieces ----------
function makePiece(type, color) {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({
    color: color === 'w' ? COLORS.white : COLORS.black,
    roughness: 0.35, metalness: 0.15,
  });
  const accent = new THREE.MeshStandardMaterial({ color: COLORS.accent, roughness: 0.5 });
  const s = 1 / 8;

  const add = (geo, x = 0, y = 0, z = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    group.add(m);
    return m;
  };

  switch (type) {
    case 'p':
      add(new THREE.CylinderGeometry(0.035, 0.05, 0.06, 16), 0, 0.03, 0);
      add(new THREE.SphereGeometry(0.035, 16, 12), 0, 0.075, 0);
      break;
    case 'r':
      add(new THREE.CylinderGeometry(0.045, 0.06, 0.1, 16), 0, 0.05, 0);
      add(new THREE.BoxGeometry(0.1, 0.05, 0.1), 0, 0.125, 0);
      break;
    case 'n':
      add(new THREE.CylinderGeometry(0.04, 0.055, 0.09, 16), 0, 0.045, 0);
      add(new THREE.ConeGeometry(0.04, 0.09, 8), 0, 0.135, 0);
      add(new THREE.SphereGeometry(0.025, 12, 8), 0, 0.185, 0);
      break;
    case 'b':
      add(new THREE.CylinderGeometry(0.035, 0.055, 0.07, 16), 0, 0.035, 0);
      add(new THREE.ConeGeometry(0.05, 0.11, 16), 0, 0.125, 0);
      add(new THREE.SphereGeometry(0.022, 12, 8), 0, 0.185, 0);
      break;
    case 'q':
      add(new THREE.CylinderGeometry(0.04, 0.06, 0.08, 16), 0, 0.04, 0);
      add(new THREE.CylinderGeometry(0.028, 0.042, 0.09, 16), 0, 0.125, 0);
      add(new THREE.SphereGeometry(0.026, 12, 8), 0, 0.185, 0);
      add(new THREE.SphereGeometry(0.014, 8, 8), 0, 0.215, 0);
      break;
    case 'k':
      add(new THREE.CylinderGeometry(0.04, 0.055, 0.08, 16), 0, 0.04, 0);
      add(new THREE.CylinderGeometry(0.026, 0.04, 0.09, 16), 0, 0.125, 0);
      add(new THREE.SphereGeometry(0.024, 12, 8), 0, 0.185, 0);
      add(new THREE.CylinderGeometry(0.008, 0.008, 0.045, 8), 0, 0.225, 0);
      add(new THREE.CylinderGeometry(0.008, 0.008, 0.045, 8), 0, 0.225, 0).rotation.z = Math.PI / 2;
      break;
  }
  return group;
}

function squareTo3D(file, rank) {
  // file 0-7 (a-h), rank 0-7 (1-8)
  const x = (file - 3.5) * (1 / 8);
  const z = (3.5 - rank) * (1 / 8);  // rank 0 (white home) at bottom (+z)
  return { x, z };
}

function renderBoard() {
  // remove old pieces
  for (const m of pieceMeshes) boardGroup.remove(m);
  pieceMeshes = [];

  const game = new Chess(state.game.fen());
  // replay up to viewIndex
  for (let i = 0; i < state.viewIndex; i++) {
    const mv = state.history[i];
    if (mv) game.move({ from: mv.from, to: mv.to, promotion: mv.promotion });
  }

  const board = game.board();
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const cell = board[r][c];
      if (!cell) continue;
      const piece = makePiece(cell.type, cell.color);
      const file = c;          // 0 = a
      const rank = 7 - r;      // 0 = rank 1
      const { x, z } = squareTo3D(file, rank);
      // orientation flip
      const fx = state.orientation === 'w' ? x : -x;
      const fz = state.orientation === 'w' ? z : -z;
      piece.position.set(fx, 0, fz);
      piece.userData = { file: state.orientation === 'w' ? file : 7 - file, rank: state.orientation === 'w' ? rank : 7 - rank, type: cell.type, color: cell.color, cell };
      boardGroup.add(piece);
      pieceMeshes.push(piece);
    }
  }
}

// ---------- engine ----------
function initEngine() {
  if (state.engine) return;
  try {
    state.engine = new Worker('/static/engine/stockfish-19-lite-single.js');
    state.engine.onmessage = (e) => handleEngineOutput(e.data);
    state.engine.postMessage('uci');
    state.engine.postMessage('isready');
    state.engineReady = true;
  } catch (err) {
    console.error('Engine init failed', err);
  }
}

let pendingBest = null;
let bestMoveResolved = false;
function handleEngineOutput(line) {
  if (!line) return;
  if (line.startsWith('info')) {
    // parse: info depth X seldepth Y multipv 1 score cp N
    const mDepth = line.match(/depth (\d+)/);
    const mCp = line.match(/score cp (-?\d+)/);
    const mMate = line.match(/score mate (-?\d+)/);
    const mMulti = line.match(/multipv (\d+)/);
    if (mMulti && mMulti[1] === '1') {
      let cp = null;
      if (mCp) cp = parseInt(mCp[1], 10);
      else if (mMate) cp = mMate[1].startsWith('-') ? -100000 : 100000;
      state.lastEval = { depth: mDepth ? parseInt(mDepth[1], 10) : 0, cp };
    }
  }
  if (line.startsWith('bestmove')) {
    const parts = line.trim().split(/\s+/);
    const move = parts[1] === '(none)' ? null : parts[1];
    state.lastBestMove = move;
    bestMoveResolved = true;
  }
}

function engineAnalyze(fen, depth, onDone) {
  return new Promise((resolve) => {
    if (!state.engine) { onDone({ cp: null, best: null }); return; }
    bestMoveResolved = false;
    state.engineBusy = true;
    state.engine.postMessage('position fen ' + fen);
    state.engine.postMessage('go depth ' + depth);
    const start = Date.now();
    const poll = setInterval(() => {
      if (bestMoveResolved || Date.now() - start > 30000) {
        clearInterval(poll);
        state.engineBusy = false;
        resolve({ cp: state.lastEval ? state.lastEval.cp : null, best: state.lastBestMove });
      }
    }, 100);
  });
}

function engineBestMove(fen, depth) {
  return new Promise((resolve) => {
    if (!state.engine) { resolve(null); return; }
    bestMoveResolved = false;
    state.engineBusy = true;
    state.engine.postMessage('position fen ' + fen);
    state.engine.postMessage('go depth ' + depth);
    const start = Date.now();
    const poll = setInterval(() => {
      if (bestMoveResolved || Date.now() - start > 30000) {
        clearInterval(poll);
        state.engineBusy = false;
        resolve(state.lastBestMove);
      }
    }, 100);
  });
}

// ---------- difficulty ----------
const LEVELS = {
  1: { name: 'Novice', depth: 3, blunder: 0.35, label: 'Novice — makes mistakes often' },
  2: { name: 'Club', depth: 7, blunder: 0.12, label: 'Club — solid, occasional slip' },
  3: { name: 'Strong', depth: 10, blunder: 0.03, label: 'Strong — rarely errs' },
  4: { name: 'Master', depth: 14, blunder: 0.0, label: 'Master — near-perfect' },
};

// ---------- game logic ----------
function currentFen() {
  // replay history up to viewIndex
  const g = new Chess();
  for (let i = 0; i < state.viewIndex; i++) {
    const mv = state.history[i];
    if (mv) g.move({ from: mv.from, to: mv.to, promotion: mv.promotion });
  }
  return g.fen();
}

function resetGame() {
  state.game = new Chess();
  state.history = [];
  state.viewIndex = 0;
  state.feedback = null;
  renderBoard();
  renderMoveList();
  renderFeedback();
  updateRatingSummary();
}

async function makeMove(from, to, promotion) {
  const g = new Chess(currentFen());
  const move = g.move({ from, to, promotion: promotion || 'q' });
  if (!move) return false;

  // apply to real history
  const real = new Chess(state.game.fen());
  // find the move at viewIndex in real history
  const newHistory = state.history.slice(0, state.viewIndex);
  const realMove = real.move({ from, to, promotion: promotion || 'q' });
  if (!realMove) return false;
  newHistory.push(realMove);
  state.history = newHistory;
  state.game = real;
  state.viewIndex = state.history.length;

  renderBoard();
  renderMoveList();
  renderFeedback();

  // feedback for the user's move
  await analyzeAndFeedback(realMove, newHistory);
  // then engine reply
  await engineReply();
}

async function analyzeAndFeedback(realMove, history) {
  const g = new Chess();
  for (let i = 0; i < history.length; i++) g.move({ from: history[i].from, to: history[i].to, promotion: history[i].promotion });

  // evaluate before the move (if any) and after
  const fenBefore = history.length >= 2 ? (() => {
    const b = new Chess();
    for (let i = 0; i < history.length - 1; i++) b.move({ from: history[i].from, to: history[i].to, promotion: history[i].promotion });
    return b.fen();
  })() : null;

  const fenAfter = g.fen();
  const bestMove = await engineBestMove(fenBefore || fenAfter, LEVELS[state.level].depth);
  const evalAfter = await engineAnalyze(fenAfter, LEVELS[state.level].depth);

  const cp = evalAfter.cp;
  // Determine if the move was good: compare eval before vs after
  let verdict = 'ok', text = '';
  const userColor = realMove.color;
  const sign = userColor === 'w' ? 1 : -1;

  if (fenBefore) {
    const evalBefore = await engineAnalyze(fenBefore, LEVELS[state.level].depth);
    const cpBefore = evalBefore.cp;
    if (cp !== null && cpBefore !== null) {
      const loss = (sign * (cp - cpBefore)); // positive = worse for user
      // Actually sign: user color perspective. cp is from white's perspective.
      const beforeWhite = cpBefore;
      const afterWhite = cp;
      const userGain = userColor === 'w' ? afterWhite - beforeWhite : beforeWhite - afterWhite;
      if (userGain > 80) { verdict = 'good'; text = `Strong move — it improved your position by about ${Math.round(userGain / 100)} pawns.`; }
      else if (userGain > 0) { verdict = 'ok'; text = `Reasonable move. Slight improvement (${Math.round(userGain / 100)} pawns).`; }
      else if (userGain > -80) { verdict = 'ok'; text = `A little weak — roughly ${Math.round(-userGain / 100)} pawns worse than the best.`; }
      else { verdict = 'bad'; text = `A mistake — it cost about ${Math.round(-userGain / 100)} pawns compared to the best move.`; }
    } else {
      verdict = 'ok'; text = 'The engine did not return a clean evaluation.';
    }
  } else {
    verdict = 'ok'; text = 'Opening move — solid starting point.';
  }

  state.feedback = { verdict, text, best: bestMove };
  renderFeedback();
}

async function engineReply() {
  // Only engine plays if it's engine's turn
  if (state.game.turn() !== (state.orientation === 'w' ? 'b' : 'w')) return;
  if (state.game.game_over()) return;

  const g = new Chess(currentFen());
  const level = LEVELS[state.level];
  let best = await engineBestMove(g.fen(), level.depth);

  if (level.blunder > 0 && Math.random() < level.blunder) {
    // blunder: pick a weak move from the legal moves
    const moves = g.moves({ verbose: true });
    const filtered = moves.filter(m => m.san !== best);
    if (filtered.length) best = filtered[Math.floor(Math.random() * filtered.length)].san;
    // need to convert SAN back to from/to
    const found = moves.find(m => m.san === best);
    if (found) best = found.from + found.to;
  }

  if (!best) return;

  // Parse the UCI move (e2e4) or SAN
  let from = null, to = null, promotion = null;
  if (/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(best)) {
    from = best.slice(0, 2); to = best.slice(2, 4);
    promotion = best.length > 4 ? best[4] : null;
  } else {
    // SAN: use chess.js to parse
    const moves = g.moves({ verbose: true });
    const found = moves.find(m => m.san === best);
    if (found) { from = found.from; to = found.to; promotion = found.promotion; }
  }
  if (!from) return;

  const real = new Chess(state.game.fen());
  const realMove = real.move({ from, to, promotion: promotion || 'q' });
  if (!realMove) return;

  const newHistory = state.history.slice(0, state.viewIndex);
  // Actually engine reply should append to the real history, but if viewIndex < history.length,
  // we truncate the future first.
  const realHistory = state.history.slice(0, state.viewIndex);
  realHistory.push(realMove);
  state.history = realHistory;
  state.game = real;
  state.viewIndex = state.history.length;

  renderBoard();
  renderMoveList();
  renderFeedback();

  // engine explanation
  const san = realMove.san;
  const explain = await engineExplain(state.game.fen(), san);
  state.feedback = {
    verdict: 'ok',
    text: `I played ${san}. ${explain}`,
    best: best,
  };
  renderFeedback();
}

async function engineExplain(fen, san) {
  // The explanation is LLM-generated. For now, use a template based on eval.
  // The live LLM chat box can give deeper explanations.
  return `I played ${san} to ${san.endsWith('+') || san.endsWith('#') ? 'give check' : 'develop'}. Ask the chat box for a deeper why.`;
}

// ---------- feedback UI ----------
function renderFeedback() {
  const el = $('#feedback');
  const v = $('#verdict');
  const t = $('#feedback-text');
  if (!state.feedback) {
    v.className = 'verdict ok'; v.textContent = 'Move';
    t.textContent = 'Your turn. Make a move.';
    return;
  }
  const { verdict, text } = state.feedback;
  v.className = 'verdict ' + (verdict === 'good' ? 'good' : verdict === 'bad' ? 'bad' : 'ok');
  v.textContent = verdict === 'good' ? 'Good move' : verdict === 'bad' ? 'Mistake' : 'Ok';
  t.textContent = text;
}

function renderMoveList() {
  const el = $('#move-list');
  if (!el) return;
  if (!state.history.length) { el.innerHTML = '<div class="muted" style="padding:8px 0">No moves yet.</div>'; return; }
  let html = '';
  for (let i = 0; i < state.history.length; i++) {
    const mv = state.history[i];
    const num = Math.floor(i / 2) + 1;
    const side = i % 2 === 0 ? '1.' : '...';
    const active = i < state.viewIndex ? (i === state.viewIndex - 1 ? ' active' : '') : ' future';
    html += `<div class="mv${active}" data-index="${i}"><span>${num}${i % 2 === 1 ? '...' : '.'} </span><span>${mv.san}</span></div>`;
  }
  el.innerHTML = html;
  el.querySelectorAll('.mv').forEach(row => {
    row.addEventListener('click', () => {
      const idx = parseInt(row.dataset.index, 10);
      state.viewIndex = idx + 1;
      renderBoard(); renderMoveList();
    });
  });
}

function renderRatingSummary() { updateRatingSummary(); }

async function updateRatingSummary() {
  const el = $('#rating-summary');
  if (!el) return;
  try {
    const r = await fetch('/api/rating').then(r => r.json());
    const g2 = r.glicko2 || {};
    const mu = g2.mu ?? 1500;
    el.innerHTML = `<strong style="font-size:1.3rem">${Math.round(mu)}</strong> <span class="muted">Glicko-2</span><br><span class="muted" style="font-size:.78rem">${r.count || 0} games played</span>`;
  } catch { el.innerHTML = '<span class="muted">Rating unavailable</span>'; }
}

// ---------- board interaction ----------
let selectedSquare = null;
function onCanvasClick(e) {
  if (!scene || !camera || !renderer) return;
  const canvas = $('#board-canvas');
  const rect = canvas.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  const y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(new THREE.Vector2(x, y), camera);

  // find piece first
  const pieceHits = raycaster.intersectObjects(pieceMeshes, true);
  if (pieceHits.length) {
    let root = pieceHits[0].object;
    while (root && !root.userData.file && !root.userData.rank) root = root.parent;
    if (root && root.userData.file !== undefined) {
      // find the piece in the displayed game state
      const g = new Chess(currentFen());
      const board = g.board();
      const file = root.userData.file;
      const rank = root.userData.rank;
      const cell = board[7 - rank][file];
      if (cell && cell.color === g.turn()) {
        selectedSquare = { file, rank, type: cell.type, color: cell.color };
        highlightSelected();
        return;
      }
    }
  }

  // tile click
  const tileHits = raycaster.intersectObjects(tiles);
  if (tileHits.length) {
    const tile = tileHits[0].object;
    let r = tile.userData.r, c = tile.userData.c;
    // convert to file/rank considering orientation
    let file = state.orientation === 'w' ? c : 7 - c;
    let rank = state.orientation === 'w' ? 7 - r : r;
    // userData on tile was (r,c) with r=0 at top (rank 8)
    // rank 0 (white home) at bottom
    if (selectedSquare) {
      // attempt move
      const from = squareName(selectedSquare.file, selectedSquare.rank);
      const to = squareName(file, rank);
      attemptMove(from, to);
      selectedSquare = null;
      clearHighlights();
    }
  }
}

function squareName(file, rank) {
  return String.fromCharCode(97 + file) + (rank + 1);
}

function highlightSelected() {
  clearHighlights();
  // no simple highlight; rely on piece color
}

function clearHighlights() {}

function attemptMove(from, to) {
  const g = new Chess(currentFen());
  const moves = g.moves({ verbose: true });
  const match = moves.find(m => m.from === from && m.to === to);
  if (!match) {
    // try promotion
    const promo = moves.find(m => m.from === from && m.to === to && m.promotion);
    if (promo) return makeMove(from, to, 'q');
    return;
  }
  // check for promotion
  const g2 = new Chess(currentFen());
  const isPromo = match.flags && match.flags.includes('p');
  makeMove(from, to, isPromo ? 'q' : undefined);
}

// ---------- puzzles ----------
let puzzlesData = [];
async function initPuzzlesData() {
  try {
    const r = await fetch('/api/puzzles').then(r => r.json());
    puzzlesData = r.puzzles || [];
  } catch { puzzlesData = []; }
}

function renderPuzzles() {
  const el = $('#puzzle-container');
  if (!el) return;
  if (!puzzlesData.length) { el.innerHTML = '<div class="empty">No puzzles loaded.</div>'; return; }
  const puzzle = puzzlesData[state.puzzleIndex % puzzlesData.length];
  const g = new Chess(puzzle.fen);
  const board = g.board();

  let html = `<h3 style="margin-top:0">${puzzle.title}</h3>`;
  html += `<div class="muted" style="margin-bottom:8px">${puzzle.hint}</div>`;
  html += `<div class="puzzle-board">`;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const cell = board[r][c];
      const light = (r + c) % 2 === 0;
      const piece = cell ? cell.type.toUpperCase() : '';
      const color = cell ? cell.color : '';
      html += `<div class="square ${light ? 'light' : 'dark'}" data-r="${r}" data-c="${c}">${cell ? piece : ''}</div>`;
    }
  }
  html += `</div>`;
  html += `<div style="margin-top:10px"><span class="badge">Difficulty ${puzzle.difficulty}</span> <span class="badge">${puzzle.theme}</span></div>`;
  el.innerHTML = html;

  // click handler for puzzle squares
  let selected = null;
  el.querySelectorAll('.square').forEach(sq => {
    sq.addEventListener('click', () => {
      const r = parseInt(sq.dataset.r, 10), c = parseInt(sq.dataset.c, 10);
      const cell = board[r][c];
      if (selected) {
        const fromR = selected.r, fromC = selected.c;
        const fromFile = fromC, fromRank = 7 - fromR;
        const toFile = c, toRank = 7 - r;
        const fromSq = squareName(fromFile, fromRank);
        const toSq = squareName(toFile, toRank);
        const g2 = new Chess(puzzle.fen);
        const moves = g2.moves({ verbose: true });
        const m = moves.find(mv => mv.from === fromSq && mv.to === toSq);
        if (m) {
          const isMate = m.san.includes('#') || m.san.includes('+');
          const isCorrect = (puzzle.solution && m.san === puzzle.solution) || isMate;
          if (isCorrect) {
            sq.classList.add('hl');
            el.querySelector('.square')?.classList.remove('hl-bad');
            alert('Correct! ' + m.san + ' is the best move.');
            savePuzzleAttempt(puzzle.id, true);
            state.puzzleSolved = true;
          } else {
            sq.classList.add('hl-bad');
            alert('Not quite. Try again.');
            savePuzzleAttempt(puzzle.id, false);
          }
          selected = null;
          return;
        }
      }
      if (cell) {
        selected = { r, c };
        el.querySelectorAll('.square').forEach(s => s.classList.remove('hl', 'hl-bad'));
        sq.classList.add('hl');
      } else {
        selected = null;
        el.querySelectorAll('.square').forEach(s => s.classList.remove('hl', 'hl-bad'));
      }
    });
  });
}

async function savePuzzleAttempt(puzzleId, solved) {
  try { await fetch('/api/puzzle_attempts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ puzzle_id: puzzleId, solved }) }); } catch {}
}

// ---------- learn page ----------
async function renderLearn() {
  const el = $('#learn-container');
  if (!el) return;
  el.innerHTML = '<div class="muted">Loading…</div>';
  try {
    const r = await fetch('/api/education').then(r => r.json());
    el.innerHTML = r.sections.map(s => `
      <div class="card" style="margin-bottom:10px">
        <h3>${s.title}</h3>
        <p style="line-height:1.55;color:#c8d2dc">${s.body}</p>
      </div>`).join('');
  } catch { el.innerHTML = '<div class="empty">Could not load education content.</div>'; }
}

// ---------- ratings ----------
async function renderRatings() {
  const el = $('#rating-ring');
  const num = $('#rating-num');
  const detail = $('#rating-detail');
  const list = $('#games-list');
  try {
    const r = await fetch('/api/rating').then(r => r.json());
    const g2 = r.glicko2 || {};
    const mu = Math.round(g2.mu ?? 1500);
    num.textContent = mu;
    // ring fill: map 1200-1900 to 0-360deg
    const fill = Math.max(0, Math.min(360, (mu - 1200) / (1900 - 1200) * 360));
    el.style.setProperty('--fill', fill + 'deg');
    detail.textContent = `${r.count || 0} games played · uncertainty ${Math.round((g2.phi || 0.6) * 100) / 100}`;
    if (list) {
      const g = await fetch('/api/games').then(r => r.json());
      list.innerHTML = g.games && g.games.length ? g.games.map(game => `
        <div class="card" style="margin-bottom:8px">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <div><strong>${game.opponent}</strong><div class="muted" style="font-size:.75rem">${game.date}</div></div>
            <div><span class="badge ${game.result === 'win' ? 'good' : game.result === 'loss' ? 'bad' : 'ok'}">${game.result}</span></div>
          </div>
          <div class="muted" style="font-size:.75rem;margin-top:6px">${game.moves} moves · ${Math.round(game.rating_before)} → ${Math.round(game.rating_after)}</div>
        </div>`).join('') : '<div class="empty">No games yet. Play one!</div>';
    }
  } catch {
    if (detail) detail.textContent = 'Rating unavailable';
  }
}

// ---------- chat ----------
function initChat() {
  const toggle = $('#chat-toggle');
  const close = $('#chat-close');
  const log = $('#chat-log');
  const panel = $('#chat-panel');
  const input = $('#chat-input');
  const send = $('#chat-send');

  toggle.addEventListener('click', () => log.classList.toggle('open'));
  close.addEventListener('click', () => log.classList.remove('open'));

  send.addEventListener('click', () => sendChatMessage());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); }
  });

  // poll for replies
  setInterval(pollChat, 3000);
  pollChat();
}

async function sendChatMessage() {
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 32);
  addChatBubble('user', text);
  // send current game context so the coach can ground answers
  const context = [
    'Current FEN: ' + currentFen(),
    'Difficulty: ' + (LEVELS[state.level] ? LEVELS[state.level].name : '?'),
    'Moves so far: ' + state.history.slice(-12).map(m => m.san || m.lan || m.text || '').join(' '),
  ].join('\n');
  try {
    await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: text, id, context }) });
    pollChat();
  } catch { addChatBubble('hermes', 'Could not send. Is the server running?'); }
}

function addChatBubble(who, text) {
  const log = $('#chat-messages');
  if (!log) return;
  const div = document.createElement('div');
  div.className = 'chat-msg ' + (who === 'user' ? 'user' : 'hermes');
  div.innerHTML = `<div class="who">${who === 'user' ? 'You' : 'Hermes'}</div><div>${escapeHtml(text)}</div>`;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

async function pollChat() {
  try {
    const r = await fetch('/api/chat').then(r => r.json());
    const messages = r.messages || [];
    const log = $('#chat-messages');
    if (!log) return;
    // render from server (source of truth)
    log.innerHTML = messages.map(m => `
      <div class="chat-msg user"><div class="who">You</div><div>${escapeHtml(m.question)}</div></div>
      ${m.answer ? `<div class="chat-msg hermes"><div class="who">Hermes</div><div>${escapeHtml(m.answer)}</div></div>` : (m.status === 'queued' ? '<div class="chat-msg hermes"><div class="who">Hermes</div><div class="muted">Thinking…</div></div>' : '')}
    `).join('');
    log.scrollTop = log.scrollHeight;
  } catch {}
}

// ---------- buttons ----------
function initButtons() {
  $('#btn-new')?.addEventListener('click', () => { resetGame(); });
  $('#btn-undo')?.addEventListener('click', () => {
    if (state.history.length) { state.history.pop(); state.viewIndex = state.history.length; state.game = new Chess(currentFen()); renderBoard(); renderMoveList(); }
  });
  $('#btn-back')?.addEventListener('click', () => {
    if (state.viewIndex > 0) { state.viewIndex--; renderBoard(); renderMoveList(); }
  });
  $('#btn-forward')?.addEventListener('click', () => {
    if (state.viewIndex < state.history.length) { state.viewIndex++; renderBoard(); renderMoveList(); }
  });
  $('#btn-flip')?.addEventListener('click', () => { state.orientation = state.orientation === 'w' ? 'b' : 'w'; renderBoard(); });
  $$('#difficulty-row button').forEach(btn => {
    btn.addEventListener('click', () => {
      state.level = parseInt(btn.dataset.level, 10);
      $$('#difficulty-row button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      resetGame();
    });
  });
  $('#btn-next-puzzle')?.addEventListener('click', () => { state.puzzleIndex = (state.puzzleIndex + 1) % Math.max(1, puzzlesData.length); renderPuzzles(); });
  $('#btn-reset-puzzle')?.addEventListener('click', () => { state.puzzleSolved = false; renderPuzzles(); });

  // canvas click
  $('#board-canvas')?.addEventListener('click', onCanvasClick);
}

initButtons();
