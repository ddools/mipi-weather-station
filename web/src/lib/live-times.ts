// Keeps every countdown on the page current. Cards render "in 2h 41m" on the
// server, and that text is only true at render time; left alone, a tab open
// all afternoon keeps counting down to a tide that has already turned.
//
// Any element with `data-until="<ISO instant>"` gets its text replaced with
// untilLabel() — optionally wrapped as `data-until-prefix` + label — every
// 15 s, and straight away when the tab comes back into view.
import { untilLabel } from "@/lib/format";

function tick() {
  const now = Date.now();
  for (const el of document.querySelectorAll<HTMLElement>("[data-until]")) {
    const label = untilLabel(el.dataset.until as string, now);
    el.textContent = `${el.dataset.untilPrefix ?? ""}${label}`;
  }
}

export function startLiveTimes() {
  tick();
  setInterval(tick, 15_000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") tick();
  });
}
