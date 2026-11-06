// Sends water-reminder pushes. Runs every 10 minutes from GitHub Actions.
// Needs these repository secrets: SUPABASE_URL, SUPABASE_SECRET_KEY, VAPID_PRIVATE_KEY.
import webpush from "web-push";

const VAPID_PUBLIC = "BK_KueT3ljsFV3wbirHDqsbgh237SVq-RhxrRoNEeQCc5sR86eKMdZ2E6kaghmiXV8-EEmpNIt3ZwKvNlu5svpY";
const APP_URL = "https://ymohamed0421-svg.github.io/cal-quest/";
const { SUPABASE_URL, SUPABASE_SECRET_KEY, VAPID_PRIVATE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || !VAPID_PRIVATE_KEY) {
  console.log("Push secrets not set yet; nothing to do.");
  process.exit(0);
}
webpush.setVapidDetails(APP_URL, VAPID_PUBLIC, VAPID_PRIVATE_KEY);

const base = SUPABASE_URL.replace(/\/$/, "") + "/rest/v1/push_subs";
const headers = { apikey: SUPABASE_SECRET_KEY, "Content-Type": "application/json" };
if (!SUPABASE_SECRET_KEY.startsWith("sb_")) headers.Authorization = "Bearer " + SUPABASE_SECRET_KEY; // legacy service_role JWT

const WINDOW_MIN = 120; // send if a reminder time passed within the last 2 hours (GitHub cron can run late)
const toMin = (hm) => { const [h, m] = hm.split(":").map(Number); return h * 60 + m; };
function localNow(tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { day: parts.year + "-" + parts.month + "-" + parts.day, hm: parts.hour + ":" + parts.minute };
}

const res = await fetch(base + "?select=*", { headers });
if (!res.ok) { console.error("Supabase error", res.status, await res.text()); process.exit(1); }
const subs = await res.json();
let sent = 0;
for (const s of subs) {
  let now;
  try { now = localNow(s.tz || "UTC"); } catch { now = localNow("UTC"); }
  const done = (s.sent && s.sent[now.day]) || [];
  const due = (s.reminders || []).filter((r) => toMin(now.hm) >= toMin(r) && toMin(now.hm) - toMin(r) <= WINDOW_MIN && !done.includes(r));
  if (!due.length) continue;
  try {
    await webpush.sendNotification(s.sub, JSON.stringify({ title: "💧 Water check-in", body: "How many bottles have you had? Tap to log them and keep your quest alive.", url: APP_URL + "?water=1" }), { TTL: 3600 });
    sent++;
  } catch (e) {
    if (e.statusCode === 404 || e.statusCode === 410) { // phone unsubscribed
      await fetch(base + "?endpoint=eq." + encodeURIComponent(s.endpoint), { method: "DELETE", headers });
      continue;
    }
    console.error("push failed", e.statusCode, e.body);
    continue;
  }
  await fetch(base + "?endpoint=eq." + encodeURIComponent(s.endpoint), { method: "PATCH", headers, body: JSON.stringify({ sent: { [now.day]: done.concat(due) } }) });
}
console.log("checked", subs.length, "phones, sent", sent);
