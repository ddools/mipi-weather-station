import type { APIRoute } from "astro";
import { getHistory, type HistoryRange } from "../../lib/supabase";

export const prerender = false;

const VALID_RANGES: HistoryRange[] = ["24h", "7d", "30d"];

export const GET: APIRoute = async ({ url }) => {
  const requested = url.searchParams.get("range");
  const range: HistoryRange = VALID_RANGES.includes(requested as HistoryRange)
    ? (requested as HistoryRange)
    : "24h";

  const rows = await getHistory(range);
  return new Response(JSON.stringify(rows), {
    headers: { "Content-Type": "application/json" },
  });
};
