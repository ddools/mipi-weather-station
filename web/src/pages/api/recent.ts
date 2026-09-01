import type { APIRoute } from "astro";
import { getRecentReadings } from "../../lib/supabase";

export const prerender = false;

// Short raw window for the Wind tile's 5-minute trend. Small payload
// (< ~30 rows); cached briefly so a burst of tab-open refreshes coalesces.
export const GET: APIRoute = async ({ url }) => {
  const raw = Number(url.searchParams.get("minutes"));
  const minutes = Number.isFinite(raw) ? Math.min(30, Math.max(5, raw)) : 15;

  const rows = await getRecentReadings(minutes);
  return new Response(JSON.stringify(rows), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=20",
    },
  });
};
