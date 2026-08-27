import type { APIRoute } from "astro";
import { getTodaySummary } from "../../lib/supabase";

export const prerender = false;

// Thin wrapper so the client refresh can pull the derived "today so far" figures
// (~8 numbers) without shipping the raw 24h rows to the browser. The heavy
// lifting is the same getHistory("24h") fetch the server already does.
export const GET: APIRoute = async () => {
  const summary = await getTodaySummary();
  return new Response(JSON.stringify(summary), {
    headers: { "Content-Type": "application/json" },
  });
};
