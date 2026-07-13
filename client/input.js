// 마우스 팬/줌 + 클릭(헥스 선택) — 클릭은 'hexclick' 커스텀 이벤트로 전달
(() => {
  const canvas = Render.canvas;
  const cam = Render.cam;
  let dragging = false, moved = false, lastX = 0, lastY = 0;

  canvas.addEventListener('mousedown', (e) => {
    dragging = true; moved = false; lastX = e.clientX; lastY = e.clientY;
    canvas.classList.add('dragging');
  });

  window.addEventListener('mouseup', (e) => {
    if (dragging && !moved && e.target === canvas) {
      const state = window.gameState;
      if (state && state.map) {
        const hex = Render.hexAt(e.clientX, e.clientY, state.map);
        if (hex) window.dispatchEvent(new CustomEvent('hexclick', { detail: hex }));
      }
    }
    dragging = false;
    canvas.classList.remove('dragging');
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
    if (moved) { cam.x -= dx; cam.y -= dy; lastX = e.clientX; lastY = e.clientY; }
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const newZoom = Math.min(6, Math.max(0.4, cam.zoom * factor));
    const mx = e.clientX, my = e.clientY;
    cam.x = (cam.x + mx) * (newZoom / cam.zoom) - mx;
    cam.y = (cam.y + my) * (newZoom / cam.zoom) - my;
    cam.zoom = newZoom;
  }, { passive: false });
})();
