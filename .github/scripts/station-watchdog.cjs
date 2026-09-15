/**
 * Station watchdog. Queries Supabase for the newest reading and manages a single
 * "station offline" GitHub issue:
 *
 *   - stale/missing data + no open issue  -> open one
 *   - fresh data + an open issue          -> comment "recovered" and close it
 *   - anything else                       -> nothing
 *
 * Supabase unreachable is treated as inconclusive (warn, do nothing) rather than
 * an outage — it usually means Supabase or the runner's network, not the Pi.
 *
 * Invoked from station-watchdog.yml via actions/github-script, which passes
 * { github, context, core }. Config comes from the environment:
 *   SUPABASE_URL, SUPABASE_ANON_KEY  (required; the anon key is already public)
 *   STALE_MINUTES                    (optional, default 20)
 */

const LABEL = "station-down";
const TITLE = "⚠️ Weather station offline";
const DASHBOARD = "https://weather.dermotdooley.com";

module.exports = async ({ github, context, core }) => {
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = process.env;
  const staleMinutes = Number(process.env.STALE_MINUTES || "20");

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    core.setFailed("SUPABASE_URL / SUPABASE_ANON_KEY are not set");
    return;
  }

  const latest = await latestReadingAt(SUPABASE_URL, SUPABASE_ANON_KEY);
  if (latest.error) {
    core.warning(`Could not query Supabase (${latest.error}); skipping this run.`);
    return;
  }

  let down;
  let detail;
  if (!latest.recordedAt) {
    down = true;
    detail = "No readings in the database.";
  } else {
    const ageMin = (Date.now() - new Date(latest.recordedAt).getTime()) / 60000;
    down = ageMin > staleMinutes;
    detail =
      `Latest reading \`${latest.recordedAt}\` — ${ageMin.toFixed(0)} min ago ` +
      `(threshold ${staleMinutes} min).`;
  }
  core.info(`${down ? "DOWN" : "OK"} — ${detail}`);

  const { owner, repo } = context.repo;
  const existing = await openWatchdogIssue(github, owner, repo);

  if (down && !existing) {
    await ensureLabel(github, owner, repo);
    const { data } = await github.rest.issues.create({
      owner,
      repo,
      title: TITLE,
      labels: [LABEL],
      body: [
        "The weather station has stopped sending data.",
        "",
        detail,
        "",
        `- Dashboard: ${DASHBOARD}`,
        "- Checked by `.github/workflows/station-watchdog.yml` (~every 15 min).",
        "",
        "This issue closes automatically when readings resume.",
      ].join("\n"),
    });
    core.notice(`Opened #${data.number}: station offline`);
    return;
  }

  if (down && existing) {
    core.info(`Still down; issue #${existing.number} already open.`);
    return;
  }

  if (!down && existing) {
    await github.rest.issues.createComment({
      owner,
      repo,
      issue_number: existing.number,
      body: `✅ Recovered. ${detail}`,
    });
    await github.rest.issues.update({
      owner,
      repo,
      issue_number: existing.number,
      state: "closed",
      state_reason: "completed",
    });
    core.notice(`Closed #${existing.number}: station recovered`);
    return;
  }

  core.info("Healthy; nothing to do.");
};

async function latestReadingAt(url, key) {
  try {
    const res = await fetch(
      `${url}/rest/v1/readings?select=recorded_at&order=recorded_at.desc&limit=1`,
      { headers: { apikey: key, authorization: `Bearer ${key}` } }
    );
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const rows = await res.json();
    return { recordedAt: rows[0]?.recorded_at ?? null };
  } catch (err) {
    return { error: String(err) };
  }
}

async function openWatchdogIssue(github, owner, repo) {
  const { data } = await github.rest.issues.listForRepo({
    owner,
    repo,
    labels: LABEL,
    state: "open",
    per_page: 10,
  });
  return data.find((i) => !i.pull_request) ?? null;
}

async function ensureLabel(github, owner, repo) {
  try {
    await github.rest.issues.getLabel({ owner, repo, name: LABEL });
  } catch {
    await github.rest.issues.createLabel({
      owner,
      repo,
      name: LABEL,
      color: "d73a4a",
      description: "Automated: the weather station stopped reporting",
    });
  }
}
