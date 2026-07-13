// 접속·상태 동기화·HUD·유닛 명령·연구·외교·채팅
(() => {
  const state = {
    map: null,
    civs: new Map(),
    units: new Map(),
    myOrders: new Map(),
    selected: null,
    resources: { meat: 0, grain: 0, wood: 0, iron: 0 },
    alliances: new Set(),  // 'minId:maxId'
    proposals: new Set(),
    queuedResearch: null,
    you: null,
    phase: 'MEETING',
    turn: 1,
    turnLimit: 120,
    endsAt: 0,
    spectator: false,
    ended: false,
  };
  window.gameState = state;

  const $ = (id) => document.getElementById(id);
  const REASON_KO = {
    phase: '회의 턴에만 명령할 수 있습니다', unit: '내 유닛이 아닙니다',
    target: '이동할 수 없는 지형입니다', path: '길이 없습니다 (바다로 막힘)',
    cap: '인구 상한(12기)에 도달했습니다', cost: '자원이 부족합니다',
    nounit: '해당 헥스에 내 유닛이 없습니다', dead: '점령된 문명은 사용할 수 없습니다',
    max: '이미 최고 레벨입니다', branch: '알 수 없는 연구입니다',
    already: '이미 동맹입니다', noproposal: '해당 제안이 없습니다',
    notally: '동맹이 아닙니다', civ: '대상이 올바르지 않습니다',
  };
  const TECH_KO = { military: '군사', gather: '채집', move: '이동', growth: '인구' };
  const TECH_RES_KO = { military: '철', gather: '목재', move: '곡식', growth: '고기' };
  let ws;

  const isMine = (u) => u.civ === state.you || u.controller === state.you;
  const civName = (id) => { const c = state.civs.get(id); return c ? c.name : '?'; };
  const pairKey = (a, b) => Math.min(a, b) + ':' + Math.max(a, b);
  const isAlly = (id) => state.you != null && state.alliances.has(pairKey(state.you, id));
  const typing = () => document.activeElement === $('chatInput') || document.activeElement === $('nameInput');

  function connect(name) {
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    ws = new WebSocket(proto + location.host);
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'join', name, token: sessionStorage.getItem('civToken') || undefined }));
    };
    ws.onmessage = (e) => handle(JSON.parse(e.data));
    ws.onclose = () => {
      if (state.ended) return;
      $('joinMsg').textContent = '서버 연결이 끊어졌습니다. 새로고침하세요.';
      $('joinOverlay').style.display = 'flex';
    };
    ws.onerror = () => { $('joinMsg').textContent = '서버에 연결할 수 없습니다.'; };
  }

  function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

  function handle(msg) {
    switch (msg.type) {
      case 'welcome': {
        state.map = msg.map;
        state.civs = new Map(msg.civs.map(c => [c.id, c]));
        state.units = new Map((msg.units || []).map(u => [u.id, u]));
        state.phase = msg.phase; state.turn = msg.turn; state.endsAt = msg.endsAt;
        state.turnLimit = msg.turnLimit || 120;
        state.ended = !!msg.ended;
        state.spectator = !!msg.spectator;
        state.alliances = new Set((msg.alliances || []).map(([a, b]) => pairKey(a, b)));
        state.proposals = new Set(msg.proposals || []);
        if (msg.token) sessionStorage.setItem('civToken', msg.token);
        if (msg.you != null) state.you = msg.you;
        if (msg.resources) state.resources = msg.resources;
        state.myOrders = new Map((msg.orders || []).map(o => [o.unitId, o.path]));

        $('joinOverlay').style.display = 'none';
        $('phaseHud').style.display = '';
        $('playersHud').style.display = '';
        $('chatHud').style.display = '';
        if (state.spectator) {
          $('chatForm').style.display = 'none';
          toast('정원(30명)이 가득 차 관전자로 입장했습니다');
        } else {
          const me = state.civs.get(state.you);
          $('myHud').style.display = '';
          $('resHud').style.display = '';
          $('helpHud').style.display = '';
          $('myFlag').style.background = me.color;
          $('myCountry').textContent = `${me.name} (${me.code})`;
          Render.centerOn(me.capital[0], me.capital[1]);
          toast(`당신은 ${me.name}입니다!`);
        }
        updateHud();
        renderPlayers();
        break;
      }
      case 'civJoined': {
        state.civs.set(msg.civ.id, msg.civ);
        for (const u of msg.units || []) state.units.set(u.id, u);
        if (msg.civ.id !== state.you) toast(`${msg.civ.name} 입장 (${msg.civ.player})`);
        renderPlayers();
        break;
      }
      case 'civResumed': {
        state.civs.set(msg.civ.id, msg.civ);
        renderPlayers();
        break;
      }
      case 'civLeft': {
        const c = state.civs.get(msg.civId);
        if (c) c.connected = false;
        renderPlayers();
        break;
      }
      case 'phase': {
        state.phase = msg.phase; state.turn = msg.turn; state.endsAt = msg.endsAt;
        if (msg.phase === 'MEETING') state.queuedResearch = null;
        updateHud();
        break;
      }
      case 'exec': {
        for (const u of state.units.values()) if (u.stunned > 0) u.stunned--;

        for (const mv of msg.moves) {
          const u = state.units.get(mv.unitId);
          if (u) { u.x = mv.x; u.y = mv.y; }
          const path = state.myOrders.get(mv.unitId);
          if (path) {
            const i = path.findIndex(([px, py]) => px === mv.x && py === mv.y);
            if (i >= 0) {
              const rest = path.slice(i + 1);
              if (rest.length) state.myOrders.set(mv.unitId, rest);
              else state.myOrders.delete(mv.unitId);
            }
          }
        }

        for (const s of msg.stuns || []) {
          const u = state.units.get(s.unitId);
          if (u) u.stunned = s.turns;
        }
        for (const id of msg.deaths || []) {
          state.units.delete(id);
          state.myOrders.delete(id);
          if (state.selected === id) state.selected = null;
        }
        for (const nu of msg.births || []) {
          state.units.set(nu.id, nu);
          if (nu.civ === state.you) toast('새 인구 유닛이 태어났습니다');
        }
        for (const d of msg.delegations || []) {
          const u = state.units.get(d.unitId);
          if (u) u.controller = d.controller;
          if (d.controller === state.you) toast(`점령국이 유닛 #${d.unitId}을 위임했습니다`);
        }
        for (const t of msg.techUpdates || []) {
          const c = state.civs.get(t.civId);
          if (c) c.tech[t.branch] = t.level;
          if (t.civId === state.you) toast(`연구 완료 — ${TECH_KO[t.branch]} Lv${t.level}`);
        }
        for (const b of msg.battles || []) {
          const mine = b.civs.find(c => c.civId === state.you);
          if (!mine) continue;
          if (mine.lost > 0) toast(`전투 패배! 유닛 ${mine.lost}기 잃음`);
          else if (b.civs.every(c => c.lost === 0)) toast('전투 — 전투력 동률, 양측 행동불능');
          else toast('전투 승리!');
        }
        for (const [a, b] of msg.allyLeft || []) {
          state.alliances.delete(pairKey(a, b));
          if (a === state.you || b === state.you) toast(`동맹 해체: ${civName(a)} - ${civName(b)}`);
        }
        for (const cq of msg.conquests || []) {
          const c = state.civs.get(cq.civId);
          if (c) { c.alive = false; c.conqueredBy = cq.by; }
          if (cq.civId === state.you) toast(`게임오버 — ${civName(cq.by)}에게 점령되었습니다. 위임 유닛으로 계속 플레이합니다`);
          else if (cq.by === state.you) toast(`${civName(cq.civId)}을(를) 점령했습니다!`);
          else toast(`${civName(cq.civId)}이(가) ${civName(cq.by)}에게 점령되었습니다`);
        }
        for (const ab of msg.absorptions || []) {
          const c = state.civs.get(ab.civId);
          if (c) { c.alive = false; c.conqueredBy = ab.by; }
          for (const u of state.units.values()) if (u.civ === ab.civId) u.civ = ab.by;
          if (ab.civId === state.you) toast(`동맹 세력비 8:2 초과 — ${civName(ab.by)}에 흡수되었습니다`);
          else if (ab.by === state.you) toast(`${civName(ab.civId)}을(를) 흡수했습니다!`);
          else toast(`${civName(ab.civId)}이(가) ${civName(ab.by)}에 흡수되었습니다`);
        }
        updateHud();
        renderPlayers();
        break;
      }
      case 'resources': {
        state.resources = msg.resources;
        if (msg.gained) {
          const parts = [];
          const KO = { meat: '고기', grain: '곡식', wood: '목재', iron: '철' };
          for (const [k, v] of Object.entries(msg.gained)) if (v > 0) parts.push(`${KO[k]} +${v}`);
          if (parts.length) toast(parts.join(' · '));
        }
        updateHud();
        break;
      }
      case 'orderAck': {
        if (msg.path && msg.path.length) state.myOrders.set(msg.unitId, msg.path);
        else state.myOrders.delete(msg.unitId);
        break;
      }
      case 'orderRejected': {
        toast(REASON_KO[msg.reason] || '명령이 거부되었습니다');
        break;
      }
      case 'spawnAck': {
        toast('생산 예약 완료 — 실행 턴에 유닛이 생성됩니다');
        break;
      }
      case 'spawnRejected':
      case 'spawnFailed': {
        toast('생산 실패: ' + (REASON_KO[msg.reason] || msg.reason));
        break;
      }
      case 'researchAck': {
        state.queuedResearch = msg.branch;
        toast(`연구 예약 — ${TECH_KO[msg.branch]} (${TECH_RES_KO[msg.branch]} ${msg.cost} 소모)`);
        updateHud();
        break;
      }
      case 'researchRejected':
      case 'researchFailed': {
        state.queuedResearch = null;
        toast('연구 실패: ' + (REASON_KO[msg.reason] || msg.reason));
        updateHud();
        break;
      }
      case 'allyProposed': {
        state.proposals.add(msg.from);
        toast(`${civName(msg.from)}이(가) 동맹을 제안했습니다`);
        renderPlayers();
        break;
      }
      case 'allyProposeAck': {
        toast(`${civName(msg.civId)}에 동맹 제안을 보냈습니다`);
        break;
      }
      case 'allyFormed': {
        const [a, b] = msg.pair;
        state.alliances.add(pairKey(a, b));
        state.proposals.delete(a);
        state.proposals.delete(b);
        if (a === state.you || b === state.you) toast(`동맹 성립: ${civName(a)} - ${civName(b)}`);
        renderPlayers();
        break;
      }
      case 'allyLeaveAck': {
        toast('동맹 파기 선언 — 다음 실행 턴에 해체됩니다');
        break;
      }
      case 'allyRejected': {
        toast('외교 실패: ' + (REASON_KO[msg.reason] || msg.reason));
        break;
      }
      case 'chat': {
        appendChat(msg);
        break;
      }
      case 'gameover': {
        state.ended = true;
        showGameover(msg);
        break;
      }
    }
  }

  // ── 채팅
  function appendChat(msg) {
    const log = $('chatLog');
    const line = document.createElement('div');
    line.className = 'chat-line' + (msg.scope === 'dm' ? ' dm' : msg.scope === 'ally' ? ' ally' : '');
    const scope = document.createElement('span');
    scope.className = 'scope';
    scope.textContent = msg.scope === 'dm'
      ? (msg.from === state.you ? `[→${civName(msg.to)}]` : '[귓속말]')
      : msg.scope === 'ally' ? '[동맹]' : '';
    const nm = document.createElement('span');
    nm.className = 'cnm';
    const c = state.civs.get(msg.from);
    if (c) nm.style.color = c.color;
    nm.textContent = civName(msg.from) + ': ';
    const tx = document.createElement('span');
    tx.textContent = msg.text;
    line.append(scope, nm, tx);
    log.append(line);
    while (log.children.length > 100) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;
  }

  $('chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('chatInput').value.trim();
    if (!text || state.spectator) return;
    const to = $('chatTo').value;
    send({ type: 'chat', to: to === 'all' || to === 'ally' ? to : Number(to), text });
    $('chatInput').value = '';
  });

  function updateChatTargets() {
    const sel = $('chatTo');
    const cur = sel.value;
    sel.innerHTML = '';
    const optAll = new Option('전체', 'all');
    const optAlly = new Option('동맹', 'ally');
    sel.append(optAll, optAlly);
    for (const c of state.civs.values()) {
      if (c.id === state.you) continue;
      sel.append(new Option('→' + c.name, String(c.id)));
    }
    if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
  }

  // ── 헥스 클릭: 내 유닛 선택 → 목표 클릭 시 이동 명령
  window.addEventListener('hexclick', (e) => {
    if (state.spectator || state.you == null || state.ended) return;
    const [hx, hy] = e.detail;
    const myUnitsHere = [...state.units.values()].filter(u => isMine(u) && u.x === hx && u.y === hy);

    if (myUnitsHere.length) {
      const idx = myUnitsHere.findIndex(u => u.id === state.selected);
      const next = myUnitsHere[(idx + 1) % myUnitsHere.length];
      state.selected = next.id;
      const path = state.myOrders.get(next.id);
      toast(`유닛 #${next.id} 선택` + (path ? ` (이동 중: ${path.length}칸 남음)` : ''));
      return;
    }

    if (state.selected != null) {
      if (state.phase !== 'MEETING') { toast('회의 턴에만 명령할 수 있습니다'); return; }
      if (state.map.rows[hy][hx] === '~') { toast('바다로는 이동할 수 없습니다'); return; }
      send({ type: 'order.move', unitId: state.selected, target: [hx, hy] });
    }
  });

  function requestSpawn() {
    if (state.spectator || state.you == null || state.ended) return;
    const me = state.civs.get(state.you);
    if (me && !me.alive) { toast(REASON_KO.dead); return; }
    let hex = null;
    if (state.selected != null) {
      const u = state.units.get(state.selected);
      if (u && u.civ === state.you) hex = [u.x, u.y];
    }
    if (!hex) {
      const first = [...state.units.values()].find(u => u.civ === state.you);
      if (first) hex = [first.x, first.y];
    }
    if (!hex) { toast('생산할 유닛 위치가 없습니다'); return; }
    send({ type: 'order.spawn', hex });
  }

  window.addEventListener('keydown', (e) => {
    if (typing()) return; // 채팅 입력 중엔 단축키 무시
    if (e.key === 'Escape') state.selected = null;
    if (e.key === 'x' && state.selected != null) {
      send({ type: 'order.stop', unitId: state.selected });
      toast('이동 취소');
    }
    if (e.key === 'b') requestSpawn();
    if (e.key === 'Enter' && state.map && !state.spectator) {
      e.preventDefault();
      $('chatInput').focus();
    }
  });
  $('spawnBtn').addEventListener('click', requestSpawn);

  // 연구 버튼
  for (const btn of document.querySelectorAll('.tech-btn')) {
    btn.addEventListener('click', () => {
      if (state.ended) return;
      send({ type: 'order.research', branch: btn.dataset.branch });
    });
  }

  function updateHud() {
    if (state.you == null) return;
    const me = state.civs.get(state.you);
    if (!me) return;
    if (!me.alive) {
      const delegated = [...state.units.values()].filter(u => u.controller === state.you).length;
      $('myInfo').textContent = `점령됨 — ${civName(me.conqueredBy)} 예속 (위임 유닛 ${delegated}기)`;
      $('spawnBtn').disabled = true;
    } else {
      const myCount = [...state.units.values()].filter(u => u.civ === state.you).length;
      const score = (me.tech.military + me.tech.gather + me.tech.move + me.tech.growth) + myCount;
      $('myInfo').textContent = `인구 ${myCount}/12 · 점수 ${score}`;
      $('spawnBtn').disabled = false;
    }
    const r = state.resources;
    $('resHud').textContent = `고기 ${r.meat} · 곡식 ${r.grain} · 목재 ${r.wood} · 철 ${r.iron}`;

    for (const btn of document.querySelectorAll('.tech-btn')) {
      const br = btn.dataset.branch;
      const lvl = me.tech[br];
      const maxed = lvl >= 5;
      btn.textContent = maxed
        ? `${TECH_KO[br]} Lv${lvl} (최고)`
        : `${TECH_KO[br]} Lv${lvl} → ${lvl + 1} (${TECH_RES_KO[br]} ${10 * (lvl + 1)})`;
      btn.disabled = maxed || !me.alive || state.spectator;
      btn.classList.toggle('queued', state.queuedResearch === br);
    }
  }

  function renderPlayers() {
    $('playerCount').textContent = state.civs.size;
    $('playerList').innerHTML = '';
    const meAlive = state.you != null && state.civs.get(state.you)?.alive;
    for (const c of state.civs.values()) {
      const row = document.createElement('div');
      row.className = 'player-row' + (c.connected ? '' : ' off');
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = c.color;
      const nm = document.createElement('span');
      nm.className = 'nm';
      const vassal = c.alive ? '' : ' [예속]';
      nm.textContent = `${c.name}${vassal} · ${c.player}${c.id === state.you ? ' (나)' : ''}`;
      row.append(dot, nm);

      if (state.you != null && c.id !== state.you && !state.spectator && meAlive && c.alive && !state.ended) {
        if (isAlly(c.id)) {
          const tag = document.createElement('span');
          tag.className = 'tag-ally';
          tag.textContent = '동맹';
          row.append(tag);
          const btn = document.createElement('button');
          btn.className = 'ally-btn leave';
          btn.textContent = '파기';
          btn.onclick = () => send({ type: 'ally.leave', civId: c.id });
          row.append(btn);
        } else if (state.proposals.has(c.id)) {
          const btn = document.createElement('button');
          btn.className = 'ally-btn accept';
          btn.textContent = '수락';
          btn.onclick = () => send({ type: 'ally.accept', civId: c.id });
          row.append(btn);
        } else {
          const btn = document.createElement('button');
          btn.className = 'ally-btn';
          btn.textContent = '동맹';
          btn.onclick = () => send({ type: 'ally.propose', civId: c.id });
          row.append(btn);
        }
      }
      $('playerList').append(row);
    }
    updateChatTargets();
  }

  function showGameover(msg) {
    const iWon = state.you != null && msg.winners.includes(state.you);
    $('overTitle').textContent = state.spectator ? '게임 종료' : (iWon ? '승리!' : '게임 종료');
    $('overReason').textContent =
      (msg.reason === 'domination' ? '제패 승리 — 마지막 생존 문명' : `점수 승리 — ${state.turnLimit}턴 도달`) +
      ' · 승자: ' + msg.winners.map(civName).join(', ');
    const box = $('overScores');
    box.innerHTML = '';
    const sorted = [...(msg.scores || [])].sort((a, b) => b.score - a.score);
    for (const s of sorted) {
      const row = document.createElement('div');
      row.className = 'score-row' + (msg.winners.includes(s.civId) ? ' winner' : '');
      const name = document.createElement('span');
      name.textContent = civName(s.civId) + (s.civId === state.you ? ' (나)' : '');
      const val = document.createElement('span');
      val.textContent = s.score;
      row.append(name, val);
      box.append(row);
    }
    $('overOverlay').style.display = 'flex';
  }

  let toastTimer;
  function toast(text) {
    const t = $('toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
  }

  // 페이즈 HUD + 렌더 루프
  function frame() {
    if (state.map) {
      const remain = Math.max(0, Math.ceil((state.endsAt - Date.now()) / 1000));
      $('turnLabel').textContent = `턴 ${state.turn}/${state.turnLimit}`;
      const pn = $('phaseName');
      if (state.ended) {
        pn.textContent = '게임 종료';
        pn.className = '';
        $('phaseTimer').textContent = '-';
      } else {
        pn.textContent = state.phase === 'MEETING' ? '회의 턴' : '실행 턴';
        pn.className = state.phase === 'MEETING' ? 'meeting' : 'execution';
        $('phaseTimer').textContent = remain;
      }
      Render.draw(state);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // 입장 UI
  $('joinBtn').addEventListener('click', () => {
    const name = $('nameInput').value.trim();
    if (!name) { $('joinMsg').textContent = '이름을 입력하세요'; return; }
    $('joinMsg').textContent = '';
    connect(name);
  });
  $('nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('joinBtn').click(); });
})();
