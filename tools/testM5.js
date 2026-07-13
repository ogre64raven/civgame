// M5 검증: 채팅 라우팅 (전체/동맹/귓속말, 관전자 발신 차단)
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

const PORT = 3200;
let fail = 0;
const check = (cond, label) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + label);
  if (!cond) fail++;
};

function startServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(__dirname, '../server/index.js')], {
      env: { ...process.env, PORT, PHASE_MEETING_MS: '600000', PHASE_EXEC_MS: '1000' },
    });
    proc.stdout.on('data', (d) => { if (String(d).includes('가동')) resolve(proc); });
    proc.stderr.on('data', (d) => console.error('서버 오류:', String(d)));
    proc.on('exit', (c) => { if (c) reject(new Error('server exit ' + c)); });
    setTimeout(() => reject(new Error('server start timeout')), 8000);
  });
}

class Client {
  constructor(name) { this.name = name; this.inbox = []; this.waiters = []; }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://localhost:${PORT}`);
      this.ws.on('open', () => this.ws.send(JSON.stringify({ type: 'join', name: this.name })));
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
  next(pred, ms = 5000) {
    return new Promise((resolve, reject) => {
      const hit = this.inbox.find(pred);
      if (hit) return resolve(hit);
      const t = setTimeout(() => reject(new Error('timeout')), ms);
      this.waiters.push((m) => { if (pred(m)) { clearTimeout(t); resolve(m); return true; } return false; });
    });
  }
  chats() { return this.inbox.filter(m => m.type === 'chat'); }
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const server = await startServer();
  try {
    const A = new Client('갑'), B = new Client('을'), C = new Client('병');
    await A.connect(); await B.connect(); await C.connect();
    const aId = A.welcome.you, bId = B.welcome.you, cId = C.welcome.you;

    // A-B 동맹
    A.send({ type: 'ally.propose', civId: bId });
    await B.next(m => m.type === 'allyProposed' && m.from === aId);
    B.send({ type: 'ally.accept', civId: aId });
    await A.next(m => m.type === 'allyFormed');

    // 1. 전체 채팅 → 3명 모두 수신
    A.send({ type: 'chat', to: 'all', text: '안녕하세요' });
    const c1 = await C.next(m => m.type === 'chat' && m.text === '안녕하세요');
    await B.next(m => m.type === 'chat' && m.text === '안녕하세요');
    await A.next(m => m.type === 'chat' && m.text === '안녕하세요');
    check(c1.scope === 'all' && c1.from === aId, '전체 채팅: 모두 수신');

    // 2. 동맹 채팅 → A, B만 수신
    A.send({ type: 'chat', to: 'ally', text: '동맹비밀' });
    const b2 = await B.next(m => m.type === 'chat' && m.text === '동맹비밀');
    check(b2.scope === 'ally', '동맹 채팅: 동맹 수신');
    await wait(500);
    check(!C.chats().some(m => m.text === '동맹비밀'), '동맹 채팅: 비동맹 미수신');

    // 3. 귓속말 → 대상만 수신
    A.send({ type: 'chat', to: cId, text: '귓속말테스트' });
    const c3 = await C.next(m => m.type === 'chat' && m.text === '귓속말테스트');
    check(c3.scope === 'dm' && c3.from === aId && c3.to === cId, '귓속말: 대상 수신');
    await wait(500);
    check(!B.chats().some(m => m.text === '귓속말테스트'), '귓속말: 제3자 미수신');

    // 4. 빈/공백 메시지 무시
    A.send({ type: 'chat', to: 'all', text: '   ' });
    await wait(500);
    check(!B.chats().some(m => m.text?.trim() === ''), '공백 메시지 무시');

    // 5. 200자 초과 잘림
    A.send({ type: 'chat', to: 'all', text: 'x'.repeat(500) });
    const b5 = await B.next(m => m.type === 'chat' && m.text.startsWith('xxx'));
    check(b5.text.length === 200, `긴 메시지 200자 제한 (${b5.text.length})`);

    console.log(fail === 0 ? '\n모든 테스트 통과' : `\n실패 ${fail}건`);
    process.exitCode = fail === 0 ? 0 : 1;
  } catch (e) {
    console.error('테스트 오류:', e.message);
    process.exitCode = 1;
  } finally {
    server.kill();
    process.exit();
  }
})();
