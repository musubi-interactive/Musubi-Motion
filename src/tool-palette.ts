import { buttonContent } from "./ui.ts";

export function mountToolPalette(ids = { panel: "tool-palette", handle: "palette-drag", lock: "palette-lock" }, label = "tool panel") {
  const viewport = document.getElementById("viewport")!;
  const panel = document.getElementById(ids.panel)!;
  const handle = document.getElementById(ids.handle)!;
  const lock = document.getElementById(ids.lock)!;
  let locked = true;
  let drag:
    { id: number; x: number; y: number; left: number; top: number } | undefined;

  function place(left: number, top: number) {
    const maxX = Math.max(4, viewport.clientWidth - panel.offsetWidth - 4);
    const maxY = Math.max(4, viewport.clientHeight - panel.offsetHeight - 4);
    panel.style.left = `${Math.max(4, Math.min(left, maxX))}px`;
    panel.style.top = `${Math.max(4, Math.min(top, maxY))}px`;
  }
  function stop() {
    if (drag && handle.hasPointerCapture(drag.id))
      handle.releasePointerCapture(drag.id);
    drag = undefined;
    delete panel.dataset.dragging;
  }
  lock.addEventListener("click", () => {
    stop();
    locked = !locked;
    const action = locked ? `Unlock ${label}` : `Lock ${label}`;
    if (lock.hasAttribute("aria-pressed")) {
      lock.setAttribute("aria-pressed", String(locked));
    }
    lock.setAttribute("aria-label", action);
    lock.title = action;
    handle.setAttribute("aria-disabled", String(locked));
    handle.title = locked
      ? `Unlock to move ${label}`
      : "Drag to move · Arrow keys to nudge";
    buttonContent(lock, locked ? "lock" : "unlock");
  });
  handle.addEventListener("pointerdown", (event) => {
    if (locked || event.button !== 0 || drag) return;
    event.preventDefault();
    handle.focus();
    drag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: panel.offsetLeft,
      top: panel.offsetTop,
    };
    handle.setPointerCapture(event.pointerId);
    panel.dataset.dragging = "";
  });
  handle.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    place(
      drag.left + event.clientX - drag.x,
      drag.top + event.clientY - drag.y,
    );
  });
  handle.addEventListener("pointerup", stop);
  handle.addEventListener("pointercancel", stop);
  handle.addEventListener("lostpointercapture", stop);
  handle.addEventListener("keydown", (event) => {
    const offsets: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const offset = offsets[event.key];
    if (!offset) return;
    event.preventDefault();
    event.stopPropagation();
    if (!locked) {
      const step = event.shiftKey ? 10 : 1;
      place(
        panel.offsetLeft + offset[0] * step,
        panel.offsetTop + offset[1] * step,
      );
    }
  });
  // Keep the handle reachable when Dockview panels or the browser are resized.
  new ResizeObserver(() => {
    if (panel.parentElement === viewport && viewport.clientWidth && viewport.clientHeight)
      place(panel.offsetLeft, panel.offsetTop);
  }).observe(viewport);
}
