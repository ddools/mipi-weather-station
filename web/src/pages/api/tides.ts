import type { APIRoute } from "astro";
import { getTideStatus } from "../../lib/tides";

export const prerender = false;

export const GET: APIRoute = async () => {
  const status = await getTideStatus();
  return new Response(JSON.stringify(status), {
    headers: { "Content-Type": "application/json" },
  });
};
