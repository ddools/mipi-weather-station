import type { APIRoute } from "astro";
import { getLatestReading } from "../../lib/supabase";

export const prerender = false;

// Age past which the station counts as offline. The collector archives every
// ~60s, so 20 min is ~20 missed cycles — long enough to ride out a brief blip,
// short enough to catch a real outage. Deliberately more lenient than the
// dashboard's 15-min "Offline" label so a monitor pointed here doesn't flap.
const STALE_SECONDS = 20 * 60;

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/**
 * Liveness probe for uptime monitors. 200 when a fresh reading exists, 503 when
 * data is stale, missing, or Supabase is unreachable — so a dumb HTTP monitor
 * (UptimeRobot, a phone app, the station-watchdog workflow) can alert on it
 * without parsing the body.
 */
export const GET: APIRoute = async () => {
  let reading;
  try {
    reading = await getLatestReading();
  } catch (err) {
    return json(503, { status: "error", detail: String(err) });
  }

  if (!reading) {
    return json(503, { status: "down", detail: "no readings in database" });
  }

  const ageSeconds = Math.round(
    (Date.now() - new Date(reading.recorded_at).getTime()) / 1000
  );
  const ok = ageSeconds <= STALE_SECONDS;

  return json(ok ? 200 : 503, {
    status: ok ? "ok" : "stale",
    recorded_at: reading.recorded_at,
    age_seconds: ageSeconds,
    stale_after_seconds: STALE_SECONDS,
  });
};
