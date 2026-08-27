import type { APIRoute } from "astro";
import { getLatestReading } from "../../lib/supabase";

export const prerender = false;

export const GET: APIRoute = async () => {
  const reading = await getLatestReading();
  return new Response(JSON.stringify(reading), {
    headers: { "Content-Type": "application/json" },
  });
};
