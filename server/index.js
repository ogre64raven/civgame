// HTTP 정적 서빙 + WebSocket 게임 서버
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { World } = require('./world');
const { Game } = require('./game');

const PORT = process.env.PORT || 3000;
const CLIENT_DIR = path.join(__dirname, '../client');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };

const server = http.createServer((req, res) => {
  let p = req.url.split('?')[0];
  if (p === '/') p = '/index.html';
  const file = path.join(CLIENT_DIR, path.normalize(p));
  if (!file.startsWith(CLIENT_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not Found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

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

const world = new World();
const game = new Game(world, broadcast);

// 실행 턴 결과: 공개 정보는 브로드캐스트, 자원·실패 통지는 각자에게만
game.onExec = (result) => {
  broadcast({
    type: 'exec', turn: game.turn,
    moves: result.moves, battles: result.battles, deaths: result.deaths,
    stuns: result.stuns, births: result.births, conquests: result.conquests,
    delegations: result.delegations, techUpdates: result.techUpdates,
    allyLeft: result.allyLeft, absorptions: result.absorptions, scores: result.scores,
  });
  for (const c of wss.clients) {
    if (c.readyState !== 1 || c.civId == null) continue;
    const civ = game.civs.get(c.civId);
    if (!civ) continue;
    sendTo(c, { type: 'resources', resources: civ.resources, gained: result.gains[c.civId] || null });
    const sf = result.spawnFails.find(f => f.civId === c.civId);
    if (sf) sendTo(c, { type: 'spawnFailed', reason: sf.reason });
    const rf = result.researchFails.find(f => f.civId === c.civId);
    if (rf) sendTo(c, { type: 'researchFailed', reason: rf.reason });
  }
  if (result.gameover) {
    broadcast({ type: 'gameover', ...result.gameover });
  }
};

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
        if (ws.civId == null) return; // 관전자는 발신 불가
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

server.listen(PORT, () => console.log(`온라인 문명 서버 가동: http://localhost:${PORT}`));
