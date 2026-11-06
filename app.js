/* Cal Quest — game-style calorie, macro, water and steps tracker.
   Everything is stored on this device (localStorage). No account, no server. */
(function () {
  "use strict";

  // ---------------------------------------------------------------- storage
  const STORE_KEY = "calquest.v1";
  const DEFAULT_REMINDERS = ["10:00", "13:00", "16:00", "19:00"];

  function fresh() {
    return {
      version: 1,
      profile: null,
      targets: null,
      days: {},
      recents: [],
      settings: { reminders: DEFAULT_REMINDERS.slice(), usdaKey: "", geminiKey: "" },
      celebrated: {},
      lastLevel: 1,
      meals: [],      // saved meals: {id, name, items:[{name, amountLabel, n}]}
      favs: [],       // favorite foods: {id, name, amountLabel, n}
      weights: {},    // dayKey -> kg
      badges: {},     // badge id -> unlocked time
      penaltySince: null,
    };
  }
  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY));
      if (s && typeof s === "object") {
        const base = fresh();
        return Object.assign(base, s, { settings: Object.assign(base.settings, s.settings || {}) });
      }
    } catch (e) { /* ignore */ }
    return fresh();
  }
  let S = load();
  setTimeout(() => primeSnap(), 0);
  if (!S.penaltySince) { S.penaltySince = dayKey0(); }
  function dayKey0() { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
  // Remember what each day looked like, so we know which days changed (for syncing between devices).
  const SNAP = {};
  function snapOf(d) { const c = Object.assign({}, d); delete c.u; return JSON.stringify(c); }
  function stampChanges() {
    const now = Date.now();
    Object.keys(S.days).forEach((k) => { const j = snapOf(S.days[k]); if (SNAP[k] !== undefined && SNAP[k] !== j) S.days[k].u = now; else if (SNAP[k] === undefined && !S.days[k].u) S.days[k].u = now; SNAP[k] = j; });
    const pj = JSON.stringify(S.profile);
    if (SNAP.__profile !== undefined && SNAP.__profile !== pj) S.profileAt = now;
    SNAP.__profile = pj;
  }
  function primeSnap() { Object.keys(S.days).forEach((k) => (SNAP[k] = snapOf(S.days[k]))); SNAP.__profile = JSON.stringify(S.profile); }
  function save(opts) {
    stampChanges();
    try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); }
    catch (e) { toast("Could not save", "Your phone storage may be full."); }
    if (!(opts && opts.noSync) && typeof Cloud !== "undefined") Cloud.queuePush();
  }

  // ---------------------------------------------------------------- helpers
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const r0 = (n) => Math.round(Number(n) || 0);
  const r1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
  const fmt = (n) => r0(n).toLocaleString("en-US");
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const pad = (n) => String(n).padStart(2, "0");
  function dayKey(d = new Date()) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function keyToDate(k) { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d); }
  function addDays(k, n) { const d = keyToDate(k); d.setDate(d.getDate() + n); return dayKey(d); }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  function getDay(k = dayKey()) {
    if (!S.days[k]) {
      S.days[k] = { foods: [], water: 0, steps: 0, checkins: {} };
      if (S.targets && k === dayKey()) S.days[k].t = Object.assign({}, S.targets);
    }
    return S.days[k];
  }
  function peekDay(k) { return S.days[k] || { foods: [], water: 0, steps: 0, checkins: {} }; }

  // ---------------------------------------------------------------- body math
  const ACTIVITY = {
    sedentary: { m: 1.2, label: "Couch mode", desc: "Desk job, little or no exercise" },
    light: { m: 1.375, label: "Lightly active", desc: "Walks or light exercise 1–3 days a week" },
    moderate: { m: 1.55, label: "Active", desc: "Exercise or sports 3–5 days a week" },
    very: { m: 1.725, label: "Very active", desc: "Hard training 6–7 days a week" },
    athlete: { m: 1.9, label: "Beast mode", desc: "Training twice a day, or a physical job plus training" },
  };
  const GOALS = {
    lose_fast: { delta: -750, pkg: 2.2, label: "Lose fat fast", desc: "About 1.5 lb (0.7 kg) a week" },
    lose: { delta: -500, pkg: 2.2, label: "Lose fat", desc: "About 1 lb (0.45 kg) a week" },
    maintain: { delta: 0, pkg: 1.8, label: "Stay the same", desc: "Keep my weight, get fitter" },
    lean_gain: { delta: 250, pkg: 2.0, label: "Build muscle (lean)", desc: "Slow gain, minimal fat" },
    bulk: { delta: 500, pkg: 2.0, label: "Bulk up", desc: "Gain weight faster" },
  };

  function computeTargets(p) {
    const bmr = 10 * p.weightKg + 6.25 * p.heightCm - 5 * p.age + (p.sex === "male" ? 5 : -161);
    const tdee = bmr * ACTIVITY[p.activity].m;
    const g = GOALS[p.goal];
    const floor = p.sex === "male" ? 1500 : 1200;
    const kcal = Math.round(Math.max(tdee + g.delta, floor) / 10) * 10;
    // Protein: g per kg, using a capped "reference" weight so very heavy bodies don't get huge numbers.
    const hM = p.heightCm / 100;
    const refKg = Math.min(p.weightKg, 27 * hM * hM);
    let protein = refKg * g.pkg;
    protein = Math.min(protein, (kcal * 0.4) / 4);
    let fat = Math.max((kcal * 0.27) / 9, 0.6 * refKg);
    let carbs = (kcal - protein * 4 - fat * 9) / 4;
    if (carbs < 50) { fat = Math.max(0.5 * refKg, (kcal - protein * 4 - 50 * 4) / 9); carbs = (kcal - protein * 4 - fat * 9) / 4; }
    const fiber = Math.round((14 * kcal) / 1000);
    const lb = p.weightKg * 2.20462;
    const oz = lb * 0.5 + (["moderate", "very", "athlete"].includes(p.activity) ? 16 : 0);
    const bottles = clamp(Math.ceil(oz / p.bottleOz), 4, 16);
    return {
      bmr: Math.round(bmr), tdee: Math.round(tdee), kcal,
      protein: Math.round(protein), carbs: Math.round(Math.max(carbs, 0)), fat: Math.round(fat), fiber,
      water: bottles, bottleOz: p.bottleOz, steps: p.stepGoal,
    };
  }

  function microTargets() {
    const p = S.profile || {}, t = S.targets || { kcal: 2000, fiber: 28 };
    const male = p.sex === "male";
    return [
      { k: "fiber", label: "Fiber", unit: "g", goal: t.fiber },
      { k: "potassium", label: "Potassium", unit: "mg", goal: male ? 3400 : 2600 },
      { k: "calcium", label: "Calcium", unit: "mg", goal: 1000 },
      { k: "iron", label: "Iron", unit: "mg", goal: male || (p.age || 30) > 50 ? 8 : 18 },
      { k: "vitc", label: "Vitamin C", unit: "mg", goal: male ? 90 : 75 },
      { k: "sodium", label: "Sodium", unit: "mg", goal: 2300, limit: true },
      { k: "sugar", label: "Sugar", unit: "g", goal: Math.round((t.kcal * 0.1) / 4), limit: true },
      { k: "sat", label: "Saturated fat", unit: "g", goal: Math.round((t.kcal * 0.1) / 9), limit: true },
    ];
  }

  // ---------------------------------------------------------------- nutrition totals
  const NKEYS = ["kcal", "p", "c", "f", "fiber", "sugar", "sat", "sodium", "potassium", "calcium", "iron", "vitc"];
  function totals(d) {
    const t = {}; NKEYS.forEach((k) => (t[k] = 0));
    (d.foods || []).forEach((f) => NKEYS.forEach((k) => (t[k] += Number(f.n && f.n[k]) || 0)));
    return t;
  }

  // ---------------------------------------------------------------- quests & XP
  const QUESTS = [
    { id: "protein", name: "Protein", xp: 100 },
    { id: "water", name: "Water", xp: 100 },
    { id: "kcal", name: "Calories", xp: 100 },
    { id: "carbs", name: "Carbs", xp: 50 },
    { id: "fat", name: "Fat", xp: 50 },
    { id: "steps", name: "Steps", xp: 75 },
    { id: "fiber", name: "Fiber", xp: 25, bonus: true },
  ];
  const CLEAR_BONUS = 200;
  const FULL_REWARD = QUESTS.reduce((a, q) => a + q.xp, 0) + CLEAR_BONUS;

  // state: "done" | "over" | "todo"; pct 0..1 shown on the bar
  function questState(k) {
    const d = peekDay(k);
    const t = d.t || S.targets;
    const tot = totals(d);
    const out = {};
    const atLeast = (have, goal) => ({ have, goal, pct: goal ? have / goal : 0, state: have >= goal ? "done" : "todo" });
    const inRange = (have, goal, lo, hi) => {
      const pct = goal ? have / goal : 0;
      return { have, goal, pct, state: pct > hi ? "over" : pct >= lo ? "done" : "todo" };
    };
    out.protein = atLeast(tot.p, t.protein);
    out.water = atLeast(d.water || 0, t.water);
    out.kcal = inRange(tot.kcal, t.kcal, 0.9, 1.1);
    out.carbs = inRange(tot.c, t.carbs, 0.85, 1.15);
    out.fat = inRange(tot.f, t.fat, 0.85, 1.2);
    out.steps = atLeast(d.steps || 0, t.steps);
    out.fiber = atLeast(tot.fiber, t.fiber);
    const main = QUESTS.filter((q) => !q.bonus);
    const doneMain = main.filter((q) => out[q.id].state === "done").length;
    const overall = main.reduce((a, q) => a + Math.min(out[q.id].pct, 1) * (out[q.id].state === "over" ? 0.5 : 1), 0) / main.length;
    const cleared = doneMain === main.length;
    let xp = QUESTS.reduce((a, q) => a + (out[q.id].state === "done" ? q.xp : 0), 0);
    if (cleared) xp += CLEAR_BONUS;
    if (d.gym && d.gym.status === "went") xp += GYM_XP;
    return { q: out, overall, cleared, xp, doneMain, mainCount: main.length };
  }

  function totalXP() {
    const keys = Object.keys(S.days);
    let xp = keys.reduce((a, k) => { const pen = penaltyState(k); return a + questState(k).xp + (pen ? pen.xp : 0); }, 0);
    const weeks = new Set(keys.map(weekStart));
    weeks.forEach((w) => (xp += bossState(w).xp));
    return Math.max(0, xp);
  }

  // ---- Penalty quest: if yesterday's daily quest wasn't cleared, today you must make up for it.
  const PENALTY_XP = 150, REDEEM_XP = 50;
  function penaltyState(k) {
    const prev = addDays(k, -1);
    const first = Object.keys(S.days).sort()[0];
    if (!S.penaltySince || prev < S.penaltySince || !first || prev < first) return null;
    if (questState(prev).cleared) return null;
    const d = peekDay(k), t = d.t || S.targets;
    const wGoal = t.water + 1, sGoal = t.steps + 2000;
    const water = (d.water || 0) >= wGoal, steps = (d.steps || 0) >= sGoal;
    const done = water && steps, past = k < dayKey();
    return { water, steps, wGoal, sGoal, done, past, have: d, xp: done ? REDEEM_XP : past ? -PENALTY_XP : 0 };
  }

  // ---- Weekly boss battle: every cleared % of a day hits the boss.
  const BOSSES = [
    ["Sugar Golem", "🍬"], ["Couch Wraith", "🛋️"], ["Sodium Serpent", "🧂"], ["Midnight Snacker", "🌙"],
    ["Dehydration Djinn", "🏜️"], ["Takeout Titan", "🥡"], ["Procrasti-Hydra", "🐉"], ["Soda Specter", "🥤"],
  ];
  const BOSS_HP = 600, BOSS_XP = 1000;
  function weekStart(k) { const d = keyToDate(k); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return dayKey(d); }
  function bossState(ws) {
    const wk = Math.floor(keyToDate(ws).getTime() / (7 * 864e5));
    const [name, icon] = BOSSES[((wk % BOSSES.length) + BOSSES.length) % BOSSES.length];
    let dmg = 0; const hits = [];
    for (let i = 0; i < 7; i++) {
      const k = addDays(ws, i);
      let hit = 0;
      if (S.days[k]) { const qs = questState(k); hit = Math.round(qs.overall * 100) + (qs.cleared ? 50 : 0); }
      hits.push(hit); dmg += hit;
    }
    const defeated = dmg >= BOSS_HP;
    return { name, icon, hp: BOSS_HP, dmg: Math.min(dmg, BOSS_HP), hits, defeated, xp: defeated ? BOSS_XP : 0, end: addDays(ws, 6) };
  }

  // ---- Badges (each one also unlocks a title)
  function bestStreak() {
    const keys = Object.keys(S.days).sort(); let best = 0, run = 0, prev = null;
    keys.forEach((k) => { if (questState(k).cleared) { run = prev && addDays(prev, 1) === k ? run + 1 : 1; prev = k; best = Math.max(best, run); } else { run = 0; prev = null; } });
    return best;
  }
  function gameStats() {
    const keys = Object.keys(S.days);
    const st = { foods: 0, photo: 0, barcode: 0, waterDays: 0, proteinDays: 0, redeemed: 0, bosses: 0, perfectWeek: false };
    keys.forEach((k) => {
      const d = S.days[k], qs = questState(k);
      st.foods += d.foods.length;
      d.foods.forEach((f) => { if (f.src === "photo") st.photo++; if (f.src === "barcode") st.barcode++; });
      if (qs.q.water.state === "done") st.waterDays++;
      if (qs.q.protein.state === "done") st.proteinDays++;
      const pen = penaltyState(k); if (pen && pen.done) st.redeemed++;
    });
    new Set(keys.map(weekStart)).forEach((w) => {
      if (bossState(w).defeated) st.bosses++;
      let all = true; for (let i = 0; i < 7; i++) { const k = addDays(w, i); if (!S.days[k] || !questState(k).cleared) all = false; }
      if (all) st.perfectWeek = true;
    });
    const g = gymStats(); st.gymDays = g.total; st.gymWeek = g.bestWeek; st.gymBest = g.best; st.prs = g.prs;
    st.best = bestStreak(); st.level = levelFromXP(totalXP()); st.weighIns = Object.keys(S.weights || {}).length; st.meals = (S.meals || []).length;
    return st;
  }
  const BADGES = [
    ["first", "🍽️", "First Bite", "Log your first food", (s) => s.foods >= 1],
    ["hydrated", "💧", "Hydrated", "Hit your water goal", (s) => s.waterDays >= 1],
    ["protein7", "🥩", "Protein Pro", "Hit protein on 7 days", (s) => s.proteinDays >= 7],
    ["streak3", "🔥", "On Fire", "3-day quest streak", (s) => s.best >= 3],
    ["streak7", "⚡", "Unstoppable", "7-day quest streak", (s) => s.best >= 7],
    ["streak30", "👑", "Living Legend", "30-day quest streak", (s) => s.best >= 30],
    ["boss1", "⚔️", "Boss Slayer", "Defeat a weekly boss", (s) => s.bosses >= 1],
    ["boss4", "🐲", "Monster Hunter", "Defeat 4 weekly bosses", (s) => s.bosses >= 4],
    ["perfect", "🌟", "Flawless", "Clear all 7 quests in a week", (s) => s.perfectWeek],
    ["photo10", "📸", "Food Paparazzi", "Log 10 foods by photo", (s) => s.photo >= 10],
    ["barcode", "▦", "Scanner", "Log a food by barcode", (s) => s.barcode >= 1],
    ["chef", "🍱", "Meal Prepper", "Save a meal", (s) => s.meals >= 1],
    ["weigh7", "⚖️", "Scale Warrior", "Log your weight 7 times", (s) => s.weighIns >= 7],
    ["redeem", "🛡️", "Redeemed", "Complete a penalty quest", (s) => s.redeemed >= 1],
    ["lvl5", "🌀", "Rising Star", "Reach level 5", (s) => s.level >= 5],
    ["lvl10", "💠", "Veteran", "Reach level 10", (s) => s.level >= 10],
    ["gym1", "🏋️", "Gym Rat", "Log your first workout", (s) => s.gymDays >= 1],
    ["gymweek", "💪", "Iron Week", "5 workouts in one week", (s) => s.gymWeek >= 5],
    ["gym7", "🦾", "Iron Will", "7-day gym streak", (s) => s.gymBest >= 7],
    ["pr", "🏆", "New PR", "Beat your best on a lift", (s) => s.prs >= 1],
  ];
  function availableTitles(L) {
    const t = TITLES.filter(([lv]) => L >= lv).map(([, n]) => n);
    BADGES.forEach(([id, , name]) => { if (S.badges[id]) t.push(name); });
    return t;
  }
  function currentTitle(L) { const want = S.settings.title; return want && availableTitles(L).includes(want) ? want : titleFor(L); }

  // ---- Themes, unlocked by level (or a badge)
  const THEMES = [
    ["azure", "Azure", 1, "#34c8ff"], ["emerald", "Emerald", 3, "#2fffa8"], ["crimson", "Crimson", 5, "#ff4d6d"],
    ["violet", "Violet", 8, "#b07cff"], ["gold", "Gold", 12, "#ffc94d"], ["shadow", "Shadow", "boss1", "#e6edf5"],
  ];
  function themeUnlocked(th, L) { return typeof th[2] === "number" ? L >= th[2] : !!S.badges[th[2]]; }
  function applyTheme() { document.documentElement.dataset.theme = S.settings.theme || "azure"; }
  // Level L starts at 250 * L*(L-1)/2 XP  → L2 at 250, L3 at 750, L4 at 1500 …
  function levelFromXP(xp) { let L = 1; while (250 * ((L + 1) * L) / 2 <= xp) L++; return L; }
  function levelStart(L) { return (250 * (L * (L - 1))) / 2; }
  const TITLES = [
    [1, "Rookie"], [3, "Fuel Apprentice"], [5, "Macro Scout"], [8, "Hydro Knight"], [12, "Protein Paladin"],
    [16, "Iron Strategist"], [20, "Nutrition Warden"], [25, "Discipline Sage"], [30, "Apex Ascendant"],
  ];
  function titleFor(L) { let t = TITLES[0][1]; TITLES.forEach(([lv, name]) => { if (L >= lv) t = name; }); return t; }
  function streak() {
    let k = dayKey(), n = 0;
    if (!questState(k).cleared) k = addDays(k, -1);
    while (S.days[k] && questState(k).cleared) { n++; k = addDays(k, -1); }
    return n;
  }

  // ---------------------------------------------------------------- UI: toasts & modals
  function toast(title, sub, cls = "") {
    const el = document.createElement("div");
    el.className = "toast " + cls;
    el.innerHTML = esc(title) + (sub ? "<small>" + esc(sub) + "</small>" : "");
    const root = $("#toast-root");
    // keep it tidy: drop older toasts with the same title, and never show more than 2
    $$(".toast", root).forEach((t) => { if (t.dataset.title === title) t.remove(); });
    while (root.children.length >= 2) root.firstChild.remove();
    el.dataset.title = title;
    root.appendChild(el);
    setTimeout(() => { el.style.transition = "opacity .4s"; el.style.opacity = "0"; }, 2600);
    setTimeout(() => el.remove(), 3100);
  }
  function corners() { return '<i class="c2"></i><i class="c3"></i>'; }
  function openModal(inner, opts = {}) {
    closeModal();
    const bg = document.createElement("div");
    bg.className = "modal-bg" + (opts.center ? " center" : "");
    bg.innerHTML = '<div class="modal"><div class="panel ' + (opts.cls || "") + '">' + corners() +
      (opts.noClose ? "" : '<button class="btn sm ghost modal-close" data-close aria-label="Close">✕</button>') + inner + "</div></div>";
    bg.addEventListener("click", (e) => { if (e.target === bg && !opts.noClose) closeModal(); if (e.target.closest("[data-close]")) closeModal(); });
    $("#modal-root").appendChild(bg);
    return bg;
  }
  function closeModal() { $("#modal-root").innerHTML = ""; }

  // ---------------------------------------------------------------- icons
  const ICON = {
    quest: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2l3 6 6 1-4.5 4.5 1 6.5L12 17l-5.5 3 1-6.5L3 9l6-1z"/></svg>',
    food: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7 2v9M4 2v5a3 3 0 006 0V2M7 11v11M17 2c-2 0-3 3-3 7s1 5 3 5v8"/></svg>',
    water: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2.5S5 10 5 14.5a7 7 0 0014 0C19 10 12 2.5 12 2.5z"/></svg>',
    gym: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 7v10M3 9v6M18 7v10M21 9v6M6 12h12"/></svg>',
    stats: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
    player: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/></svg>',
  };
  function bottleSVG(fill) { // fill 0..1
    const h = 46 * clamp(fill, 0, 1), y = 60 - h;
    return '<svg viewBox="0 0 34 64"><defs><clipPath id="bc"><path d="M12 2h10v8l5 6v44H7V16l5-6z"/></clipPath></defs>' +
      '<rect x="0" y="' + y + '" width="34" height="' + h + '" fill="#34c8ff" opacity=".85" clip-path="url(#bc)"/>' +
      '<path d="M12 2h10v8l5 6v44H7V16l5-6z" fill="none" stroke="' + (fill > 0 ? "#9be6ff" : "rgba(52,200,255,.45)") + '" stroke-width="1.6"/></svg>';
  }

  // ---------------------------------------------------------------- app shell
  let tab = "quest";
  let foodDay = dayKey();

  function render() {
    applyTheme();
    if (!S.profile || !S.targets) return renderOnboarding();
    const xp = totalXP(), L = levelFromXP(xp), start = levelStart(L), next = levelStart(L + 1);
    const st = streak();
    const app = $("#app");
    app.innerHTML =
      '<div class="shell">' +
      '<header class="hud">' +
      '<div class="lvl"><div class="num">' + L + '</div><div class="lab">LEVEL</div></div>' +
      '<div class="hud-right"><div class="title-row"><div class="ptitle">' + esc(S.profile.name || "Player") + ' · Title: <b>' + esc(currentTitle(L)) + '</b></div>' +
      '<div class="streak" title="Days in a row with every quest cleared">' + (st ? "🔥 " + st + "-day streak" : "") + '</div></div>' +
      '<div class="xpbar"><i style="width:' + clamp(((xp - start) / (next - start)) * 100, 0, 100) + '%"></i></div>' +
      '<div class="xptext"><span>XP ' + fmt(xp - start) + " / " + fmt(next - start) + '</span><span>Total ' + fmt(xp) + ' XP</span></div></div>' +
      '</header><main id="view"></main></div>' +
      '<nav class="nav">' +
      ["quest", "food", "water", "gym", "stats", "player"].map((t) => '<button data-tab="' + t + '" class="' + (tab === t ? "active" : "") + '">' + ICON[t] + t.charAt(0).toUpperCase() + t.slice(1) + "</button>").join("") +
      "</nav>";
    $$(".nav button").forEach((b) => b.addEventListener("click", () => { tab = b.dataset.tab; if (tab === "food") foodDay = dayKey(); render(); window.scrollTo(0, 0); }));
    const v = $("#view");
    if (tab === "quest") renderQuest(v);
    else if (tab === "food") renderFood(v);
    else if (tab === "water") renderWater(v);
    else if (tab === "stats") renderStats(v);
    else if (tab === "gym") renderGym(v);
    else renderPlayer(v);
    checkCelebrations(L);
  }

  // ---------------------------------------------------------------- QUEST view
  function renderQuest(v) {
    const k = dayKey();
    getDay(k);
    const qs = questState(k), t = peekDay(k).t || S.targets;
    const unit = { protein: "g", water: "", kcal: "", carbs: "g", fat: "g", steps: "", fiber: "g" };
    const hint = {
      protein: "Hit at least your target", water: (t.bottleOz || 16.9) + " oz bottles", kcal: "Land within 10% of target",
      carbs: "Land within ±15%", fat: "Land within −15% / +20%", steps: "Walk it out", fiber: "Bonus side quest",
    };
    const rows = QUESTS.map((q) => {
      const s = qs.q[q.id];
      const val = q.id === "steps" ? fmt(s.have) + "/" + fmt(s.goal) : (q.id === "water" ? r1(s.have) : fmt(s.have)) + "/" + fmt(s.goal) + unit[q.id];
      return '<li class="' + s.state + (q.bonus ? " bonus" : "") + '"><button class="qrow" data-q="' + q.id + '">' +
        '<span class="qname">-' + esc(q.name) + (s.state === "over" ? " <small>Over the limit, XP lost</small>" : "<small>" + esc(hint[q.id]) + "</small>") + '</span>' +
        '<span class="qval">[' + val + ']</span><span class="badge">' + (s.state === "done" ? "✓ " : "+") + q.xp + '</span></button>' +
        '<div class="qbar"><i style="width:' + clamp(s.pct * 100, 0, 100) + '%"></i></div></li>';
    }).join("");
    const pct = Math.round(qs.overall * 100);
    v.innerHTML =
      '<section class="panel">' + corners() +
      '<h1 class="panel-title">Quest Info</h1>' +
      '<p class="panel-sub">Daily Quest – Fuel the body, forge the will</p>' +
      '<div class="progress-ring"><div class="big-pct ' + (qs.cleared ? "full" : "") + '">' + pct + '%</div>' +
      (qs.cleared ? '<div class="stamp">QUEST CLEARED</div>' : '<div class="note" style="margin-top:4px">' + qs.doneMain + " of " + qs.mainCount + " goals complete</div>") + "</div>" +
      '<div class="goals-h">GOALS</div><ul class="quest">' + rows + "</ul>" +
      '<p class="caution"><b>Caution!</b> – If the daily quest remains incomplete, your streak will be lost.</p>' +
      '<p class="reward">Reward : ' + FULL_REWARD + ' XP</p>' +
      '<div class="qfoot"><button class="btn sm" data-go="food">+ Food</button><div class="timer" id="timer">--:--:--<small>TIME LEFT</small></div><button class="btn sm" data-go="water">+ Water</button></div>' +
      "</section>" +
      penaltyHTML(k) + bossHTML(weekStart(k), true) + '<div id="lb-slot"></div>' +
      '<div class="quick"><button class="btn" id="qb-bottle">+1 Bottle</button><button class="btn" id="qb-food">Log food</button><button class="btn" id="qb-steps">Steps</button></div>';
    $$(".qrow", v).forEach((b) => b.addEventListener("click", () => {
      const id = b.dataset.q;
      if (id === "water") openWaterModal();
      else if (id === "steps") openStepsModal();
      else { tab = "food"; foodDay = dayKey(); render(); }
    }));
    $$("[data-go]", v).forEach((b) => b.addEventListener("click", () => { if (b.dataset.go === "water") openWaterModal(); else openAddFood(); }));
    $("#qb-bottle").addEventListener("click", () => addWater(1));
    $("#qb-food").addEventListener("click", () => openAddFood());
    $("#qb-steps").addEventListener("click", openStepsModal);
    if (typeof Cloud !== "undefined") Cloud.renderLeaderboard($("#lb-slot"));
    tickTimer();
  }
  function penaltyHTML(k) {
    const pen = penaltyState(k); if (!pen) return "";
    const row = (name, have, goal, ok) => '<li class="' + (ok ? "done" : "") + '"><div class="qrow" style="cursor:default"><span class="qname">-' + name + '</span><span class="qval">[' + fmt(have) + "/" + fmt(goal) + ']</span><span class="badge">' + (ok ? "✓" : "!") + '</span></div><div class="qbar"><i style="width:' + clamp((have / goal) * 100, 0, 100) + '%"></i></div></li>';
    return '<section class="panel penalty">' + corners() + '<h2 class="panel-title" style="font-size:22px">⚠ Penalty Quest</h2>' +
      '<p class="panel-sub">Yesterday\'s quest was left unfinished. Make up for it today.</p><ul class="quest" style="margin-top:10px">' +
      row("Extra water", r1(pen.have.water || 0), pen.wGoal, pen.water) + row("Extra steps", pen.have.steps || 0, pen.sGoal, pen.steps) + "</ul>" +
      '<p class="caution">' + (pen.done ? '<span style="color:var(--good)">Penalty cleared! +' + REDEEM_XP + " XP</span>" : "<b>Fail:</b> −" + PENALTY_XP + " XP at midnight · <b style=\"color:var(--good)\">Clear:</b> +" + REDEEM_XP + " XP") + "</p></section>";
  }
  function bossHTML(ws, compact) {
    const b = bossState(ws), left = Math.max(0, b.hp - b.dmg);
    const daysLeft = Math.max(0, Math.round((keyToDate(b.end) - keyToDate(dayKey())) / 864e5) + 1);
    return '<section class="panel boss">' + corners() +
      '<div style="display:flex;align-items:center;gap:12px"><div class="boss-ic">' + b.icon + '</div><div style="flex:1"><div class="h2" style="margin:0">Weekly boss</div>' +
      '<div class="boss-name">' + esc(b.name) + (b.defeated ? ' <span style="color:var(--good)">DEFEATED</span>' : "") + "</div></div></div>" +
      '<div class="hpbar"><i style="width:' + ((left / b.hp) * 100) + '%"></i></div>' +
      '<div class="xptext"><span>HP ' + fmt(left) + " / " + fmt(b.hp) + "</span><span>" + (b.defeated ? "+" + BOSS_XP + " XP earned" : daysLeft + " day" + (daysLeft === 1 ? "" : "s") + " left · reward " + BOSS_XP + " XP") + "</span></div>" +
      (compact ? "" : '<div class="hits">' + b.hits.map((h, i) => '<div><b>' + (h ? h : "–") + "</b><span>" + "MTWTFSS"[i] + "</span></div>").join("") + "</div>") +
      '<p class="note" style="margin-top:8px">Every % of your daily quest hits the boss. Clearing a day adds a 50-damage critical hit.</p></section>';
  }
  function tickTimer() {
    const el = $("#timer"); if (!el) return;
    const now = new Date(), end = new Date(now); end.setHours(24, 0, 0, 0);
    const s = Math.max(0, Math.floor((end - now) / 1000));
    el.firstChild.nodeValue = Math.floor(s / 3600) + ":" + pad(Math.floor((s % 3600) / 60)) + ":" + pad(s % 60);
  }
  setInterval(() => {
    tickTimer();
    // new day rolled over while the app was open
    if (S.profile && render._day && render._day !== dayKey()) { render._day = dayKey(); render(); }
  }, 1000);
  render._day = dayKey();

  // ---------------------------------------------------------------- celebrations
  function checkCelebrations(L) {
    const k = dayKey();
    const qs = questState(k);
    let changed = false;
    QUESTS.forEach((q) => {
      const key = k + ":" + q.id;
      if (qs.q[q.id].state === "done" && !S.celebrated[key]) {
        S.celebrated[key] = 1; changed = true;
        toast("Goal complete: " + q.name, "+" + q.xp + " XP", "good");
      }
    });
    if (qs.cleared && !S.celebrated[k + ":clear"]) {
      S.celebrated[k + ":clear"] = 1; changed = true;
      setTimeout(() => toast("DAILY QUEST CLEARED", "+" + CLEAR_BONUS + " XP bonus", "good"), 500);
    }
    if (L > (S.lastLevel || 1)) {
      S.lastLevel = L; changed = true;
      setTimeout(() => {
        const bg = openModal('<div class="levelup"><h2 class="panel-title">Level Up!</h2><div class="big">' + L + '</div>' +
          '<p class="panel-sub">New title: ' + esc(titleFor(L)) + '</p>' + (THEMES.find((th) => th[2] === L) ? '<p class="explain" style="text-align:center">🎨 New theme unlocked: <b>' + THEMES.find((th) => th[2] === L)[1] + "</b> (Player tab)</p>" : "") + '<p class="explain" style="text-align:center">Keep stacking daily quests to level up faster.</p>' +
          '<button class="btn primary block" data-close>Continue</button></div>', { center: true });
        bg.querySelector(".panel").classList.add("levelup");
      }, 900);
    } else if (L < (S.lastLevel || 1)) { S.lastLevel = L; changed = true; }
    // new badges
    const st = gameStats();
    BADGES.forEach(([id, icon, name, , test]) => {
      if (!S.badges[id] && test(st)) {
        S.badges[id] = Date.now(); changed = true;
        setTimeout(() => toast("🏅 Badge unlocked: " + name, "New title available in Player", "good"), 1200);
      }
    });
    const bs = bossState(weekStart(k));
    if (bs.defeated && !S.celebrated[k + ":boss"] && !S.celebrated["boss:" + weekStart(k)]) {
      S.celebrated["boss:" + weekStart(k)] = 1; S.celebrated[k + ":boss"] = 1; changed = true;
      setTimeout(() => toast(bs.icon + " " + bs.name + " defeated!", "+" + BOSS_XP + " XP", "good"), 1500);
    }
    // prune old celebration keys
    const cutoff = addDays(k, -3);
    Object.keys(S.celebrated).forEach((key) => { if (/^\d{4}-/.test(key) && key.slice(0, 10) < cutoff) { delete S.celebrated[key]; changed = true; } });
    if (changed) save();
  }

  // ---------------------------------------------------------------- WATER
  function addWater(n, k = dayKey()) {
    const d = getDay(k);
    d.water = Math.max(0, r1((d.water || 0) + n));
    save(); render();
    if (n > 0) toast("Water logged 💧", r1(d.water) + " bottle" + (d.water === 1 ? "" : "s") + " today");
  }
  function renderWater(v) {
    const k = dayKey(), d = getDay(k), t = d.t || S.targets;
    const goal = t.water, have = d.water || 0;
    let bottles = "";
    for (let i = 0; i < Math.max(goal, Math.ceil(have)); i++) bottles += '<div class="bottle">' + bottleSVG(clamp(have - i, 0, 1)) + "</div>";
    const rem = S.settings.reminders;
    const now = new Date(), nowHM = pad(now.getHours()) + ":" + pad(now.getMinutes());
    v.innerHTML =
      '<section class="panel">' + corners() + '<h1 class="panel-title">Hydration</h1><p class="panel-sub">Side quest – drink ' + goal + " bottles</p>" +
      '<div class="bottles">' + bottles + "</div>" +
      '<div class="water-num">' + r1(have) + '<small> / ' + goal + "</small></div>" +
      '<div class="water-oz">' + fmt(have * t.bottleOz) + " oz of " + fmt(goal * t.bottleOz) + " oz</div>" +
      '<div class="row" style="margin-top:16px"><button class="btn" id="w-minus">−1</button><button class="btn" id="w-half">+½</button><button class="btn primary" id="w-plus">+1 Bottle</button></div>' +
      "</section>" +
      '<div class="h2">Today\'s check-ins</div><div class="checkins">' +
      rem.map((hm) => {
        const c = d.checkins[hm];
        return "<div><span>" + esc(to12(hm)) + "</span><span class=\"" + (c != null ? "ok" : "") + "\">" +
          (c != null ? "✓ logged " + r1(c) + " bottle" + (c === 1 ? "" : "s") : hm <= nowHM ? "missed" : "upcoming") + "</span></div>";
      }).join("") + "</div>" +
      '<button class="btn block" style="margin-top:14px" id="w-check">Water check-in now</button>' +
      '<p class="note">Reminders: set them up once in the Player tab → "Water reminders". Each time you open the app after a reminder time, it asks how many bottles you drank.</p>';
    $("#w-minus").addEventListener("click", () => addWater(-1));
    $("#w-half").addEventListener("click", () => addWater(0.5));
    $("#w-plus").addEventListener("click", () => addWater(1));
    $("#w-check").addEventListener("click", () => openWaterModal());
  }
  function to12(hm) { const [h, m] = hm.split(":").map(Number); return ((h + 11) % 12 + 1) + ":" + pad(m) + (h < 12 ? " AM" : " PM"); }

  function openWaterModal(slot) {
    let n = 1;
    const d = getDay();
    const bg = openModal(
      '<h2 class="panel-title" style="font-size:24px">💧 Water Check-in</h2>' +
      '<p class="panel-sub">How many bottles did you drink' + (slot ? " since your last check-in" : "") + "?</p>" +
      '<div class="stepper"><button class="btn" id="m-minus">−</button><div class="val" id="m-val">1</div><button class="btn" id="m-plus">+</button></div>' +
      '<p class="explain" style="text-align:center">Today so far: <b>' + r1(d.water || 0) + "</b> of " + (d.t || S.targets).water + " bottles</p>" +
      '<div class="row"><button class="btn ghost" id="m-none">None</button><button class="btn primary" id="m-log">Log</button></div>', { center: true });
    const upd = () => ($("#m-val", bg).textContent = r1(n));
    $("#m-minus", bg).addEventListener("click", () => { n = Math.max(0, n - 0.5); upd(); });
    $("#m-plus", bg).addEventListener("click", () => { n = Math.min(12, n + 0.5); upd(); });
    const finish = (amount) => {
      markCheckins(amount);
      closeModal();
      if (amount > 0) addWater(amount); else { save(); render(); }
    };
    $("#m-none", bg).addEventListener("click", () => finish(0));
    $("#m-log", bg).addEventListener("click", () => finish(n));
  }
  // Mark every reminder time that has already passed today as answered.
  function markCheckins(amount) {
    const d = getDay(), now = new Date(), nowHM = pad(now.getHours()) + ":" + pad(now.getMinutes());
    const due = S.settings.reminders.filter((hm) => hm <= nowHM && d.checkins[hm] == null);
    due.forEach((hm, i) => (d.checkins[hm] = i === due.length - 1 ? amount : 0));
  }
  function maybeAskWater() {
    if (!S.profile || $("#modal-root").children.length) return;
    const d = getDay(), now = new Date(), nowHM = pad(now.getHours()) + ":" + pad(now.getMinutes());
    const due = S.settings.reminders.filter((hm) => hm <= nowHM && d.checkins[hm] == null);
    if (due.length) openWaterModal(due[due.length - 1]);
  }

  // ---------------------------------------------------------------- STEPS
  function openStepsModal() {
    const d = getDay();
    const bg = openModal(
      '<h2 class="panel-title" style="font-size:24px">👟 Steps</h2>' +
      '<p class="panel-sub">Goal: ' + fmt((d.t || S.targets).steps) + " steps</p>" +
      '<label class="f" for="st-in">Steps today</label><input id="st-in" type="number" inputmode="numeric" min="0" max="200000" value="' + (d.steps || "") + '" placeholder="e.g. 8500">' +
      '<div class="row" style="margin-top:12px"><button class="btn" id="st-paste">Paste from Health</button><button class="btn primary" id="st-save">Save</button></div>' +
      '<p class="note">"Paste from Health" works after you set up the free "Copy Steps" shortcut once (Player tab → Apple Health steps). Run the shortcut, come back here, tap Paste.</p>', { center: true });
    const save1 = (val) => {
      const n = parseInt(String(val).replace(/[^\d]/g, ""), 10);
      if (!Number.isFinite(n) || n < 0 || n > 200000) { toast("That doesn't look like a step count"); return; }
      d.steps = n; save(); closeModal(); render(); toast("Steps updated", fmt(n) + " steps");
    };
    $("#st-save", bg).addEventListener("click", () => save1($("#st-in", bg).value));
    $("#st-paste", bg).addEventListener("click", async () => {
      try {
        const txt = await navigator.clipboard.readText();
        const num = (txt.match(/\d[\d,\.]*/) || [""])[0].replace(/[,\.](?=\d{3}\b)/g, "").split(".")[0];
        if (!num) { toast("No steps found on clipboard", "Run Copy Steps first. Right after midnight it copies nothing because today has 0 steps."); return; }
        $("#st-in", bg).value = num; save1(num);
      } catch (e) { toast("Couldn't read the clipboard", "Tap the box, then tap Paste instead"); $("#st-in", bg).focus(); }
    });
  }

  // ---------------------------------------------------------------- FOOD
  const MEALS = [["breakfast", "Breakfast"], ["lunch", "Lunch"], ["dinner", "Dinner"], ["snack", "Snacks"]];
  function renderFood(v) {
    const k = foodDay, d = peekDay(k), t = d.t || S.targets, tot = totals(d);
    const isToday = k === dayKey();
    const label = isToday ? "Today" : k === addDays(dayKey(), -1) ? "Yesterday" : keyToDate(k).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    const mbar = (have, goal) => '<div class="mb"><i style="width:' + clamp((have / goal) * 100, 0, 100) + '%"></i></div>';
    const meals = MEALS.map(([id, name]) => {
      const items = d.foods.filter((f) => (f.meal || "snack") === id);
      const kc = items.reduce((a, f) => a + f.n.kcal, 0);
      return '<div class="meal"><div class="meal-h">' + name + ' <span>' + fmt(kc) + ' kcal</span>' +
        (items.length ? '<button class="btn sm ghost" data-savemeal="' + id + '">Save meal</button>' : "") + '<button class="btn sm" data-add="' + id + '">+ Add</button></div>' +
        (items.length ? items.map((f) => '<div class="fitem fitem4"><button class="x star' + (isFav(f) ? " on" : "") + '" data-fav="' + esc(f.id) + '" aria-label="Favorite">' + (isFav(f) ? "★" : "☆") + '</button><div class="n">' + esc(f.name) + "<small>" + esc(f.amountLabel) + " · P " + r0(f.n.p) + " · C " + r0(f.n.c) + " · F " + r0(f.n.f) + '</small></div><div class="k">' + fmt(f.n.kcal) + '</div><button class="x" data-del="' + esc(f.id) + '" aria-label="Remove">×</button></div>').join("") : '<div class="empty">Nothing yet</div>') + "</div>";
    }).join("");
    const micros = microTargets().map((m) => {
      const have = tot[m.k] || 0, pc = m.goal ? have / m.goal : 0;
      return '<div class="micro' + (m.limit ? " limit" : "") + (m.limit && pc > 1 ? " over" : "") + '"><span>' + m.label + (m.limit ? " <small style=\"color:var(--muted)\">(limit)</small>" : "") + '</span><span class="v">' +
        (m.unit === "g" ? r1(have) : fmt(have)) + " / " + fmt(m.goal) + " " + m.unit + '</span><div class="bar"><i style="width:' + clamp(pc * 100, 0, 100) + '%"></i></div></div>';
    }).join("");
    v.innerHTML =
      '<div class="daynav"><button class="btn sm ghost" id="d-prev">‹ Prev</button><div class="d">' + esc(label) + '</div><button class="btn sm ghost" id="d-next" ' + (isToday ? "disabled" : "") + ">Next ›</button></div>" +
      '<section class="panel">' + corners() +
      '<div class="macro-grid">' +
      '<div class="m"><b>' + fmt(tot.kcal) + "</b><span>/ " + fmt(t.kcal) + " kcal</span>" + mbar(tot.kcal, t.kcal) + "</div>" +
      '<div class="m"><b>' + r0(tot.p) + "</b><span>/ " + t.protein + "g prot</span>" + mbar(tot.p, t.protein) + "</div>" +
      '<div class="m"><b>' + r0(tot.c) + "</b><span>/ " + t.carbs + "g carb</span>" + mbar(tot.c, t.carbs) + "</div>" +
      '<div class="m"><b>' + r0(tot.f) + "</b><span>/ " + t.fat + "g fat</span>" + mbar(tot.f, t.fat) + "</div></div>" +
      '<p class="explain" style="text-align:center;margin-bottom:0">' + (tot.kcal <= t.kcal ? "<b>" + fmt(t.kcal - tot.kcal) + "</b> calories left" : "<b style=\"color:var(--bad)\">" + fmt(tot.kcal - t.kcal) + "</b> calories over") + "</p>" +
      "</section>" +
      '<button class="btn primary block" id="f-add">+ Log food</button>' +
      meals +
      '<div class="h2">Vitamins & minerals</div>' + micros +
      '<p class="note">Food values are estimates. Online foods come from USDA FoodData Central and Open Food Facts.</p>';
    $("#d-prev").addEventListener("click", () => { foodDay = addDays(foodDay, -1); render(); });
    $("#d-next").addEventListener("click", () => { if (!isToday) { foodDay = addDays(foodDay, 1); render(); } });
    $("#f-add").addEventListener("click", () => openAddFood(guessMeal(), k));
    $$("[data-add]", v).forEach((b) => b.addEventListener("click", () => openAddFood(b.dataset.add, k)));
    $$("[data-fav]", v).forEach((b) => b.addEventListener("click", () => {
      const f = getDay(k).foods.find((x) => x.id === b.dataset.fav); if (!f) return;
      if (isFav(f)) { S.favs = S.favs.filter((x) => favKey(x) !== favKey(f)); toast("Removed from favorites"); }
      else { S.favs.unshift({ id: uid(), name: f.name, amountLabel: f.amountLabel, n: Object.assign({}, f.n), src: f.src }); S.favs = S.favs.slice(0, 40); toast("⭐ Added to favorites", "Find it at the top of Log food"); }
      save(); render();
    }));
    $$("[data-savemeal]", v).forEach((b) => b.addEventListener("click", () => {
      const mealId = b.dataset.savemeal, items = getDay(k).foods.filter((f) => (f.meal || "snack") === mealId);
      const def = (MEALS.find((m) => m[0] === mealId) || [, "Meal"])[1];
      const name = (prompt("Name this meal (e.g. \"Usual breakfast\")", "My " + def.toLowerCase()) || "").trim();
      if (!name) return;
      S.meals.unshift({ id: uid(), name: name.slice(0, 40), items: items.map((f) => ({ name: f.name, amountLabel: f.amountLabel, n: Object.assign({}, f.n), src: f.src })) });
      save(); render(); toast("🍱 Meal saved: " + name, "Log it with one tap from + Log food");
    }));
    $$("[data-del]", v).forEach((b) => b.addEventListener("click", () => {
      const day = getDay(k), i = day.foods.findIndex((f) => f.id === b.dataset.del);
      if (i >= 0) { const [gone] = day.foods.splice(i, 1); save(); render(); toast("Removed", gone.name); }
    }));
  }
  function favKey(f) { return f.name + "|" + f.amountLabel; }
  function isFav(f) { return (S.favs || []).some((x) => favKey(x) === favKey(f)); }
  function guessMeal() { const h = new Date().getHours(); return h < 11 ? "breakfast" : h < 16 ? "lunch" : h < 21 ? "dinner" : "snack"; }

  // food "source" shape: { name, brand, src, per100: {kcal,p,c,f,...}, servingG, servingLabel }
  function builtinFoods() {
    return (window.BUILTIN_FOODS || []).map((r) => ({
      name: r[0], brand: "", src: "BASIC", servingLabel: r[1], servingG: r[2],
      per100: { kcal: r[3], p: r[4], c: r[5], f: r[6], fiber: r[7], sugar: r[8], sat: r[9], sodium: r[10], potassium: r[11], calcium: r[12], iron: r[13], vitc: r[14] },
    }));
  }
  function matchScore(name, q) {
    const n = name.toLowerCase(), words = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return 0;
    let s = 0;
    for (const w of words) { const i = n.indexOf(w); if (i < 0) return 0; s += i === 0 ? 3 : 1; }
    return s;
  }

  function withTimeout(url, ms = 9000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    return fetch(url, { signal: ctl.signal }).finally(() => clearTimeout(t));
  }
  const USDA_MAP = { 1008: "kcal", 1003: "p", 1005: "c", 1004: "f", 1079: "fiber", 2000: "sugar", 1258: "sat", 1093: "sodium", 1092: "potassium", 1087: "calcium", 1089: "iron", 1162: "vitc" };
  async function searchUSDA(q) {
    const key = S.settings.usdaKey || "DEMO_KEY";
    const url = "https://api.nal.usda.gov/fdc/v1/foods/search?api_key=" + encodeURIComponent(key) + "&query=" + encodeURIComponent(q) +
      "&pageSize=15&dataType=" + encodeURIComponent("Survey (FNDDS),SR Legacy,Foundation");
    const res = await withTimeout(url);
    if (res.status === 429) { const e = new Error("USDA limit"); e.limit = true; throw e; }
    if (!res.ok) throw new Error("USDA " + res.status);
    const js = await res.json();
    return (js.foods || []).map((f) => {
      const per100 = {};
      let kj = null, atw = null;
      (f.foodNutrients || []).forEach((n) => {
        const id = n.nutrientId, key2 = USDA_MAP[id];
        if (key2 && n.value != null && (key2 !== "kcal" || (n.unitName || "").toUpperCase() === "KCAL")) per100[key2] = n.value;
        if ((id === 2047 || id === 2048) && n.value != null) atw = n.value;
        if (id === 1062 && n.value != null) kj = n.value;
      });
      if (per100.kcal == null) per100.kcal = atw != null ? atw : kj != null ? kj / 4.184 : null;
      if (per100.kcal == null) return null;
      let servingG = 100, servingLabel = "100 g";
      const m = (f.foodMeasures || []).find((x) => x.gramWeight > 0 && x.disseminationText && !/quantity not specified/i.test(x.disseminationText));
      if (m) { servingG = m.gramWeight; servingLabel = m.disseminationText + " (" + r0(m.gramWeight) + " g)"; }
      return { name: titleCase(f.description || "Food"), brand: f.brandOwner || "", src: "USDA", per100, servingG, servingLabel };
    }).filter(Boolean);
  }
  async function searchOFF(q) {
    const fields = "code,product_name,brands,nutriments,serving_size,serving_quantity";
    const urls = [
      "https://search.openfoodfacts.org/search?q=" + encodeURIComponent(q) + "&page_size=15&fields=" + fields,
      "https://world.openfoodfacts.org/cgi/search.pl?search_terms=" + encodeURIComponent(q) + "&search_simple=1&action=process&json=1&page_size=15&fields=" + fields,
    ];
    let lastErr;
    for (const url of urls) {
      try {
        const res = await withTimeout(url, 9000);
        if (!res.ok) { lastErr = new Error("Open Food Facts " + res.status); continue; }
        const js = await res.json();
        return (js.hits || js.products || []).map(offToFood).filter(Boolean);
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error("Open Food Facts unavailable");
  }
  function offToFood(p) {
    const n = p.nutriments || {};
    const g = (k) => (n[k + "_100g"] != null ? Number(n[k + "_100g"]) : null);
    let kcal = g("energy-kcal");
    if (kcal == null && g("energy") != null) kcal = g("energy") / 4.184;
    if (kcal == null || !p.product_name) return null;
    const mg = (k) => (g(k) != null ? g(k) * 1000 : 0); // OFF stores minerals in grams
    const per100 = { kcal, p: g("proteins") || 0, c: g("carbohydrates") || 0, f: g("fat") || 0, fiber: g("fiber") || 0, sugar: g("sugars") || 0, sat: g("saturated-fat") || 0, sodium: mg("sodium"), potassium: mg("potassium"), calcium: mg("calcium"), iron: mg("iron"), vitc: mg("vitamin-c") };
    const sq = Number(p.serving_quantity);
    return { name: p.product_name, brand: (p.brands || "").split(",")[0], src: "BRAND", per100, servingG: sq > 0 ? sq : 100, servingLabel: sq > 0 ? (p.serving_size || r0(sq) + " g") : "100 g" };
  }
  const SEARCH_CACHE = new Map();
  function titleCase(s) { return s.length > 3 && s === s.toUpperCase() ? s.charAt(0) + s.slice(1).toLowerCase() : s; }

  function openAddFood(meal = guessMeal(), k = dayKey()) {
    let mode = "search";
    let results = [];
    let searchSeq = 0;
    const bg = openModal(
      '<h2 class="panel-title" style="font-size:24px">Log Food</h2>' +
      '<div class="tabs" style="margin-top:12px"><button data-mode="search" class="active">Search</button><button data-mode="photo">📷 Photo</button><button data-mode="quick">Quick add</button></div>' +
      '<div id="af-body"></div>');
    const body = $("#af-body", bg);
    $$(".tabs button", bg).forEach((b) => b.addEventListener("click", () => {
      mode = b.dataset.mode; $$(".tabs button", bg).forEach((x) => x.classList.toggle("active", x === b)); draw();
    }));
    function mealSelect(id) {
      return '<label class="f" for="' + id + '">Meal</label><select id="' + id + '">' + MEALS.map(([m, n]) => '<option value="' + m + '"' + (m === meal ? " selected" : "") + ">" + n + "</option>").join("") + "</select>";
    }
    function draw() {
      if (mode === "photo") return drawPhoto();
      if (mode === "quick") {
        body.innerHTML =
          '<label class="f" for="qa-name">Name</label><input id="qa-name" placeholder="e.g. Mom\'s lasagna">' +
          '<div class="row"><div><label class="f" for="qa-k">Calories</label><input id="qa-k" type="number" inputmode="decimal" min="0"></div>' +
          '<div><label class="f" for="qa-p">Protein g</label><input id="qa-p" type="number" inputmode="decimal" min="0"></div></div>' +
          '<div class="row"><div><label class="f" for="qa-c">Carbs g</label><input id="qa-c" type="number" inputmode="decimal" min="0"></div>' +
          '<div><label class="f" for="qa-f">Fat g</label><input id="qa-f" type="number" inputmode="decimal" min="0"></div></div>' +
          '<div class="row"><div><label class="f" for="qa-fi">Fiber g (optional)</label><input id="qa-fi" type="number" inputmode="decimal" min="0"></div>' +
          '<div><label class="f" for="qa-na">Sodium mg (optional)</label><input id="qa-na" type="number" inputmode="decimal" min="0"></div></div>' +
          mealSelect("qa-meal") + '<button class="btn primary block" style="margin-top:16px" id="qa-add">Add</button>';
        $("#qa-add", body).addEventListener("click", () => {
          const num = (id) => Math.max(0, parseFloat($(id, body).value) || 0);
          const name = $("#qa-name", body).value.trim() || "Quick add";
          const p = num("#qa-p"), c = num("#qa-c"), f = num("#qa-f");
          let kcal = num("#qa-k"); if (!kcal) kcal = p * 4 + c * 4 + f * 9;
          if (!kcal) { toast("Enter calories or macros"); return; }
          const n = { kcal, p, c, f, fiber: num("#qa-fi"), sugar: 0, sat: 0, sodium: num("#qa-na"), potassium: 0, calcium: 0, iron: 0, vitc: 0 };
          logFood(k, { name, amountLabel: "1 serving", meal: $("#qa-meal", body).value, n });
          closeModal();
        });
        return;
      }
      body.innerHTML =
        '<label class="btn block" style="display:flex;align-items:center;justify-content:center;gap:8px;margin-bottom:10px">▦ Scan a barcode' +
        '<input type="file" id="bc-file" accept="image/*" capture="environment" class="hidden"></label>' +
        '<input id="af-q" type="search" placeholder="Search: chicken, banana, Chobani…" autocomplete="off" enterkeyhint="search">' +
        '<div class="results" id="af-res"></div>';
      $("#bc-file", body).addEventListener("change", async (e) => {
        const file = e.target.files && e.target.files[0]; if (!file) return;
        const box = $("#af-res", body);
        box.innerHTML = '<div class="loading">Reading barcode</div>';
        try {
          const code = await readBarcode(file);
          box.innerHTML = '<div class="loading">Looking up ' + esc(code) + '</div>';
          const food = await lookupBarcode(code);
          if (food) openAmount(food);
          else box.innerHTML = '<div class="empty">Barcode ' + esc(code) + " isn't in the free food database yet. Try 📷 Photo (snap the Nutrition Facts label) or Quick add.</div>";
        } catch (err) { box.innerHTML = '<div class="err" style="text-align:left">' + esc(err.message || "Something went wrong") + "</div>"; }
        e.target.value = "";
      });
      const qIn = $("#af-q", body);
      showList("");
      let timer;
      qIn.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => showList(qIn.value.trim()), 700); });
      qIn.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); qIn.blur(); showList(qIn.value.trim(), true); } });
      setTimeout(() => qIn.focus(), 50);
    }
    function showList(q, online) {
      const box = $("#af-res", body); if (!box) return;
      const seq = ++searchSeq;
      if (!q) {
        let quick = "";
        if (S.meals.length) quick += '<div class="h2" style="margin-top:6px">🍱 My meals</div>' + S.meals.map((m) => {
          const kc = m.items.reduce((a, f) => a + f.n.kcal, 0), pr = m.items.reduce((a, f) => a + f.n.p, 0);
          return '<div class="res-row"><button class="res" data-meal="' + esc(m.id) + '"><span class="src">MEAL</span><b>' + esc(m.name) + "</b><span>" + m.items.length + (m.items.length === 1 ? " item · " : " items · ") + fmt(kc) + " kcal · P " + r0(pr) + 'g</span></button><button class="x" data-delmeal="' + esc(m.id) + '" aria-label="Delete meal">×</button></div>';
        }).join("");
        if (S.favs.length) quick += '<div class="h2">⭐ Favorites</div>' + S.favs.map((f) =>
          '<div class="res-row"><button class="res" data-favadd="' + esc(f.id) + '"><span class="src">FAV</span><b>' + esc(f.name) + "</b><span>" + esc(f.amountLabel) + " · " + fmt(f.n.kcal) + " kcal · P " + r0(f.n.p) + 'g</span></button><button class="x" data-delfav="' + esc(f.id) + '" aria-label="Remove favorite">×</button></div>').join("");
        box.innerHTML = quick;
        $$("[data-meal]", box).forEach((b) => b.addEventListener("click", () => {
          const m = S.meals.find((x) => x.id === b.dataset.meal); if (!m) return;
          m.items.forEach((it) => { const d = getDay(k); d.foods.push({ id: uid(), t: Date.now(), name: it.name, amountLabel: it.amountLabel, n: Object.assign({}, it.n), src: it.src, meal }); });
          save(); closeModal(); render(); toast("🍱 Logged: " + m.name, fmt(m.items.reduce((a, f) => a + f.n.kcal, 0)) + " kcal");
        }));
        $$("[data-favadd]", box).forEach((b) => b.addEventListener("click", () => {
          const f = S.favs.find((x) => x.id === b.dataset.favadd); if (!f) return;
          logFood(k, { name: f.name, amountLabel: f.amountLabel, n: Object.assign({}, f.n), src: f.src, meal }); closeModal();
        }));
        $$("[data-delmeal]", box).forEach((b) => b.addEventListener("click", () => { if (confirm("Delete this saved meal?")) { S.meals = S.meals.filter((x) => x.id !== b.dataset.delmeal); save(); showList(""); } }));
        $$("[data-delfav]", box).forEach((b) => b.addEventListener("click", () => { S.favs = S.favs.filter((x) => x.id !== b.dataset.delfav); save(); showList(""); }));
        results = S.recents.slice(0, 12);
        box.innerHTML += (results.length ? '<div class="h2" style="margin-top:6px">Recent</div>' : '<div class="h2" style="margin-top:6px">Popular basics</div>');
        if (!results.length) results = builtinFoods().slice(0, 12);
        box.insertAdjacentHTML("beforeend", results.map(resHTML).join(""));
        bindRes(box);
        return;
      }
      const local = S.recents.concat(builtinFoods())
        .map((f) => ({ f, s: matchScore(f.name + " " + (f.brand || ""), q) })).filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s).map((x) => x.f);
      const seen = new Set(); results = local.filter((f) => { const id = f.src + f.name; if (seen.has(id)) return false; seen.add(id); return true; }).slice(0, 8);
      const local1 = results.slice();
      const aiBtn = () => S.settings.geminiKey ? '<button class="btn block" id="af-ai" style="margin-top:8px">✨ Ask AI: nutrition for “' + esc(q) + '”</button>' : "";
      const bindAI = () => { const b = $("#af-ai", box); if (b) b.addEventListener("click", () => askAI(q, box)); };
      if (q.length < 3) { box.innerHTML = results.map(resHTML).join(""); bindRes(box); return; }
      box.innerHTML = results.map(resHTML).join("") + '<div class="loading" id="af-load">Searching online</div>';
      bindRes(box);
      const ck = q.toLowerCase();
      const cached = SEARCH_CACHE.get(ck);
      const work = cached ? Promise.resolve(cached) : Promise.allSettled([searchUSDA(q), searchOFF(q)]).then(([u, o]) => {
        const r = { usda: u.status === "fulfilled" ? u.value : null, off: o.status === "fulfilled" ? o.value : null, uErr: u.reason, oErr: o.reason };
        if (r.usda || r.off) SEARCH_CACHE.set(ck, r);
        return r;
      });
      work.then((r) => {
        if (seq !== searchSeq) return;
        results = local1.concat((r.usda || []).slice(0, 10), (r.off || []).slice(0, 10));
        const failed = !r.usda && !r.off;
        let msg = "";
        if (failed) msg = '<div class="empty">Online food search isn\'t answering right now' + (r.uErr && r.uErr.limit ? " (the free USDA search hit its hourly limit)" : "") + "." +
          (S.settings.geminiKey ? " Use ✨ Ask AI below, or Quick add." : " Try again in a few minutes, or use Quick add.") + "</div>";
        else if (!results.length) msg = '<div class="empty">No results. Try other words.</div>';
        box.innerHTML = results.map(resHTML).join("") + msg + aiBtn();
        bindRes(box); bindAI();
      });
    }
    // Ask Gemini (with Google Search) for nutrition of whatever was typed: restaurant & branded foods.
    async function askAI(q, box) {
      box.innerHTML = '<div class="loading">Asking AI about “' + esc(q) + '”</div>';
      try {
        const d = await gemini([{ text:
          "Give the nutrition facts for one typical serving of: \"" + q + "\". If it's a branded or restaurant item, use the official published nutrition facts (search the web). " +
          "Return JSON only: {\"name\":string,\"brand\":string,\"serving\":string,\"grams\":number,\"kcal\":number,\"protein_g\":number,\"carbs_g\":number,\"fat_g\":number,\"fiber_g\":number,\"sugar_g\":number,\"sat_fat_g\":number,\"sodium_mg\":number}" }], { search: true, fallbackNoSearch: true });
        const x = Array.isArray(d) ? d[0] : d;
        if (!x || !(+x.kcal > 0)) throw new Error("The AI couldn't find that food. Try other words.");
        const g = +x.grams > 0 ? +x.grams : 100;
        const per100 = {};
        const map = { kcal: "kcal", p: "protein_g", c: "carbs_g", f: "fat_g", fiber: "fiber_g", sugar: "sugar_g", sat: "sat_fat_g", sodium: "sodium_mg" };
        NKEYS.forEach((k) => (per100[k] = map[k] ? ((+x[map[k]] || 0) * 100) / g : 0));
        openAmount({ name: String(x.name || q).slice(0, 80), brand: String(x.brand || "").slice(0, 60), src: "AI", per100, servingG: g, servingLabel: String(x.serving || "1 serving").slice(0, 60) + (x.grams ? " (" + r0(g) + " g)" : "") });
      } catch (e) {
        box.innerHTML = '<div class="err" style="text-align:left">' + esc(e.message || "Something went wrong") + "</div>";
      }
    }
    // ---- photo → AI estimate
    function drawPhoto() {
      if (!S.settings.geminiKey) {
        body.innerHTML =
          '<p class="explain" style="margin-top:0">Snap your plate and an AI guesses the foods and calories. It needs a free key from Google, one time only:</p>' +
          '<ol class="explain" style="padding-left:20px">' +
          '<li>Open <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener" style="color:var(--line)">aistudio.google.com/apikey</a> and sign in with any Google account.</li>' +
          "<li>Tap <b>Create API key</b>. If it asks, accept the terms and pick or create any project.</li>" +
          "<li>Tap the <b>copy</b> icon next to your key to copy the whole thing.</li>" +
          "<li>Come back here, paste it below, tap Save.</li></ol>" +
          '<label class="f" for="gk">Your Google AI key</label><input id="gk" placeholder="Paste your key here" autocomplete="off" autocapitalize="off" spellcheck="false">' +
          '<button class="btn primary block" style="margin-top:12px" id="gk-save">Save key</button>' +
          '<p class="note">The key is saved only on this phone. Don\'t share it. It\'s free for personal use; Google may use free-tier photos to improve its AI.</p>';
        $("#gk-save", body).addEventListener("click", () => {
          const v = $("#gk", body).value.trim();
          // Classic keys start with "AIza"; Google also issues newer formats, so accept any long key and let Google check it.
          if (!/^[\w.\-]{20,}$/.test(v)) { toast("That doesn't look like a Google AI key", "Copy the whole key, with no spaces"); return; }
          S.settings.geminiKey = v; save(); drawPhoto();
        });
        return;
      }
      body.innerHTML =
        '<label class="btn primary block" style="display:flex;align-items:center;justify-content:center;gap:8px;min-height:64px">📷 Take or choose a photo' +
        '<input type="file" id="ph-file" accept="image/*" capture="environment" class="hidden"></label>' +
        '<label class="f" for="ph-hint">Anything the photo can\'t show? (optional)</label><input id="ph-hint" placeholder="e.g. cooked in butter, large portion">' +
        '<div id="ph-out"></div>';
      $("#ph-file", body).addEventListener("change", async (e) => {
        const file = e.target.files && e.target.files[0]; if (!file) return;
        const out = $("#ph-out", body);
        out.innerHTML = '<div class="loading" style="margin-top:14px">Scanning your food</div>';
        try {
          const { b64, url } = await shrinkImage(file);
          out.innerHTML = '<img src="' + url + '" alt="" style="width:100%;max-height:220px;object-fit:cover;margin-top:14px;border:1px solid var(--line-dim)"><div class="loading">Scanning your food</div>';
          const items = await analyzePhoto(b64, $("#ph-hint", body).value.trim(), (msg) => { const l = $(".loading", out); if (l) l.textContent = msg; });
          showPhotoItems(items, url);
        } catch (err) {
          out.innerHTML = '<div class="err" style="text-align:left">' + esc(err.message || "Something went wrong") + "</div>";
        }
      });
    }
    function showPhotoItems(items, url) {
      const out = $("#ph-out", body);
      if (!items.length) { out.innerHTML = '<div class="err">No food found in that photo. Try again closer up.</div>'; return; }
      const numIn = (cls, v, lab) => '<div><label class="f" style="margin:6px 0 4px">' + lab + '</label><input class="' + cls + '" type="number" inputmode="decimal" min="0" value="' + r0(v) + '"></div>';
      out.innerHTML = '<img src="' + url + '" alt="" style="width:100%;max-height:200px;object-fit:cover;margin-top:14px;border:1px solid var(--line-dim)">' +
        '<p class="explain">AI guess. Fix anything that looks off, then add. Packaged food? <b>▦ Scan a barcode</b> in Search is the most accurate.</p>' +
        items.map((it, i) => '<div class="res" data-pi="' + i + '" style="cursor:default"><div style="display:flex;gap:8px;align-items:center"><input class="pi-name" value="' + esc(it.name) + '" style="flex:1;padding:8px">' +
          '<button class="x pi-del" aria-label="Remove">×</button></div><span>' + esc(it.portion || "") +
          (it.label ? ' · <b style="color:var(--good);display:inline;font-size:12px">✓ official label values</b>' : it.packaged ? ' · <b style="color:var(--warn);display:inline;font-size:12px">estimate, check the label</b>' : "") + '</span>' +
          '<div class="row" style="margin:8px 0 2px">' + [0.5, 1, 1.5, 2].map((m) => '<button class="btn sm ' + (m === 1 ? "primary" : "ghost") + ' pi-m" data-m="' + m + '">' + (m === 0.5 ? "½" : m) + "×</button>").join("") + "</div>" +
          '<div class="row">' + numIn("pi-k", it.kcal, "kcal") + numIn("pi-p", it.p, "prot g") + numIn("pi-c", it.c, "carb g") + numIn("pi-f", it.f, "fat g") + "</div></div>").join("") +
        mealSelect("ph-meal") + '<button class="btn good block" style="margin-top:14px" id="ph-add">Add to log</button>';
      // portion size buttons: scale the AI's numbers for this item
      $$(".pi-m", out).forEach((b) => b.addEventListener("click", () => {
        const row = b.closest(".res"), it = items[+row.dataset.pi], m = +b.dataset.m;
        it.mult = m;
        $(".pi-k", row).value = r0(it.kcal * m); $(".pi-p", row).value = r0(it.p * m); $(".pi-c", row).value = r0(it.c * m); $(".pi-f", row).value = r0(it.f * m);
        $$(".pi-m", row).forEach((x) => { x.classList.toggle("primary", x === b); x.classList.toggle("ghost", x !== b); });
      }));
      $$(".pi-del", out).forEach((b) => b.addEventListener("click", () => b.closest(".res").remove()));
      $("#ph-add", out).addEventListener("click", () => {
        const rows = $$(".res[data-pi]", out);
        if (!rows.length) { toast("Nothing to add"); return; }
        const meal1 = $("#ph-meal", out).value;
        rows.forEach((row) => {
          const it = items[+row.dataset.pi], g = (c) => Math.max(0, parseFloat($(c, row).value) || 0);
          const mm = it.mult || 1;
          const n = { kcal: g(".pi-k"), p: g(".pi-p"), c: g(".pi-c"), f: g(".pi-f"), fiber: (it.fiber || 0) * mm, sugar: (it.sugar || 0) * mm, sat: (it.sat || 0) * mm, sodium: (it.sodium || 0) * mm, potassium: 0, calcium: 0, iron: 0, vitc: 0 };
          logFood(k, { name: ($(".pi-name", row).value.trim() || it.name) + (it.label ? "" : " 📷"), amountLabel: it.portion || "1 portion", meal: meal1, n, src: "photo" });
        });
        closeModal();
      });
    }

    function resHTML(f, i) {
      const per = scaleNutrients(f.per100, f.servingG);
      return '<button class="res" data-i="' + i + '"><span class="src">' + esc(f.src) + "</span><b>" + esc(f.name) + "</b><span>" +
        (f.brand ? esc(f.brand) + " · " : "") + esc(f.servingLabel) + " · " + fmt(per.kcal) + " kcal · P " + r0(per.p) + "g</span></button>";
    }
    function bindRes(box) { $$(".res[data-i]", box).forEach((b) => b.addEventListener("click", () => openAmount(results[+b.dataset.i]))); }

    function openAmount(food) {
      let unit = "serving", qty = 1;
      body.innerHTML =
        '<div class="res" style="cursor:default"><span class="src">' + esc(food.src) + "</span><b>" + esc(food.name) + "</b><span>" + (food.brand ? esc(food.brand) + " · " : "") + "1 serving = " + esc(food.servingLabel) + "</span></div>" +
        '<div class="row"><div><label class="f" for="am-q">Amount</label><input id="am-q" type="number" inputmode="decimal" min="0" step="any" value="1"></div>' +
        '<div><label class="f" for="am-u">Unit</label><select id="am-u"><option value="serving">serving(s)</option><option value="g">grams</option><option value="oz">ounces</option></select></div></div>' +
        mealSelect("am-meal") +
        '<div class="statgrid" id="am-prev"></div>' +
        '<div class="row" style="margin-top:16px"><button class="btn ghost" id="am-back">Back</button><button class="btn primary" id="am-add">Add</button></div>';
      const grams = () => (unit === "serving" ? qty * food.servingG : unit === "oz" ? qty * 28.35 : qty);
      const prev = () => {
        const n = scaleNutrients(food.per100, grams());
        $("#am-prev", body).innerHTML =
          '<div class="stat wide"><span>Calories</span><b>' + fmt(n.kcal) + "</b></div>" +
          '<div class="stat"><span>Protein</span><b>' + r1(n.p) + 'g</b></div><div class="stat"><span>Carbs</span><b>' + r1(n.c) + "g</b></div>" +
          '<div class="stat"><span>Fat</span><b>' + r1(n.f) + 'g</b></div><div class="stat"><span>Fiber</span><b>' + r1(n.fiber) + "g</b></div>";
      };
      $("#am-q", body).addEventListener("input", (e) => { qty = Math.max(0, parseFloat(e.target.value) || 0); prev(); });
      $("#am-u", body).addEventListener("change", (e) => {
        const g = grams(); unit = e.target.value;
        qty = unit === "serving" ? r1(g / food.servingG) : unit === "oz" ? r1(g / 28.35) : r0(g);
        $("#am-q", body).value = qty; prev();
      });
      $("#am-back", body).addEventListener("click", draw);
      $("#am-add", body).addEventListener("click", () => {
        if (!(grams() > 0)) { toast("Enter an amount"); return; }
        const label = unit === "serving" ? (qty === 1 ? food.servingLabel : r1(qty) + " × " + food.servingLabel) : r1(qty) + (unit === "g" ? " g" : " oz");
        logFood(k, { name: food.name + (food.brand ? " (" + food.brand + ")" : ""), amountLabel: label, meal: $("#am-meal", body).value, n: scaleNutrients(food.per100, grams()), src: food.viaBarcode ? "barcode" : food.src === "AI" ? "ai" : "search" });
        remember(food);
        closeModal();
      });
      prev();
    }
    draw();
  }
  // Resize a photo to ≤1024 px JPEG so it uploads fast.
  function shrinkImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const max = 1024, s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement("canvas");
        c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        const data = c.toDataURL("image/jpeg", 0.82);
        resolve({ b64: data.split(",")[1], url: data });
        URL.revokeObjectURL(url);
      };
      img.onerror = () => reject(new Error("Couldn't open that photo. Try another one."));
      img.src = url;
    });
  }
  // One call to Google's Gemini. opts.json → ask for JSON output; opts.search → let it use Google Search.
  async function gemini(parts, opts = {}) {
    const key = S.settings.geminiKey;
    const models = [S.settings.geminiModel || "gemini-flash-latest", "gemini-2.5-flash"];
    const req = { contents: [{ parts }], generationConfig: { temperature: 0.2 } };
    if (opts.json) req.generationConfig.responseMimeType = "application/json";
    if (opts.search) req.tools = [{ google_search: {} }];
    const body = JSON.stringify(req);
    let lastErr;
    for (const model of models) {
      let res;
      try {
        const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 45000);
        res = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent", {
          method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key }, body, signal: ctl.signal,
        }).finally(() => clearTimeout(t));
      } catch (e) { throw new Error("Couldn't reach the AI. Check your internet and try again."); }
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        let why = ""; try { why = (JSON.parse(txt).error || {}).message || ""; } catch (e) { why = txt; }
        why = String(why).slice(0, 160);
        if ((res.status === 400 || res.status === 401 || res.status === 403) && /API key not valid|API_KEY_INVALID|UNAUTHENTICATED|invalid authentication/i.test(txt)) {
          S.settings.geminiKey = ""; save();
          throw new Error("Google says that key doesn't work. Close this, tap 📷 Photo again and paste a new key.");
        }
        if (res.status === 429) { lastErr = new Error("You hit the free AI limit for now. Wait a minute and try again, or use Search / ▦ barcode."); lastErr.limit = true; }
        else lastErr = new Error("The AI had a problem (" + res.status + (why ? ": " + why : "") + "). Try again in a moment.");
        continue; // try the backup model, which has its own free quota
      }
      const js = await res.json();
      const cand = (js.candidates || [])[0] || {};
      const text = ((cand.content || {}).parts || []).map((p) => p.text || "").join("");
      // pull the JSON out even if it's wrapped in ``` fences or extra words
      const m = text.match(/[\[{][\s\S]*[\]}]/);
      try { return JSON.parse(m ? m[0] : text); } catch (e) { throw new Error("The AI gave a confusing answer. Try again."); }
    }
    if (opts.search && opts.fallbackNoSearch && lastErr && !lastErr.limit) return gemini(parts, Object.assign({}, opts, { search: false, fallbackNoSearch: false }));
    throw lastErr || new Error("The AI isn't available right now.");
  }
  const PHOTO_PROMPT =
    "You are a nutrition expert. Identify every distinct food and drink in this photo. " +
    "If an item is a PACKAGED or BRANDED product (a wrapper, box, can or logo is visible), set packaged=true, fill brand and product, " +
    "and give the manufacturer's official nutrition facts for ONE package/serving as sold, using the real net weight from the package, not a visual guess. " +
    "If a nutrition facts label is visible, copy its numbers exactly. Otherwise estimate the portion actually shown, accounting for visible oils, sauces and cooking method. " +
    "Return JSON only: {\"items\":[{\"name\":string,\"brand\":string,\"product\":string,\"packaged\":boolean,\"portion\":string,\"grams\":number,\"kcal\":number,\"protein_g\":number,\"carbs_g\":number,\"fat_g\":number,\"fiber_g\":number,\"sugar_g\":number,\"sat_fat_g\":number,\"sodium_mg\":number}]}. " +
    "Use short everyday names and a portion in everyday words plus grams (e.g. \"1 bar (45 g)\"). If there is no food, return {\"items\":[]}.";
  function aiItem(x) {
    return {
      name: String(x.name || x.product || "Food").slice(0, 80), portion: String(x.portion || x.serving || "").slice(0, 80),
      brand: String(x.brand || "").slice(0, 60), product: String(x.product || "").slice(0, 80), packaged: !!x.packaged,
      kcal: +x.kcal || 0, p: +x.protein_g || 0, c: +x.carbs_g || 0, f: +x.fat_g || 0,
      fiber: +x.fiber_g || 0, sugar: +x.sugar_g || 0, sat: +x.sat_fat_g || 0, sodium: +x.sodium_mg || 0,
    };
  }
  async function analyzePhoto(b64, hint, onStatus) {
    const data = await gemini([{ inline_data: { mime_type: "image/jpeg", data: b64 } }, { text: PHOTO_PROMPT + (hint ? " Extra info from the user: " + hint : "") }], { json: true });
    const items = (Array.isArray(data) ? data : data.items || []).filter((x) => x && (x.name || x.product)).slice(0, 12).map(aiItem);
    // For packaged foods, double-check against the real label using Google Search.
    const packaged = items.filter((it) => it.packaged && (it.brand || it.product));
    if (packaged.length) {
      if (onStatus) onStatus("Checking the official label");
      await Promise.all(packaged.slice(0, 3).map(async (it) => {
        try {
          const what = (it.brand + " " + (it.product || it.name)).trim();
          const d = await gemini([{ text:
            "Search the web for the official Nutrition Facts of \"" + what + "\" (from the brand's site, the package, or a grocery retailer). " +
            "Return JSON only for ONE serving as listed on the label: {\"found\":boolean,\"serving\":string,\"grams\":number,\"kcal\":number,\"protein_g\":number,\"carbs_g\":number,\"fat_g\":number,\"fiber_g\":number,\"sugar_g\":number,\"sat_fat_g\":number,\"sodium_mg\":number}. " +
            "If you can't find reliable label data, return {\"found\":false}." }], { search: true });
          if (d && d.found && +d.kcal > 0) {
            const l = aiItem(Object.assign({}, d, { name: it.name, brand: it.brand, product: it.product, packaged: true, portion: d.serving ? "1 serving: " + d.serving : it.portion }));
            Object.assign(it, l, { label: true });
          }
        } catch (e) { /* label check failed: keep the photo estimate */ }
      }));
    }
    return items;
  }

  // ---- barcode → Open Food Facts
  let zxingLoad;
  function loadZXing() {
    if (window.ZXing) return Promise.resolve();
    zxingLoad = zxingLoad || new Promise((ok, bad) => {
      const s = document.createElement("script"); s.src = "vendor/zxing-0.21.3.min.js";
      s.onload = ok; s.onerror = () => { zxingLoad = null; bad(new Error("Couldn't load the barcode scanner. Check your internet.")); };
      document.head.appendChild(s);
    });
    return zxingLoad;
  }
  async function readBarcode(file) {
    await loadZXing();
    const Z = window.ZXing;
    const hints = new Map();
    hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.UPC_A, Z.BarcodeFormat.UPC_E]);
    hints.set(Z.DecodeHintType.TRY_HARDER, true);
    const reader = new Z.MultiFormatReader(); reader.setHints(hints);
    const img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => bad(new Error("Couldn't open that photo.")); i.src = URL.createObjectURL(file); });
    // try a few sizes and both orientations — phone photos are big and barcodes can be sideways
    for (const max of [1200, 800, 1800]) {
      for (const rot of [0, 90]) {
        const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.round(img.naturalWidth * s), h = Math.round(img.naturalHeight * s);
        const c = document.createElement("canvas"); const ctx = c.getContext("2d");
        if (rot) { c.width = h; c.height = w; ctx.translate(h, 0); ctx.rotate(Math.PI / 2); } else { c.width = w; c.height = h; }
        ctx.drawImage(img, 0, 0, w, h);
        try {
          const lum = new Z.HTMLCanvasElementLuminanceSource(c);
          const res = reader.decode(new Z.BinaryBitmap(new Z.HybridBinarizer(lum)));
          URL.revokeObjectURL(img.src);
          return res.getText();
        } catch (e) { /* try next */ }
      }
    }
    URL.revokeObjectURL(img.src);
    throw new Error("Couldn't find a barcode. Get closer, keep it flat and in focus, and try again.");
  }
  async function lookupBarcode(code) {
    const tries = [code]; if (code.length === 12) tries.push("0" + code); if (code.length === 13 && code[0] === "0") tries.push(code.slice(1));
    for (const c of tries) {
      const res = await withTimeout("https://world.openfoodfacts.org/api/v2/product/" + encodeURIComponent(c) + ".json?fields=code,product_name,brands,nutriments,serving_size,serving_quantity", 10000);
      if (!res.ok) continue;
      const js = await res.json();
      if (js.status === 1 && js.product) { const f = offToFood(js.product); if (f) { f.viaBarcode = true; return f; } }
    }
    return null;
  }

  function scaleNutrients(per100, g) {
    const n = {}; NKEYS.forEach((k) => (n[k] = ((Number(per100[k]) || 0) * g) / 100)); return n;
  }
  function remember(food) {
    const id = food.src + "|" + food.name + "|" + (food.brand || "");
    S.recents = [Object.assign({}, food)].concat(S.recents.filter((f) => f.src + "|" + f.name + "|" + (f.brand || "") !== id)).slice(0, 30);
    save();
  }
  function logFood(k, item) {
    const d = getDay(k);
    item.id = uid(); item.t = Date.now();
    d.foods.push(item);
    save();
    if (tab !== "quest") foodDay = k;
    render();
    toast("Logged: " + item.name, fmt(item.n.kcal) + " kcal · " + r0(item.n.p) + "g protein");
  }

  // ---------------------------------------------------------------- PLAYER
  function renderPlayer(v) {
    const p = S.profile, t = S.targets;
    const xp = totalXP(), L = levelFromXP(xp);
    const cleared = Object.keys(S.days).filter((k) => questState(k).cleared).length;
    const ht = p.units === "imperial" ? Math.floor(p.heightCm / 2.54 / 12) + "′ " + r0((p.heightCm / 2.54) % 12) + "″" : r0(p.heightCm) + " cm";
    const wt = p.units === "imperial" ? r0(p.weightKg * 2.20462) + " lb" : r1(p.weightKg) + " kg";
    v.innerHTML =
      '<section class="panel">' + corners() + '<h1 class="panel-title">Player</h1><p class="panel-sub">' + esc(p.name || "Player") + " · Lv " + L + " " + esc(titleFor(L)) + "</p>" +
      '<div class="statgrid"><div class="stat"><span>Total XP</span><b>' + fmt(xp) + '</b></div><div class="stat"><span>Quests cleared</span><b>' + cleared + "</b></div>" +
      '<div class="stat"><span>Streak</span><b>' + streak() + ' 🔥</b></div><div class="stat"><span>Days logged</span><b>' + Object.keys(S.days).filter((k) => S.days[k].foods.length).length + "</b></div></div></section>" +
      '<div class="h2">Daily targets</div>' +
      kv("Calories", fmt(t.kcal) + " kcal") + kv("Protein", t.protein + " g") + kv("Carbs", t.carbs + " g") + kv("Fat", t.fat + " g") + kv("Fiber", t.fiber + " g") +
      kv("Water", t.water + " × " + t.bottleOz + " oz bottles") + kv("Steps", fmt(t.steps)) +
      '<p class="note">Based on: ' + esc(p.sex) + ", " + p.age + " yrs, " + ht + ", " + wt + ", " + esc(ACTIVITY[p.activity].label.toLowerCase()) + ", goal: " + esc(GOALS[p.goal].label.toLowerCase()) +
      ". Your body burns about " + fmt(t.tdee) + " kcal a day.</p>" +
      '<button class="btn block" id="pl-edit" style="margin-top:10px">Update my stats (new weight, goal…)</button>' +
      '<div id="acct-slot"></div>' +
      '<div class="h2">Badges (' + BADGES.filter((b) => S.badges[b[0]]).length + "/" + BADGES.length + ')</div><div class="badges">' +
      BADGES.map(([id, icon, name, desc]) => '<div class="bdg' + (S.badges[id] ? " got" : "") + '"><i>' + (S.badges[id] ? icon : "🔒") + "</i><b>" + esc(name) + "</b><span>" + esc(desc) + "</span></div>").join("") + "</div>" +
      '<div class="h2">Title</div><select id="pl-title">' + availableTitles(L).map((t) => '<option' + (t === currentTitle(L) ? " selected" : "") + ">" + esc(t) + "</option>").join("") + "</select>" +
      '<p class="note">Level up and earn badges to unlock more titles.</p>' +
      '<div class="h2">Theme</div><div class="themes">' + THEMES.map((th) => {
        const ok = themeUnlocked(th, L), on = (S.settings.theme || "azure") === th[0];
        return '<button class="theme' + (on ? " on" : "") + '" data-theme-pick="' + th[0] + '"' + (ok ? "" : " disabled") + ' style="--sw:' + th[3] + '"><i></i>' + th[1] + "<span>" + (ok ? (on ? "In use" : "Unlocked") : "🔒 " + (typeof th[2] === "number" ? "Level " + th[2] : "Boss Slayer badge")) + "</span></button>";
      }).join("") + "</div>" +

      '<div class="h2">Setup guides</div>' +
      '<details class="guide"><summary>💧 Water reminders (4× a day)</summary><div class="gb">' +
      "<p>iPhone web apps can't send their own reminders yet without a server, so we use the free <b>Reminders</b> app that's already on your phone:</p><ol>" +
      "<li>Open the <b>Reminders</b> app.</li><li>Tap <b>New Reminder</b> and type <code>Drink water 💧 log it in Cal Quest</code>.</li>" +
      "<li>Tap the <b>ⓘ</b> next to it. Turn on <b>Date</b> and <b>Time</b>, set the time to <b>" + to12(S.settings.reminders[0]) + "</b>.</li>" +
      "<li>Tap <b>Repeat</b> → <b>Daily</b>. Tap <b>Done</b>.</li>" +
      "<li>Do the same 3 more times for <b>" + S.settings.reminders.slice(1).map(to12).join("</b>, <b>") + "</b>.</li></ol>" +
      "<p>When a reminder pops up, open Cal Quest. It will ask you how many bottles you drank.</p>" +
      '<label class="f">Check-in times (change if you like)</label><div class="times">' +
      S.settings.reminders.map((hm, i) => '<input type="time" data-rem="' + i + '" value="' + hm + '">').join("") + "</div></div></details>" +

      '<details class="guide"><summary>👟 Apple Health steps</summary><div class="gb">' +
      "<p>Web apps aren't allowed to read the Health app directly, so a free Shortcut copies your step count and you paste it in with one tap. Set it up once:</p><ol>" +
      "<li>Open the <b>Shortcuts</b> app. Tap <b>+</b> (top right).</li>" +
      "<li>Tap <b>Search Actions</b>, type <code>Find Health Samples</code>, tap it.</li>" +
      "<li>In that action, tap the word after <b>Type</b> and choose <b>Steps</b>. Make sure it says <b>Start Date is Today</b>.</li>" +
      "<li>Search and add <code>Calculate Statistics</code>. Set it to <b>Sum</b>.</li>" +
      "<li>Search and add <code>Round Number</code>.</li>" +
      "<li>Search and add <code>Copy to Clipboard</code>.</li>" +
      "<li>Tap the name at the top, call it <code>Copy Steps</code>, tap <b>Done</b>. The first time it runs, tap <b>Allow</b> for Health.</li></ol><p class=\"note\">If you have 0 steps so far today (like just after midnight), the shortcut copies nothing. That's normal.</p>" +
      "<p><b>Every day:</b> run <b>Copy Steps</b> (tip: add it as a widget), open Cal Quest, tap <b>Steps</b> → <b>Paste from Health</b>.</p></div></details>" +

      '<details class="guide"><summary>📲 Install on iPhone & share</summary><div class="gb"><ol>' +
      "<li>Open this page in <b>Safari</b>.</li><li>Tap the <b>Share</b> button (square with an arrow).</li><li>Scroll down, tap <b>Add to Home Screen</b>, then <b>Add</b>.</li></ol>" +
      "<p>To share with friends, just send them the link. Each person's data stays on their own phone.</p>" +
      '<button class="btn block" id="pl-share">Share the app link</button></div></details>' +

      '<details class="guide"><summary>💾 Backup & restore</summary><div class="gb">' +
      "<p>Your data lives only on this phone. If you delete the app icon, it's gone, so save a backup sometimes.</p>" +
      '<div class="row"><button class="btn" id="pl-export">Save backup</button><button class="btn" id="pl-import">Restore</button></div>' +
      '<input type="file" id="pl-file" accept="application/json,.json" class="hidden"></div></details>' +

      '<details class="guide"><summary>⚙️ Advanced</summary><div class="gb">' +
      '<label class="f" for="pl-usda">USDA API key (optional)</label><input id="pl-usda" placeholder="Leave blank to use the shared demo key" value="' + esc(S.settings.usdaKey) + '">' +
      '<p class="note">Online search uses a shared demo key with a small hourly limit. A free personal key from api.data.gov removes the limit.</p>' +
      '<div class="kv"><span>Photo AI key</span><b>' + (S.settings.geminiKey ? "saved ✓" : "not set") + "</b></div>" +
      (S.settings.geminiKey ? '<button class="btn sm block" id="pl-gk" style="margin-top:8px">Remove photo AI key</button>' : "") +
      '<button class="btn danger block" id="pl-reset" style="margin-top:14px">Erase everything</button></div></details>' +
      '<p class="note">Cal Quest gives general estimates, not medical advice. Talk to a doctor before big diet changes.</p>';

    $("#pl-edit").addEventListener("click", () => renderOnboarding(true));
    if (typeof Cloud !== "undefined") Cloud.renderAccount($("#acct-slot"));
    $("#pl-title").addEventListener("change", (e) => { S.settings.title = e.target.value; save(); render(); toast("Title equipped", e.target.value); });
    $$("[data-theme-pick]", v).forEach((b) => b.addEventListener("click", () => { S.settings.theme = b.dataset.themePick; save(); render(); }));
    $$("[data-rem]", v).forEach((inp) => inp.addEventListener("change", () => {
      if (!/^\d\d:\d\d$/.test(inp.value)) return;
      S.settings.reminders[+inp.dataset.rem] = inp.value;
      S.settings.reminders.sort(); save(); toast("Check-in times saved"); Cloud.refreshPushTimes();
    }));
    $("#pl-share").addEventListener("click", async () => {
      const url = location.origin + location.pathname;
      try {
        if (navigator.share) await navigator.share({ title: "Cal Quest", text: "Track calories like a video game 🎮 Open in Safari → Share → Add to Home Screen", url });
        else { await navigator.clipboard.writeText(url); toast("Link copied", url); }
      } catch (e) { /* cancelled */ }
    });
    $("#pl-export").addEventListener("click", exportData);
    $("#pl-import").addEventListener("click", () => $("#pl-file").click());
    $("#pl-file").addEventListener("change", importData);
    $("#pl-usda").addEventListener("change", (e) => { S.settings.usdaKey = e.target.value.trim(); save(); toast("Saved"); });
    if ($("#pl-gk")) $("#pl-gk").addEventListener("click", () => { S.settings.geminiKey = ""; save(); render(); toast("Photo AI key removed"); });
    $("#pl-reset").addEventListener("click", () => {
      if (confirm("Erase all your data on this phone? This can't be undone.")) { localStorage.removeItem(STORE_KEY); S = fresh(); primeSnap(); tab = "quest"; if (typeof Cloud !== "undefined") Cloud.signOut(true); render(); }
    });
  }
  // ---------------------------------------------------------------- GYM
  const GYM_XP = 100;
  const MUSCLES = ["Chest", "Back", "Shoulders", "Biceps", "Triceps", "Legs", "Glutes", "Abs", "Cardio", "Full body"];
  const SPLITS = { Push: ["Chest", "Shoulders", "Triceps"], Pull: ["Back", "Biceps"], Legs: ["Legs", "Glutes"], Upper: ["Chest", "Back", "Shoulders", "Biceps", "Triceps"], "Full body": ["Full body"] };
  const COMMON_LIFTS = ["Bench press", "Incline dumbbell press", "Chest fly", "Push-ups", "Pull-ups", "Lat pulldown", "Barbell row", "Seated cable row", "Deadlift",
    "Overhead press", "Lateral raise", "Rear delt fly", "Bicep curl", "Hammer curl", "Tricep pushdown", "Skull crushers", "Dips", "Squat", "Leg press",
    "Romanian deadlift", "Leg curl", "Leg extension", "Calf raise", "Hip thrust", "Lunges", "Plank", "Crunches", "Treadmill", "Stair climber", "Bike"];
  let gymDay = null;
  function gymOf(k) { const d = peekDay(k); return d.gym || null; }
  function gymStreak() {
    // A workout day adds 1. A rest day keeps the streak alive (max 2 rest days in a row). A blank day breaks it.
    let k = dayKey(), n = 0, rests = 0;
    const g0 = gymOf(k); if (!g0 || !g0.status) k = addDays(k, -1); // today not logged yet: don't break
    for (let i = 0; i < 400; i++) {
      const g = gymOf(k);
      if (g && g.status === "went") { n++; rests = 0; }
      else if (g && g.status === "rest" && rests < 2) { rests++; }
      else break;
      k = addDays(k, -1);
    }
    return n;
  }
  function liftBest(name, beforeK) {
    let best = null;
    Object.keys(S.days).forEach((k) => {
      if (beforeK && k >= beforeK) return;
      const g = S.days[k].gym; if (!g || !g.ex) return;
      g.ex.forEach((e) => { if (e.name.toLowerCase() !== name.toLowerCase()) return; (e.sets || []).forEach((st) => { const w = +st.w || 0, r = +st.r || 0; if (!best || w > best.w || (w === best.w && r > best.r)) best = { w, r, k }; }); });
    });
    return best;
  }
  function lastTime(name, beforeK) {
    const keys = Object.keys(S.days).filter((k) => k < beforeK && S.days[k].gym && S.days[k].gym.ex).sort().reverse();
    for (const k of keys) { const e = S.days[k].gym.ex.find((x) => x.name.toLowerCase() === name.toLowerCase()); if (e) return { k, e }; }
    return null;
  }
  function gymStats() {
    const keys = Object.keys(S.days).filter((k) => S.days[k].gym && S.days[k].gym.status === "went");
    const byWeek = {}; keys.forEach((k) => (byWeek[weekStart(k)] = (byWeek[weekStart(k)] || 0) + 1));
    let prs = 0;
    keys.forEach((k) => (S.days[k].gym.ex || []).forEach((e) => { const prev = liftBest(e.name, k); if (prev && (e.sets || []).some((st) => (+st.w || 0) > prev.w)) prs++; }));
    let best = 0, run = 0, rests = 0; const all = Object.keys(S.days).sort();
    if (all.length) for (let k = all[0]; k <= dayKey(); k = addDays(k, 1)) {
      const g = gymOf(k);
      if (g && g.status === "went") { run++; rests = 0; best = Math.max(best, run); }
      else if (g && g.status === "rest" && rests < 2) rests++;
      else if (k !== dayKey()) { run = 0; rests = 0; }
    }
    return { total: keys.length, bestWeek: Math.max(0, ...Object.values(byWeek)), best, prs };
  }
  function setLabel(st, unit) { return (+st.w ? r1(st.w) + " " + unit + " × " : "") + (+st.r || 0) + (+st.w ? "" : " reps"); }
  function exSummary(e, unit) {
    const sets = (e.sets || []).filter((x) => +x.r || +x.w);
    if (!sets.length) return esc(e.name);
    const same = sets.every((x) => x.w === sets[0].w && x.r === sets[0].r);
    return "<b>" + esc(e.name) + "</b> " + (same ? sets.length + "×" + (+sets[0].r || 0) + (+sets[0].w ? " @ " + r1(sets[0].w) + " " + unit : "") : sets.map((x) => setLabel(x, unit)).join(", "));
  }
  function renderGym(v) {
    const today = dayKey(), k = gymDay || today, isToday = k === today, unit = S.profile.units === "imperial" ? "lb" : "kg";
    const d = getDay(k); d.gym = d.gym || { status: null, muscles: [], ex: [], notes: "" };
    const g = d.gym, gs = gymStreak();
    const week = []; const ws = weekStart(today);
    for (let i = 0; i < 7; i++) { const kk = addDays(ws, i), gg = gymOf(kk); week.push('<div class="' + (kk === today ? "now" : "") + '"><b>' + (gg && gg.status === "went" ? "💪" : gg && gg.status === "rest" ? "😴" : kk < today ? "✕" : "·") + "</b><span>" + "MTWTFSS"[i] + "</span></div>"); }
    const thisWeek = Array.from({ length: 7 }, (_, i) => gymOf(addDays(ws, i))).filter((x) => x && x.status === "went").length;
    const past = Object.keys(S.days).filter((kk) => kk !== k && S.days[kk].gym && S.days[kk].gym.status === "went").sort().reverse().slice(0, 10);
    const label = isToday ? "Today" : k === addDays(today, -1) ? "Yesterday" : keyToDate(k).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    const suggestions = Array.from(new Set(Object.values(S.days).flatMap((dd) => (dd.gym && dd.gym.ex ? dd.gym.ex.map((e) => e.name) : [])).concat(COMMON_LIFTS)));
    v.innerHTML =
      '<section class="panel">' + corners() + '<h1 class="panel-title">Gym</h1>' +
      '<div class="gym-streak"><div class="big-pct' + (gs ? " full" : "") + '">' + gs + '</div><div class="note" style="margin:0">day gym streak 🔥</div></div>' +
      '<div class="hits gweek">' + week.join("") + "</div>" +
      '<p class="explain" style="text-align:center">' + thisWeek + " workout" + (thisWeek === 1 ? "" : "s") + " this week · each workout = +" + GYM_XP + " XP. Rest days (😴) keep your streak, up to 2 in a row.</p></section>" +

      '<div class="daynav"><button class="btn sm ghost" id="g-prev">‹ Prev</button><div class="d">' + esc(label) + '</div><button class="btn sm ghost" id="g-next" ' + (isToday ? "disabled" : "") + ">Next ›</button></div>" +
      '<div class="row" style="margin-top:12px"><button class="btn ' + (g.status === "went" ? "good" : "") + '" id="g-went">💪 I went' + (g.status === "went" ? " ✓" : "") + '</button><button class="btn ' + (g.status === "rest" ? "primary" : "") + '" id="g-rest">😴 Rest day' + (g.status === "rest" ? " ✓" : "") + "</button></div>" +
      (g.status === "went" ?
        '<div class="h2">What did you hit?</div><div class="chips">' + Object.keys(SPLITS).map((sp) => '<button class="chip split" data-split="' + sp + '">' + sp + "</button>").join("") + "</div>" +
        '<div class="chips" style="margin-top:8px">' + MUSCLES.map((m) => '<button class="chip' + (g.muscles.includes(m) ? " on" : "") + '" data-mus="' + m + '">' + m + "</button>").join("") + "</div>" +
        '<div class="h2">Exercises</div>' +
        (g.ex.length ? g.ex.map((e, i) => {
          const lt = lastTime(e.name, k), pb = liftBest(e.name, k);
          return '<section class="chart-card ex" data-ex="' + i + '"><div class="chart-h"><b>' + esc(e.name) + '</b><button class="x" data-delex="' + i + '" aria-label="Remove exercise">×</button></div>' +
            (lt ? '<div class="note" style="margin:0 0 6px">Last time (' + esc(keyToDate(lt.k).toLocaleDateString(undefined, { month: "short", day: "numeric" })) + "): " + exSummary(lt.e, unit) + (pb ? " · Best: " + setLabel(pb, unit) : "") + "</div>" : "") +
            '<div class="sets">' + (e.sets || []).map((st, j) => '<div class="setrow"><span>' + (j + 1) + '</span><input type="number" inputmode="decimal" placeholder="' + unit + '" value="' + (st.w === "" || st.w == null ? "" : st.w) + '" data-w="' + j + '"><span>×</span><input type="number" inputmode="numeric" placeholder="reps" value="' + (st.r === "" || st.r == null ? "" : st.r) + '" data-r="' + j + '"><button class="x" data-delset="' + j + '" aria-label="Remove set">×</button></div>').join("") + "</div>" +
            '<button class="btn sm ghost block" data-addset="' + i + '" style="margin-top:6px">+ Add set</button></section>';
        }).join("") : '<div class="empty">No exercises yet. Add what you did below.</div>') +
        '<div class="row" style="margin-top:10px"><input id="g-exname" list="g-lifts" placeholder="Exercise, e.g. Bench press" autocapitalize="sentences"><button class="btn primary" id="g-addex" style="flex:0 0 90px">Add</button></div>' +
        '<datalist id="g-lifts">' + suggestions.map((x) => '<option value="' + esc(x) + '">').join("") + "</datalist>" +
        '<label class="f" for="g-notes">Notes</label><input id="g-notes" value="' + esc(g.notes || "") + '" placeholder="How did it feel?">'
        : "") +
      '<div class="h2">Past workouts</div>' +
      (past.length ? past.map((kk) => {
        const pg = S.days[kk].gym;
        const dl = kk === addDays(today, -1) ? "Yesterday" : keyToDate(kk).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
        return '<section class="chart-card"><div class="chart-h"><b>' + esc(dl) + "</b><span>" + esc((pg.muscles || []).join(" · ") || "Workout") + "</span></div>" +
          ((pg.ex || []).length ? '<div class="pastex">' + pg.ex.map((e) => "<div>" + exSummary(e, unit) + "</div>").join("") + "</div>" : "") +
          (pg.notes ? '<p class="note" style="margin:6px 0 0">' + esc(pg.notes) + "</p>" : "") +
          (g.status === "went" && (pg.ex || []).length ? '<button class="btn sm ghost" data-copy="' + kk + '" style="margin-top:8px">Copy to ' + esc(label.toLowerCase()) + "</button>" : "") + "</section>";
      }).join("") : '<div class="empty">Your workouts will show up here.</div>');

    const saveG = (rerender) => { save(); if (rerender) render(); };
    $("#g-prev").addEventListener("click", () => { gymDay = addDays(k, -1); render(); });
    $("#g-next").addEventListener("click", () => { if (!isToday) { gymDay = addDays(k, 1); if (gymDay === today) gymDay = null; render(); } });
    $("#g-went").addEventListener("click", () => { const was = g.status; g.status = g.status === "went" ? null : "went"; saveG(true); if (g.status === "went" && was !== "went") toast("💪 Workout logged", "+" + GYM_XP + " XP · streak " + gymStreak(), "good"); });
    $("#g-rest").addEventListener("click", () => {
      if (g.status !== "rest") { const r1d = gymOf(addDays(k, -1)), r2d = gymOf(addDays(k, -2)); if (r1d && r1d.status === "rest" && r2d && r2d.status === "rest") { toast("3 rest days in a row?", "That one won't save your streak, but it's logged"); } }
      g.status = g.status === "rest" ? null : "rest"; saveG(true);
    });
    if (g.status !== "went") return;
    $$("[data-split]", v).forEach((b) => b.addEventListener("click", () => { g.muscles = SPLITS[b.dataset.split].slice(); saveG(true); }));
    $$("[data-mus]", v).forEach((b) => b.addEventListener("click", () => { const m = b.dataset.mus; g.muscles = g.muscles.includes(m) ? g.muscles.filter((x) => x !== m) : g.muscles.concat(m); saveG(true); }));
    $("#g-addex").addEventListener("click", () => {
      const name = $("#g-exname").value.trim(); if (!name) return;
      const lt = lastTime(name, k);
      g.ex.push({ name: name.slice(0, 40), sets: lt ? lt.e.sets.map((x) => ({ w: x.w, r: x.r })) : [{ w: "", r: "" }] });
      saveG(true);
      if (lt) toast("Copied last time's sets", "Change the numbers to what you did today");
    });
    $("#g-notes").addEventListener("change", (e) => { g.notes = e.target.value.slice(0, 200); saveG(false); });
    $$(".ex", v).forEach((card) => {
      const e = g.ex[+card.dataset.ex];
      $$("[data-w]", card).forEach((inp) => inp.addEventListener("change", () => { e.sets[+inp.dataset.w].w = inp.value === "" ? "" : Math.max(0, +inp.value); checkPR(e, unit, k); saveG(false); }));
      $$("[data-r]", card).forEach((inp) => inp.addEventListener("change", () => { e.sets[+inp.dataset.r].r = inp.value === "" ? "" : Math.max(0, Math.round(+inp.value)); saveG(false); }));
      $$("[data-delset]", card).forEach((b) => b.addEventListener("click", () => { e.sets.splice(+b.dataset.delset, 1); saveG(true); }));
    });
    $$("[data-addset]", v).forEach((b) => b.addEventListener("click", () => { const e = g.ex[+b.dataset.addset], last = e.sets[e.sets.length - 1] || { w: "", r: "" }; e.sets.push({ w: last.w, r: last.r }); saveG(true); }));
    $$("[data-delex]", v).forEach((b) => b.addEventListener("click", () => { if (confirm("Remove " + g.ex[+b.dataset.delex].name + "?")) { g.ex.splice(+b.dataset.delex, 1); saveG(true); } }));
    $$("[data-copy]", v).forEach((b) => b.addEventListener("click", () => {
      const src = S.days[b.dataset.copy].gym;
      src.ex.forEach((e) => { if (!g.ex.some((x) => x.name.toLowerCase() === e.name.toLowerCase())) g.ex.push({ name: e.name, sets: e.sets.map((x) => ({ w: x.w, r: x.r })) }); });
      if (!g.muscles.length) g.muscles = (src.muscles || []).slice();
      saveG(true); toast("Workout copied", "Update the weights and reps");
    }));
  }
  function checkPR(e, unit, k) {
    const prev = liftBest(e.name, k); if (!prev) return;
    const top = Math.max(0, ...e.sets.map((x) => +x.w || 0));
    const key = k + ":pr:" + e.name.toLowerCase();
    if (top > prev.w && !S.celebrated[key]) { S.celebrated[key] = 1; toast("🏆 New PR: " + e.name, r1(top) + " " + unit + " (old best " + r1(prev.w) + ")", "good"); }
  }

  // ---------------------------------------------------------------- STATS
  let statRange = 7;
  function renderStats(v) {
    const today = dayKey(), p = S.profile, imp = p.units === "imperial";
    const days = []; for (let i = statRange - 1; i >= 0; i--) days.push(addDays(today, -i));
    const lab = (k) => statRange === 7 ? "MTWTFSS"[(keyToDate(k).getDay() + 6) % 7] : String(keyToDate(k).getDate());
    const tot = days.map((k) => totals(peekDay(k)));
    const tg = days.map((k) => peekDay(k).t || S.targets);
    const avg = (arr) => { const xs = arr.filter((x) => x > 0); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; };
    const kc = tot.map((t) => t.kcal), pr = tot.map((t) => t.p), wa = days.map((k) => peekDay(k).water || 0), stp = days.map((k) => peekDay(k).steps || 0);
    const wKeys = Object.keys(S.weights).sort();
    const lastW = wKeys.length ? S.weights[wKeys[wKeys.length - 1]] : p.weightKg;
    const show = (kg) => imp ? r1(kg * 2.20462) : r1(kg), unitW = imp ? "lb" : "kg";
    const firstW = wKeys.length ? S.weights[wKeys[0]] : null;
    const change = firstW != null && wKeys.length > 1 ? lastW - firstW : null;
    v.innerHTML =
      '<section class="panel">' + corners() + '<h1 class="panel-title">Progress</h1>' +
      '<div class="tabs" style="margin-top:12px"><button data-range="7" class="' + (statRange === 7 ? "active" : "") + '">7 days</button><button data-range="30" class="' + (statRange === 30 ? "active" : "") + '">30 days</button></div>' +
      '<div class="statgrid"><div class="stat"><span>Avg calories</span><b>' + fmt(avg(kc)) + '</b></div><div class="stat"><span>Avg protein</span><b>' + r0(avg(pr)) + ' g</b></div>' +
      '<div class="stat"><span>Quests cleared</span><b>' + days.filter((k) => S.days[k] && questState(k).cleared).length + "/" + statRange + '</b></div><div class="stat"><span>Weight</span><b>' + show(lastW) + " " + unitW + (change != null ? ' <small style="font-size:13px;color:' + (change <= 0 ? "var(--good)" : "var(--warn)") + '">' + (change > 0 ? "+" : "") + show(change) + "</small>" : "") + "</b></div></div></section>" +
      '<div class="h2">Log your weight</div><div class="row"><input id="w-in" type="number" inputmode="decimal" step="0.1" placeholder="' + show(lastW) + " " + unitW + '"><button class="btn primary" id="w-save" style="flex:0 0 110px">Save</button></div>' +
      '<p class="note">Weigh in the morning, same time each day. Your calorie targets update with your new weight.</p>' +
      chartCard("Weight (" + unitW + ")", lineChart(wKeys.filter((k) => k >= addDays(today, -Math.max(statRange, 30) + 1)).map((k) => ({ k, v: +show(S.weights[k]) })), addDays(today, -Math.max(statRange, 30) + 1), today), "Last 30 days") +
      chartCard("Calories", barChart(days.map(lab), kc, tg.map((t) => t.kcal), days), "Line = your target") +
      chartCard("Protein (g)", barChart(days.map(lab), pr.map(r0), tg.map((t) => t.protein), days), "Line = your target") +
      chartCard("Water (bottles)", barChart(days.map(lab), wa, tg.map((t) => t.water), days), "Line = your target") +
      chartCard("Steps", barChart(days.map(lab), stp, tg.map((t) => t.steps), days), "Line = your target") +
      '<div class="h2">This week\'s boss</div>' + bossHTML(weekStart(today), false);
    $$("[data-range]", v).forEach((b) => b.addEventListener("click", () => { statRange = +b.dataset.range; render(); }));
    $("#w-save").addEventListener("click", () => {
      let w = parseFloat($("#w-in").value); if (!(w > 0)) { toast("Enter your weight"); return; }
      const kg = imp ? w / 2.20462 : w;
      if (kg < 30 || kg > 300) { toast("That weight looks off"); return; }
      S.weights[today] = kg;
      S.profile.weightKg = kg; S.targets = computeTargets(S.profile); getDay().t = Object.assign({}, S.targets);
      save(); render(); toast("⚖️ Weight saved", "Targets updated: " + fmt(S.targets.kcal) + " kcal · " + S.targets.protein + "g protein");
    });
    $$(".chart", v).forEach(bindChart);
  }
  function chartCard(title, svg, note) { return '<section class="chart-card"><div class="chart-h"><b>' + esc(title) + "</b><span>" + esc(note) + "</span></div>" + svg + '<div class="chart-tip">Tap a bar or point to see the value</div></section>'; }
  function niceMax(v) { if (v <= 0) return 1; const e = Math.pow(10, Math.floor(Math.log10(v))); const f = v / e; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * e; }
  function barChart(labels, vals, targets, keys) {
    const W = 340, H = 150, L = 34, R = 6, T = 10, B = 20, n = vals.length;
    const max = niceMax(Math.max(1, ...vals, ...targets) * 1.05), pw = W - L - R, ph = H - T - B, bw = Math.max(3, Math.min(22, (pw / n) * 0.6));
    const y = (v) => T + ph - (v / max) * ph, x = (i) => L + (pw / n) * (i + 0.5);
    let g = "";
    [0, 0.5, 1].forEach((f) => { const yy = y(max * f); g += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + yy + '" y2="' + yy + '" class="grid"/><text x="' + (L - 4) + '" y="' + (yy + 3) + '" class="ax" text-anchor="end">' + shortNum(max * f) + "</text>"; });
    vals.forEach((v, i) => {
      const h = Math.max(0, (v / max) * ph), x0 = x(i) - bw / 2, top = T + ph - h, r = Math.min(4, bw / 2, h);
      const hit = targets[i] && v >= targets[i] * 0.9;
      if (h > 0) g += '<path class="bar' + (hit ? " hit" : "") + '" d="M' + x0 + "," + (T + ph) + "V" + (top + r) + "Q" + x0 + "," + top + " " + (x0 + r) + "," + top + "H" + (x0 + bw - r) + "Q" + (x0 + bw) + "," + top + " " + (x0 + bw) + "," + (top + r) + "V" + (T + ph) + 'Z"/>';
      g += '<rect class="hitbox" x="' + (L + (pw / n) * i) + '" y="' + T + '" width="' + pw / n + '" height="' + ph + '" data-tip="' + esc(keyToDate(keys[i]).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) + ": " + fmt(v) + (targets[i] ? " / " + fmt(targets[i]) : "")) + '"/>';
      if (n <= 7 || i % 5 === 4 || i === n - 1) g += '<text x="' + x(i) + '" y="' + (H - 6) + '" class="ax" text-anchor="middle">' + esc(labels[i]) + "</text>";
    });
    // target line (step through days in case the target changed)
    let d = ""; targets.forEach((t, i) => { const yy = y(t), x1 = L + (pw / n) * i, x2 = x1 + pw / n; d += (i ? "L" : "M") + x1 + "," + yy + "L" + x2 + "," + yy; });
    g += '<path d="' + d + '" class="tline"/>';
    return '<svg class="chart" viewBox="0 0 ' + W + " " + H + '" role="img">' + g + "</svg>";
  }
  function lineChart(pts, fromK, toK) {
    const W = 340, H = 150, L = 34, R = 10, T = 12, B = 20;
    if (!pts.length) return '<div class="empty" style="padding:24px 0;text-align:center">No weigh-ins yet. Log your weight above to start your chart.</div>';
    const vs = pts.map((p) => p.v), lo = Math.floor(Math.min(...vs) - 2), hi = Math.ceil(Math.max(...vs) + 2);
    const span = Math.max(1, (keyToDate(toK) - keyToDate(fromK)) / 864e5);
    const x = (k) => L + ((keyToDate(k) - keyToDate(fromK)) / 864e5 / span) * (W - L - R), y = (v) => T + (H - T - B) - ((v - lo) / (hi - lo)) * (H - T - B);
    let g = "";
    [lo, (lo + hi) / 2, hi].forEach((v) => { g += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(v) + '" y2="' + y(v) + '" class="grid"/><text x="' + (L - 4) + '" y="' + (y(v) + 3) + '" class="ax" text-anchor="end">' + r1(v) + "</text>"; });
    g += '<text x="' + L + '" y="' + (H - 6) + '" class="ax">' + keyToDate(fromK).toLocaleDateString(undefined, { month: "short", day: "numeric" }) + '</text><text x="' + (W - R) + '" y="' + (H - 6) + '" class="ax" text-anchor="end">Today</text>';
    if (pts.length > 1) g += '<path class="wline" d="' + pts.map((p, i) => (i ? "L" : "M") + x(p.k) + "," + y(p.v)).join("") + '"/>';
    pts.forEach((p) => { g += '<circle class="wdot" cx="' + x(p.k) + '" cy="' + y(p.v) + '" r="4"/><circle class="hitbox" cx="' + x(p.k) + '" cy="' + y(p.v) + '" r="14" data-tip="' + esc(keyToDate(p.k).toLocaleDateString(undefined, { month: "short", day: "numeric" }) + ": " + p.v) + '"/>'; });
    return '<svg class="chart" viewBox="0 0 ' + W + " " + H + '" role="img">' + g + "</svg>";
  }
  function shortNum(v) { return v >= 1000 ? r1(v / 1000) + "k" : String(r0(v)); }
  function bindChart(svg) {
    const tip = svg.parentNode.querySelector(".chart-tip");
    svg.querySelectorAll(".hitbox").forEach((h) => h.addEventListener("click", () => {
      svg.querySelectorAll(".sel").forEach((x) => x.classList.remove("sel")); h.classList.add("sel"); tip.textContent = h.dataset.tip;
    }));
  }

  function kv(k, v) { return '<div class="kv"><span>' + esc(k) + "</span><b>" + esc(v) + "</b></div>"; }
  function exportData() {
    const blob = new Blob([JSON.stringify(S)], { type: "application/json" });
    const file = new File([blob], "cal-quest-backup-" + dayKey() + ".json", { type: "application/json" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { navigator.share({ files: [file], title: "Cal Quest backup" }).catch(() => {}); return; }
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = file.name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  function importData(e) {
    const f = e.target.files && e.target.files[0]; if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const data = JSON.parse(rd.result);
        if (!data || typeof data !== "object" || !data.days) throw new Error("bad");
        if (!confirm("Replace what's on this phone with this backup?")) return;
        localStorage.setItem(STORE_KEY, JSON.stringify(data)); S = load(); render(); toast("Backup restored");
      } catch (err) { toast("That file isn't a Cal Quest backup"); }
    };
    rd.readAsText(f);
  }

  // ---------------------------------------------------------------- ONBOARDING
  function renderOnboarding(editing) {
    const prev = S.profile || {};
    const p = Object.assign({ name: "", sex: "", age: "", units: "imperial", heightCm: null, weightKg: null, activity: "", goal: "", bottleOz: 16.9, stepGoal: 8000 }, prev);
    let step = editing ? 1 : 0;
    const app = $("#app");
    const STEPS = 7;

    function choice(group, val, label, desc, sel) {
      return '<button class="choice' + (sel ? " sel" : "") + '" data-g="' + group + '" data-v="' + val + '"><b>' + label + "</b>" + (desc ? "<span>" + desc + "</span>" : "") + "</button>";
    }
    function screen(inner, opts = {}) {
      app.innerHTML = '<div class="ob"><section class="panel">' + corners() +
        (step > 0 && step <= STEPS ? '<div class="step">Step ' + step + " of " + STEPS + "</div>" : "") + inner +
        '<div class="err" id="ob-err"></div><div class="ob-nav">' +
        (step > (editing ? 1 : 0) ? '<button class="btn ghost" id="ob-back">Back</button>' : "") +
        '<button class="btn primary" id="ob-next">' + (opts.next || "Next") + "</button></div></section></div>";
      const back = $("#ob-back"); if (back) back.addEventListener("click", () => { step--; draw(); });
      $$(".choice[data-g]").forEach((b) => b.addEventListener("click", () => {
        $$('.choice[data-g="' + b.dataset.g + '"]').forEach((x) => x.classList.remove("sel")); b.classList.add("sel");
        p[b.dataset.g] = b.dataset.v;
        if (b.dataset.g === "units") draw();
      }));
      $("#ob-next").addEventListener("click", () => {
        const err = opts.validate ? opts.validate() : "";
        if (err) { $("#ob-err").textContent = err; return; }
        step++; draw(); window.scrollTo(0, 0);
      });
    }
    const val = (id) => ($("#" + id) ? $("#" + id).value.trim() : "");

    function draw() {
      if (step === 0) {
        screen('<h1 class="panel-title">Cal Quest</h1><p class="panel-sub">A new quest has appeared</p>' +
          '<p class="lead">Answer 7 quick questions. I\'ll work out exactly how much to eat and drink to reach your goal, then turn every day into a quest that earns XP.</p>',
          { next: "Accept quest" });
      } else if (step === 1) {
        screen('<h2 class="panel-title" style="font-size:24px">Who are you?</h2>' +
          '<label class="f" for="ob-name">Player name</label><input id="ob-name" maxlength="20" value="' + esc(p.name) + '" placeholder="Your name">' +
          '<label class="f">Body type (for the calorie math)</label><div class="seg">' + choice("sex", "male", "Male", "", p.sex === "male") + choice("sex", "female", "Female", "", p.sex === "female") + "</div>" +
          '<label class="f" for="ob-age">Age</label><input id="ob-age" type="number" inputmode="numeric" min="13" max="100" value="' + esc(p.age) + '" placeholder="e.g. 21">',
          { validate: () => {
            p.name = val("ob-name"); const a = parseInt(val("ob-age"), 10);
            if (!p.sex) return "Pick one so the math is right";
            if (!(a >= 13 && a <= 100)) return "Enter an age between 13 and 100";
            p.age = a; return "";
          } });
      } else if (step === 2) {
        const imp = p.units === "imperial";
        const ft = p.heightCm ? Math.floor(p.heightCm / 2.54 / 12) : "", inch = p.heightCm ? r0((p.heightCm / 2.54) % 12) : "";
        const wv = p.weightKg ? (imp ? r0(p.weightKg * 2.20462) : r1(p.weightKg)) : "";
        screen('<h2 class="panel-title" style="font-size:24px">Your body</h2>' +
          '<div class="seg" style="margin-top:12px">' + choice("units", "imperial", "lb / ft", "", imp) + choice("units", "metric", "kg / cm", "", !imp) + "</div>" +
          (imp
            ? '<label class="f">Height</label><div class="row"><input id="ob-ft" type="number" inputmode="numeric" placeholder="feet" value="' + ft + '"><input id="ob-in" type="number" inputmode="numeric" placeholder="inches" value="' + inch + '"></div>' +
              '<label class="f" for="ob-w">Weight (lb)</label><input id="ob-w" type="number" inputmode="decimal" placeholder="e.g. 175" value="' + wv + '">'
            : '<label class="f" for="ob-cm">Height (cm)</label><input id="ob-cm" type="number" inputmode="numeric" placeholder="e.g. 178" value="' + (p.heightCm ? r0(p.heightCm) : "") + '">' +
              '<label class="f" for="ob-w">Weight (kg)</label><input id="ob-w" type="number" inputmode="decimal" placeholder="e.g. 80" value="' + wv + '">'),
          { validate: () => {
            let h, w = parseFloat(val("ob-w"));
            if (p.units === "imperial") { h = ((parseFloat(val("ob-ft")) || 0) * 12 + (parseFloat(val("ob-in")) || 0)) * 2.54; w = w / 2.20462; }
            else h = parseFloat(val("ob-cm"));
            if (!(h >= 120 && h <= 230)) return "That height looks off. Check it again";
            if (!(w >= 30 && w <= 300)) return "That weight looks off. Check it again";
            p.heightCm = h; p.weightKg = w; return "";
          } });
      } else if (step === 3) {
        screen('<h2 class="panel-title" style="font-size:24px">How active are you?</h2><p class="lead">Be honest. It changes how much you should eat.</p><div class="choices">' +
          Object.entries(ACTIVITY).map(([k, a]) => choice("activity", k, a.label, a.desc, p.activity === k)).join("") + "</div>",
          { validate: () => (p.activity ? "" : "Pick one") });
      } else if (step === 4) {
        screen('<h2 class="panel-title" style="font-size:24px">What\'s your goal?</h2><div class="choices" style="margin-top:12px">' +
          Object.entries(GOALS).map(([k, g]) => choice("goal", k, g.label, g.desc, p.goal === k)).join("") + "</div>",
          { validate: () => (p.goal ? "" : "Pick one") });
      } else if (step === 5) {
        const sizes = [[16.9, "16.9 oz", "Standard water bottle (500 ml)"], [24, "24 oz", "Big bottle (710 ml)"], [32, "32 oz", "Large jug (1 L)"], [40, "40 oz", "Huge tumbler (1.2 L)"]];
        screen('<h2 class="panel-title" style="font-size:24px">Your water bottle</h2><p class="lead">You\'ll count water in bottles. How big is yours?</p><div class="choices">' +
          sizes.map(([oz, l, d]) => choice("bottleOz", oz, l, d, Number(p.bottleOz) === oz)).join("") + "</div>",
          { validate: () => { p.bottleOz = Number(p.bottleOz); return p.bottleOz ? "" : "Pick one"; } });
      } else if (step === 6) {
        const opts = [[5000, "5,000", "Getting started"], [8000, "8,000", "Solid daily goal"], [10000, "10,000", "Classic target"], [12000, "12,000+", "Grinder"]];
        screen('<h2 class="panel-title" style="font-size:24px">Daily steps goal</h2><div class="choices" style="margin-top:12px">' +
          opts.map(([n, l, d]) => choice("stepGoal", n, l, d, Number(p.stepGoal) === n)).join("") + "</div>",
          { validate: () => { p.stepGoal = Number(p.stepGoal); return p.stepGoal ? "" : "Pick one"; } });
      } else if (step === 7) {
        const t = computeTargets(p);
        const g = GOALS[p.goal];
        const verb = g.delta < 0 ? "lose weight" : g.delta > 0 ? "gain" : "stay the same";
        screen('<h2 class="panel-title" style="font-size:26px">Your Stats</h2><p class="panel-sub">Daily targets unlocked</p>' +
          '<div class="statgrid"><div class="stat wide"><span>Eat this many calories a day</span><b>' + fmt(t.kcal) + "</b></div>" +
          '<div class="stat"><span>Protein</span><b>' + t.protein + ' g</b></div><div class="stat"><span>Carbs</span><b>' + t.carbs + " g</b></div>" +
          '<div class="stat"><span>Fat</span><b>' + t.fat + ' g</b></div><div class="stat"><span>Water</span><b>' + t.water + ' <small style="font-size:13px">bottles</small></b></div></div>' +
          '<p class="explain">Your body burns about <b>' + fmt(t.tdee) + " calories</b> a day (" + fmt(t.bmr) + " just to stay alive, plus activity). " +
          (g.delta ? "Eating <b>" + fmt(t.kcal) + "</b> a day " + (g.delta < 0 ? "puts you " + fmt(t.tdee - t.kcal) + " under" : "puts you " + fmt(t.kcal - t.tdee) + " over") + ", so you'll " + verb + " at about the right pace." : "Eating <b>" + fmt(t.kcal) + "</b> a day keeps you level.") +
          " Water: <b>" + t.water + " bottles</b> of " + p.bottleOz + " oz. Steps: <b>" + fmt(t.steps) + "</b>.</p>",
          { next: editing ? "Save" : "Begin quest" });
      } else {
        S.profile = p;
        S.targets = computeTargets(p);
        const td = getDay(); td.t = Object.assign({}, S.targets);
        save();
        tab = "quest";
        render();
        if (!editing) setTimeout(() => toast("Quest accepted", "Log food and water to earn XP"), 300);
        else toast("Stats updated", "New targets apply from today");
      }
    }
    draw();
  }

  // ---------------------------------------------------------------- CLOUD (Supabase)
  const CFG = window.CALQUEST_CONFIG || {};
  const Cloud = (() => {
    const enabled = !!(CFG.supabaseUrl && CFG.supabaseKey && window.supabase);
    const sb = enabled ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, { auth: { persistSession: true, autoRefreshToken: true, storageKey: "calquest.auth", detectSessionInUrl: false } }) : null;
    let user = null, me = null, pushTimer = null, syncing = false, lastSync = null, lbCache = null;

    async function init() {
      if (!enabled) return;
      const { data } = await sb.auth.getSession();
      user = data.session ? data.session.user : null;
      sb.auth.onAuthStateChange((_e, session) => { user = session ? session.user : null; });
      if (user) { await loadMe(); await pull(); }
    }
    async function loadMe() {
      const { data } = await sb.from("players").select("*").eq("id", user.id).maybeSingle();
      me = data || null;
    }

    // ---- merge another device's copy into this one
    function score(d) { return (d.foods || []).length * 10 + (d.water || 0) + (d.steps || 0) / 1000 + Object.keys(d.checkins || {}).length; }
    function merge(remote) {
      if (!remote || typeof remote !== "object") return false;
      if (!S.profile && remote.profile) { S = Object.assign(fresh(), remote, { settings: Object.assign(fresh().settings, remote.settings || {}, { geminiKey: S.settings.geminiKey, usdaKey: S.settings.usdaKey }) }); primeSnap(); return true; }
      let changed = false;
      Object.keys(remote.days || {}).forEach((k) => {
        const r = remote.days[k], l = S.days[k];
        if (!l) { S.days[k] = r; changed = true; return; }
        const ru = r.u || 0, lu = l.u || 0;
        if (ru > lu || (!ru && !lu && score(r) > score(l))) { S.days[k] = r; changed = true; }
      });
      if (remote.profile && (remote.profileAt || 0) > (S.profileAt || 0)) { S.profile = remote.profile; S.targets = remote.targets; S.profileAt = remote.profileAt; changed = true; }
      ["weights", "badges", "celebrated"].forEach((key) => Object.keys(remote[key] || {}).forEach((k) => { if (S[key][k] === undefined) { S[key][k] = remote[key][k]; changed = true; } }));
      ["meals", "favs"].forEach((key) => (remote[key] || []).forEach((m) => { if (!S[key].some((x) => x.id === m.id)) { S[key].push(m); changed = true; } }));
      if ((remote.lastLevel || 1) > (S.lastLevel || 1)) S.lastLevel = remote.lastLevel;
      if (remote.penaltySince && (!S.penaltySince || remote.penaltySince < S.penaltySince)) S.penaltySince = remote.penaltySince;
      return changed;
    }
    function cleanCopy() {
      const c = JSON.parse(JSON.stringify(S));
      c.settings = Object.assign({}, c.settings, { geminiKey: "", usdaKey: "" }); // keys stay on this phone
      return c;
    }
    async function pull() {
      if (!user) return;
      const { data, error } = await sb.from("saves").select("data, updated_at").eq("id", user.id).maybeSingle();
      if (error) return;
      if (data && merge(data.data)) { save({ noSync: true }); render(); }
      await push();
    }
    function queuePush() { if (!user) return; clearTimeout(pushTimer); pushTimer = setTimeout(push, 3000); }
    async function push() {
      if (!user || syncing) return;
      syncing = true;
      try {
        const now = new Date().toISOString();
        const r1x = await sb.from("saves").upsert({ id: user.id, data: cleanCopy(), updated_at: now });
        if (r1x.error) throw r1x.error;
        if (me) {
          const k = dayKey(), qs = questState(k), xp = totalXP(), L = levelFromXP(xp);
          await sb.from("players").update({ level: L, xp, streak: streak(), title: currentTitle(L), theme: S.settings.theme || "azure", stats_day: k,
            today_pct: Math.round(qs.overall * 100), cleared_today: qs.cleared, boss_dmg: bossState(weekStart(k)).dmg, gym_streak: gymStreak(), updated_at: now }).eq("id", user.id);
        }
        lastSync = new Date();
        const el = $("#acct-sync"); if (el) el.textContent = "Last synced " + lastSync.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      } catch (e) { /* offline: try again on next save */ }
      syncing = false;
    }

    // ---- account UI
    function renderAccount(slot) {
      if (!slot) return;
      if (!enabled) { slot.innerHTML = ""; return; }
      if (!user) {
        slot.innerHTML = '<div class="h2">☁️ Account</div><section class="chart-card">' +
          '<p class="explain" style="margin-top:0">Make a free account to back up your progress, use Cal Quest on other devices, and add friends to your leaderboard.</p>' +
          '<div class="tabs"><button data-am="up" class="active">Sign up</button><button data-am="in">Log in</button></div>' +
          '<div id="am-user"><label class="f" for="ac-user">Username (friends find you by this)</label><input id="ac-user" maxlength="20" autocapitalize="off" autocomplete="username" placeholder="e.g. youssef_lifts"></div>' +
          '<label class="f" for="ac-email">Email</label><input id="ac-email" type="email" autocapitalize="off" autocomplete="email" placeholder="you@example.com">' +
          '<label class="f" for="ac-pass">Password (6+ characters)</label><input id="ac-pass" type="password" autocomplete="current-password">' +
          '<div class="err" id="ac-err"></div><button class="btn primary block" id="ac-go">Create account</button></section>';
        let mode = "up";
        $$("[data-am]", slot).forEach((b) => b.addEventListener("click", () => {
          mode = b.dataset.am; $$("[data-am]", slot).forEach((x) => x.classList.toggle("active", x === b));
          $("#am-user", slot).classList.toggle("hidden", mode === "in"); $("#ac-go", slot).textContent = mode === "up" ? "Create account" : "Log in";
        }));
        $("#ac-go", slot).addEventListener("click", async () => {
          const err = $("#ac-err", slot), btn = $("#ac-go", slot);
          const email = $("#ac-email", slot).value.trim(), pass = $("#ac-pass", slot).value, uname = $("#ac-user", slot).value.trim();
          err.textContent = "";
          if (!/^\S+@\S+\.\S+$/.test(email)) { err.textContent = "Enter a real email"; return; }
          if (pass.length < 6) { err.textContent = "Password needs 6+ characters"; return; }
          if (mode === "up" && !/^[A-Za-z0-9_]{3,20}$/.test(uname)) { err.textContent = "Username: 3–20 letters, numbers or _"; return; }
          btn.disabled = true; btn.textContent = "One sec…";
          try {
            if (mode === "up") {
              const taken = await sb.from("players").select("id").ilike("username", uname).maybeSingle();
              const { data, error } = await sb.auth.signUp({ email, password: pass });
              if (error) throw error;
              if (!data.session) { err.textContent = "Check your email to confirm, then come back and Log in."; btn.disabled = false; btn.textContent = "Create account"; return; }
              user = data.user;
              if (taken.data) { /* taken by someone else; signed-in users can see it */ }
              const ins = await sb.from("players").insert({ id: user.id, username: uname });
              if (ins.error) { await sb.from("players").insert({ id: user.id, username: uname + "_" + Math.floor(Math.random() * 90 + 10) }); toast("That username was taken", "We added a number. You can share it as-is."); }
            } else {
              const { data, error } = await sb.auth.signInWithPassword({ email, password: pass });
              if (error) throw error;
              user = data.user;
            }
            await loadMe(); await pull(); render(); toast("☁️ Signed in", "Your progress now backs up automatically");
          } catch (e) {
            err.textContent = /Invalid login/i.test(e.message) ? "Wrong email or password" : /already registered/i.test(e.message) ? "That email already has an account. Tap Log in." : (e.message || "Something went wrong");
            btn.disabled = false; btn.textContent = mode === "up" ? "Create account" : "Log in";
          }
        });
        return;
      }
      slot.innerHTML = '<div class="h2">☁️ Account</div><section class="chart-card">' +
        kv("Username", me ? me.username : "…") + kv("Email", user.email || "") +
        '<p class="note" id="acct-sync">' + (lastSync ? "Last synced " + lastSync.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "Backs up automatically") + "</p>" +
        '<div class="row"><button class="btn" id="ac-sync">Sync now</button><button class="btn ghost" id="ac-out">Log out</button></div></section>' + pushHTML();
      $("#ac-sync", slot).addEventListener("click", async () => { await pull(); toast("☁️ Synced"); });
      $("#ac-out", slot).addEventListener("click", () => { if (confirm("Log out? Your data stays on this phone.")) signOut(); });
      bindPush(slot);
      if (!me) loadMe().then(() => render());
    }
    async function signOut(silent) { if (!enabled) return; try { await sb.auth.signOut(); } catch (e) { /* ignore */ } user = null; me = null; lbCache = null; if (!silent) { render(); toast("Logged out"); } }

    // ---- friends leaderboard
    async function fetchBoard() {
      const f = await sb.from("follows").select("followee").eq("follower", user.id);
      const ids = [user.id].concat((f.data || []).map((x) => x.followee));
      const { data } = await sb.from("players").select("id, username, level, xp, streak, gym_streak, title, stats_day, today_pct, cleared_today").in("id", ids);
      return (data || []).sort((a, b) => b.xp - a.xp);
    }
    function boardHTML(rows) {
      const k = dayKey();
      return rows.map((r, i) => '<div class="lb-row' + (r.id === user.id ? " me" : "") + '"><b class="rk">' + (i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : i + 1) + '</b><div class="who">' + esc(r.username) + "<small>Lv " + r.level + " · " + esc(r.title) + '</small></div><div class="lb-st">' + (r.streak ? "🔥" + r.streak : "") + (r.gym_streak ? " 🏋️" + r.gym_streak : "") +
        '<small>' + (r.stats_day === k ? (r.cleared_today ? "✓ cleared" : r.today_pct + "% today") : "–") + "</small></div>" +
        (r.id !== user.id ? '<button class="x" data-unf="' + esc(r.id) + '" aria-label="Remove friend">×</button>' : "<span></span>") + "</div>").join("");
    }
    function renderLeaderboard(slot) {
      if (!slot || !enabled) return;
      if (!user) { slot.innerHTML = '<section class="chart-card"><div class="chart-h"><b>🏆 Friends leaderboard</b></div><p class="explain" style="margin:0">Make a free account in the <b>Player</b> tab to compete with friends.</p></section>'; return; }
      const paint = (rows) => {
        slot.innerHTML = '<section class="chart-card"><div class="chart-h"><b>🏆 Friends leaderboard</b><span>by total XP</span></div>' + boardHTML(rows) +
          '<div class="row" style="margin-top:10px"><input id="fr-in" placeholder="Friend\'s username" autocapitalize="off"><button class="btn" id="fr-add" style="flex:0 0 90px">Add</button></div>' +
          '<p class="note">Your username: <b>' + esc(me ? me.username : "") + '</b>. Friends see your level, streak and today\'s %, never your food.</p></section>';
        $("#fr-add", slot).addEventListener("click", async () => {
          const name = $("#fr-in", slot).value.trim(); if (!name) return;
          const { data } = await sb.from("players").select("id, username").ilike("username", name).maybeSingle();
          if (!data) { toast("No player called " + name, "Check the spelling with your friend"); return; }
          if (data.id === user.id) { toast("That's you 😄"); return; }
          const r = await sb.from("follows").insert({ follower: user.id, followee: data.id });
          if (r.error && !/duplicate/i.test(r.error.message)) { toast("Couldn't add friend", r.error.message); return; }
          toast("🤝 Added " + data.username); lbCache = null; renderLeaderboard(slot);
        });
        $$("[data-unf]", slot).forEach((b) => b.addEventListener("click", async () => {
          if (!confirm("Remove this friend from your leaderboard?")) return;
          await sb.from("follows").delete().eq("follower", user.id).eq("followee", b.dataset.unf); lbCache = null; renderLeaderboard(slot);
        }));
      };
      if (lbCache && Date.now() - lbCache.t < 60000) paint(lbCache.rows);
      else { slot.innerHTML = '<section class="chart-card"><div class="chart-h"><b>🏆 Friends leaderboard</b></div><div class="loading">Loading</div></section>'; fetchBoard().then((rows) => { lbCache = { t: Date.now(), rows }; if (document.body.contains(slot)) paint(rows); }).catch(() => (slot.innerHTML = "")); }
    }

    // ---- push reminders
    const standalone = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
    const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window && !!CFG.vapidPublicKey;
    function pushHTML() {
      let body;
      if (!standalone()) body = '<p class="explain" style="margin:0">Open Cal Quest from your <b>home screen icon</b> (not Safari) to turn on push reminders.</p>';
      else if (!pushSupported()) body = '<p class="explain" style="margin:0">This phone doesn\'t support web push. Update to iOS 16.4 or newer, or use the Reminders app guide below.</p>';
      else if (Notification.permission === "granted" && S.settings.pushOn) body = '<p class="explain" style="margin:0">✅ On. You\'ll get a ping at ' + S.settings.reminders.map(to12).join(", ") + '.</p><div class="row" style="margin-top:10px"><button class="btn sm" id="pu-test">Update times</button><button class="btn sm ghost" id="pu-off">Turn off</button></div>';
      else body = '<p class="explain" style="margin:0">Get a notification at ' + S.settings.reminders.map(to12).join(", ") + ' to log your water.</p><button class="btn primary block" style="margin-top:10px" id="pu-on">🔔 Turn on water reminders</button>';
      return '<div class="h2">🔔 Push reminders</div><section class="chart-card">' + body + "</section>";
    }
    async function subscribe() {
      const reg = await navigator.serviceWorker.ready;
      const key = Uint8Array.from(atob(CFG.vapidPublicKey.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((CFG.vapidPublicKey.length + 3) % 4)), (c) => c.charCodeAt(0));
      const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
      const j = sub.toJSON();
      const r = await sb.from("push_subs").upsert({ endpoint: j.endpoint, user_id: user.id, sub: j, reminders: S.settings.reminders, tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" });
      if (r.error) throw r.error;
    }
    function bindPush(slot) {
      const on = $("#pu-on", slot), upd = $("#pu-test", slot), off = $("#pu-off", slot);
      if (on) on.addEventListener("click", async () => {
        try {
          const perm = await Notification.requestPermission();
          if (perm !== "granted") { toast("Notifications are blocked", "Settings → Notifications → Cal Quest → Allow"); return; }
          await subscribe(); S.settings.pushOn = true; save(); render(); toast("🔔 Water reminders on");
        } catch (e) { toast("Couldn't turn on reminders", e.message || ""); }
      });
      if (upd) upd.addEventListener("click", async () => { try { await subscribe(); toast("Reminder times updated"); } catch (e) { toast("Couldn't update", e.message || ""); } });
      if (off) off.addEventListener("click", async () => {
        try { const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription(); if (sub) { await sb.from("push_subs").delete().eq("endpoint", sub.endpoint); await sub.unsubscribe(); } } catch (e) { /* ignore */ }
        S.settings.pushOn = false; save(); render(); toast("Reminders off");
      });
    }
    async function refreshPushTimes() { if (user && S.settings.pushOn && pushSupported() && Notification.permission === "granted") { try { await subscribe(); } catch (e) { /* ignore */ } } }

    return { init, queuePush, pull, renderAccount, renderLeaderboard, signOut, refreshPushTimes, get user() { return user; }, enabled };
  })();

  // ---------------------------------------------------------------- boot
  render();
  if (/[?&]water=1/.test(location.search)) { history.replaceState(null, "", location.pathname); setTimeout(() => S.profile && openWaterModal(), 600); }
  else setTimeout(maybeAskWater, 800);
  Cloud.init().then(() => { if (Cloud.user) render(); }).catch(() => {});
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      if (render._day !== dayKey()) render._day = dayKey();
      if (!$("#modal-root").children.length && S.profile) render();
      setTimeout(maybeAskWater, 400);
      if (Cloud.user) Cloud.pull().catch(() => {});
    }
  });
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }
})();
