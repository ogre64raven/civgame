// 통합 테스트 공용: 서버 스폰·WS 클라이언트·관리자 API
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

const ADMIN_PASS = 'testpass';
const ROOM = '1111'; // 테스트 고정 방 번호

function startServer(port, env = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(__dirname, '../server/index.js')], {
      env: { ...process.env, PORT: port, ADMIN_PASSWORD: ADMIN_PASS, ROOM, ...env },
    });
    proc.stdout.on('data', (d) => { if (String(d).includes('가동')) resolve(proc); });
    proc.stderr.on('data', (d) => console.error('서버 오류:', String(d)));
    proc.on('exit', (c) => { if (c) reject(new Error('server exit ' + c)); });
    setTimeout(() => reject(new Error('server start timeout')), 8000);
  });
}

async function admin(port, method, ep, body, pass = ADMIN_PASS) {
  const res = await fetch(`http://localhost:${port}/api/admin/${ep}`, {
    method,
    headers: { 'x-admin-pass': pass, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

class Client {
  constructor(name, port, room = ROOM) { this.name = name; this.port = port; this.room = room; this.inbox = []; this.waiters = []; }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://localhost:${this.port}`);
      this.ws.on('open', () => this.ws.send(JSON.stringify({ type: 'join', name: this.name, room: this.room })));
      this.ws.on('message', (raw) => {
        const m = JSON.parse(raw);
        if (m.type === 'welcome') { this.welcome = m; resolve(m); }
        this.inbox.push(m);
        this.waiters = this.waiters.filter(w => !w(m));
      });
      this.ws.on('error', reject);
      setTimeout(() => reject(new Error('join timeout')), 8000);
    });
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  next(pred, ms = 8000) {
    return new Promise((resolve, reject) => {
      const hit = this.inbox.find(pred);
      if (hit) return resolve(hit);
      const t = setTimeout(() => reject(new Error('message timeout')), ms);
      this.waiters.push((m) => { if (pred(m)) { clearTimeout(t); resolve(m); return true; } return false; });
    });
  }
  clearInbox() { this.inbox = []; }
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));

module.exports = { startServer, admin, Client, wait, ADMIN_PASS, ROOM };
