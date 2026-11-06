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
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); }
    catch (e) { toast("Could not save", "Your phone storage may be full."); }
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
    return { q: out, overall, cleared, xp, doneMain, mainCount: main.length };
  }

  function totalXP() { return Object.keys(S.days).reduce((a, k) => a + questState(k).xp, 0); }
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
    if (!S.profile || !S.targets) return renderOnboarding();
    const xp = totalXP(), L = levelFromXP(xp), start = levelStart(L), next = levelStart(L + 1);
    const st = streak();
    const app = $("#app");
    app.innerHTML =
      '<div class="shell">' +
      '<header class="hud">' +
      '<div class="lvl"><div class="num">' + L + '</div><div class="lab">LEVEL</div></div>' +
      '<div class="hud-right"><div class="title-row"><div class="ptitle">' + esc(S.profile.name || "Player") + ' · Title: <b>' + esc(titleFor(L)) + '</b></div>' +
      '<div class="streak" title="Days in a row with every quest cleared">' + (st ? "🔥 " + st + "-day streak" : "") + '</div></div>' +
      '<div class="xpbar"><i style="width:' + clamp(((xp - start) / (next - start)) * 100, 0, 100) + '%"></i></div>' +
      '<div class="xptext"><span>XP ' + fmt(xp - start) + " / " + fmt(next - start) + '</span><span>Total ' + fmt(xp) + ' XP</span></div></div>' +
      '</header><main id="view"></main></div>' +
      '<nav class="nav">' +
      ["quest", "food", "water", "player"].map((t) => '<button data-tab="' + t + '" class="' + (tab === t ? "active" : "") + '">' + ICON[t] + (t === "quest" ? "Quest" : t === "food" ? "Food" : t === "water" ? "Water" : "Player") + "</button>").join("") +
      "</nav>";
    $$(".nav button").forEach((b) => b.addEventListener("click", () => { tab = b.dataset.tab; if (tab === "food") foodDay = dayKey(); render(); window.scrollTo(0, 0); }));
    const v = $("#view");
    if (tab === "quest") renderQuest(v);
    else if (tab === "food") renderFood(v);
    else if (tab === "water") renderWater(v);
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
    tickTimer();
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
          '<p class="panel-sub">New title: ' + esc(titleFor(L)) + '</p><p class="explain" style="text-align:center">Keep stacking daily quests to level up faster.</p>' +
          '<button class="btn primary block" data-close>Continue</button></div>', { center: true });
        bg.querySelector(".panel").classList.add("levelup");
      }, 900);
    } else if (L < (S.lastLevel || 1)) { S.lastLevel = L; changed = true; }
    // prune old celebration keys
    const cutoff = addDays(k, -3);
    Object.keys(S.celebrated).forEach((key) => { if (key.slice(0, 10) < cutoff) { delete S.celebrated[key]; changed = true; } });
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
        if (!num) { toast("No number found on clipboard", "Run the Copy Steps shortcut first"); return; }
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
      return '<div class="meal"><div class="meal-h">' + name + ' <span>' + fmt(kc) + ' kcal</span><button class="btn sm" data-add="' + id + '">+ Add</button></div>' +
        (items.length ? items.map((f) => '<div class="fitem"><div class="n">' + esc(f.name) + "<small>" + esc(f.amountLabel) + " · P " + r0(f.n.p) + " · C " + r0(f.n.c) + " · F " + r0(f.n.f) + '</small></div><div class="k">' + fmt(f.n.kcal) + '</div><button class="x" data-del="' + esc(f.id) + '" aria-label="Remove">×</button></div>').join("") : '<div class="empty">Nothing yet</div>') + "</div>";
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
    $$("[data-del]", v).forEach((b) => b.addEventListener("click", () => {
      const day = getDay(k), i = day.foods.findIndex((f) => f.id === b.dataset.del);
      if (i >= 0) { const [gone] = day.foods.splice(i, 1); save(); render(); toast("Removed", gone.name); }
    }));
  }
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
    const url = "https://world.openfoodfacts.org/cgi/search.pl?search_terms=" + encodeURIComponent(q) +
      "&search_simple=1&action=process&json=1&page_size=15&fields=code,product_name,brands,nutriments,serving_size,serving_quantity";
    const res = await withTimeout(url, 10000);
    if (!res.ok) throw new Error("OFF " + res.status);
    const js = await res.json();
    return (js.products || []).map(offToFood).filter(Boolean);
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
      qIn.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => showList(qIn.value.trim()), 250); });
      qIn.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); qIn.blur(); showList(qIn.value.trim(), true); } });
      setTimeout(() => qIn.focus(), 50);
    }
    function showList(q, online) {
      const box = $("#af-res", body); if (!box) return;
      const seq = ++searchSeq;
      if (!q) {
        results = S.recents.slice(0, 12);
        box.innerHTML = (results.length ? '<div class="h2" style="margin-top:6px">Recent</div>' : '<div class="h2" style="margin-top:6px">Popular basics</div>') +
          (results.length ? "" : "") ;
        if (!results.length) results = builtinFoods().slice(0, 12);
        box.innerHTML += results.map(resHTML).join("");
        bindRes(box);
        return;
      }
      const local = S.recents.concat(builtinFoods())
        .map((f) => ({ f, s: matchScore(f.name + " " + (f.brand || ""), q) })).filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s).map((x) => x.f);
      const seen = new Set(); results = local.filter((f) => { const id = f.src + f.name; if (seen.has(id)) return false; seen.add(id); return true; }).slice(0, 8);
      box.innerHTML = results.map(resHTML).join("") + '<div class="loading" id="af-load">Searching online</div>';
      bindRes(box);
      if (q.length < 2) { $("#af-load", box).remove(); return; }
      Promise.allSettled([searchUSDA(q), searchOFF(q)]).then(([u, o]) => {
        if (seq !== searchSeq) return;
        const add = [].concat(u.status === "fulfilled" ? u.value.slice(0, 10) : [], o.status === "fulfilled" ? o.value.slice(0, 10) : []);
        results = results.concat(add);
        const failed = u.status === "rejected" && o.status === "rejected";
        box.innerHTML = results.map(resHTML).join("") +
          (failed ? '<div class="empty">Online search is unavailable right now. Try again, or use Quick add.</div>' : !results.length ? '<div class="empty">No results. Try other words, or use Quick add.</div>' : "");
        bindRes(box);
      });
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
          '<div class="row">' + numIn("pi-k", it.kcal, "kcal") + numIn("pi-p", it.p, "prot g") + numIn("pi-c", it.c, "carb g") + numIn("pi-f", it.f, "fat g") + "</div></div>").join("") +
        mealSelect("ph-meal") + '<button class="btn good block" style="margin-top:14px" id="ph-add">Add to log</button>';
      $$(".pi-del", out).forEach((b) => b.addEventListener("click", () => b.closest(".res").remove()));
      $("#ph-add", out).addEventListener("click", () => {
        const rows = $$(".res[data-pi]", out);
        if (!rows.length) { toast("Nothing to add"); return; }
        const meal1 = $("#ph-meal", out).value;
        rows.forEach((row) => {
          const it = items[+row.dataset.pi], g = (c) => Math.max(0, parseFloat($(c, row).value) || 0);
          const n = { kcal: g(".pi-k"), p: g(".pi-p"), c: g(".pi-c"), f: g(".pi-f"), fiber: it.fiber || 0, sugar: it.sugar || 0, sat: it.sat || 0, sodium: it.sodium || 0, potassium: 0, calcium: 0, iron: 0, vitc: 0 };
          logFood(k, { name: ($(".pi-name", row).value.trim() || it.name) + (it.label ? "" : " 📷"), amountLabel: it.portion || "1 portion", meal: meal1, n });
        });
        closeModal();
      });
    }

    function resHTML(f, i) {
      const per = scaleNutrients(f.per100, f.servingG);
      return '<button class="res" data-i="' + i + '"><span class="src">' + esc(f.src) + "</span><b>" + esc(f.name) + "</b><span>" +
        (f.brand ? esc(f.brand) + " · " : "") + esc(f.servingLabel) + " · " + fmt(per.kcal) + " kcal · P " + r0(per.p) + "g</span></button>";
    }
    function bindRes(box) { $$(".res", box).forEach((b) => b.addEventListener("click", () => openAmount(results[+b.dataset.i]))); }

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
        logFood(k, { name: food.name + (food.brand ? " (" + food.brand + ")" : ""), amountLabel: label, meal: $("#am-meal", body).value, n: scaleNutrients(food.per100, grams()) });
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
      if (res.status === 404) { lastErr = new Error("AI model not available"); continue; }
      if (res.status === 400 || res.status === 401 || res.status === 403) {
        const txt = await res.text().catch(() => "");
        if (/API key|API_KEY|PERMISSION|UNAUTHENTICATED/i.test(txt)) { S.settings.geminiKey = ""; save(); throw new Error("Google says that key doesn't work. Close this, tap 📷 Photo again and paste a new key."); }
        const e = new Error("The AI couldn't read that photo. Try another one."); e.bad = true; throw e;
      }
      if (res.status === 429) { const e = new Error("You hit the free AI limit for now. Wait a minute and try again, or log it with Search."); e.limit = true; throw e; }
      if (!res.ok) throw new Error("The AI is busy (" + res.status + "). Try again in a moment.");
      const js = await res.json();
      const cand = (js.candidates || [])[0] || {};
      const text = ((cand.content || {}).parts || []).map((p) => p.text || "").join("");
      // pull the JSON out even if it's wrapped in ``` fences or extra words
      const m = text.match(/[\[{][\s\S]*[\]}]/);
      try { return JSON.parse(m ? m[0] : text); } catch (e) { throw new Error("The AI gave a confusing answer. Try again."); }
    }
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
        } catch (e) { if (e.limit) throw e; /* keep the photo estimate */ }
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
      if (js.status === 1 && js.product) { const f = offToFood(js.product); if (f) return f; }
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
      "<li>Tap the name at the top, call it <code>Copy Steps</code>, tap <b>Done</b>. The first time it runs, tap <b>Allow</b> for Health.</li></ol>" +
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
    $$("[data-rem]", v).forEach((inp) => inp.addEventListener("change", () => {
      if (!/^\d\d:\d\d$/.test(inp.value)) return;
      S.settings.reminders[+inp.dataset.rem] = inp.value;
      S.settings.reminders.sort(); save(); toast("Check-in times saved");
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
      if (confirm("Erase all your data on this phone? This can't be undone.")) { localStorage.removeItem(STORE_KEY); S = fresh(); tab = "quest"; render(); }
    });
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

  // ---------------------------------------------------------------- boot
  render();
  setTimeout(maybeAskWater, 800);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      if (render._day !== dayKey()) render._day = dayKey();
      if (!$("#modal-root").children.length && S.profile) render();
      setTimeout(maybeAskWater, 400);
    }
  });
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }
})();
