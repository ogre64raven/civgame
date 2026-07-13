// 헥스 월드 — worldmask.json 로드, 좌표계(odd-r offset, pointy-top), 이웃/탐색
const fs = require('fs');
const path = require('path');

const TERRAIN = {
  '~': { name: 'sea', ko: '바다', resource: null },
  'g': { name: 'grass', ko: '초원', resource: 'grain' },
  'p': { name: 'plains', ko: '평원', resource: 'meat' },
  'f': { name: 'forest', ko: '숲', resource: 'wood' },
  'm': { name: 'mountain', ko: '산', resource: 'iron' },
};

class World {
  constructor(maskPath) {
    const m = JSON.parse(fs.readFileSync(
      maskPath || path.join(__dirname, '../data/worldmask.json'), 'utf8'));
    this.w = m.w; this.h = m.h;
    this.latTop = m.latTop; this.latSpan = m.latSpan;
    this.rows = m.rows;
    this._compSizes = null;
  }

  wrapX(x) { return ((x % this.w) + this.w) % this.w; }

  terrain(x, y) {
    if (y < 0 || y >= this.h) return '~';
    return this.rows[y][this.wrapX(x)];
  }

  isLand(x, y) { return this.terrain(x, y) !== '~'; }
  resourceAt(x, y) { return TERRAIN[this.terrain(x, y)].resource; }

  // odd-r offset 이웃 (동서 랩어라운드)
  neighbors(x, y) {
    const even = [[1, 0], [0, -1], [-1, -1], [-1, 0], [-1, 1], [0, 1]];
    const odd = [[1, 0], [1, -1], [0, -1], [-1, 0], [0, 1], [1, 1]];
    const dirs = (y % 2) ? odd : even;
    const out = [];
    for (const [dx, dy] of dirs) {
      const ny = y + dy;
      if (ny >= 0 && ny < this.h) out.push([this.wrapX(x + dx), ny]);
    }
    return out;
  }

  lonlatToHex(lat, lon) {
    let y = Math.round(((this.latTop - lat) / this.latSpan) * this.h - 0.5);
    y = Math.max(0, Math.min(this.h - 1, y));
    const off = (y % 2) ? 0.5 : 0;
    const x = this.wrapX(Math.round(((lon + 180) / 360) * this.w - 0.5 - off));
    return [x, y];
  }

  // (x,y)에서 가장 가까운, predicate를 만족하는 육지 헥스 (BFS, maxDepth 링까지)
  nearestLand(x, y, predicate, maxDepth = 30) {
    const ok = ([cx, cy]) => this.isLand(cx, cy) && (!predicate || predicate(cx, cy));
    if (ok([x, y])) return [x, y];
    const seen = new Set([x + ',' + y]);
    let frontier = [[x, y]];
    for (let d = 0; d < maxDepth; d++) {
      const next = [];
      for (const cell of frontier) {
        for (const nb of this.neighbors(cell[0], cell[1])) {
          const k = nb[0] + ',' + nb[1];
          if (seen.has(k)) continue;
          seen.add(k);
          if (ok(nb)) return nb;
          next.push(nb);
        }
      }
      frontier = next;
    }
    return null;
  }

  // 육지 연결 컴포넌트(대륙/섬)별 크기: 'x,y' -> 크기
  componentSizes() {
    if (this._compSizes) return this._compSizes;
    const sizes = new Map();
    const seen = new Set();
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const k0 = x + ',' + y;
        if (!this.isLand(x, y) || seen.has(k0)) continue;
        const cells = [k0];
        seen.add(k0);
        let frontier = [[x, y]];
        while (frontier.length) {
          const next = [];
          for (const [cx, cy] of frontier) {
            for (const [nx, ny] of this.neighbors(cx, cy)) {
              const k = nx + ',' + ny;
              if (seen.has(k) || !this.isLand(nx, ny)) continue;
              seen.add(k);
              cells.push(k);
              next.push([nx, ny]);
            }
          }
          frontier = next;
        }
        for (const k of cells) sizes.set(k, cells.length);
      }
    }
    this._compSizes = sizes;
    return sizes;
  }

  toJSON() {
    return { w: this.w, h: this.h, latTop: this.latTop, latSpan: this.latSpan, rows: this.rows };
  }
}

module.exports = { World, TERRAIN };
