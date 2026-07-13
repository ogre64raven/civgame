// HTTP 정적 서빙 + 관리자 API + WebSocket 게임 서버
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { World } = require('./world');
const { Game } = require('./game');

const PORT = process.env.PORT || 3000;
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'admin1234';
const CLIENT_DIR = path.join(__dirname, '../client');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };

const world = new World();
let game;

function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === 1) c.send(s);
}
function sendTo(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}
function wsOfCiv(civId) {
  for (const c of wss.clients) if (c.civId === civId && c.readyState === 1) return c;
  return null;
}

function makeGame() {
  const g = new Game(world, broadcast);
  g.onExec = (result) => {
    broadcast({
      type: 'exec', turn: g.turn,
      moves: result.moves, battles: result.battles, deaths: result.deaths,
      stuns: result.stuns, births: result.births, conquests: result.conquests,
      delegations: result.delegations, techUpdates: result.techUpdates,
      allyLeft: result.allyLeft, absorptions: result.absorptions, scores: result.scores,
    });
    for (const c of wss.clients) {
      if (c.readyState !== 1 || c.civId == null) continue;
      const civ = g.civs.get(c.civId);
      if (!civ) continue;
      sendTo(c, { type: 'resources', resources: civ.resources, gained: result.gains[c.civId] || null });
      const sf = result.spawnFails.find(f => f.civId === c.civId);
      if (sf) sendTo(c, { type: 'spawnFailed', reason: sf.reason });
      const rf = result.researchFails.find(f => f.civId === c.civId);
      if (rf) sendTo(c, { type: 'researchFailed', reason: rf.reason });
    }
    if (result.gameover) broadcast({ type: 'gameover', ...result.gameover });
  };
  return g;
}

// ── 관리자 API
function adminState() {
  return {
    state: game.state, phase: game.phase, turn: game.turn,
    endsAt: game.phaseEnds, settings: game.settings,
    playerCount: game.civs.size,
    players: [...game.civs.values()].map(c => ({
      id: c.id, name: c.name, code: c.code, player: c.player,
      connected: c.connected, alive: c.alive, conqueredBy: c.conqueredBy,
      units: game.unitCountOf(c.id), score: game.score(c),
    })),
    spectators: [...wss.clients].filter(c => c.readyState === 1 && c.civId == null).length,
    eligibleCountries: game.pool.length + game.civs.size,
  };
}

function handleAdmin(req, res, url, body) {
  if (req.headers['x-admin-pass'] !== ADMIN_PASS) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'unauthorized' }));
  }
  const send = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  if (req.method === 'POST' && url === '/api/admin/login') return send(200, { ok: true });
  if (req.method === 'GET' && url === '/api/admin/state') return send(200, adminState());
  if (req.method === 'POST' && url === '/api/admin/start') {
    const r = game.startGame();
    if (!r.ok) return send(400, r);
    broadcast({
      type: 'gameStarted',
      units: [...game.units.values()],
      phase: game.phase, turn: game.turn, endsAt: game.phaseEnds,
    });
    return send(200, { ok: true });
  }
  if (req.method === 'POST' && url === '/api/admin/reset') {
    clearTimeout(game.timer);
    game = makeGame();
    broadcast({ type: 'reset' });
    return send(200, { ok: true });
  }
  if (req.method === 'POST' && url === '/api/admin/kick') {
    const civId = Number(body.civId);
    const target = wsOfCiv(civId);
    const ok = game.kick(civId);
    if (!ok) return send(400, { error: 'no such civ' });
    broadcast({ type: 'civKicked', civId });
    if (target) { sendTo(target, { type: 'kicked' }); target.close(); }
    return send(200, { ok: true });
  }
  if (req.method === 'POST' && url === '/api/admin/settings') {
    const s = game.updateSettings(body);
    return send(200, { ok: true, settings: s });
  }
  send(404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  if (url.startsWith('/api/admin/')) {
    if (req.method === 'POST') {
      let raw = '';
      req.on('data', (d) => { raw += d; if (raw.length > 4096) req.destroy(); });
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch { }
        handleAdmin(req, res, url, body);
      });
    } else {
      handleAdmin(req, res, url, {});
    }
    return;
  }

  let p = url;
  if (p === '/') p = '/index.html';
  if (p === '/admin') p = '/admin.html';
  const file = path.join(CLIENT_DIR, path.normalize(p));
  if (!file.startsWith(CLIENT_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not Found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
game = makeGame();

wss.on('connection', (ws) => {
  ws.civId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'join': {
        const r = game.join(msg.token, msg.name);
        if (r.spectator) {
          sendTo(ws, { type: 'welcome', spectator: true, map: world.toJSON(), ...game.snapshot() });
          return;
        }
        ws.civId = r.civ.id;
        sendTo(ws, {
          type: 'welcome',
          you: r.civ.id,
          token: r.civ.token,
          map: world.toJSON(),
          resources: r.civ.resources,
          orders: game.ordersOf(r.civ.id),
          proposals: [...(game.allyProposals.get(r.civ.id) || [])],
          ...game.snapshot(),
        });
        broadcast({
          type: r.isNew ? 'civJoined' : 'civResumed',
          civ: game.civPublic(r.civ),
          units: r.isNew ? [...game.units.values()].filter(u => u.civ === r.civ.id) : undefined,
        });
        break;
      }
      case 'order.move': {
        if (ws.civId == null) return;
        const r = game.moveOrder(ws.civId, msg.unitId, msg.target);
        if (r.ok) sendTo(ws, { type: 'orderAck', unitId: msg.unitId, path: r.path });
        else sendTo(ws, { type: 'orderRejected', unitId: msg.unitId, reason: r.reason });
        break;
      }
      case 'order.stop': {
        if (ws.civId == null) return;
        game.cancelOrder(ws.civId, msg.unitId);
        sendTo(ws, { type: 'orderAck', unitId: msg.unitId, path: [] });
        break;
      }
      case 'order.spawn': {
        if (ws.civId == null) return;
        const r = game.spawnOrder(ws.civId, msg.hex);
        if (r.ok) sendTo(ws, { type: 'spawnAck', hex: msg.hex });
        else sendTo(ws, { type: 'spawnRejected', reason: r.reason });
        break;
      }
      case 'order.research': {
        if (ws.civId == null) return;
        const r = game.researchOrder(ws.civId, msg.branch);
        if (r.ok) sendTo(ws, { type: 'researchAck', branch: r.branch, cost: r.cost, res: r.res });
        else sendTo(ws, { type: 'researchRejected', reason: r.reason });
        break;
      }
      case 'ally.propose': {
        if (ws.civId == null) return;
        const r = game.proposeAlly(ws.civId, msg.civId);
        if (!r.ok) { sendTo(ws, { type: 'allyRejected', reason: r.reason }); break; }
        if (r.formed) broadcast({ type: 'allyFormed', pair: r.formed });
        else {
          sendTo(ws, { type: 'allyProposeAck', civId: msg.civId });
          sendTo(wsOfCiv(msg.civId), { type: 'allyProposed', from: ws.civId });
        }
        break;
      }
      case 'ally.accept': {
        if (ws.civId == null) return;
        const r = game.acceptAlly(ws.civId, msg.civId);
        if (r.ok) broadcast({ type: 'allyFormed', pair: r.formed });
        else sendTo(ws, { type: 'allyRejected', reason: r.reason });
        break;
      }
      case 'ally.leave': {
        if (ws.civId == null) return;
        const r = game.leaveAlly(ws.civId, msg.civId);
        if (r.ok) sendTo(ws, { type: 'allyLeaveAck', civId: msg.civId });
        else sendTo(ws, { type: 'allyRejected', reason: r.reason });
        break;
      }
      case 'chat': {
        if (ws.civId == null) return;
        const text = String(msg.text || '').trim().slice(0, 200);
        if (!text) return;
        const from = ws.civId;
        if (msg.to === 'all') {
          broadcast({ type: 'chat', scope: 'all', from, text });
        } else if (msg.to === 'ally') {
          const allies = game.allies.get(from) || new Set();
          const payload = { type: 'chat', scope: 'ally', from, text };
          sendTo(ws, payload);
          for (const id of allies) sendTo(wsOfCiv(id), payload);
        } else if (typeof msg.to === 'number' && game.civs.has(msg.to) && msg.to !== from) {
          const payload = { type: 'chat', scope: 'dm', from, to: msg.to, text };
          sendTo(ws, payload);
          sendTo(wsOfCiv(msg.to), payload);
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    if (ws.civId != null) {
      game.disconnect(ws.civId);
      broadcast({ type: 'civLeft', civId: ws.civId });
    }
  });
});

server.listen(PORT, () => console.log(`온라인 문명 서버 가동: http://localhost:${PORT} (관리자: /admin)`));
