/* ============================================================
   Wilayat — App controller (routing, i18n, rendering, modules)
   Vanilla JS · no build step
   ============================================================ */

// Same origin as the page (FastAPI serves both the site and the API), so this works
// on localhost AND on your real domain. Override with window.WILAYAT_API if needed.
const API_BASE = (typeof window !== "undefined" && window.WILAYAT_API) || "/api";

const State = {
  // Kashmiri (ks) was removed — anyone who had it saved falls back to Urdu.
  lang: (localStorage.getItem("wilayat.lang") === "ks" ? "ur" : (localStorage.getItem("wilayat.lang") || "en")),
  theme: "dark",
  route: "home",
  prayer: null,   // { times, tz, label } once loaded for the user's location
  // { lat, lng } — shared everywhere; remembered across refreshes
  coords: JSON.parse(localStorage.getItem("wilayat.coords") || "null"),
  qibla: null,    // bearing to the Kaaba (degrees from North) once computed
};
function saveCoords(lat, lng, meta = {}) {
  State.coords = {
    lat: Number(lat),
    lng: Number(lng),
    source: meta.source || "gps",
    accuracy: Number.isFinite(meta.accuracy) ? Math.round(meta.accuracy) : null,
    updatedAt: Date.now(),
  };
  localStorage.setItem("wilayat.coords", JSON.stringify(State.coords));
}

const t = (key) => (I18N[State.lang] && I18N[State.lang][key]) || I18N.en[key] || key;
const el = (sel) => document.querySelector(sel);
const els = (sel) => [...document.querySelectorAll(sel)];

// ---------------- API layer (graceful offline fallback) ----------------
let API_UP = null; // null=unknown, true/false once probed
// On GitHub Pages there is no backend: every /api call is served from the
// pre-generated static JSON under /api/*, and search runs in the browser.
const STATIC = (typeof window !== "undefined" && window.WILAYAT_STATIC) || /\.github\.io$/.test(location.hostname);
const STATIC_BASE = (() => {
  if (!STATIC) return null;
  const s = [...document.scripts].map((x) => x.src).find((x) => /\/js\/app\.js/.test(x)) || "";
  return s.replace(/js\/app\.js.*$/, "") + "api/";
})();
async function api(path) {
  if (STATIC) { API_UP = true; return staticApi(path); }
  const r = await fetch(API_BASE + path, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  API_UP = true;
  return r.json();
}

// ----- Static (no-backend) API: maps /api paths to files + in-browser search -----
async function _sjson(rel) {
  const r = await fetch(STATIC_BASE + rel, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}
let _qIdx = null, _hIdx = null, _surNames = null, _tafMap = {};
const _ar2en = (s) => String(s)
  .replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d))
  .replace(/[۰-۹]/g, (d) => "۰۱۲۳۴۵۶۷۸۹".indexOf(d));
const _en2ar = (s) => String(s).replace(/\d/g, (d) => "٠١٢٣٤٥٦٧٨٩"[+d]);

async function staticApi(path) {
  const [p, qs] = path.split("?");
  const q = new URLSearchParams(qs || "");
  if (p === "/quran/search") return staticQuranSearch(q.get("q") || "", +(q.get("limit") || 50));
  if (p === "/hadith/search") return staticHadithSearch(q.get("q") || "", +(q.get("limit") || 50));
  if (p === "/dua/search") return staticListSearch(typeof DUAS !== "undefined" ? DUAS : [], q.get("q") || "", +(q.get("limit") || 40));
  if (p === "/ziyarat/search") return staticListSearch(typeof ZIYARAT !== "undefined" ? ZIYARAT : [], q.get("q") || "", +(q.get("limit") || 40));
  let m = p.match(/^\/quran\/tafsir\/(\d+)\/(\d+)$/);
  if (m) return staticTafsir(+m[1], +m[2], q.get("edition") || "almizan_en");
  m = p.match(/^\/hadith\/book\/(.+)$/);
  if (m) return _sjson(`hadith/book/${m[1]}/${+(q.get("page") || 1)}.json`);
  return _sjson(p.replace(/^\//, "") + ".json");
}

async function staticQuranSearch(qq, limit) {
  const ql = qq.toLowerCase().trim();
  if (!ql) return { count: 0, results: [] };
  if (!_qIdx) _qIdx = await _sjson("search/quran.json");
  if (!_surNames) { const idx = await _sjson("quran/surahs.json"); _surNames = {}; (idx.surahs || []).forEach((s) => { _surNames[s.n] = s.en; }); }
  const out = [];
  for (const v of _qIdx) {
    if ((v.en && v.en.toLowerCase().includes(ql)) || (v.translit && v.translit.toLowerCase().includes(ql)) ||
        (v.ar && v.ar.includes(qq)) || (v.ur && v.ur.includes(qq)) || (v.fa && v.fa.includes(qq))) {
      out.push({ surah: v.s, surahName: _surNames[v.s] || "", ayah: v.a, ar: v.ar, en: v.en });
      if (out.length >= limit) break;
    }
  }
  return { count: out.length, results: out };
}

async function staticHadithSearch(rawIn, limit) {
  const raw = _ar2en((rawIn || "").trim());
  if (!raw) return { count: 0, results: [] };
  if (!_hIdx) _hIdx = await _sjson("search/hadith.json");
  const numeric = /^\d+$/.test(raw), isAr = /[؀-ۿ]/.test(raw), norm = raw.toLowerCase();
  const grab = (...pats) => { for (const p of pats) { const m = raw.match(p); if (m) return m[1]; } return null; };
  const vol_q = grab(/\bvol(?:ume)?\s*(\d+)/i, /(?:الجزء|الجز|جزء|ج)\s*[.:]?\s*(\d+)/);
  const ch_q = grab(/\bch(?:apter)?\s*(\d+)/i, /باب\s*[.:]?\s*(\d+)/);
  const h_q = grab(/\bh(?:adith)?\s*(\d+)/i, /(?:الحديث|حديث|ح)\s*[.:]?\s*(\d+)/);
  const refMode = !numeric && !!(vol_q || ch_q || h_q);
  // Book-name tokens are Latin-only (Arabic keywords like ح/باب must not become a name filter).
  const latinNorm = norm.replace(/[^a-z0-9\s]/g, " ");
  const nameToks = refMode ? latinNorm.split(/\s+/).filter((t) => t && !["vol", "volume", "ch", "chapter", "h", "hadith"].includes(t) && !/^\d+$/.test(t)) : [];
  const queryHasArName = isAr && _hIdx.some((b) => b.ar && raw.includes(b.ar));
  const out = [];
  for (const b of _hIdx) {
    if (refMode) {
      if (vol_q && b.vol !== vol_q) continue;
      if (nameToks.length) { const ns = (b.name || "").toLowerCase(); if (!nameToks.every((t) => ns.includes(t))) continue; }
      if (queryHasArName && b.ar && !raw.includes(b.ar)) continue;
    }
    for (const it of b.items) {
      const hid = String(it.id);
      let match;
      if (numeric) match = raw === hid;
      else if (refMode) match = h_q ? hid === h_q : (ch_q ? String(it.ch) === ch_q : true);
      else if (isAr) match = (it.ar || "").includes(raw);
      else match = (b.name + " " + (it.en || "")).toLowerCase().includes(norm);
      if (match) {
        const citation = b.name + (it.ch ? ` · Ch. ${it.ch}` : "") + ` · H. ${it.id}`;
        const ar_citation = (b.ed === "ar" && b.ar)
          ? b.ar + (b.vol ? ` – الجزء ${_en2ar(b.vol)}` : "") + (it.ch ? `، باب ${_en2ar(it.ch)}` : "") + `، ح ${_en2ar(it.id)}`
          : null;
        out.push({ bookId: b.bookId, name: b.name, id: it.id, chapter: it.ch, ar: it.ar, en: it.en,
                   edition: b.ed, reference: { citation, ar_citation } });
        if (out.length >= limit) return { count: out.length, results: out };
      }
    }
  }
  return { count: out.length, results: out };
}

function staticListSearch(list, qq, limit) {
  const ql = qq.toLowerCase().trim();
  list = list || [];
  const out = [];
  for (const d of list) {
    if (((d.en || "") + " " + (d.ar || "") + " " + (d.note || "")).toLowerCase().includes(ql)) {
      out.push({ ar: d.ar || "", en: d.en || "", title: d.en || "", id: d.textId || "" });
      if (out.length >= limit) break;
    }
  }
  return { count: out.length, results: out };
}

async function staticTafsir(s, a, ed) {
  if (!_tafMap[ed]) _tafMap[ed] = await _sjson(`quran/tafsir/${ed}/map.json`);
  const map = _tafMap[ed];
  const cid = map[`${s}:${a}`];
  if (cid == null) throw new Error("HTTP 404");
  // al-Mizan groups verses; find the range this commentary block covers.
  const pref = s + ":", same = [];
  for (const k in map) { if (map[k] === cid && k.indexOf(pref) === 0) same.push(+k.split(":")[1]); }
  const covers = same.length ? { from: Math.min(...same), to: Math.max(...same) } : null;
  return { ...(await _sjson(`quran/tafsir/${ed}/c/${cid}.json`)), surah: s, ayah: a, covers };
}
function offlineBanner() {
  return `<div class="card" style="border-color:var(--gold);background:linear-gradient(135deg,rgba(31,123,255,.14),transparent);margin-bottom:16px">
    ⚠️ ${t("offline")} <code>uvicorn app.main:app --reload</code></div>`;
}
// Maps each UI language onto the language whose CONTENT (phrase map + data) to use.
// Dari→Persian, Kashmiri→Urdu, Azerbaijani/Malay/Singapore borrow per case.
const CONTENT_LANG = { en: "en", az: "az", ms: "ms", ur: "ur", ks: "ur", fa: "fa", ar: "ar" };
const contentLang = () => CONTENT_LANG[State.lang] || "en";
// Quran/verse translation field (verse data carries en/ur/fa/az/ms; ks→ur, prs→fa, sg→en).
const trField = () => ({ en: "en", az: "az", ms: "ms", ur: "ur", ks: "ur", fa: "fa", ar: null }[State.lang] ?? null);
let currentAudio = null;
// Clean play / pause glyphs (SVG, not emoji) for the recitation buttons.
const ICON_PLAY = '<svg class="picon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
const ICON_PAUSE = '<svg class="picon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1.2"/><rect x="14" y="5" width="4" height="14" rx="1.2"/></svg>';
// Western → Arabic-Indic digits (for numbering shown beside Arabic text).
const arDigits = (s) => String(s).replace(/[0-9]/g, (d) => "٠١٢٣٤٥٦٧٨٩"[+d]);
// Arabic hadith text often begins with its order number ("1 - حدثنا…"); render
// that leading number in Arabic-Indic numerals (the English translation keeps 1.).
const arHadithText = (s) => String(s).replace(/^(\s*)(\d+)/, (_, sp, n) => sp + arDigits(n));
function playAudio(url) {
  if (!url) return toast(t("coming_soon"));
  if (currentAudio) currentAudio.pause();
  currentAudio = new Audio(url);
  currentAudio.play().then(() => toast("🔊 " + t("listen"))).catch(() => toast(t("audio_unavailable")));
}

// Per-ayah play/pause: the button shows ▶ when idle and ⏸ while that ayah plays.
let _ayahBtn = null;
function playAyah(btn, url) {
  if (!url) return toast(t("coming_soon"));
  if (currentAudio && _ayahBtn === btn && !currentAudio.paused) {
    currentAudio.pause();
    btn.innerHTML = ICON_PLAY;
    return;
  }
  if (currentAudio) currentAudio.pause();
  if (_ayahBtn && _ayahBtn !== btn) _ayahBtn.innerHTML = ICON_PLAY;
  if (typeof stopSurahAudio === "function") stopSurahAudio();
  currentAudio = new Audio(url);
  _ayahBtn = btn;
  btn.innerHTML = ICON_PAUSE;
  currentAudio.onended = () => { if (_ayahBtn === btn) btn.innerHTML = ICON_PLAY; };
  currentAudio.play().catch(() => { btn.innerHTML = ICON_PLAY; toast(t("audio_unavailable")); });
}

// ---------------- i18n + direction ----------------
function applyLang() {
  const conf = I18N[State.lang];
  document.body.setAttribute("dir", conf._dir);
  document.documentElement.lang = State.lang;
  localStorage.setItem("wilayat.lang", State.lang);
  els("[data-i18n]").forEach((n) => (n.textContent = t(n.dataset.i18n)));
  els("[data-i18n-ph]").forEach((n) => (n.placeholder = t(n.dataset.i18nPh)));
  el("#langLabel").textContent = conf._name;
  localizeNumbers();
}

// ---------------- Locale numerals + phrase translation ----------------
const DIGIT_SETS = { ar: "٠١٢٣٤٥٦٧٨٩", ur: "۰۱۲۳۴۵۶۷۸۹", fa: "۰۱۲۳۴۵۶۷۸۹", ks: "۰۱۲۳۴۵۶۷۸۹" };
let _phraseRe = null;
function buildPhraseRegex() {
  if (typeof PHRASES === "undefined") return;
  const keys = Object.keys(PHRASES).sort((a, b) => b.length - a.length)
    .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  // Letter boundaries so e.g. "All" never matches inside "Allah".
  try {
    _phraseRe = new RegExp("(?<![A-Za-z])(?:" + keys.join("|") + ")(?![A-Za-z])", "g");
  } catch {
    // Older Safari has no lookbehind — fall back to multi-char keys only (safe without boundaries).
    const safe = keys.filter((k) => k.length >= 5 && k !== "Allah");
    _phraseRe = new RegExp("\\b(?:" + safe.join("|") + ")\\b", "g");
  }
}
// Localize one string: translate known phrases, then convert digits.
function localizeStr(str) {
  const plang = contentLang();   // Dari→Persian, Kashmiri→Urdu phrases; en-mapped langs keep English
  let out = str;
  if (plang !== "en" && _phraseRe) out = out.replace(_phraseRe, (m) => (PHRASES[m] && PHRASES[m][plang]) || m);
  const d = DIGIT_SETS[State.lang];
  if (d) out = out.replace(/[0-9]/g, (n) => d[+n]);
  return out;
}
// Walk the active view and localize every text node (phrases + numerals).
function localizeNumbers(root) {
  if (State.lang === "en") return;
  root = root || document.querySelector("#views");
  if (!root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
  for (const node of nodes) {
    const nv = localizeStr(node.nodeValue);
    if (nv !== node.nodeValue) node.nodeValue = nv;
  }
}
let _numObserver;
function setupNumberLocalization() {
  const root = document.querySelector("#views");
  if (!root || _numObserver) return;
  buildPhraseRegex();
  _numObserver = new MutationObserver(() => {
    if (State.lang === "en") return;
    _numObserver.disconnect();           // avoid self-retrigger while we edit text
    localizeNumbers(root);
    _numObserver.observe(root, { childList: true, subtree: true, characterData: true });
  });
  _numObserver.observe(root, { childList: true, subtree: true, characterData: true });
}

function applyTheme() {
  State.theme = "dark";
  document.body.setAttribute("data-theme", "dark");
  localStorage.removeItem("wilayat.theme");
}

// ---------------- Toast ----------------
let toastTimer;
function toast(msg) {
  const box = el("#toast");
  box.textContent = msg;
  box.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove("show"), 1900);
}

// ---------------- Router ----------------
let _navIndex = 0;

function normalizeRoute(route) {
  return RENDERERS[route] ? route : "home";
}

function routeUrl(route) {
  const base = location.pathname + location.search;
  return route === "home" ? base : `${base}#${route}`;
}

function syncHistory(route, options = {}) {
  if (options.history === false || !window.history || !history.pushState) return;
  const state = history.state && history.state.wilayat ? history.state : null;
  if (options.replace || !state) {
    history.replaceState({ wilayat: true, route, index: _navIndex }, "", routeUrl(route));
    return;
  }
  if (state.route === route) return;
  _navIndex += 1;
  history.pushState({ wilayat: true, route, index: _navIndex }, "", routeUrl(route));
}

function appBack(fallback = "home") {
  if (_navIndex > 0) {
    history.back();
    return;
  }
  if (State.route !== fallback) go(fallback);
}

// Position the glass pill under a given bottom-nav item.
function _bnavPillTo(bn, it) {
  const pill = bn.querySelector(".bnav-pill");
  if (!pill || !it) return;
  pill.style.width = it.offsetWidth + "px";
  pill.style.height = it.offsetHeight + "px";
  pill.style.transform = `translate(${it.offsetLeft}px, ${it.offsetTop}px)`;
  pill.style.opacity = "1";
}
// Slide the frosted-glass highlight pill under the active bottom-nav icon.
function moveBnavPill() {
  const bn = el("#bottomNav"); if (!bn) return;
  _bnavPillTo(bn, bn.querySelector(".bottom-item.active"));
}
// Drag support: the glass pill travels continuously WITH your finger across the
// bar (no jumping); on release it snaps to the nearest icon and selects it.
function setupBnavDrag(bn) {
  const items = () => [...bn.querySelectorAll(".bottom-item")];
  const nearestItem = (clientX) => {
    let best = null, bestD = Infinity;
    items().forEach((it) => {
      const r = it.getBoundingClientRect();
      const d = Math.abs(clientX - (r.left + r.width / 2));
      if (d < bestD) { bestD = d; best = it; }
    });
    return best;
  };
  let dragging = false, pw = 0, ph = 0, topY = 0, minX = 0, maxX = 0;
  const follow = (clientX) => {
    const pill = bn.querySelector(".bnav-pill"); if (!pill) return;
    let x = clientX - bn.getBoundingClientRect().left - pw / 2;
    x = Math.max(minX, Math.min(maxX, x));
    pill.style.transform = `translate(${x}px, ${topY}px) scale(1.16)`;  // grows while dragging
  };
  bn.addEventListener("pointerdown", (e) => {
    const list = items(); if (!list.length) return;
    dragging = true;
    try { bn.setPointerCapture(e.pointerId); } catch (_) {}
    const act = bn.querySelector(".bottom-item.active") || list[0];
    pw = act.offsetWidth; ph = act.offsetHeight; topY = act.offsetTop;
    minX = list[0].offsetLeft;
    maxX = list[list.length - 1].offsetLeft + list[list.length - 1].offsetWidth - pw;
    const pill = bn.querySelector(".bnav-pill");
    pill.style.transition = "none";                 // 1:1 with the finger, no easing/jump
    pill.style.width = pw + "px"; pill.style.height = ph + "px"; pill.style.opacity = "1";
    follow(e.clientX);
  });
  bn.addEventListener("pointermove", (e) => { if (dragging) follow(e.clientX); });
  const finish = (e) => {
    if (!dragging) return;
    dragging = false;
    const pill = bn.querySelector(".bnav-pill");
    if (pill) pill.style.transition = "";           // restore smooth snap
    const it = nearestItem(e.clientX);
    if (it) { _bnavPillTo(bn, it); if (it.dataset.route) go(it.dataset.route); }
  };
  bn.addEventListener("pointerup", finish);
  bn.addEventListener("pointercancel", () => {
    dragging = false;
    const pill = bn.querySelector(".bnav-pill"); if (pill) pill.style.transition = "";
    moveBnavPill();
  });
}

function go(route, options = {}) {
  route = normalizeRoute(route);
  if (route !== "qibla") stopQiblaCompass();
  stopSurahAudio();   // stop any Quran recitation when navigating away / going back
  State.route = route;
  els(".nav-item, .bottom-item").forEach((n) => n.classList.toggle("active", n.dataset.route === route));
  moveBnavPill();
  els(".view").forEach((v) => v.classList.remove("active"));
  const view = el("#view-" + route);
  if (view) {
    view.classList.add("active");
    view.scrollIntoView({ behavior: "instant", block: "start" });
    // Modules opened from Explore (non-primary sections) rise up like a bottom sheet.
    view.classList.remove("sheet-in");
    if (route !== "home" && !isPrimaryRoute(route)) { void view.offsetWidth; view.classList.add("sheet-in"); }
  }
  RENDERERS[route] && RENDERERS[route](view);
  // Sections reached from the Settings sheet open full-screen (no phone bottom nav).
  document.body.classList.toggle("settings-route", route !== "home" && !isPrimaryRoute(route));
  el("#sidebar").classList.remove("open");
  window.scrollTo({ top: 0 });
  syncHistory(route, options);
  updateSearchMark();
  if (route === "home") {
    const si = el(".search input");
    if (si && si.value.trim()) filterHomeModules(si.value);
  }
}

// ---------------- Renderers per module ----------------
const RENDERERS = {
  home: renderHome,
  quran: renderQuran,
  hadith: renderHadith,
  explore: renderExplore,
  mahdi: renderMahdi,
  progress: renderProgress,
  ahlquran: renderAhlQuran,
  events: renderEvents,
  journey: renderJourney,
  proofs: renderProofs,
  science: renderScience,
  holy: renderHolyBooks,
  life: renderLife,
  tafsir: renderTafsir,
  dua: renderDua,
  ziyarat: renderZiyarat,
  prayer: renderPrayer,
  qibla: renderQibla,
  calendar: renderCalendar,
  ahlulbayt: renderAhlulBayt,
  ai: renderAI,
  library: renderLibrary,
  community: renderCommunity,
  search: renderSearch,
  media: renderMedia,
  tasbih: renderTasbih,
  admin: renderAdmin,
};

function head(titleKey, subKey) {
  // Settings-reached pages keep a back arrow on phone (others use the bottom nav).
  const settingsPage = State.route !== "home" && !isPrimaryRoute(State.route);
  const back = State.route !== "home"
    ? `<button class="screen-back${settingsPage ? " for-settings" : ""}" onclick="appBack()" aria-label="Back">←</button>` : "";
  return `<div class="page-head">${back}<div class="eyebrow wilayat-mark">Al-Wilayat</div>
    <h1>${t(titleKey)}</h1>${subKey ? `<p>${t(subKey)}</p>` : ""}</div>`;
}

// ---------- Usage stats (persisted; real numbers on the home page) ----------
const Stats = {
  KEY: "wilayat.stats",
  _today: () => new Date().toISOString().slice(0, 10),
  _yesterday: () => new Date(Date.now() - 864e5).toISOString().slice(0, 10),
  load() { try { return JSON.parse(localStorage.getItem(this.KEY) || "{}"); } catch { return {}; } },
  save(s) { try { localStorage.setItem(this.KEY, JSON.stringify(s)); } catch { /* ignore */ } },
  _roll(s) {
    const t = this._today();
    if (s.date !== t) { s.date = t; s.versesToday = 0; s.dhikrToday = 0; s.readSurahs = []; s.readAyat = []; s.readHadithDay = []; }
    return s;
  },
  get() { const s = this._roll(this.load()); this.save(s); return s; },
  touchStreak() {
    const s = this._roll(this.load());
    if (s.lastActive !== this._today()) {
      s.streak = (s.lastActive === this._yesterday()) ? (s.streak || 0) + 1 : 1;
      s.lastActive = this._today();
    }
    if (!s.streak) s.streak = 1;
    this.save(s);
  },
  addSurahRead(n, verseCount) {
    const s = this.get();
    s.readSurahs = s.readSurahs || [];
    if (!s.readSurahs.includes(n)) {
      s.readSurahs.push(n);
      s.versesToday = (s.versesToday || 0) + (verseCount || 0);
      this.save(s);
    }
  },
  addDhikr(n = 1) { const s = this.get(); s.dhikrToday = (s.dhikrToday || 0) + n; this.save(s); },
  // Count a single verse as read (once per ayah per day) — for live per-user "Read today".
  addVerseRead(key) {
    const s = this.get();
    s.readAyat = s.readAyat || [];       // today (resets daily)
    s.readAyatAll = s.readAyatAll || []; // all-time unique ayahs (whole-Qur'an progress)
    let changed = false;
    if (!s.readAyat.includes(key)) { s.readAyat.push(key); s.versesToday = (s.versesToday || 0) + 1; changed = true; }
    if (!s.readAyatAll.includes(key)) { s.readAyatAll.push(key); changed = true; }
    if (changed) this.save(s);
  },
  // Count a single hadith as read (once per hadith per day) — feeds the hadith graph.
  addHadithRead(key) {
    const s = this.get();
    s.readHadithDay = s.readHadithDay || [];   // today (resets daily)
    s.readHadithAll = s.readHadithAll || [];   // all-time unique
    s.hadithHist = s.hadithHist || {};         // { "YYYY-MM-DD": count }
    let changed = false;
    const today = this._today();
    if (!s.readHadithDay.includes(key)) {
      s.readHadithDay.push(key);
      s.hadithHist[today] = (s.hadithHist[today] || 0) + 1;
      changed = true;
    }
    if (!s.readHadithAll.includes(key)) { s.readHadithAll.push(key); changed = true; }
    if (changed) this.save(s);
  },
  // Current calendar week, Sunday → Saturday, with each day's hadith-read count.
  hadithWeek() {
    const hist = this.get().hadithHist || {};
    const todayKey = this._today();
    const base = new Date(todayKey + "T00:00:00Z");   // UTC midnight of today's key
    const dow = base.getUTCDay();                      // 0 = Sunday
    const out = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(base); d.setUTCDate(base.getUTCDate() - dow + i);
      const key = d.toISOString().slice(0, 10);
      out.push({ key, dow: d.getUTCDay(), count: hist[key] || 0, isToday: key === todayKey });
    }
    return out;
  },
  // ---- Per-device prayer tracking (live build) ----
  getPrayers(date) { const s = this.load(); return (s.prayers && s.prayers[date || this._today()]) || []; },
  togglePrayer(key) {
    const s = this._roll(this.load());
    const d = this._today();
    s.prayers = s.prayers || {};
    const arr = (s.prayers[d] || []).slice();
    const i = arr.indexOf(key);
    if (i >= 0) arr.splice(i, 1); else arr.push(key);
    s.prayers[d] = arr;
    this.save(s);
    return arr;
  },
  // Consecutive days on which all `total` obligatory prayers were marked.
  prayerStreak(total) {
    const pr = this.load().prayers || {};
    const iso = (dt) => dt.toISOString().slice(0, 10);
    let day = new Date();
    if ((pr[iso(day)] || []).length < total) day = new Date(Date.now() - 864e5); // today still in progress
    let streak = 0;
    while ((pr[iso(day)] || []).length >= total) { streak++; day = new Date(day.getTime() - 864e5); }
    return streak;
  },
  // ---- Dua / Ziyarat reads (all-time unique, per kind) ----
  addTextRead(kind, id) {
    if (!id) return;
    const s = this.load();
    s.readText = s.readText || {};
    s.readText[kind] = s.readText[kind] || [];
    if (!s.readText[kind].includes(id)) { s.readText[kind].push(id); this.save(s); }
  },
  readCount(kind) { const s = this.load(); return ((s.readText || {})[kind] || []).length; },
};
// The 5 obligatory daily prayers (Sunrise is not a prayer).
const OBLIGATORY = () => PRAYERS.filter((p) => p.key !== "sunrise");

// Ring goals: Verses = the whole Qur'an (6236 ayahs, cumulative); prayers 5/day, dhikr 100/day.
const QURAN_TOTAL = 6236;
const GOALS = { verses: QURAN_TOTAL, dhikr: 100 };
// Concentric progress rings (prayers / verses / dhikr) — per-user, from localStorage.
function progressRings(st) {
  const np = nextPrayer();               // next prayer (name + time) for the HUD centre
  const pt = OBLIGATORY().length;
  const prayed = Stats.getPrayers().length;
  const vCount = (st.readAyatAll || []).length;   // cumulative unique ayahs read (whole Qur'an)
  const pR = Math.min(1, prayed / pt);
  const vR = Math.min(1, vCount / GOALS.verses);
  const dR = Math.min(1, (st.dhikrToday || 0) / GOALS.dhikr);
  const overall = Math.round(((pR + vR + dR) / 3) * 100);
  const C = { prayers: "#cc3b3b", verses: "#2f9e57", dhikr: "#a9743e" }; // solid (legend dots)
  const G = { prayers: ["#e56a6a", "#7e1f1f"], verses: ["#57d693", "#1c6e3f"], dhikr: ["#d7a566", "#734827"] };
  const grad = (id, a, b) =>
    `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient>`;
  const ring = (r, val, id) => {
    const c = 2 * Math.PI * r;
    return `<circle cx="100" cy="100" r="${r}" fill="none" stroke="rgba(255,255,255,.09)" stroke-width="15"/>` +
      `<circle cx="100" cy="100" r="${r}" fill="none" stroke="url(#${id})" stroke-width="15" stroke-linecap="round" ` +
      `stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(c * (1 - val)).toFixed(1)}" ` +
      `transform="rotate(-90 100 100)" style="transition:stroke-dashoffset 1.1s var(--ease)"/>`;
  };
  // silver shine bead at the leading tip of each ring
  const tip = (r, val) => {
    if (val <= 0.001) return "";
    const ang = (-90 + val * 360) * Math.PI / 180;
    const x = 100 + r * Math.cos(ang), y = 100 + r * Math.sin(ang);
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4.6" fill="#eef4fc" filter="url(#silver)"/>`;
  };
  // real drifting, shining SILVER dust (particles float up & fade)
  const dustC = ["#e8eef7", "#c3cfe0", "#d6deec"]; // silver shades
  const dpos = [[26, 44], [172, 52], [184, 150], [30, 158], [150, 26], [52, 182], [180, 104], [22, 108],
    [100, 16], [100, 188], [66, 30], [140, 176], [42, 88], [164, 122], [82, 168], [122, 60], [36, 130], [168, 74]];
  const dust = dpos.map((d, i) => {
    const dur = (3.4 + (i % 5) * 0.8).toFixed(1);
    const del = (i * 0.33).toFixed(2);
    const dx = ((i % 2 ? 1 : -1) * (3 + (i % 4) * 3));
    const r = (0.8 + (i % 3) * 0.7).toFixed(1);
    return `<circle class="dust" cx="${d[0]}" cy="${d[1]}" r="${r}" fill="${dustC[i % 3]}" ` +
      `style="--dx:${dx}px;animation-duration:${dur}s;animation-delay:${del}s"/>`;
  }).join("");
  // Jarvis-style HUD — tick bezel, orbiting nodes, gradient glowing arcs, pulsing core
  let jTicks = "", jDots = "";
  for (let i = 0; i < 60; i++) {
    const a = i * 6 * Math.PI / 180, lng = i % 5 === 0;
    const r1 = lng ? 42.5 : 44.5, r2 = 47.5;
    jTicks += `<line x1="${(50 + r1 * Math.cos(a)).toFixed(2)}" y1="${(50 + r1 * Math.sin(a)).toFixed(2)}" x2="${(50 + r2 * Math.cos(a)).toFixed(2)}" y2="${(50 + r2 * Math.sin(a)).toFixed(2)}" stroke="#8fa6c8" stroke-width="${lng ? 1 : 0.5}" opacity="${lng ? 0.7 : 0.3}"/>`;
  }
  for (let i = 0; i < 12; i++) {
    const a = i * 30 * Math.PI / 180;
    jDots += `<circle cx="${(50 + 37 * Math.cos(a)).toFixed(2)}" cy="${(50 + 37 * Math.sin(a)).toFixed(2)}" r="1.1" fill="#cfdcf0" opacity=".55"/>`;
  }
  const jarvis = `
    <svg class="jarvis" viewBox="0 0 100 100" aria-hidden="true">
      <defs>
        <linearGradient id="jg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#8fdcff"/><stop offset=".5" stop-color="#2a6fd6"/><stop offset="1" stop-color="#163a80"/>
        </linearGradient>
        <linearGradient id="jsweep" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#8fe6ff" stop-opacity=".5"/><stop offset="1" stop-color="#8fe6ff" stop-opacity="0"/>
        </linearGradient>
        <filter id="jglow" x="-60%" y="-60%" width="220%" height="220%"><feDropShadow dx="0" dy="0" stdDeviation="1.4" flood-color="#57b6ff" flood-opacity=".9"/></filter>
      </defs>
      <!-- twin bezel + ticks -->
      <circle cx="50" cy="50" r="47.5" fill="none" stroke="#3a4f74" stroke-width=".6" opacity=".55"/>
      <circle cx="50" cy="50" r="45" fill="none" stroke="#24365c" stroke-width=".5" opacity=".5"/>
      ${jTicks}
      <!-- silver node ring -->
      <g class="j-spin ccw vslow">${jDots}</g>
      <!-- outer segmented gradient ring -->
      <g class="j-spin cw slow">
        <circle cx="50" cy="50" r="40" fill="none" stroke="url(#jg)" stroke-width="2.6" stroke-linecap="round" stroke-dasharray="30 10 7 10 30 10 7 10" filter="url(#jglow)"/>
      </g>
      <!-- mid dashed ring -->
      <g class="j-spin ccw">
        <circle cx="50" cy="50" r="31" fill="none" stroke="#dce4f0" stroke-width="1.5" stroke-dasharray="5 9" opacity=".85"/>
      </g>
      <!-- inner static frame -->
      <circle cx="50" cy="50" r="25" fill="none" stroke="#2a6fd6" stroke-width=".8" opacity=".4" stroke-dasharray="2 4"/>
      <!-- centre: next prayer -->
      <text x="50" y="45" text-anchor="middle" class="j-name">${langName(np)}</text>
      <text x="50" y="59" text-anchor="middle" class="j-time">${np.time}</text>
    </svg>`;
  const row = (color, label, a, b) =>
    `<div><span class="dot" style="background:${color}"></span>${label}<b>${a}/${b}</b></div>`;
  return `
    <div class="card progress-card">
      <div class="prog-head"><svg class="prog-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/></svg> ${localizedText("Your progress today")}</div>
      <div class="prog-wrap">
        ${jarvis}
        <div class="prog-ring" role="img" aria-label="${overall}% ${localizedText("today")}">
          <svg viewBox="0 0 200 200">
            <defs>
              ${grad("gP", G.prayers[0], G.prayers[1])}${grad("gV", G.verses[0], G.verses[1])}${grad("gD", G.dhikr[0], G.dhikr[1])}
              <filter id="silver" x="-60%" y="-60%" width="220%" height="220%"><feDropShadow dx="0" dy="0" stdDeviation="2.3" flood-color="#dfe8f5" flood-opacity="0.95"/></filter>
            </defs>
            ${dust}
            ${ring(88, pR, "gP")}${ring(65, vR, "gV")}${ring(42, dR, "gD")}
            ${tip(88, pR)}${tip(65, vR)}${tip(42, dR)}
          </svg>
          <div class="prog-center"><div class="big">${overall}%</div><div class="lbl">${localizedText("today")}</div></div>
        </div>
        <div class="prog-legend">
          <div><span class="dot" style="background:${C.prayers}"></span><span class="leg-name">${localizedText("Day streak")}</span><b>${st.streak || 1}</b></div>
          <div><span class="dot" style="background:${C.verses}"></span><span class="leg-name">${localizedText("Prayer streak")}</span><b>${prayed}/${pt}</b></div>
          <div><span class="dot" style="background:${C.dhikr}"></span><span class="leg-name">${localizedText("Dhikr")}</span><b>${st.dhikrToday || 0}/${GOALS.dhikr}</b></div>
        </div>
      </div>
    </div>`;
}

// First-ever visit on this device → "Welcome"; any later visit → "Welcome back".
function welcomeMessage() {
  try {
    if (localStorage.getItem("wilayat.welcomed")) return "Welcome back to Al-Wilayat";
    localStorage.setItem("wilayat.welcomed", "1");
  } catch (e) { /* ignore */ }
  return "Welcome to Al-Wilayat";
}
// Split the welcome text into per-letter spans for a continuous ripple wave.
function welcomeHTML() {
  return [...welcomeMessage()].map((ch, i) =>
    ch === " " ? '<span class="sp">&nbsp;</span>'
      : `<span style="animation-delay:${(i * 0.05).toFixed(2)}s">${ch}</span>`).join("");
}

// ---------- Dua of the day (31 short duas, one per day) ----------
const DUA_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/><path d="M6 8h2"/><path d="M6 12h2"/><path d="M16 8h2"/><path d="M16 12h2"/></svg>';
const QA_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>';
function qaBar() {
  return `
    <button class="option-bar" onclick="openQA()">
      <span class="ob-ic">${QA_ICON}</span>
      <span class="ob-title">${localizedText("Q&A")}</span>
      <span class="ob-arrow" aria-hidden="true">›</span>
    </button>`;
}

// ---------- SAVED (bookmarked Qur'an surahs) ----------
const SAVE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>';
// Clean line icons for the hadith/collection bars (replace the old book emojis).
const SEARCH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>';
const PIN_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>';
const BELL_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>';
const BOOK_ICON  ='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>';
const BOOKS_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>';
const BOOK_OFF_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/><line x1="3" y1="3" x2="21" y2="21"/></svg>';
const Saved = {
  KEY: "wilayat.saved",
  load() { try { return JSON.parse(localStorage.getItem(this.KEY) || "[]"); } catch { return []; } },
  store(a) { try { localStorage.setItem(this.KEY, JSON.stringify(a)); } catch { /* ignore */ } },
  has(id) { return this.load().some((x) => x.id === id); },
  toggle(item) {
    const a = this.load(); const i = a.findIndex((x) => x.id === item.id);
    if (i >= 0) { a.splice(i, 1); this.store(a); return false; }
    a.unshift(item); this.store(a); return true;
  },
  remove(id) { this.store(this.load().filter((x) => x.id !== id)); },
};
let _savedSurahMeta = {};
function toggleSaveSurah(n, btn) {
  const m = _savedSurahMeta[n] || {};
  const on = Saved.toggle({ id: "surah-" + n, type: "surah", n, ar: m.ar || "", name: m.name || ("Surah " + n) });
  if (btn) btn.classList.toggle("saved", on);
  toast(localizedText(on ? "Saved" : "Removed"));
}
function savedBar() {
  return `
    <button class="option-bar" onclick="openSaved()">
      <span class="ob-ic">${SAVE_ICON}</span>
      <span class="ob-title">${localizedText("Saved")}</span>
      <span class="ob-arrow" aria-hidden="true">›</span>
    </button>`;
}
function openSaved() {
  const items = Saved.load();
  const list = items.length ? items.map((x) => `
    <div class="list-item" onclick="openSavedItem('${x.id}')">
      <div class="badge-num">${SAVE_ICON}</div>
      <div class="meta"><div class="t">${x.name || ("Surah " + x.n)}</div><div class="s">${localizedText("Qur'an")}</div></div>
      ${x.ar ? `<div class="side-ar" dir="rtl" lang="ar">${x.ar}</div>` : ""}
      <button class="icon-btn" style="flex-shrink:0" onclick="event.stopPropagation();removeSaved('${x.id}')" aria-label="${localizedText("Remove")}">×</button>
    </div>`).join("")
    : `<p class="ev-intro" dir="ltr">${localizedText("No saved items yet. Tap the bookmark ⌾ on a surah to save it here.")}</p>`;
  openQuranReader(`
    <div class="q-reader">
      <div class="qr-topbar">
        <button class="dua-back" onclick="history.back()" aria-label="${localizedText("Back")}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg></button>
        <span class="qr-title">${localizedText("Saved")}</span>
      </div>
      <div class="qr-body">${list}</div>
    </div>`);
}
function openSavedItem(id) {
  const x = Saved.load().find((i) => i.id === id);
  if (x && x.type === "surah") openSurah(x.n);
}
function removeSaved(id) { Saved.remove(id); openSaved(); }
function duaOfDay() {
  const list = (typeof DUAS31 !== "undefined") ? DUAS31 : [];
  if (!list.length) return null;
  const d = new Date();
  // whole-day count in local time → advances by exactly 1 each calendar day
  const dayCount = Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
  const idx = ((dayCount % list.length) + list.length) % list.length;   // cycles 0..30, one per day
  return { dua: list[idx], idx, day: idx + 1 };
}
function duaText(dua) {
  const f = trField();                                     // ur/fa/az/ms/en or null
  return (f && f !== "en" && dua[f]) ? dua[f] : dua.en;
}
function duaDayCard() {
  if (typeof DUAS31 === "undefined" || !DUAS31.length) return "";
  return `
    <button class="option-bar" onclick="openDuaDay()">
      <span class="ob-ic">${DUA_ICON}</span>
      <span class="ob-title">${localizedText("Dua of the Day")}</span>
      <span class="ob-arrow" aria-hidden="true">›</span>
    </button>`;
}

// ---------- DUA OF THE DAY (slide-up sheet) ----------
let _duaIdx = 0;
function duaSheetHTML(idx) {
  const list = (typeof DUAS31 !== "undefined") ? DUAS31 : [];
  if (!list.length) return "";
  if (idx == null) idx = duaOfDay().idx;
  _duaIdx = ((idx % list.length) + list.length) % list.length;
  const d = list[_duaIdx];
  const meaning = duaText(d);
  const rtl = ARABIC_SCRIPT_LANGS.includes(State.lang);
  return `
    <div class="dua-hero">
      <img class="dua-hero-img" src="assets/dua-hands.jpg?v=1" alt="" draggable="false" ondragstart="return false" />
      <div class="dua-hero-shade"></div>
      <div class="dua-hero-top">
        <span class="dua-top-left">
          <button class="dua-back" onclick="history.back()" aria-label="${localizedText("Back")}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg></button>
          <span class="dua-eyebrow">${localizedText("Dua of the Day")}</span>
        </span>
      </div>
    </div>
    <div class="dua-panel" dir="${rtl ? "rtl" : "ltr"}">
      <div class="dua-hero-ar" dir="rtl" lang="ar">${d.ar}</div>
      ${d.tr ? `<div class="dua-translit">${d.tr}</div>` : ""}
      <div class="dua-meaning">${meaning}</div>
      ${d.src ? `<div class="dua-src">${d.src}</div>` : ""}
      <button class="dua-recite" onclick="duaRecite()" aria-label="${localizedText("Recite")}">
        <span class="dr-ic dr-play"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg></span>
        <span class="dr-ic dr-stop"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg></span>
        <span class="dr-label">${localizedText("Recite")}</span>
      </button>
    </div>`;
}
let _duaSpeaking = false;
function duaRecite() {
  const synth = window.speechSynthesis;
  const list = (typeof DUAS31 !== "undefined") ? DUAS31 : [];
  const btn = document.querySelector(".dua-recite");
  if (!synth || !list.length) { toast(localizedText("Voice not available")); return; }
  if (synth.speaking || synth.paused) { synth.cancel(); return; }   // toggle off
  const d = list[_duaIdx];
  const u = new SpeechSynthesisUtterance(d.ar);
  u.lang = "ar-SA"; u.rate = 0.78; u.pitch = 1;
  const ar = (synth.getVoices() || []).find((v) => /^ar/i.test(v.lang));
  if (ar) u.voice = ar;
  const setLabel = (txt) => { const l = document.querySelector(".dua-recite .dr-label"); if (l) l.textContent = txt; };
  u.onstart = () => { _duaSpeaking = true; btn && btn.classList.add("playing"); setLabel(localizedText("Stop")); };
  u.onend = u.onerror = () => { _duaSpeaking = false; const b = document.querySelector(".dua-recite"); b && b.classList.remove("playing"); setLabel(localizedText("Recite")); };
  synth.cancel();
  synth.speak(u);
}
function stopDuaRecite() { try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch (e) {} }
function openDuaDay() {
  const body = el("#duaSheetBody");
  if (body) body.innerHTML = duaSheetHTML();
  el("#duaSheet")?.classList.add("open");
  el("#duaBackdrop")?.classList.add("open");
  document.body.classList.add("sheet-lock");
  if (!(history.state && history.state.duaOpen)) {
    history.pushState({ wilayat: true, route: State.route, index: _navIndex, duaOpen: true },
      "", location.href);
  }
}
function closeDuaDay() {
  stopDuaRecite();
  el("#duaSheet")?.classList.remove("open");
  el("#duaBackdrop")?.classList.remove("open");
  document.body.classList.remove("sheet-lock");
}

// ---------- Q&A QUIZ (slide-up sheet) ----------
const QUIZ_LANG = () => ({ en:"en", ar:"ar", ur:"ur", ks:"ur", fa:"fa", az:"az", ms:"ms" }[State.lang] || "en");
const qL = (o) => (o && (o[QUIZ_LANG()] || o.en)) || "";
let _quiz = null;   // { order:[], i, score, answered }

function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

function qaSheetShell() {
  return `
    <div class="dua-hero qa-hero">
      <img class="dua-hero-img qa-img" src="assets/qa-mosque.jpg?v=2" alt="" draggable="false" ondragstart="return false" />
      <div class="dua-hero-shade"></div>
      <div class="dua-hero-top">
        <span class="dua-top-left">
          <button class="dua-back" onclick="history.back()" aria-label="${localizedText("Back")}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg></button>
          <span class="dua-eyebrow">${localizedText("Q&A")}</span>
        </span>
      </div>
    </div>
    <div class="quiz-wrap" id="quizWrap"></div>`;
}
function quizStart() {
  const list = (typeof QUIZ50 !== "undefined") ? QUIZ50 : [];
  _quiz = { order: shuffle(list.map((_, i) => i)), i: 0, score: 0, answered: false };
  quizRender();
}
function quizRender() {
  const wrap = el("#quizWrap");
  const list = (typeof QUIZ50 !== "undefined") ? QUIZ50 : [];
  if (!wrap || !_quiz || !list.length) return;
  const rtl = ARABIC_SCRIPT_LANGS.includes(State.lang);
  if (_quiz.i >= _quiz.order.length) { wrap.innerHTML = quizResultHTML(); return; }
  const q = list[_quiz.order[_quiz.i]];
  const total = _quiz.order.length;
  const pct = Math.round((_quiz.i / total) * 100);
  const opts = q.opts.map((o, k) =>
    `<button class="quiz-opt" data-k="${k}" onclick="quizAnswer(${k})">
       <span class="qo-letter">${String.fromCharCode(65 + k)}</span>
       <span class="qo-text">${qL(o)}</span>
       <span class="qo-mark" aria-hidden="true"></span>
     </button>`).join("");
  wrap.innerHTML = `
    <div class="dua-panel quiz-card" dir="${rtl ? "rtl" : "ltr"}">
      <div class="quiz-top">
        <span class="quiz-count">${localizedText("Question")} ${_quiz.i + 1} / ${total}</span>
        <span class="quiz-score">${localizedText("Score")}: ${_quiz.score}</span>
      </div>
      <div class="quiz-bar"><i style="width:${pct}%"></i></div>
      <div class="quiz-q">${qL(q.q)}</div>
      <div class="quiz-opts">${opts}</div>
      <button class="quiz-next" id="quizNext" onclick="quizNext()" disabled>${localizedText("Next")} <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg></button>
    </div>`;
}
function quizAnswer(k) {
  const list = (typeof QUIZ50 !== "undefined") ? QUIZ50 : [];
  if (!_quiz || _quiz.answered) return;
  _quiz.answered = true;
  const q = list[_quiz.order[_quiz.i]];
  const correct = q.correct;
  if (k === correct) _quiz.score++;
  const btns = document.querySelectorAll(".quiz-opt");
  btns.forEach((b) => {
    const bk = Number(b.dataset.k);
    b.classList.add("done");
    if (bk === correct) b.classList.add("correct");
    else if (bk === k) b.classList.add("wrong");
  });
  const scoreEl = document.querySelector(".quiz-score");
  if (scoreEl) scoreEl.textContent = `${localizedText("Score")}: ${_quiz.score}`;
  const next = el("#quizNext");
  if (next) { next.disabled = false; next.classList.add("ready"); }
}
function quizNext() {
  if (!_quiz || !_quiz.answered) return;
  const card = document.querySelector(".quiz-card");
  _quiz.i++;
  _quiz.answered = false;
  if (card) {
    card.classList.add("leaving");
    setTimeout(quizRender, 240);
  } else quizRender();
}
function quizResultHTML() {
  const total = _quiz.order.length;
  const s = _quiz.score;
  const pct = Math.round((s / total) * 100);
  let msg = localizedText("Keep learning — try again!");
  if (pct >= 90) msg = localizedText("Outstanding, mashaAllah!");
  else if (pct >= 70) msg = localizedText("Great work, mashaAllah!");
  else if (pct >= 50) msg = localizedText("Good effort — keep going!");
  return `
    <div class="dua-panel quiz-card quiz-result">
      <div class="qr-ring" style="--p:${pct}">
        <div class="qr-inner"><span class="qr-score">${s}</span><span class="qr-total">/ ${total}</span></div>
      </div>
      <div class="qr-msg">${msg}</div>
      <button class="quiz-next ready" onclick="quizStart()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9 9 0 0 0-6.7 3"/><path d="M3 3v5h5"/></svg> ${localizedText("Try Again")}</button>
    </div>`;
}
function openQA() {
  const body = el("#qaSheetBody");
  if (body) { body.innerHTML = qaSheetShell(); quizStart(); }
  el("#qaSheet")?.classList.add("open");
  el("#qaBackdrop")?.classList.add("open");
  document.body.classList.add("sheet-lock");
  if (!(history.state && history.state.qaOpen)) {
    history.pushState({ wilayat: true, route: State.route, index: _navIndex, qaOpen: true },
      "", location.href);
  }
}
function closeQA() {
  el("#qaSheet")?.classList.remove("open");
  el("#qaBackdrop")?.classList.remove("open");
  if (!(el("#duaSheet")?.classList.contains("open"))) document.body.classList.remove("sheet-lock");
}

// ---------- HOME ----------
function renderHome(v) {
  const next = nextPrayer();
  const st = Stats.get();

  v.innerHTML = `
    <div class="hero glass-hi">
      <div class="kalima-calligraphy" dir="rtl" aria-label="محمد رسول الله">
        <img src="assets/kalima-calligraphy.png?v=1" alt="محمد رسول الله" draggable="false" ondragstart="return false" />
      </div>
    </div>
    <div class="welcome-bar"><span>${localizedText("Knowledge is better than wealth")}</span></div>
    ${progressRings(st)}
    ${duaDayCard()}
    ${qaBar()}
    ${savedBar()}
    ${State.coords ? "" : `<div class="card" style="text-align:center;margin-bottom:18px">
      <span style="color:var(--text-2);font-size:13px">${t("enable_loc")}</span>
      <button class="btn" style="margin-top:10px" onclick="requestLocation(true)">📍 ${t("use_location")}</button></div>`}`;
}
// ---------- TAFSIR (Shia Qur'an commentaries) ----------
const TAFSIR_LIST = [
  { id: "tf-qummi", name: "Tafsir al-Qummi", author: "Ali ibn Ibrahim al-Qummi" },
  { id: "tf-ayyashi", name: "Tafsir al-'Ayyashi", author: "Muhammad ibn Mas'ud al-'Ayyashi" },
  { id: "tf-furat", name: "Tafsir Furat al-Kufi", author: "Furat ibn Ibrahim al-Kufi" },
  { id: "tf-askari", name: "Tafsir al-Imam al-'Askari (a.s.)", author: "attributed to Imam al-Hasan al-'Askari (a.s.)" },
  { id: "tf-nur", name: "Nur al-Thaqalayn", author: "al-'Arusi al-Huwayzi" },
];
function tafsirBoxes(list) {
  return list.map((t, i) => `
    <button class="ev-box" onclick="openTafsir(${i})">
      <span class="ev-num">${i + 1}</span>
      <span class="ev-name">${localizedText(t.name)}</span>
      <span class="ev-date">${localizedText(t.author)}</span>
    </button>`).join("");
}
function renderTafsir(v) {
  v.innerHTML = head("nav_tafsir")
    + `<p class="ahlq-intro">${localizedText("The classical Qur'an commentaries (tafsir) of the school of the Ahl al-Bait.")}</p>`
    + `<div class="jr-grid">${tafsirBoxes(TAFSIR_LIST)}</div>`;
}
const TAFSIR_V = "20260801-eshia164";
const tafsirFileSrc = (id) => "js/tafsir_" + id.replace("tf-", "") + ".js?v=" + TAFSIR_V;
function tafsirShell(t, inner) {
  return `
    <div class="q-reader">
      <div class="qr-topbar">
        <button class="dua-back" onclick="history.back()" aria-label="${localizedText("Back")}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg></button>
        <span class="qr-title">${localizedText(t.name)}</span>
      </div>
      <div class="qr-body" dir="rtl">
        <div class="ahlq-ref" style="text-align:center;margin-bottom:12px" dir="ltr">${localizedText(t.author)}</div>
        ${inner}
      </div>
    </div>`;
}
const tafsirData = (id) => (typeof window.TAFSIR_DATA !== "undefined") ? window.TAFSIR_DATA[id] : null;
function openTafsir(i) {
  const t = TAFSIR_LIST[i]; if (!t) return;
  if (tafsirData(t.id)) { showTafsirVolumes(i); return; }
  // lazy-load this tafsir's data file, then show its volumes
  openQuranReader(tafsirShell(t, `<div class="qr-load"><div class="card">${localizedText("Loading")}…</div></div>`));
  const s = document.createElement("script");
  s.src = tafsirFileSrc(t.id);
  s.onload = () => showTafsirVolumes(i);
  s.onerror = () => { const b = el("#qrSheetBody"); if (b) b.innerHTML = tafsirShell(t, `<p class="ev-intro" dir="ltr">${localizedText("This tafsir will be added soon, insha'Allah.")}</p>`); };
  document.body.appendChild(s);
}
// One bar per volume; tapping opens that volume's paginated reader.
let _tafOpenIdx = 0, _tafReading = false;
function showTafsirVolumes(i) {
  const t = TAFSIR_LIST[i]; if (!t) return;
  const data = tafsirData(t.id);
  const vols = (data && data.volumes) ? data.volumes : [];
  _tafOpenIdx = i; _tafReading = false;
  if (vols.length <= 1) { showTafsirPage(i, 0, 0); return; }   // single volume → straight in
  const rtl = ARABIC_SCRIPT_LANGS.includes(State.lang);
  const bars = vols.map((v, vi) => `
    <button class="option-bar" onclick="openTafsirVolume(${i},${vi})">
      <span class="ob-ic">${QURAN_ICON}</span>
      <span class="ob-text"><span class="ob-title">${localizedText("Volume")} ${locNum(vi + 1, State.lang)}</span><span class="ob-sub">${locNum(v.pages.length, State.lang)} ${localizedText("pages")}</span></span>
      <span class="ob-arrow" aria-hidden="true">›</span>
    </button>`).join("");
  openQuranReader(tafsirShell(t, `<div dir="${rtl ? "rtl" : "ltr"}">${bars}</div>`));
  const b = el("#qrSheetBody"); if (b) b.scrollTop = 0;
}
function openTafsirVolume(i, vol) {
  _tafReading = true; _tafOpenIdx = i;
  // push a history entry so Back returns to the volume list (not out of the reader)
  history.pushState({ wilayat: true, route: State.route, index: _navIndex, qrOpen: true, tafRead: 1 }, "", location.href);
  showTafsirPage(i, vol, 0);
}
const tafsirTrFileSrc = (id, lang) => "js/tafsir_" + id.replace("tf-", "") + "_" + lang + ".js?v=" + TAFSIR_V;
let _tafTrFail = {};
// Render tafsir text: join scan line-breaks, tidy punctuation, and highlight the
// Qur'anic verse quotes (in ornate brackets) and the "God said" verse markers.
function tafClean(s) {
  s = escapeHtml(String(s || "")).replace(/\r/g, "").replace(/\n+/g, " ");
  // 0) Strip invisible zero-width noise from the scans that leaves letters looking
  //    cramped — but only at word boundaries, so meaningful mid-word ZWNJ (Urdu/
  //    Farsi) is preserved. Also soften robotic abbreviations to plain wording.
  s = s.replace(/[​-‍⁠﻿]+(?=[\s.,،؛:!؟]|$)/g, "")
       .replace(/(^|[\s.,،؛:!؟])[​-‍⁠﻿]+/g, "$1");
  s = s.replace(/\bi\.\s*e\.\s*/gi, "that is, ").replace(/\be\.\s*g\.\s*/gi, "for example, ");
  // 1) Pull structural bits into placeholders FIRST so the punctuation clean-up
  //    below can never corrupt them. \x01 ref · \x02 quote · \x03 number · \x04 marker
  s = s.replace(/\(?\s*(\d{1,3}):(\d{1,3})\s*\)?/g, " \x01$1:$2\x01 ");
  s = s.replace(/[«“][ ]*([^»”]{2,400}?)[ ]*[»”]/g, "\x02$1\x02");
  s = s.replace(/(?:^|\s)(\d{1,3})\s*-\s+/g, " \x03$1\x03 ");
  s = s.replace(/\s*(قوله تعالى|قوله عزّ وجلّ|قوله عز وجل|قوله جل جلاله|قال الله تعالى|قال تعالى|وقوله)\s*/g,
                " \x04$1\x04 ");
  // 2) Drop stray OCR/transliteration junk: lone Latin letters (keep only real
  //    words a/A/I/O) and orphan "C-G"-type hyphen tokens. Twice for back-to-back.
  for (let k = 0; k < 2; k++) {
    s = s.replace(/(^|\s)[B-HJ-NP-Zb-z][.,;:]?(?=\s|$)/g, "$1")
         .replace(/(^|\s)[A-Za-z]-[A-Za-z][.,;:]?(?=\s|$)/g, "$1");
  }
  // 3) Punctuation clean-up (leftover after removals)
  s = s.replace(/\s+[-–—]+\s*/g, " ").replace(/\s*[-–—]+\s+/g, " ")   // OCR dashes → space (keep al-Baqarah)
       .replace(/&quot;|&#39;|['"“”„‟]/g, "")                          // orphan stray quotes
       .replace(/\s+([.,،؛:!؟])/g, "$1")                              // no space before punctuation
       .replace(/[,،]+(?=\s*[.،؛:!؟])/g, "")                          // comma right before another mark → drop
       .replace(/([.،؛:!؟])[\s.,،؛:]*([.،؛:!؟])/g, "$1$2")            // collapse mixed runs
       .replace(/([.،؛:!؟])\1+/g, "$1")                              // dedupe repeats
       .replace(/(^|[\x01\x02\x03\x04])\s*[.,،؛:!؟]+\s*/g, "$1 ")     // orphan punctuation at a block start
       .replace(/\s{2,}/g, " ").trim();
  // 4) Materialise the placeholders into HTML
  s = s.replace(/\x01(\d{1,3}:\d{1,3})\x01/g, '<br><br><span class="taf-ref">$1</span> ')
       .replace(/\x02([^\x02]*)\x02/g, '<span class="taf-verse">« $1 »</span>')
       .replace(/\x03(\d{1,3})\x03/g, '<br><br><span class="taf-num">$1 -</span> ')
       .replace(/\x04([^\x04]*)\x04/g, '<br><br><span class="taf-marker">$1</span> ');
  return s.replace(/^(?:<br>\s*)+/, "").replace(/\s{2,}/g, " ").trim();
}
// Localize Western digits (0-9) to the reading language's numeral system:
// Arabic → ٠-٩, Urdu/Kashmiri/Farsi/Dari → ۰-۹, Latin languages unchanged.
const _NUMSET = { ar: "٠١٢٣٤٥٦٧٨٩", ur: "۰۱۲۳۴۵۶۷۸۹", ks: "۰۱۲۳۴۵۶۷۸۹", fa: "۰۱۲۳۴۵۶۷۸۹" };
function locNum(s, lang) {
  const set = _NUMSET[lang];
  return set ? String(s).replace(/[0-9]/g, (d) => set[+d]) : String(s);
}
function showTafsirPage(i, vol, page) {
  const t = TAFSIR_LIST[i]; if (!t) return;
  const data = tafsirData(t.id);
  const vols = (data && data.volumes) ? data.volumes : [];
  const v = vols[vol]; if (!v) return;
  const pages = v.pages || [];
  const n = pages.length;
  if (!n) return;
  page = Math.max(0, Math.min(page, n - 1));
  const multiVol = vols.length > 1;
  const arHtml = `<div class="taf-page" dir="rtl">${locNum(tafClean(pages[page]), "ar")}</div>`;

  // Tafsir has its own real Kashmiri translation (Bing), so ks → "ks" here even
  // though the rest of the app maps Kashmiri to the Urdu text.
  const trLang = State.lang === "ks" ? "ks" : trField();
  const needTr = trLang && trLang !== "ar";
  const failKey = t.id + "|" + trLang;
  const trBook = (window.TAFSIR_TR && window.TAFSIR_TR[t.id]) ? window.TAFSIR_TR[t.id][trLang] : null;
  const trVol = (trBook && trBook[vol]) ? trBook[vol] : null;
  let trHtml = "";
  if (needTr && trVol) {
    const rtl = ARABIC_SCRIPT_LANGS.includes(State.lang);
    trHtml = `<div class="taf-tr" dir="${rtl ? "rtl" : "ltr"}">${locNum(tafClean(trVol[page] || ""), State.lang)}</div>`;
  } else if (needTr && !_tafTrFail[failKey]) {
    trHtml = `<div class="taf-tr taf-tr-load" dir="ltr">${localizedText("Loading")}…</div>`;
    if (window._tafTrLoading !== failKey) {
      window._tafTrLoading = failKey;
      const s = document.createElement("script");
      s.src = tafsirTrFileSrc(t.id, trLang);
      s.onload = () => { window._tafTrLoading = null; showTafsirPage(i, vol, page); };
      s.onerror = () => { window._tafTrLoading = null; _tafTrFail[failKey] = 1; showTafsirPage(i, vol, page); };
      document.body.appendChild(s);
    }
  }
  const inner = `
        ${arHtml}
        ${trHtml}
        <div class="taf-pager" dir="ltr">
          <button class="btn taf-nav" ${page <= 0 ? "disabled" : ""} onclick="showTafsirPage(${i},${vol},${page - 1})">‹ ${localizedText("Previous")}</button>
          <span class="taf-count">${locNum(page + 1, State.lang)} / ${locNum(n, State.lang)}</span>
          <button class="btn taf-nav" ${page >= n - 1 ? "disabled" : ""} onclick="showTafsirPage(${i},${vol},${page + 1})">${localizedText("Next")} ›</button>
        </div>`;
  openQuranReader(tafsirShell(t, inner));
  const b = el("#qrSheetBody"); if (b) b.scrollTop = 0;
}

// ---------- HADITH LIBRARY (major full-text collections, from eshia) ----------
const HLIB_LIST = [
  { slug: "istibsar",  name: "al-Istibsar",         author: "Shaykh al-Tusi" },
  { slug: "tahdhib",   name: "Tahdhib al-Ahkam",    author: "Shaykh al-Tusi" },
  { slug: "mizan",     name: "Mizan al-Hikmah",     author: "Muhammad al-Rayshahri" },
  { slug: "mustadrak", name: "Mustadrak al-Wasail", author: "al-Muhaddith al-Nuri" },
  { slug: "wasail",    name: "Wasail al-Shia",      author: "al-Hurr al-'Amili" },
  { slug: "bihar",     name: "Bihar al-Anwar",      author: "al-'Allamah al-Majlisi" },
];
// Approx. narration counts (scholarly) for the big collections — used in the stats.
const HLIB_NARR = { istibsar: 5511, tahdhib: 13590, mizan: 23000, mustadrak: 23514, wasail: 35850, bihar: 40000 };
const hlibNarrTotal = () => HLIB_LIST.reduce((a, t) => a + (HLIB_NARR[t.slug] || 0), 0);
// Per-volume lazy loading: a tiny manifest (volume page-counts), then one small
// file per volume (Arabic) and per volume+language (translation) on demand — so
// giant books like Bihar (42k pages) never load all at once.
const HLIB_V = "20260805-hlib5";
const hlibManifestSrc = (slug) => "js/hadithlib_" + slug + ".js?v=" + HLIB_V;
const hlibVolSrc = (slug, vol) => "js/hadithlib_" + slug + "_v" + vol + ".js?v=" + HLIB_V;
const hlibTrVolSrc = (slug, lang, vol) => "js/hadithlib_" + slug + "_" + lang + "_v" + vol + ".js?v=" + HLIB_V;
const hlibMeta = (slug) => (window.HLIB_META && window.HLIB_META[slug]) ? window.HLIB_META[slug] : null;
const hlibVolPages = (slug, vol) => (window.HLIB_DATA && window.HLIB_DATA[slug] && window.HLIB_DATA[slug][vol]) ? window.HLIB_DATA[slug][vol] : null;
let _hlibTrFail = {}, _hlibReading = false, _hlibOpenIdx = 0;
// Rendered as bars (like the other hadith books), shown below the graph.
function hlibBars() {
  const arName = { istibsar: "الاستبصار", tahdhib: "تهذيب الأحكام", mizan: "ميزان الحكمة", mustadrak: "مستدرك الوسائل", wasail: "وسائل الشيعة", bihar: "بحار الأنوار" };
  return HLIB_LIST.map((t, i) => {
    const title = disp(t.name, arName[t.slug] || t.name, t.name);
    return `<button class="ev-box" onclick="openHlib(${i})">
      <span class="ev-ic">${BOOK_ICON}</span>
      <span class="ev-name">${title}</span>
      <span class="ev-date">${localizedText(t.author)}</span>
    </button>`;
  }).join("");
}
function openHlib(i) {
  const t = HLIB_LIST[i]; if (!t) return;
  if (hlibMeta(t.slug)) { showHlibVolumes(i); return; }
  openQuranReader(tafsirShell(t, `<div class="qr-load"><div class="card">${localizedText("Loading")}…</div></div>`));
  const s = document.createElement("script");
  s.src = hlibManifestSrc(t.slug);
  s.onload = () => showHlibVolumes(i);
  s.onerror = () => { const b = el("#qrSheetBody"); if (b) b.innerHTML = tafsirShell(t, `<p class="ev-intro" dir="ltr">${localizedText("This book will be added soon, insha'Allah.")}</p>`); };
  document.body.appendChild(s);
}
function showHlibVolumes(i) {
  const t = HLIB_LIST[i]; if (!t) return;
  const meta = hlibMeta(t.slug);
  const vols = (meta && meta.vols) ? meta.vols : [];
  _hlibOpenIdx = i; _hlibReading = false;
  if (vols.length <= 1) { openHlibVolume(i, 0); return; }   // single volume → straight in
  const rtl = ARABIC_SCRIPT_LANGS.includes(State.lang);
  const bars = vols.map((cnt, vi) => `
    <button class="option-bar" onclick="openHlibVolume(${i},${vi})">
      <span class="ob-ic">${QURAN_ICON}</span>
      <span class="ob-text"><span class="ob-title">${localizedText("Volume")} ${locNum(vi + 1, State.lang)}</span><span class="ob-sub">${locNum(cnt, State.lang)} ${localizedText("pages")}</span></span>
      <span class="ob-arrow" aria-hidden="true">›</span>
    </button>`).join("");
  openQuranReader(tafsirShell(t, `<div dir="${rtl ? "rtl" : "ltr"}">${bars}</div>`));
  const b = el("#qrSheetBody"); if (b) b.scrollTop = 0;
}
function openHlibVolume(i, vol) {
  const t = HLIB_LIST[i]; if (!t) return;
  const meta = hlibMeta(t.slug);
  const multiVol = meta && meta.vols && meta.vols.length > 1;
  if (multiVol) {
    _hlibReading = true; _hlibOpenIdx = i;
    history.pushState({ wilayat: true, route: State.route, index: _navIndex, qrOpen: true, tafRead: 1 }, "", location.href);
  }
  if (hlibVolPages(t.slug, vol)) { showHlibPage(i, vol, 0); return; }
  openQuranReader(tafsirShell(t, `<div class="qr-load"><div class="card">${localizedText("Loading")}…</div></div>`));
  const s = document.createElement("script");
  s.src = hlibVolSrc(t.slug, vol);
  s.onload = () => showHlibPage(i, vol, 0);
  s.onerror = () => { const b = el("#qrSheetBody"); if (b) b.innerHTML = tafsirShell(t, `<p class="ev-intro" dir="ltr">${localizedText("This book will be added soon, insha'Allah.")}</p>`); };
  document.body.appendChild(s);
}
function showHlibPage(i, vol, page) {
  const t = HLIB_LIST[i]; if (!t) return;
  const meta = hlibMeta(t.slug);
  const vcount = (meta && meta.vols) ? meta.vols.length : 1;
  const pages = hlibVolPages(t.slug, vol); if (!pages) return;
  const n = pages.length; if (!n) return;
  page = Math.max(0, Math.min(page, n - 1));
  const multiVol = vcount > 1;
  const arHtml = `<div class="taf-page" dir="rtl">${locNum(tafClean(pages[page]), "ar")}</div>`;
  const trLang = State.lang === "ks" ? "ks" : trField();
  const needTr = trLang && trLang !== "ar";
  const failKey = t.slug + "|" + trLang + "|" + vol;
  const trVol = (window.HLIB_TR && window.HLIB_TR[t.slug] && window.HLIB_TR[t.slug][trLang]) ? window.HLIB_TR[t.slug][trLang][vol] : null;
  let trHtml = "";
  if (needTr && trVol) {
    const rtl = ARABIC_SCRIPT_LANGS.includes(State.lang);
    trHtml = `<div class="taf-tr" dir="${rtl ? "rtl" : "ltr"}">${locNum(tafClean(trVol[page] || ""), State.lang)}</div>`;
  } else if (needTr && !_hlibTrFail[failKey]) {
    trHtml = `<div class="taf-tr taf-tr-load" dir="ltr">${localizedText("Loading")}…</div>`;
    if (window._hlibTrLoading !== failKey) {
      window._hlibTrLoading = failKey;
      const s = document.createElement("script");
      s.src = hlibTrVolSrc(t.slug, trLang, vol);
      s.onload = () => { window._hlibTrLoading = null; showHlibPage(i, vol, page); };
      s.onerror = () => { window._hlibTrLoading = null; _hlibTrFail[failKey] = 1; showHlibPage(i, vol, page); };
      document.body.appendChild(s);
    }
  }
  const inner = `
        ${arHtml}
        ${trHtml}
        <div class="taf-pager" dir="ltr">
          <button class="btn taf-nav" ${page <= 0 ? "disabled" : ""} onclick="showHlibPage(${i},${vol},${page - 1})">‹ ${localizedText("Previous")}</button>
          <span class="taf-count">${locNum(page + 1, State.lang)} / ${locNum(n, State.lang)}</span>
          <button class="btn taf-nav" ${page >= n - 1 ? "disabled" : ""} onclick="showHlibPage(${i},${vol},${page + 1})">${localizedText("Next")} ›</button>
        </div>`;
  openQuranReader(tafsirShell(t, inner));
  const b = el("#qrSheetBody"); if (b) b.scrollTop = 0;
}

// ---------- LIFE (the Muslim's life — Qur'an, hadith & explanation) ----------
const LIFE_CATS = [
  { cat: "Faith & the Heart", items: [
    { id: "life-ikhlas", title: "Sincerity (Ikhlas) & Intention (Niyyah)" },
    { id: "life-tawakkul", title: "Reliance on God (Tawakkul)" },
    { id: "life-tawbah", title: "Repentance (Tawbah) & Returning to God" },
    { id: "life-sabr", title: "Patience (Sabr) & Gratitude (Shukr)" },
    { id: "life-khawf", title: "Fear & Hope (Khawf wa Raja)" },
    { id: "life-heart", title: "Purifying the Heart from Its Diseases" },
  ]},
  { cat: "The Major Sins & How to Protect Yourself", items: [
    { id: "life-shirk", title: "Shirk — Associating Partners with God" },
    { id: "life-salah-neglect", title: "Neglecting the Prayer" },
    { id: "life-riba", title: "Riba — Usury & Interest" },
    { id: "life-ghibah", title: "Backbiting (Ghibah) & Guarding the Tongue" },
    { id: "life-lying", title: "Lying & Breaking Trust" },
    { id: "life-zina", title: "Unlawful Relations (Zina) & Lowering the Gaze" },
    { id: "life-alcohol", title: "Alcohol, Drugs & Intoxicants" },
    { id: "life-kibr", title: "Pride, Envy & Showing Off (Riya)" },
    { id: "life-anger", title: "Anger & How to Control It" },
  ]},
  { cat: "Worship & Daily Practice", items: [
    { id: "life-salah", title: "The Five Daily Prayers" },
    { id: "life-fasting", title: "Fasting & Ramadan" },
    { id: "life-zakat", title: "Zakat, Khums & Charity" },
    { id: "life-dhikr", title: "Remembrance of God (Dhikr)" },
    { id: "life-dua", title: "The Etiquette of Supplication (Dua)" },
    { id: "life-quran", title: "Living by the Qur'an" },
  ]},
  { cat: "Family & Relationships", items: [
    { id: "life-parents", title: "The Rights of Parents" },
    { id: "life-marriage", title: "Marriage & Choosing a Spouse" },
    { id: "life-spouse", title: "The Rights of Husband & Wife" },
    { id: "life-children", title: "Raising Righteous Children" },
    { id: "life-rahm", title: "Kinship Ties (Silat al-Rahm)" },
    { id: "life-neighbours", title: "The Rights of Neighbours" },
  ]},
  { cat: "Character & Dealings", items: [
    { id: "life-honesty", title: "Honesty & Trustworthiness" },
    { id: "life-justice", title: "Justice & Fairness" },
    { id: "life-manners", title: "Humility & Good Manners (Akhlaq)" },
    { id: "life-haya", title: "Modesty (Haya) & Dress" },
    { id: "life-forgiveness", title: "Forgiveness & Pardoning" },
    { id: "life-halal", title: "Halal Earning & Avoiding the Haram" },
  ]},
  { cat: "Life Moments & Transitions", items: [
    { id: "life-birth", title: "Birth & the Newborn (Adhan, Aqiqah, Naming)" },
    { id: "life-youth", title: "Youth, Coming of Age & Responsibility" },
    { id: "life-wedding", title: "The Wedding & Building a Home" },
    { id: "life-trials", title: "Hardship, Illness & Trials" },
    { id: "life-death", title: "Death, the Grave & the Hereafter" },
    { id: "life-etiquette", title: "Daily Etiquette (Eating, Sleeping, Travel, Home)" },
  ]},
];
function lifeBar(ci, ii, x) {
  return `
    <button class="option-bar" onclick="openLife(${ci},${ii})">
      <span class="ob-ic">${QURAN_ICON}</span>
      <span class="ob-text"><span class="ob-title">${localizedText(x.title)}</span></span>
      <span class="ob-arrow" aria-hidden="true">›</span>
    </button>`;
}
function renderLife(v) {
  const body = LIFE_CATS.map((c, ci) => `
    <div class="proof-relig"><span class="proof-sym">◆</span> ${localizedText(c.cat)}</div>
    ${c.items.map((x, ii) => lifeBar(ci, ii, x)).join("")}`).join("");
  v.innerHTML = head("nav_life")
    + `<p class="ahlq-intro">${localizedText("A guide for every part of a Muslim's life — faith and the heart, the sins to avoid and how to protect yourself, worship, family, character, and the great moments of life.")}</p>`
    + body;
}
function openLife(ci, ii) {
  const c = LIFE_CATS[ci]; if (!c) return;
  const x = c.items[ii]; if (!x) return;
  const rtl = ARABIC_SCRIPT_LANGS.includes(State.lang);
  const data = (typeof LIFE_DATA !== "undefined" && x.id) ? LIFE_DATA[x.id] : null;
  const quran = (data && Array.isArray(data.quran)) ? data.quran : [];
  const hadith = data ? evList(data.hadith) : [];
  const exp = data ? evList(data.exp) : [];
  const quranHtml = quran.length ? `
        <div class="ev-sec-title">${localizedText("Quranic proofs")}</div>
        ${quran.map((q) => {
          const mm = [...String(q.tr && q.tr.en || "").matchAll(/(\d+):(\d+)(?:-(\d+))?/g)];
          const key = mm.length ? mm[mm.length - 1][0] : "";
          const playBtn = (q.ar && key) ? `<button class="qverse-play" onclick="reciteVerse('${key}', this)" aria-label="${localizedText("Recite")}"><span class="qv-play"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg></span><span class="qv-stop"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg></span></button>` : "";
          return `<div class="proof-verse">
          ${playBtn}
          ${q.ar ? `<div class="ahlq-verse ahlq-verse-sm" dir="rtl" lang="ar">${q.ar}</div>` : ""}
          <div class="proof-ref">${(q.tr && (q.tr[trField() || "en"] || q.tr.en)) || ""}</div>
        </div>`;
        }).join("")}` : "";
  const hadithHtml = hadith.length ? `
        <div class="ev-sec-title">${localizedText("Hadith proofs")}</div>
        ${hadith.map((s) => `<div class="proof-ref">${s}</div>`).join("")}` : "";
  const expHtml = exp.length ? `
        <div class="ev-sec-title">${localizedText("Explanation")}</div>
        <div class="ahlq-content">${exp.map((s) => `<p>${s}</p>`).join("")}</div>` : "";
  openQuranReader(`
    <div class="q-reader">
      <div class="qr-topbar">
        <button class="dua-back" onclick="history.back()" aria-label="${localizedText("Back")}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg></button>
        <span class="qr-title">${localizedText(x.title)}</span>
      </div>
      <div class="qr-body" dir="${rtl ? "rtl" : "ltr"}">
        ${quranHtml}
        ${hadithHtml}
        ${expHtml}
        <div class="ahlq-sign">${localizedText("Explanation by")} <strong>Al-Wilayat</strong></div>
      </div>
    </div>`);
}

// ---------- SCIENCE (scientific signs in Qur'an & the Imams' hadith) ----------
// Data lives in web/js/science.js (var SCIENCE_DATA). Bars grouped by theme.
const SCIENCE_CATS = [
  { cat: "The Universe & the Cosmos", items: [
    { id: "sci-bigbang", title: "The Big Bang — the parting of the heavens & earth" },
    { id: "sci-expanding", title: "The Expanding Universe" },
    { id: "sci-multiverse", title: "The Multiverse — a thousand thousand worlds" },
    { id: "sci-orbits", title: "Celestial Orbits & the Moving Sun" },
    { id: "sci-iron", title: "Iron Sent Down from the Sky" },
    { id: "sci-sevenheavens", title: "The Seven Heavens in Layers" },
    { id: "sci-moonlight", title: "The Sun's Light & the Moon's Reflected Light" },
    { id: "sci-smoke", title: "The Heaven Was Smoke (Gas & Dust)" },
    { id: "sci-blackholes", title: "The Hidden, Sweeping Stars (Black Holes)" },
  ]},
  { cat: "Life & the Human Being", items: [
    { id: "sci-water", title: "The Origin of Life from Water" },
    { id: "sci-embryo", title: "The Stages of the Human Embryo" },
    { id: "sci-fingerprints", title: "Fingerprints" },
    { id: "sci-pain", title: "Pain Receptors in the Skin" },
    { id: "sci-pairs", title: "Everything Created in Pairs" },
    { id: "sci-gender", title: "The Child's Sex from the Male's Drop" },
    { id: "sci-milk", title: "How Milk Is Formed (Between Blood & Food)" },
    { id: "sci-honey", title: "Honey as a Healing" },
    { id: "sci-bee", title: "The Worker Bees Are Female" },
  ]},
  { cat: "The Earth, Seas & Mountains", items: [
    { id: "sci-mountains", title: "Mountains as Pegs" },
    { id: "sci-seas", title: "The Barrier Between the Two Seas" },
    { id: "sci-sky", title: "The Sky as a Protected Roof" },
    { id: "sci-round", title: "The Round Earth & the Wrapping of Night & Day" },
    { id: "sci-winds", title: "The Fertilising Winds" },
    { id: "sci-lowestland", title: "The Lowest Land on Earth" },
  ]},
  { cat: "Matter, Atoms & Time", items: [
    { id: "sci-atom", title: "The Atom & What Is Smaller" },
    { id: "sci-time", title: "The Relativity of Time" },
    { id: "sci-glorify", title: "All Things Vibrate in Glorification" },
  ]},
  { cat: "Quantum Physics & the Unseen", items: [
    { id: "sci-ghayb", title: "The Unseen Reality (al-Ghayb)" },
    { id: "sci-waveparticle", title: "Wave–Particle Duality" },
    { id: "sci-entanglement", title: "Quantum Entanglement — Action at a Distance" },
    { id: "sci-observer", title: "The Observer & the Ever-Witnessing (al-Shahid)" },
  ]},
];
function scienceBar(ci, ii, s) {
  return `
    <button class="option-bar" onclick="openScience(${ci},${ii})">
      <span class="ob-ic">${QURAN_ICON}</span>
      <span class="ob-text"><span class="ob-title">${localizedText(s.title)}</span></span>
      <span class="ob-arrow" aria-hidden="true">›</span>
    </button>`;
}
function renderScience(v) {
  const body = SCIENCE_CATS.map((c, ci) => `
    <div class="proof-relig"><span class="proof-sym">◆</span> ${localizedText(c.cat)}</div>
    ${c.items.map((s, ii) => scienceBar(ci, ii, s)).join("")}`).join("");
  v.innerHTML = head("nav_science")
    + `<p class="ahlq-intro">${localizedText("The truths of modern science foretold in the Qur'an and the teachings of the Imams of the Ahl al-Bait, centuries before their discovery.")}</p>`
    + body;
}
function openScience(ci, ii) {
  const c = SCIENCE_CATS[ci]; if (!c) return;
  const s = c.items[ii]; if (!s) return;
  const rtl = ARABIC_SCRIPT_LANGS.includes(State.lang);
  const data = (typeof SCIENCE_DATA !== "undefined" && s.id) ? SCIENCE_DATA[s.id] : null;
  const refs = data ? evList(data.refs) : [];
  const context = data ? evList(data.context) : [];
  const refsHtml = refs.length ? `
        <div class="ev-sec-title">${localizedText("Verse & narrations")}</div>
        ${refs.map((x) => `<div class="proof-ref">${x}</div>`).join("")}` : "";
  const ctxHtml = context.length ? `
        <div class="ev-sec-title">${localizedText("The science & explanation")}</div>
        <div class="ahlq-content">${context.map((x) => `<p>${x}</p>`).join("")}</div>` : "";
  // recitation audio for the main Qur'anic verse (surah:ayah taken from aref)
  const km = (data && data.aref) ? String(data.aref).match(/(\d+):(\d+)/) : null;
  const key = km ? km[0] : "";
  const playBtn = (data && data.arabic && key) ? `<button class="qverse-play" onclick="reciteVerse('${key}', this)" aria-label="${localizedText("Recite")}"><span class="qv-play"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg></span><span class="qv-stop"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg></span></button>` : "";
  openQuranReader(`
    <div class="q-reader">
      <div class="qr-topbar">
        <button class="dua-back" onclick="history.back()" aria-label="${localizedText("Back")}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg></button>
        <span class="qr-title">${localizedText(s.title)}</span>
      </div>
      <div class="qr-body" dir="${rtl ? "rtl" : "ltr"}">
        ${data ? `<div class="proof-verse">
          ${playBtn}
          <div class="ahlq-verse ahlq-verse-sm" dir="rtl" lang="ar">${data.arabic}</div>
          <div class="proof-ref" style="text-align:center">${data.aref}</div>
        </div>` : ""}
        ${refsHtml}
        ${ctxHtml}
        <div class="ahlq-sign">${localizedText("Explanation by")} <strong>Al-Wilayat</strong></div>
      </div>
    </div>`);
}

// ---------- HOLY BOOKS (previously revealed heavenly scriptures, KJV) ----------
// Box → book bars → chapter reader (English base + your-language translation).
const HOLYBOOKS_LIST = [
  { id: "hb-tawrat", name: "Tawrat (Torah)", desc: "The five books of Moses", books: ["genesis", "exodus", "leviticus", "numbers", "deuteronomy"] },
  { id: "hb-zabur",  name: "Zabur (Psalms)", desc: "The Psalms of Prophet Dawud (a.s.)", books: ["psalms"] },
  { id: "hb-injil",  name: "Injil (Gospel)", desc: "The four Gospels", books: ["matthew", "mark", "luke", "john"] },
  { id: "hb-ot",     name: "Old Testament",  desc: "The Hebrew Bible — 39 books", filter: "ot" },
  { id: "hb-nt",     name: "New Testament",  desc: "The Christian scriptures — 27 books", filter: "nt" },
];
const HOLY_V = "20260803-holy2";
const holyManifestSrc = () => "js/holy_manifest.js?v=" + HOLY_V;
const holyBookSrc = (slug) => "js/holy_" + slug + ".js?v=" + HOLY_V;
const holyTrSrc = (slug, lang) => "js/holy_" + slug + "_" + lang + ".js?v=" + HOLY_V;
// Holy Books' base text is English; every other language shows a translation.
const holyTrLang = () => ({ en: null, sg: null, ar: "ar", ur: "ur", ks: "ks", fa: "fa", az: "az", ms: "ms" }[State.lang] ?? null);
let _holyTrFail = {}, _holyReading = false, _holyOpenIdx = 0;

function holyBoxes(list) {
  return list.map((t, i) => `
    <button class="ev-box" onclick="openHolyBook(${i})">
      <span class="ev-num">${i + 1}</span>
      <span class="ev-name">${localizedText(t.name)}</span>
      <span class="ev-date">${localizedText(t.desc)}</span>
    </button>`).join("");
}
function renderHolyBooks(v) {
  v.innerHTML = head("nav_holy")
    + `<p class="ahlq-intro">${localizedText("The previously revealed heavenly scriptures — for study and comparison.")}</p>`
    + `<div class="jr-grid">${holyBoxes(HOLYBOOKS_LIST)}</div>`;
}
function holyShell(box, inner) {
  return `
    <div class="q-reader">
      <div class="qr-topbar">
        <button class="dua-back" onclick="history.back()" aria-label="${localizedText("Back")}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg></button>
        <span class="qr-title">${localizedText(box.name)}</span>
      </div>
      <div class="qr-body">${inner}</div>
    </div>`;
}
function holyBoxList(i) {
  const box = HOLYBOOKS_LIST[i]; const all = window.HB_BOOKS || [];
  if (box.filter) return all.filter((b) => b.t === box.filter);
  return (box.books || []).map((s) => all.find((b) => b.slug === s)).filter(Boolean);
}
function openHolyBook(i) {
  const box = HOLYBOOKS_LIST[i]; if (!box) return;
  if (window.HB_BOOKS) { showHolyBooks(i); return; }
  openQuranReader(holyShell(box, `<div class="qr-load"><div class="card">${localizedText("Loading")}…</div></div>`));
  const s = document.createElement("script");
  s.src = holyManifestSrc();
  s.onload = () => showHolyBooks(i);
  s.onerror = () => { const b = el("#qrSheetBody"); if (b) b.innerHTML = holyShell(box, `<p class="ev-intro" dir="ltr">${localizedText("This will be added soon, insha'Allah.")}</p>`); };
  document.body.appendChild(s);
}
function showHolyBooks(i) {
  const box = HOLYBOOKS_LIST[i]; if (!box) return;
  _holyOpenIdx = i; _holyReading = false;
  const bars = holyBoxList(i).map((b) => `
    <button class="option-bar" onclick="openHolyReader('${b.slug}',${i})">
      <span class="ob-ic">${QURAN_ICON}</span>
      <span class="ob-text"><span class="ob-title">${b.name}</span><span class="ob-sub">${locNum(b.ch, State.lang)} ${localizedText("chapters")}</span></span>
      <span class="ob-arrow" aria-hidden="true">›</span>
    </button>`).join("");
  openQuranReader(holyShell(box, `<div>${bars}</div>`));
  const b = el("#qrSheetBody"); if (b) b.scrollTop = 0;
}
function openHolyReader(slug, boxIdx) {
  _holyReading = true; _holyOpenIdx = boxIdx;
  history.pushState({ wilayat: true, route: State.route, index: _navIndex, qrOpen: true, tafRead: 1 }, "", location.href);
  if (window.HB_DATA && window.HB_DATA[slug]) { showHolyPage(slug, 0); return; }
  const box = HOLYBOOKS_LIST[boxIdx];
  openQuranReader(holyShell(box, `<div class="qr-load"><div class="card">${localizedText("Loading")}…</div></div>`));
  const s = document.createElement("script");
  s.src = holyBookSrc(slug);
  s.onload = () => showHolyPage(slug, 0);
  s.onerror = () => { const b = el("#qrSheetBody"); if (b) b.innerHTML = holyShell(box, `<p class="ev-intro" dir="ltr">${localizedText("This will be added soon, insha'Allah.")}</p>`); };
  document.body.appendChild(s);
}
function holyClean(s) {
  s = escapeHtml(String(s || ""));
  s = s.replace(/(^|\n)(\d+)\.\s*/g, '$1<span class="taf-num">$2</span> ');
  return s.replace(/\n/g, "<br>");
}
function showHolyPage(slug, page) {
  const bk = (window.HB_BOOKS || []).find((b) => b.slug === slug); if (!bk) return;
  const box = HOLYBOOKS_LIST[_holyOpenIdx] || HOLYBOOKS_LIST[0];
  const pages = (window.HB_DATA || {})[slug] || [];
  const n = pages.length; if (!n) return;
  page = Math.max(0, Math.min(page, n - 1));
  const enHtml = `<div class="taf-page" dir="ltr" style="text-align:left;font-family:inherit;font-size:16px">${holyClean(pages[page])}</div>`;

  const trLang = holyTrLang();
  const needTr = !!trLang;
  const failKey = slug + "|" + trLang;
  const trVol = (window.HB_TR && window.HB_TR[slug] && window.HB_TR[slug][trLang]) ? window.HB_TR[slug][trLang] : null;
  let trHtml = "";
  if (needTr && trVol) {
    const rtl = ARABIC_SCRIPT_LANGS.includes(State.lang);
    trHtml = `<div class="taf-tr" dir="${rtl ? "rtl" : "ltr"}">${locNum(holyClean(trVol[page] || ""), State.lang)}</div>`;
  } else if (needTr && !_holyTrFail[failKey]) {
    trHtml = `<div class="taf-tr taf-tr-load" dir="ltr">${localizedText("Loading")}…</div>`;
    if (window._holyTrLoading !== failKey) {
      window._holyTrLoading = failKey;
      const s = document.createElement("script");
      s.src = holyTrSrc(slug, trLang);
      s.onload = () => { window._holyTrLoading = null; showHolyPage(slug, page); };
      s.onerror = () => { window._holyTrLoading = null; _holyTrFail[failKey] = 1; showHolyPage(slug, page); };
      document.body.appendChild(s);
    }
  }
  const inner = `
        <div class="ev-sec-title" style="text-align:center;margin-bottom:12px">${bk.name} · ${localizedText("Chapter")} ${locNum(page + 1, State.lang)}</div>
        ${enHtml}
        ${trHtml}
        <div class="taf-pager" dir="ltr">
          <button class="btn taf-nav" ${page <= 0 ? "disabled" : ""} onclick="showHolyPage('${slug}',${page - 1})">‹ ${localizedText("Previous")}</button>
          <span class="taf-count">${locNum(page + 1, State.lang)} / ${locNum(n, State.lang)}</span>
          <button class="btn taf-nav" ${page >= n - 1 ? "disabled" : ""} onclick="showHolyPage('${slug}',${page + 1})">${localizedText("Next")} ›</button>
        </div>`;
  openQuranReader(holyShell(box, inner));
  const b = el("#qrSheetBody"); if (b) b.scrollTop = 0;
}

// ---------- PROOFS (signs in other religions' scriptures) ----------
// Religion headings, each with proof bars. Bar content (the scriptural proof +
// explanation, in 7 languages) is filled on command.
// Religion symbols as SVG so all render at one identical size (glyph fonts don't).
const SYM_STAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><polygon points="12 3 3.5 18 20.5 18"/><polygon points="12 21 3.5 6 20.5 6"/></svg>';
const SYM_CROSS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="2" x2="12" y2="22"/><line x1="6" y1="8" x2="18" y2="8"/></svg>';
const SYM_WHEEL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.2"/><line x1="14.2" y1="12" x2="21" y2="12"/><line x1="13.56" y1="13.56" x2="18.36" y2="18.36"/><line x1="12" y1="14.2" x2="12" y2="21"/><line x1="10.44" y1="13.56" x2="5.64" y2="18.36"/><line x1="9.8" y1="12" x2="3" y2="12"/><line x1="10.44" y1="10.44" x2="5.64" y2="5.64"/><line x1="12" y1="9.8" x2="12" y2="3"/><line x1="13.56" y1="10.44" x2="18.36" y2="5.64"/></svg>';
const SYM_OM = '<svg viewBox="0 0 24 24" aria-hidden="true"><text x="12" y="18.5" text-anchor="middle" font-size="21" font-family="\'Noto Sans Devanagari\',sans-serif" fill="currentColor">ॐ</text></svg>';

const PROOF_RELIGIONS = [
  { religion: "Judaism", symbol: SYM_STAR, items: [
    { id: "jud-muhammad", title: "The coming of Prophet Muhammad ﷺ" },
    { id: "jud-twelve", title: "The twelve great leaders (from the line of Ishmael)" },
    { id: "jud-karbala", title: "Karbala and the sacrifice of Imam al-Husayn (a.s.)" },
    { id: "jud-palestine", title: "The land of Palestine" },
  ]},
  { religion: "Christianity", symbol: SYM_CROSS, items: [
    { id: "chr-muhammad", title: "The coming of Prophet Muhammad ﷺ (the Paraclete / Ahmad)" },
    { id: "chr-twelve", title: "The twelve leaders after the Prophet" },
    { id: "chr-karbala", title: "Karbala and the sacrifice of Imam al-Husayn (a.s.)" },
    { id: "chr-palestine", title: "The land of Palestine" },
  ]},
  { religion: "Hinduism", symbol: SYM_OM, items: [
    { id: "hin-muhammad", title: "The coming of Prophet Muhammad ﷺ (Bhavishya Purana)" },
    { id: "hin-imams", title: "The awaited guides and the Imams" },
    { id: "hin-karbala", title: "Karbala and the sacrifice of Imam al-Husayn (a.s.)" },
  ]},
  { religion: "Buddhism", symbol: SYM_WHEEL, items: [
    { id: "bud-muhammad", title: "The awaited Maitreya — Prophet Muhammad ﷺ" },
    { id: "bud-guide", title: "The coming guide of the world" },
  ]},
];
function proofBar(ri, ii, p) {
  return `
    <button class="option-bar" onclick="openProof(${ri},${ii})">
      <span class="ob-ic">${QURAN_ICON}</span>
      <span class="ob-text"><span class="ob-title">${localizedText(p.title)}</span></span>
      <span class="ob-arrow" aria-hidden="true">›</span>
    </button>`;
}
function renderProofs(v) {
  const body = PROOF_RELIGIONS.map((r, ri) => `
    <div class="proof-relig"><span class="proof-sym ${r.religion === "Hinduism" ? "proof-sym-om" : ""}">${r.symbol}</span> ${localizedText(r.religion)}</div>
    ${r.items.map((p, ii) => proofBar(ri, ii, p)).join("")}`).join("");
  v.innerHTML = head("nav_proofs")
    + `<p class="ahlq-intro">${localizedText("Signs and prophecies of the truths of Shia Islam — the leadership of the twelve Imams, the sacrifice of Karbala, the coming of Prophet Muhammad ﷺ, and the land of Palestine — as found in the scriptures of other religions.")}</p>`
    + body;
}
function openProof(ri, ii) {
  const r = PROOF_RELIGIONS[ri]; if (!r) return;
  const p = r.items[ii]; if (!p) return;
  const rtl = ARABIC_SCRIPT_LANGS.includes(State.lang);
  const data = (typeof PROOFS_DATA !== "undefined" && p.id) ? PROOFS_DATA[p.id] : null;
  const refs = data ? evList(data.refs) : [];
  const context = data ? evList(data.context) : [];
  const refsHtml = refs.length ? `
        <div class="ev-sec-title">${localizedText("The reference")}</div>
        ${refs.map((s) => `<div class="proof-ref">${s}</div>`).join("")}` : "";
  const ctxHtml = context.length ? `
        <div class="ev-sec-title">${localizedText("Context & explanation")}</div>
        <div class="ahlq-content">${context.map((s) => `<p>${s}</p>`).join("")}</div>` : "";
  openQuranReader(`
    <div class="q-reader">
      <div class="qr-topbar">
        <button class="dua-back" onclick="history.back()" aria-label="${localizedText("Back")}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg></button>
        <span class="qr-title">${localizedText(p.title)}</span>
      </div>
      <div class="qr-body" dir="${rtl ? "rtl" : "ltr"}">
        <div class="ahlq-ref" style="text-align:center;margin-bottom:18px"><span class="proof-sym">${r.symbol}</span> ${localizedText(r.religion)}</div>
        ${refsHtml}
        ${ctxHtml}
        <div class="ahlq-sign">${localizedText("Explanation by")} <strong>Al-Wilayat</strong></div>
      </div>
    </div>`);
}

// ---------- JOURNEY (sacred ziyarat & pilgrimage journeys) ----------
const JOURNEY_LIST = [
  { id: "jr-arbaeen", name: "Arba'een Walk", place: "Karbala", date: "20 Safar" },
  { id: "jr-ashura", name: "Ashura Ziyarat", place: "Karbala", date: "10 Muharram" },
  { id: "jr-ghadir", name: "Eid al-Ghadir", place: "Najaf", date: "18 Dhu al-Hijjah" },
  { id: "jr-arafah", name: "Arafah", place: "Karbala & Makkah", date: "9 Dhu al-Hijjah" },
  { id: "jr-qadr", name: "Laylat al-Qadr", place: "Najaf & Karbala", date: "Ramadan" },
  { id: "jr-mahdi", name: "Birth of Imam al-Mahdi (a.s.)", place: "Jamkaran Mosque", date: "15 Sha'ban" },
  { id: "jr-ali", name: "Martyrdom of Imam Ali (a.s.)", place: "Imam Ali Shrine, Najaf" },
  { id: "jr-husayn", name: "Martyrdom of Imam Husayn (a.s.)", place: "Imam Husayn Shrine, Karbala" },
  { id: "jr-askari", name: "Martyrdom of Imam Hasan al-Askari (a.s.)", place: "Al-Askari Shrine, Samarra" },
  { id: "jr-ridha", name: "Birth & martyrdom of Imam al-Ridha (a.s.)", place: "Imam Reza Shrine, Mashhad" },
  { id: "jr-masumah", name: "Birth & martyrdom of Lady Fatimah al-Ma'sumah (a.s.)", place: "Shrine of Fatima Masumeh, Qom" },
  { id: "jr-atabat", name: "Pilgrimage to the shrines of the Imams in Iraq", place: "Atabat — Najaf, Karbala, Kadhimayn & Samarra" },
];
function journeyBoxes(list) {
  return list.map((j, i) => `
    <button class="ev-box" onclick="openJourney(${i})">
      <span class="ev-num">${i + 1}</span>
      <span class="ev-name">${localizedText(j.name)}</span>
      <span class="ev-date">${localizedText(j.place)}${j.date ? ` · ${localizedText(j.date)}` : ""}</span>
    </button>`).join("");
}
function renderJourney(v) {
  v.innerHTML = head("nav_journey")
    + `<p class="ahlq-intro">${localizedText("Sacred ziyarat and pilgrimage journeys of the followers of the Ahl al-Bait.")}</p>`
    + `<div class="jr-grid">${journeyBoxes(JOURNEY_LIST)}</div>`;
}
function openJourney(i) {
  const j = JOURNEY_LIST[i]; if (!j) return;
  const rtl = ARABIC_SCRIPT_LANGS.includes(State.lang);
  const data = (typeof JOURNEY_DATA !== "undefined" && j.id) ? JOURNEY_DATA[j.id] : null;
  const intro = data ? evF(data.intro) : "";
  const steps = data ? evList(data.steps) : [];
  const recite = data ? evList(data.recite) : [];
  const prayer = (data && data.prayer) ? evF(data.prayer) : "";
  const acts = data ? evList(data.acts) : [];
  const sec = (title, inner) => `<div class="ev-sec-title">${localizedText(title)}</div>${inner}`;
  const stepsHtml = steps.length ? sec("What to do — step by step", `<ol class="ev-steps">${steps.map((s) => `<li>${s}</li>`).join("")}</ol>`) : "";
  const reciteHtml = recite.length ? sec("What to recite", `<ul class="ev-acts">${recite.map((s) => `<li>${s}</li>`).join("")}</ul>`) : "";
  const prayerHtml = prayer ? sec("How to perform the prayer", `<div class="ev-prayer">${prayer}</div>`) : "";
  const actsHtml = acts.length ? sec("Etiquette & activities", `<ul class="ev-acts">${acts.map((s) => `<li>${s}</li>`).join("")}</ul>`) : "";
  openQuranReader(`
    <div class="q-reader">
      <div class="qr-topbar">
        <button class="dua-back" onclick="history.back()" aria-label="${localizedText("Back")}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg></button>
        <span class="qr-title">${localizedText(j.name)}</span>
      </div>
      <div class="qr-body" dir="${rtl ? "rtl" : "ltr"}">
        <div class="ahlq-ref" style="text-align:center;margin-bottom:6px">${localizedText(j.place)}</div>
        ${j.date ? `<div class="ahlq-ref" style="text-align:center;margin-bottom:16px">${localizedText(j.date)}</div>` : ""}
        ${intro ? `<p class="ev-intro">${intro}</p>` : ""}
        ${stepsHtml}
        ${reciteHtml}
        ${prayerHtml}
        ${actsHtml}
        <div class="ahlq-sign">${localizedText("Explanation by")} <strong>Al-Wilayat</strong></div>
      </div>
    </div>`);
}

// ---------- EVENTS (Shia calendar of occasions) ----------
// Grouped like the Stories boxes. Names carry their honorifics inline. Dates
// (where given) show under the name. Tapping a box opens a slide-up detail sheet.
const EVENT_CATS = [
  { title: "Major celebrations (Eid and Wiladah)", items: [
    { id: "eid-fitr", name: "Eid al-Fitr", date: "1 Shawwal" },
    { id: "eid-adha", name: "Eid al-Adha", date: "10 Dhu al-Hijjah" },
    { id: "eid-ghadir", name: "Eid al-Ghadir", date: "18 Dhu al-Hijjah" },
    { id: "eid-mubahalah", name: "Eid al-Mubahalah", date: "24 Dhu al-Hijjah" },
    { id: "eid-mabath", name: "Eid al-Mab'ath — Beginning of the Prophet's mission", date: "27 Rajab" },
  ]},
  { title: "Birth anniversaries (Wiladah)", items: [
    { id: "wl-prophet", name: "Prophet Muhammad ﷺ" },
    { id: "wl-ali", name: "Imam Ali (a.s.)" },
    { id: "wl-fatimah", name: "Lady Fatimah al-Zahra (a.s.)" },
    { id: "wl-hasan", name: "Imam Hasan (a.s.)" },
    { id: "wl-husayn", name: "Imam Husayn (a.s.)" },
    { id: "wl-sajjad", name: "Imam Zayn al-Abidin (a.s.)" },
    { id: "wl-baqir", name: "Imam Muhammad al-Baqir (a.s.)" },
    { id: "wl-sadiq", name: "Imam Ja'far al-Sadiq (a.s.)" },
    { id: "wl-kazim", name: "Imam Musa al-Kazim (a.s.)" },
    { id: "wl-ridha", name: "Imam Ali al-Ridha (a.s.)" },
    { id: "wl-jawad", name: "Imam Muhammad al-Jawad (a.s.)" },
    { id: "wl-hadi", name: "Imam Ali al-Hadi (a.s.)" },
    { id: "wl-askari", name: "Imam Hasan al-Askari (a.s.)" },
    { id: "wl-mahdi", name: "Imam al-Mahdi (a.j.)" },
  ]},
  { title: "Days of mourning (Shahadah)", items: [
    { id: "sh-prophet", name: "Passing of the Prophet Muhammad ﷺ" },
    { id: "sh-fatimah", name: "Martyrdom of Lady Fatimah al-Zahra (a.s.)" },
    { id: "sh-ali", name: "Martyrdom of Imam Ali (a.s.)" },
    { id: "sh-hasan", name: "Martyrdom of Imam Hasan (a.s.)" },
    { id: "sh-ashura", name: "Ashura — Martyrdom of Imam Husayn (a.s.)", date: "10 Muharram" },
    { id: "sh-arbaeen", name: "Arba'een", date: "20 Safar" },
    { id: "sh-sajjad", name: "Martyrdom of Imam Zayn al-Abidin (a.s.)" },
    { id: "sh-baqir", name: "Martyrdom of Imam Muhammad al-Baqir (a.s.)" },
    { id: "sh-sadiq", name: "Martyrdom of Imam Ja'far al-Sadiq (a.s.)" },
    { id: "sh-kazim", name: "Martyrdom of Imam Musa al-Kazim (a.s.)" },
    { id: "sh-ridha", name: "Martyrdom of Imam Ali al-Ridha (a.s.)" },
    { id: "sh-jawad", name: "Martyrdom of Imam Muhammad al-Jawad (a.s.)" },
    { id: "sh-hadi", name: "Martyrdom of Imam Ali al-Hadi (a.s.)" },
    { id: "sh-askari", name: "Martyrdom of Imam Hasan al-Askari (a.s.)" },
  ]},
  { title: "Other important nights and occasions", items: [
    { id: "oc-qadr", name: "Laylat al-Qadr", date: "19th, 21st & 23rd of Ramadan" },
    { id: "oc-qadr-nights", name: "Nights of Qadr — especially the 23rd night" },
    { id: "oc-arafah", name: "Arafah", date: "9 Dhu al-Hijjah" },
    { id: "oc-new-year", name: "First of Muharram — Islamic New Year", date: "1 Muharram" },
    { id: "oc-muharram", name: "Month of Muharram — mourning period" },
    { id: "oc-safar", name: "Month of Safar — continued mourning" },
    { id: "oc-nisf-shaban", name: "Nisf Sha'ban — Birth of Imam al-Mahdi (a.j.) & a night of worship", date: "15 Sha'ban" },
  ]},
];
function eventBoxes(items, ci, start) {
  return items.map((e, ii) => `
    <button class="ev-box" onclick="openEvent(${ci},${ii})">
      <span class="ev-num">${start + ii}</span>
      <span class="ev-name">${localizedText(e.name)}</span>
      ${e.date ? `<span class="ev-date">${localizedText(e.date)}</span>` : ""}
    </button>`).join("");
}
function renderEvents(v) {
  let n = 1;
  const cats = EVENT_CATS.map((c, ci) => {
    const boxes = eventBoxes(c.items, ci, n);
    n += c.items.length;
    return `<div class="ev-cat">${localizedText(c.title)}</div>
      <div class="ev-scroll">${boxes}</div>`;
  }).join("");
  v.innerHTML = head("nav_events") + `<div id="eventsBody">${cats}</div>`;
}
const evF = (o) => (o && (o[trField() || "en"] || o.en)) || "";
const evList = (o) => (o && (o[trField() || "en"] || o.en)) || [];
function openEvent(ci, ii) {
  const c = EVENT_CATS[ci]; if (!c) return;
  const e = c.items[ii]; if (!e) return;
  const rtl = ARABIC_SCRIPT_LANGS.includes(State.lang);
  const data = (typeof EVENTS_DATA !== "undefined" && e.id) ? EVENTS_DATA[e.id] : null;
  const intro = data ? evF(data.intro) : "";
  const steps = data ? evList(data.steps) : [];
  const acts = data ? evList(data.acts) : [];
  const prayer = (data && data.prayer) ? evF(data.prayer) : "";
  const stepsHtml = steps.length ? `
        <div class="ev-sec-title">${localizedText("How to observe it — step by step")}</div>
        <ol class="ev-steps">${steps.map((s) => `<li>${s}</li>`).join("")}</ol>` : "";
  const prayerHtml = prayer ? `
        <div class="ev-sec-title">${localizedText("How to perform the prayer")}</div>
        <div class="ev-prayer">${prayer}</div>` : "";
  const actsHtml = acts.length ? `
        <div class="ev-sec-title">${localizedText("Recommended acts & activities")}</div>
        <ul class="ev-acts">${acts.map((a) => `<li>${a}</li>`).join("")}</ul>` : "";
  openQuranReader(`
    <div class="q-reader">
      <div class="qr-topbar">
        <button class="dua-back" onclick="history.back()" aria-label="${localizedText("Back")}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg></button>
        <span class="qr-title">${localizedText(e.name)}</span>
      </div>
      <div class="qr-body" dir="${rtl ? "rtl" : "ltr"}">
        ${e.date ? `<div class="ahlq-ref" style="text-align:center;margin-bottom:16px">${localizedText(e.date)}</div>` : ""}
        ${intro ? `<p class="ev-intro">${intro}</p>` : ""}
        ${stepsHtml}
        ${prayerHtml}
        ${actsHtml}
        <div class="ahlq-sign">${localizedText("Explanation by")} <strong>Al-Wilayat</strong></div>
      </div>
    </div>`);
}

// ---------- AHL AL-BAIT IN THE QURAN ----------
// Data lives in web/js/ahlquran.js (var AHL_PROOFS) — the ten Quranic proofs for
// the Ahl al-Bait and their leadership, with verse + 7-language explanation.
const ahlProofs = () => (typeof AHL_PROOFS !== "undefined" ? AHL_PROOFS : []);
// Pick the field for the current language from an {en,ar,ur,fa,az,ms} object.
const apF = (o) => (o && (o[trField() || "en"] || o.en)) || "";
const QURAN_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/></svg>';
function ahlProofBar(p, i) {
  return `
    <button class="option-bar" onclick="openAhlProof('${p.id}')">
      <span class="ob-ic">${QURAN_ICON}</span>
      <span class="ob-text">
        <span class="ob-title">${i + 1}. ${apF(p.name)}</span>
        <span class="ob-sub">${p.ref}</span>
      </span>
      <span class="ob-arrow" aria-hidden="true">›</span>
    </button>`;
}
function renderAhlQuran(v) {
  v.innerHTML = head("title_ahlquran")
    + `<p class="ahlq-intro">${localizedText("The clearest proofs in the Qur'an for the Ahl al-Bait and their divinely-appointed leadership.")}</p>`
    + ahlProofs().map((p, i) => ahlProofBar(p, i)).join("");
}
function ahlProofHTML(p) {
  const rtl = ARABIC_SCRIPT_LANGS.includes(State.lang);
  const num = ahlProofs().findIndex((x) => x.id === p.id) + 1;
  const exp = (p.exp && (p.exp[trField() || "en"] || p.exp.en)) || [];
  const verseTr = apF(p.verseTr);
  const paras = exp.map((para) => `<p>${para}</p>`).join("");
  // recitation audio for the proof's Qur'anic verse (surah:ayah from the ref)
  const km = (p.ref || "").match(/(\d+):(\d+)/);
  const key = km ? km[0] : "";
  const playBtn = (p.verse && key) ? `<button class="qverse-play" onclick="reciteVerse('${key}', this)" aria-label="${localizedText("Recite")}"><span class="qv-play"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg></span><span class="qv-stop"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg></span></button>` : "";
  return `
    <div class="q-reader ahlq-reader">
      <div class="qr-topbar">
        <button class="dua-back" onclick="history.back()" aria-label="${localizedText("Back")}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg></button>
        <span class="qr-title">${num}. ${apF(p.name)}</span>
      </div>
      <div class="qr-body" dir="${rtl ? "rtl" : "ltr"}">
        <div class="ahlq-head">
          <div class="ahlq-arname" dir="rtl" lang="ar">${p.arabicName}</div>
          <div class="ahlq-ref">${p.ref}</div>
        </div>
        <div class="proof-verse">
          ${playBtn}
          <div class="ahlq-verse ahlq-verse-sm" dir="rtl" lang="ar">${p.verse}</div>
        </div>
        ${verseTr ? `<div class="ahlq-versetr">${verseTr}</div>` : ""}
        <div class="ahlq-content">${paras}</div>
        <div class="ahlq-sign">${localizedText("Explanation by")} <strong>Al-Wilayat</strong></div>
      </div>
    </div>`;
}
function openAhlProof(id) {
  const p = ahlProofs().find((x) => x.id === id);
  if (!p) return;
  openQuranReader(ahlProofHTML(p));
}
const routeFor = (id) => (id === "ahlulbayt" ? "ahlulbayt" : id);
const ARABIC_SCRIPT_LANGS = ["ar", "ur", "fa", "ks"];
// Latin-script langs: untranslated phrases stay English instead of blank.
const EN_LIKE_LANGS = ["en", "az", "ms"];
const ARABIC_RE = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/;
const isArabicScript = (s) => ARABIC_RE.test(s || "");
const localizedText = (str) => localizeStr(str || "");
const selectedText = (str) => {
  const raw = str || "";
  const out = localizedText(raw);
  return (EN_LIKE_LANGS.includes(State.lang) || out !== raw) ? out : "";
};
const localizedName = (p) => {
  if (!p) return "";
  if (p[State.lang]) return p[State.lang];
  if (State.lang === "ar") return p.ar || selectedText(p.en) || "";
  return selectedText(p.en || "");
};
const langName = (p) => localizedName(p);
// Main panel titles follow the selected language; the right-side .ar title stays Arabic.
const disp = (en, ar, fallback = "") => (State.lang === "ar"
  ? (ar || selectedText(en) || fallback)
  : (selectedText(en) || fallback));
const plain = (str) => (str || "").replace(/\s+/g, " ").trim();
const sameText = (a, b) => plain(a) === plain(b);
const sideArabic = (ar, main = "") => {
  // Suppress the side Arabic when it duplicates the main title or the main is
  // already Arabic script (any Arabic-script UI language) — avoids Arabic twice.
  if (!ar || State.lang === "ar" || sameText(ar, main) || isArabicScript(main)) return "";
  return `<div class="ar">${ar}</div>`;
};
const quranListTitle = (s) => {
  const title = disp(s.en, s.ar);
  if (title) return title;
  return `${t("surah")} ${s.n}`;
};
const translatedOrEmpty = (str) => {
  const out = localizedText(str || "");
  return (EN_LIKE_LANGS.includes(State.lang) || out !== (str || "")) ? out : "";
};
const translatedContent = (str) => translatedOrEmpty(str);
// Hadith translation in the current language: use the stored per-language field
// (ur/fa/az/ms — Kashmiri→ur, Dari→fa) when available; otherwise the English.
// The Arabic original (h.ar) is never changed.
function hadithTrans(h) {
  // Kashmiri has its own real translation; fall back to Urdu, then English.
  if (State.lang === "ks" && h && h.ks) return h.ks;
  const f = trField();                       // "ur" | "fa" | "az" | "ms" | "en" | null
  if (f && f !== "en" && h && h[f]) return h[f];
  return translatedContent(h && h.en);
}
// Surah-name meaning: exact-match table (az/ms) first, else the phrase map.
const surahMeaning = (m) => {
  const o = typeof QURAN_MEANINGS !== "undefined" ? QURAN_MEANINGS[m] : null;
  if (o && o[contentLang()]) return o[contentLang()];
  return translatedOrEmpty(m);
};
// Localized category label (dua/ziyarat/library groups).
const tcat = (name) => (!CATS[name] ? (selectedText(name) || name) : (CATS[name][State.lang] || selectedText(name) || name));
// Compass cardinal letters for Arabic-script language modes.
const dirLabel = (d) => (ARABIC_SCRIPT_LANGS.includes(State.lang) ? ({ N: "شم", S: "جن", E: "شر", W: "غر" })[d] : d);
// Fallback chains so the month/weekday always localize (never an English month
// when a niche tag like ks-Arab / fa-AF isn't in the browser's data).
const dateLocale = () => ({
  en: undefined,
  ar: ["ar"],
  ur: ["ur", "ur-PK"],
  fa: ["fa"],
  az: ["az", "az-Latn", "tr"],
  ms: ["ms", "ms-MY", "id"],
  ks: ["ks-Arab", "ks", "ur"],
})[State.lang];

// ---------- QURAN ----------
async function renderQuran(v) {
  v.innerHTML = head("m_quran", "m_quran_d") + `
    <label class="search" style="margin-bottom:16px"><span class="search-ic">${SEARCH_ICON}</span>
      <input id="qSearch" placeholder="${t("search")}" onkeydown="if(event.key==='Enter')quranSearch()"></label>
    <div id="quranBody"><div class="card">${t("loading")}</div></div>`;
  try {
    const data = await api("/quran/surahs");
    const list = data.surahs.map((s) => {
      const title = quranListTitle(s);
      const meaningText = surahMeaning(s.meaning);
      const meaning = meaningText ? `${meaningText} · ` : "";
      return `<div class="list-item" onclick="openSurah(${s.n})">
        <div class="badge-num">${s.n}</div>
        <div class="meta"><div class="t">${title}</div><div class="s">${meaning}${s.ayat} ${t("verses")} · ${localizedText(s.type)}</div></div>
        ${sideArabic(s.ar, title)}
      </div>`;
    }).join("");
    el("#quranBody").innerHTML = (data.seed ? offlineBanner() : "") + list;
  } catch {
    el("#quranBody").innerHTML = offlineBanner() + SURAHS.map((s) => {
      const title = quranListTitle(s);
      const meaningText = surahMeaning(s.meaning);
      const meaning = meaningText ? `${meaningText} · ` : "";
      return `<div class="list-item" onclick="openSurah(${s.n})"><div class="badge-num">${s.n}</div>
        <div class="meta"><div class="t">${title}</div><div class="s">${meaning}${s.ayat} ${t("verses")} · ${localizedText(s.type)}</div></div>
        ${sideArabic(s.ar, title)}</div>`;
    }).join("");
  }
}

function verseBlock(a, surahN) {
  const tf = trField();
  const tr = tf ? `<div class="tr">${a[tf] || ""}</div>` : "";
  const audio = a.audio ? `<button class="chip" onclick="event.stopPropagation();playAyah(this,'${a.audio}')">${ICON_PLAY}</button>` : "";
  return `<div class="ayah-block"${surahN ? ` data-v="${surahN}:${a.n}"` : ""}>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <span class="num">${surahN ? surahN + ":" : ""}${a.n}</span>
        <span style="display:flex;gap:6px">${audio}</span></div>
      <div class="ar">${a.ar}</div>
      <div class="translit">${a.translit || ""}</div>${tr}</div>`;
}

// tafsir edition follows the active language (falls back to English)
// al-Mizan exists in ar/fa/ur/en; map each UI language onto the closest edition
// (Kashmiri→Urdu, Dari→Farsi; Azerbaijani/Malay/Singapore→English).
const tafsirEdition = () => "almizan_" +
  ({ en: "en", ar: "ar", fa: "fa", ur: "ur", ks: "ur", az: "az", ms: "ms" }[State.lang] || "en");

async function toggleTafsir(s, a, btn) {
  const box = btn.closest(".ayah-block").querySelector(".tafsir-box");
  if (box.style.display === "block") { box.style.display = "none"; return; }
  box.style.display = "block";
  box.innerHTML = `<div style="color:var(--text-2);padding:10px">${t("loading")}</div>`;
  try {
    const d = await api(`/quran/tafsir/${s}/${a}?edition=${tafsirEdition()}`);
    box.innerHTML = `
      <div style="margin-top:12px;padding:16px;border-radius:14px;background:rgba(8,35,84,.58);border:1px solid var(--glass-brd)">
        <div class="eyebrow">📚 ${localizedText(d.name)} · ${localizedText(d.author || "Allamah Tabatabai")}${d.covers && d.covers.from !== d.covers.to ? ` · ${localizedText("verses")} ${s}:${d.covers.from}–${d.covers.to}` : ""}</div>
        <div style="margin-top:10px;line-height:1.8;white-space:pre-wrap;${ARABIC_SCRIPT_LANGS.includes(State.lang) ? "direction:rtl;text-align:right" : ""}">${tafsirToHtml(d.text)}</div>
      </div>`;
  } catch {
    box.innerHTML = `<div style="color:var(--text-2);padding:10px">${localizedText("Tafsir unavailable. Please make sure the backend is running.")}</div>`;
  }
}
// Whole-surah al-Mizan tafsir, opened from the top Tafsir button (passage by
// passage, loaded progressively). No per-verse chips anymore.
async function openSurahTafsir(n) {
  const meta = _savedSurahMeta[n] || {};
  const ayat = meta.ayat || 286;
  const rtl = ARABIC_SCRIPT_LANGS.includes(State.lang);
  openQuranReader(`
    <div class="q-reader">
      <div class="qr-topbar">
        <button class="dua-back" onclick="openSurah(${n})" aria-label="${localizedText("Back")}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg></button>
        <span class="qr-title">${localizedText("Tafsir al-Mizan")}${meta.name ? " · " + meta.name : ""}</span>
      </div>
      <div class="qr-body" id="surahTafBody" dir="${rtl ? "rtl" : "ltr"}">
        <div class="qr-load"><div class="card">${t("loading")}</div></div>
      </div>
    </div>`);
  const body = el("#surahTafBody"); if (!body) return;
  let html = "", a = 1, guard = 0;
  try {
    while (a <= ayat && guard++ < 500) {
      const d = await api(`/quran/tafsir/${n}/${a}?edition=${tafsirEdition()}`);
      const from = (d.covers && d.covers.from) || a;
      const to = (d.covers && d.covers.to) || a;
      html += `<div class="card" style="margin-bottom:14px">
        <div class="eyebrow">📚 ${localizedText("verses")} ${n}:${from}${to !== from ? "–" + to : ""}</div>
        <div style="margin-top:10px;line-height:1.9;white-space:pre-wrap;${rtl ? "direction:rtl;text-align:right" : ""}">${tafsirToHtml(d.text)}</div>
      </div>`;
      body.innerHTML = html;                       // render progressively
      a = (to >= from) ? to + 1 : a + 1;
    }
    if (!html) body.innerHTML = `<div class="card">${localizedText("Tafsir unavailable. Please make sure the backend is running.")}</div>`;
  } catch {
    body.innerHTML = html + `<div class="card">${localizedText("Tafsir unavailable. Please make sure the backend is running.")}</div>`;
  }
}
// minimal markdown: strip code fences, bold, headings
function tafsirToHtml(md) {
  return escapeHtml(md || "")
    .replace(/```[a-z]*\n?/g, "").replace(/```/g, "")
    // move the trailing verse number to the FRONT of each English verse line:
    // "In the Name of Allah… (1)"  →  "(1) In the Name of Allah…"
    // (only spaces/tabs — never newlines — so the gaps between verses stay intact)
    .replace(/^([ \t]*.*[A-Za-z].*?)[ \t]*\((\d+)\)[ \t]*$/gm, "($2) $1")
    .replace(/^#+\s*(.+)$/gm, "<strong>$1</strong>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>");
}

// Live: count each Quran verse once as it scrolls into view (per-user "Read today").
let _verseObserver = null;
function observeVersesRead(container) {
  if (typeof IntersectionObserver === "undefined") return;
  if (_verseObserver) _verseObserver.disconnect();
  _verseObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting && e.target.dataset.v) {
        Stats.addVerseRead(e.target.dataset.v);
        _verseObserver.unobserve(e.target);
      }
    }
  }, { threshold: 0.6 });
  container.querySelectorAll(".ayah-block[data-v]").forEach((b) => _verseObserver.observe(b));
}

// Live: count each hadith once as it scrolls into view (per-user daily reads).
let _hadithObserver = null;
function observeHadithRead(container) {
  if (typeof IntersectionObserver === "undefined") return;
  if (_hadithObserver) _hadithObserver.disconnect();
  _hadithObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting && e.target.dataset.h) {
        Stats.addHadithRead(e.target.dataset.h);
        _hadithObserver.unobserve(e.target);
      }
    }
  }, { threshold: 0.6 });
  container.querySelectorAll(".ayah-block[data-h]").forEach((b) => _hadithObserver.observe(b));
}

// ---------- Quran reader sheet (slides up from the bottom) ----------
function openQuranReader(html) {
  const sheet = el("#qrSheet");
  const body = el("#qrSheetBody");
  if (body) body.innerHTML = html;
  const alreadyOpen = sheet && sheet.classList.contains("open");
  if (sheet && !alreadyOpen) {
    // guarantee the slide-up transition fires from the closed (off-screen) state
    sheet.classList.remove("open");
    void sheet.offsetHeight;                 // force reflow
    if (body) body.scrollTop = 0;
    requestAnimationFrame(() => sheet.classList.add("open"));
  }
  el("#qrBackdrop")?.classList.add("open");
  document.body.classList.add("sheet-lock");
  if (!(history.state && history.state.qrOpen)) {
    history.pushState({ wilayat: true, route: State.route, index: _navIndex, qrOpen: true }, "", location.href);
  }
  return body;
}
function closeQuranReader() {
  stopSurahAudio();
  stopVerseAudio();
  el("#qrSheet")?.classList.remove("open");
  el("#qrBackdrop")?.classList.remove("open");
  document.body.classList.remove("sheet-lock");
}

// ---- Per-verse Qur'an recitation (real reciter audio, one or more ayat) ----
let _verseAudio = null;
function stopVerseAudio() {
  try { if (_verseAudio) { _verseAudio.onended = null; _verseAudio.onerror = null; _verseAudio.pause(); _verseAudio = null; } } catch (e) {}
  document.querySelectorAll(".qverse-play.playing").forEach((b) => b.classList.remove("playing"));
}
function reciteVerse(ref, btn) {
  const m = String(ref).match(/(\d+):(\d+)(?:-(\d+))?/);
  if (!m) return;
  const already = btn && btn.classList.contains("playing");
  stopVerseAudio();
  if (already) return;                      // tapping the playing button stops it
  const s = +m[1], a1 = +m[2], a2 = m[3] ? +m[3] : a1;
  const pad = (n, w) => String(n).padStart(w, "0");
  const keys = [];
  for (let a = a1; a <= a2; a++) keys.push(pad(s, 3) + pad(a, 3));
  if (btn) btn.classList.add("playing");
  let i = 0;
  const playNext = () => {
    if (i >= keys.length) { stopVerseAudio(); return; }
    _verseAudio = new Audio("https://everyayah.com/data/Alafasy_128kbps/" + keys[i] + ".mp3");
    _verseAudio.onended = () => { i++; playNext(); };
    _verseAudio.onerror = () => { stopVerseAudio(); toast(localizedText("Recitation not available")); };
    _verseAudio.play().catch(() => { stopVerseAudio(); });
  };
  playNext();
}

async function openSurah(n) {
  stopSurahAudio();                       // reset recitation state for the new surah
  const body = openQuranReader(`<div class="qr-load"><div class="card">${t("loading")}</div></div>`);
  try {
    const d = await api(`/quran/surah/${n}`);   // verses are counted per-ayah as they scroll into view
    const allAudio = d.verses.filter((v) => v.audio).map((v) => v.audio);
    _savedSurahMeta[n] = { ar: d.ar, name: quranListTitle({ ...d, n }), ayat: d.ayat };
    body.innerHTML = `<div class="q-reader">
      <div class="qr-topbar">
        <button class="dua-back" onclick="history.back()" aria-label="${localizedText("Back")}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg></button>
        <button class="qr-listen" id="surahPlayBtn" onclick="playSurah(${n})">${ICON_PLAY}<span>${t("listen")}</span></button>
        <button class="qr-save ${Saved.has("surah-" + n) ? "saved" : ""}" onclick="toggleSaveSurah(${n}, this)" aria-label="${t("bookmark")}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg></button>
        <button class="qr-listen qr-taf-btn" style="margin-inline-start:auto" onclick="openSurahTafsir(${n})" aria-label="${localizedText("Tafsir al-Mizan")}">📚<span>${localizedText("Tafsir")}</span></button>
      </div>
      <div class="qr-body">
        <div class="card" style="text-align:center;margin-bottom:16px">
          <h2 style="font-family:Amiri,serif;font-size:32px;color:var(--text-0)">${d.ar}</h2>
          <p style="color:var(--text-2)">${quranListTitle({ ...d, n })}${surahMeaning(d.meaning) ? " · " + surahMeaning(d.meaning) : ""} · ${d.ayat} ${t("verses")}</p>
        </div>
        ${n !== 1 && n !== 9 ? `<div class="ayah-block" style="text-align:center"><div class="ar">بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ</div></div>` : ""}
        ${d.verses.map((a) => verseBlock(a, n)).join("")}
      </div>
    </div>`;
    window._surahAudio = allAudio;
    observeVersesRead(body);   // count each verse once as it scrolls into view (Mac + live)
  } catch {
    body.innerHTML = offlineBanner();
  }
}
// Surah recitation with a play / pause button that reflects the real state.
let _surahPlay = { queue: [], i: 0, active: false };
function setSurahPlayBtn(playing) {
  const btn = el("#surahPlayBtn");
  if (btn) {
    btn.innerHTML = playing ? `${ICON_PAUSE}<span>${t("pause")}</span>` : `${ICON_PLAY}<span>${t("listen")}</span>`;
    btn.classList.toggle("playing", !!playing);
  }
}
function stopSurahAudio() {
  if (currentAudio) { currentAudio.pause(); currentAudio.onended = null; }  // break the auto-advance chain
  _surahPlay.active = false;
  if (_ayahBtn) { _ayahBtn.innerHTML = ICON_PLAY; _ayahBtn = null; }        // reset any per-ayah button
  setSurahPlayBtn(false);
}
function _surahNext() {
  if (_surahPlay.i >= _surahPlay.queue.length) { _surahPlay.active = false; setSurahPlayBtn(false); return; }
  if (currentAudio) currentAudio.pause();
  currentAudio = new Audio(_surahPlay.queue[_surahPlay.i++]);
  currentAudio.onended = _surahNext;
  currentAudio.play().catch(() => {});
}
function playSurah(n) {
  if (_surahPlay.active && currentAudio) {
    if (currentAudio.paused) { currentAudio.play().catch(() => {}); setSurahPlayBtn(true); }
    else { currentAudio.pause(); setSurahPlayBtn(false); }
    return;
  }
  const q = window._surahAudio || [];
  if (!q.length) return toast(t("coming_soon"));
  if (_ayahBtn) { _ayahBtn.innerHTML = ICON_PLAY; _ayahBtn = null; }
  _surahPlay = { queue: q, i: 0, active: true };
  setSurahPlayBtn(true);
  _surahNext();
  toast("🔊 " + t("surah") + " " + n);
}

async function openJuz(j) {
  const body = openQuranReader(`<div class="qr-load"><div class="card">${t("loading")}</div></div>`);
  try {
    const d = await api(`/quran/juz/${j}`);
    body.innerHTML = `<div class="q-reader">
      <div class="qr-topbar">
        <button class="dua-back" onclick="history.back()" aria-label="${localizedText("Back")}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg></button>
        <span class="qr-title">${t("juz")} ${j}</span>
      </div>
      <div class="qr-body">
        <div class="card" style="text-align:center;margin-bottom:16px"><h2>${t("juz")} ${j}</h2><p style="color:var(--text-2)">${d.count} ${t("verses")}</p></div>
        ${d.verses.map((a) => verseBlock(a, a.surah)).join("")}
      </div>
    </div>`;
    observeVersesRead(body);
  } catch { body.innerHTML = offlineBanner(); }
}

async function quranSearch() {
  const q = el("#qSearch").value.trim(); if (q.length < 2) return;
  const body = el("#quranBody");
  body.innerHTML = `<div class="card">${t("searching")}</div>`;
  try {
    const d = await api(`/quran/search?q=${encodeURIComponent(q)}`);
    body.innerHTML = `<button class="btn ghost" style="margin-bottom:16px" onclick="renderQuran(document.getElementById('view-quran'))">← ${t("surahs")}</button>
      <div class="page-head"><h1 style="font-size:18px">${d.count} ${t("results_for")} "${escapeHtml(q)}"</h1></div>
      ${d.results.map((r) => `<div class="ayah-block" onclick="openSurah(${r.surah})">
        <div class="num">${localizedText(r.surahName || "")} ${r.surah}:${r.ayah}</div>
        <div class="ar">${r.ar}</div>${translatedContent(r.en) ? `<div class="tr">${translatedContent(r.en)}</div>` : ""}</div>`).join("") || `<div class='card'>${t("no_matches")}</div>`}`;
  } catch { body.innerHTML = offlineBanner(); }
}

// ---------- HADITH ----------
// Professional stats graph: library size (brown→orange = magnitude) + your reading (green = activity).
function hadithGraph(allBooks) {
  const avail = (allBooks || []).filter((b) => b.downloaded && b.count);
  if (!avail.length) return "";
  // include the big full-text collections (page-based, scholarly counts) in the totals
  const totalNarr = avail.reduce((a, b) => a + (b.count || 0), 0) + hlibNarrTotal();
  const totalColl = avail.length + HLIB_LIST.length;   // count each book (incl. every volume) as one collection
  // Combined chart list: existing books (volumes grouped) + the big collections.
  const grouped = groupHadithBooks(avail).map((g) => g.group
    ? { name: disp(g.name, hlibArBase(g.vols[0].bookId) || g.name, ""), count: g.vols.reduce((a, b) => a + (b.count || 0), 0) }
    : { name: disp(g.book.name, HADITH_AR[g.book.bookId] || g.book.name, ""), count: g.book.count || 0 });
  const hlibChart = HLIB_LIST.map((tk) => ({ name: disp(tk.name, tk.name, ""), count: HLIB_NARR[tk.slug] || 0 }));
  const top = grouped.concat(hlibChart).sort((a, b) => b.count - a.count).slice(0, 6);
  const maxC = Math.max(...top.map((b) => b.count), 1);
  const bars = top.map((b) => {
    const pct = Math.max(6, Math.round((b.count / maxC) * 100));
    return `<div class="hd-row">
      <span class="hd-name" title="${b.name}">${b.name}</span>
      <div class="hd-track"><i style="width:${pct}%"></i></div>
      <span class="hd-val">${b.count.toLocaleString()}</span>
    </div>`;
  }).join("");

  const week = Stats.hadithWeek();
  const today = (week.find((d) => d.isToday) || { count: 0 }).count;
  const weekTotal = week.reduce((a, d) => a + d.count, 0);

  return `<div class="hd-graph card">
    <div class="hd-stats">
      <div class="hd-stat"><span class="n">${totalColl}</span><span class="l">${t("collections")}</span></div>
      <div class="hd-stat"><span class="n">${totalNarr.toLocaleString()}</span><span class="l">${t("narrations")}</span></div>
      <div class="hd-stat"><span class="n hd-green">${today}</span><span class="l">${localizedText("Read today")}</span></div>
    </div>
    <div class="hd-sec">${localizedText("Narrations by book")}</div>
    <div class="hd-bars">${bars}</div>
    <div class="hd-spark-head">
      <span class="hd-sec" style="margin:0">${localizedText("Reading activity")} · ${localizedText("7 days")}</span>
      <span class="hd-spark-total">${weekTotal} ${localizedText("read")}</span>
    </div>
    ${hadithSpark(week)}
  </div>`;
}

// Smooth green area sparkline of the last 7 days' hadith reads.
function hadithSpark(week) {
  const W = 300, H = 104, padX = 14, padTop = 26, padBot = 24;
  const n = week.length;
  const maxW = Math.max(...week.map((d) => d.count), 4);
  const dl = ["S", "M", "T", "W", "T", "F", "S"];
  const xs = (i) => padX + i * ((W - 2 * padX) / (n - 1));
  const ys = (c) => padTop + (1 - c / maxW) * (H - padTop - padBot);
  const pts = week.map((d, i) => [xs(i), ys(d.count)]);
  // Catmull-Rom → cubic bezier for a smooth line
  let line = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || pts[i + 1];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
    line += ` C${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  const area = line + ` L${pts[n - 1][0].toFixed(1)} ${(H - padBot).toFixed(1)} L${pts[0][0].toFixed(1)} ${(H - padBot).toFixed(1)} Z`;
  const dots = pts.map((p, i) => {
    const on = week[i].isToday;
    return `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${on ? 4 : 2.6}" class="hd-dot${on ? " on" : ""}"/>`;
  }).join("");
  const labels = week.map((d, i) =>
    `<text x="${xs(i).toFixed(1)}" y="${H - 5}" text-anchor="middle" class="hd-lbl${d.isToday ? " on" : ""}">${dl[d.dow]}</text>`).join("");
  const ti = week.findIndex((d) => d.isToday);
  const todayLbl = (ti >= 0 && week[ti].count > 0)
    ? `<text x="${pts[ti][0].toFixed(1)}" y="${(pts[ti][1] - 8).toFixed(1)}" text-anchor="middle" class="hd-dot-lbl">${week[ti].count}</text>` : "";
  return `<svg class="hd-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Reading activity, this week">
    <defs>
      <linearGradient id="hdSparkFill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#00A6A6" stop-opacity=".42"/>
        <stop offset="1" stop-color="#00A6A6" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <path d="${area}" fill="url(#hdSparkFill)" class="hd-spark-area"/>
    <path d="${line}" pathLength="100" fill="none" stroke="#00A6A6" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" class="hd-spark-line"/>
    ${dots}${todayLbl}${labels}
  </svg>`;
}

// Group a book's volumes (Al-Kafi vol 1-8, Uyun vol 1-2) under one entry so the
// list shows one bar per book → tapping opens its volumes as bars (like tafsir).
let _hadithGroups = [];
function groupHadithBooks(books) {
  const out = [], byBase = {};
  books.forEach((b) => {
    const m = (b.bookId || "").match(/^(.*)-Volume-(\d+)-(.*)$/);
    if (m) {
      const key = m[1] + "|" + m[3];
      if (!byBase[key]) { byBase[key] = { group: true, name: b.name, author: b.author, vols: [] }; out.push(byBase[key]); }
      byBase[key].vols.push(b);
    } else {
      out.push({ group: false, book: b });
    }
  });
  out.forEach((g) => { if (g.group) g.vols.sort((a, c) => (+a.bookId.match(/Volume-(\d+)/)[1]) - (+c.bookId.match(/Volume-(\d+)/)[1])); });
  return out;
}
const hlibArBase = (id) => (HADITH_AR[id] || "").replace(/\s*[–-]\s*الجزء.*/, "").trim();
function openHadithVolumes(gi) {
  const g = _hadithGroups[gi]; if (!g || !g.group) return;
  const arBase = hlibArBase(g.vols[0].bookId) || g.name;
  const title = disp(g.name, arBase, t("nav_hadith"));
  const bars = g.vols.map((b, vi) => {
    const click = b.downloaded ? `openBook('${b.bookId}')` : `toast(t('downloading'))`;
    return `<div class="list-item" onclick="${click}">
      <div class="badge-num">${locNum(vi + 1, State.lang)}</div>
      <div class="meta"><div class="t">${localizedText("Volume")} ${locNum(vi + 1, State.lang)}</div>
        <div class="s">${(b.count || 0).toLocaleString()} ${t("narrations")}</div></div>
    </div>`;
  }).join("");
  el("#hadithBody").innerHTML =
    `<button class="btn ghost" style="margin-bottom:16px" onclick="renderHadith(document.getElementById('view-hadith'))">← ${t("collections")}</button>
     <div class="page-head"><h1 style="font-size:18px">${title}</h1></div>${bars}`;
  const b = el("#qrSheetBody"); window.scrollTo(0, 0);
}

async function renderHadith(v) {
  v.innerHTML = head("m_hadith", "m_hadith_d") + `
    <label class="search" style="margin-bottom:16px"><span class="search-ic">${SEARCH_ICON}</span>
      <input id="hSearch" placeholder="${t("search")}" inputmode="search" oninput="hadithSearchLive(this.value)" onkeydown="if(event.key==='Enter')hadithSearch()"></label>
    <div id="hadithBody"><div class="card">${t("loading")}</div></div>`;
  try {
    const d = await api("/hadith/books");
    _hadithGroups = groupHadithBooks(d.books);
    const books = _hadithGroups.map((g, gi) => {
      if (g.group) {
        const arBase = hlibArBase(g.vols[0].bookId) || g.name;
        const author = ARABIC_SCRIPT_LANGS.includes(State.lang)
          ? (AUTHOR_AR[g.vols[0].bookId.split("-").pop()] || localizedText(g.author)) : localizedText(g.author);
        const title = disp(g.name, arBase, t("nav_hadith"));
        const total = g.vols.reduce((a, b) => a + (b.count || 0), 0);
        return `<button class="ev-box" onclick="openHadithVolumes(${gi})">
          <span class="ev-ic">${BOOKS_ICON}</span>
          <span class="ev-name">${title}</span>
          <span class="ev-date">${author} · ${g.vols.length} ${localizedText("volumes")}</span>
        </button>`;
      }
      const b = g.book;
      const status = b.downloaded ? "" : b.unavailable ? ` · ⚠️ ${localizedText("not in source API")}` : " · ⏳";
      const click = b.downloaded ? `openBook('${b.bookId}')`
        : b.unavailable ? `toast(localizedText('This book is not available yet.'))`
        : `toast(t('downloading'))`;
      const arName = HADITH_AR[b.bookId] || b.name;
      const author = ARABIC_SCRIPT_LANGS.includes(State.lang)
        ? (AUTHOR_AR[b.bookId.split("-").pop()] || localizedText(b.author))
        : localizedText(b.author);
      const title = disp(b.name, arName, t("nav_hadith"));   // real book name, not the English meaning
      return `<button class="ev-box" onclick="${click}" ${b.unavailable ? 'style="opacity:.55"' : ""}>
        <span class="ev-ic">${b.unavailable ? BOOK_OFF_ICON : BOOK_ICON}</span>
        <span class="ev-name">${title}</span>
        <span class="ev-date">${author}</span>
      </button>`;
    }).join("");
    el("#hadithBody").innerHTML =
      `<div class="page-head"><h1 style="font-size:18px">${t("collections")} (${_hadithGroups.reduce((n, g) => n + (g.group ? g.vols.length : 1), 0) + HLIB_LIST.length})</h1></div><div class="jr-grid">${books}${hlibBars()}</div>`;
  } catch {
    el("#hadithBody").innerHTML = offlineBanner()
      + `<div class="page-head"><h1 style="font-size:18px">${t("collections")} (${HADITH_BOOKS.length + HLIB_LIST.length})</h1></div>`
      + `<div class="jr-grid">` + HADITH_BOOKS.map((b) => {
      const title = disp(b.en, b.ar, t("nav_hadith"));
      return `<button class="ev-box"><span class="ev-ic">${BOOK_ICON}</span>
        <span class="ev-name">${title}</span><span class="ev-date">${localizedText(b.author)}</span></button>`;
    }).join("") + hlibBars() + `</div>`;
  }
}

// Exact reference (book, volume, chapter no., hadith no.) under every narration
// Localized label for a book's edition — "Arabic" or "English".
function editionLabel(ed) {
  return ed === "en" ? t("ed_en") : t("ed_ar");
}

function refLine(h) {
  const r = h.reference || {};
  // Reference follows the BOOK's edition (Arabic book → Arabic ref, RTL; English
  // book → English ref) and is never run through the phrase translator, so it
  // never mixes languages.
  const arCite = r.ar_citation;
  const cite = arCite || r.citation || r.book || h.name || "";
  const dir = arCite ? "rtl" : "ltr";
  const loc = (!arCite && r.location) ? ` - ${r.location}` : "";
  return `<div class="translit" dir="${dir}" style="margin-top:10px;border-top:1px solid var(--glass-brd);padding-top:8px">
    📖 <strong style="color:var(--text-0)">${cite}</strong>${loc}</div>`;
}

let _book = { id: null, page: 1, total: 0 };
async function openBook(id, page = 1) {
  _book = { id, page, total: 0 };
  const body = openQuranReader(`<div class="qr-load"><div class="card">${t("loading")}</div></div>`);
  try {
    const d = await api(`/hadith/book/${id}?page=${page}&size=20`);
    _book.total = d.total;
    const pages = Math.ceil(d.total / d.size);
    const items = d.hadiths.map((h, i) => `
      <div class="ayah-block" data-h="${id}:${(page - 1) * 20 + i}">
        <div class="translit" style="margin:0 0 8px">${localizedText(h.category || "")} ${h.chapter ? "· " + localizedText(h.chapter) : ""}</div>
        ${h.ar ? `<div class="ar">${arHadithText(h.ar)}</div>` : ""}
        ${hadithTrans(h) ? `<div class="tr">${hadithTrans(h)}</div>` : ""}
        ${h.grading ? `<div class="translit">⚖️ ${localizedText(h.grading)}</div>` : ""}
        ${refLine(h)}
      </div>`).join("");
    body.innerHTML = `<div class="q-reader">
      <div class="qr-topbar">
        <button class="dua-back" onclick="history.back()" aria-label="${localizedText("Back")}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg></button>
        <span class="qr-title">${localizedText(d.name)}</span>
      </div>
      <div class="qr-body">
        <div style="color:var(--text-2);font-size:13px;margin-bottom:14px">${d.total.toLocaleString()} ${t("narrations")}${d.edition ? " · " + editionLabel(d.edition) : ""}</div>
        ${items}
        <div style="display:flex;gap:10px;justify-content:center;margin-top:18px;align-items:center">
          <button class="btn ghost" ${page <= 1 ? "disabled" : ""} onclick="openBook('${id}',${page - 1})">←</button>
          <span style="color:var(--text-2)">${localizedText("Page")} ${page} / ${pages}</span>
          <button class="btn ghost" ${page >= pages ? "disabled" : ""} onclick="openBook('${id}',${page + 1})">→</button>
        </div>
      </div>
    </div>`;
    const sb = el("#qrSheetBody"); if (sb) { sb.scrollTop = 0; observeHadithRead(sb); }
  } catch { body.innerHTML = offlineBanner(); }
}

// Live hadith search — fires as you type (debounced). Numbers from 1 digit; text 2+.
let _hSearchTimer = null;
function hadithSearchLive(q) {
  clearTimeout(_hSearchTimer);
  q = (q || "").trim();
  if (!q) { renderHadith(el("#view-hadith")); return; }
  if (q.length < 2 && !/^\d+$/.test(q)) return;
  _hSearchTimer = setTimeout(hadithSearch, 300);
}

async function hadithSearch() {
  const q = el("#hSearch").value.trim();
  if (q.length < 2 && !/^\d+$/.test(q)) return;
  const body = el("#hadithBody");
  body.innerHTML = `<div class="card">${t("searching")}</div>`;
  try {
    const d = await api(`/hadith/search?q=${encodeURIComponent(q)}`);
    body.innerHTML = `<button class="btn ghost" style="margin-bottom:16px" onclick="renderHadith(document.getElementById('view-hadith'))">← ${t("collections")}</button>
      <div class="page-head"><h1 style="font-size:18px">${d.count} ${t("results_for")} "${escapeHtml(q)}"</h1></div>
      ${d.results.map((h) => `<div class="ayah-block">
        ${h.ar ? `<div class="ar">${arHadithText(h.ar)}</div>` : ""}${hadithTrans(h) ? `<div class="tr">${hadithTrans(h)}</div>` : ""}${refLine(h)}</div>`).join("") || `<div class='card'>${t("no_matches")}</div>`}`;
  } catch { body.innerHTML = offlineBanner(); }
}

// ---------- DUA (curated index + real texts from al-Kafi Book of Supplication) ----------
async function renderDua(v) {
  const cats = [...new Set(DUAS.map((d) => d.cat))];
  const sections = cats.map((c) => {
    const cards = DUAS.filter((d) => d.cat === c).map((d) => {
      const title = disp(d.en, d.ar, t("nav_dua"));
      return `<div class="list-item" onclick="openText('dua','${d.textId || ""}', this)">
        <div class="meta"><div class="t">${title} ›</div><div class="s">${localizedText(d.src)} · ${localizedText(d.note)}</div></div>
        ${sideArabic(d.ar, title)}
      </div>`;
    }).join("");
    return `<div class="page-head" style="margin-top:18px"><h1 style="font-size:17px">${tcat(c)}</h1></div>${cards}`;
  }).join("");
  v.innerHTML = head("m_dua", "m_dua_d") + sections;
}

// ---------- ZIYARAT (curated index + real Kamil al-Ziyarat texts) ----------
async function renderZiyarat(v) {
  const cats = [...new Set(ZIYARAT.map((z) => z.cat))];
  const sections = cats.map((c) => {
    const cards = ZIYARAT.filter((z) => z.cat === c).map((z) => {
      const title = disp(z.en, z.ar, t("nav_ziyarat"));
      return `<div class="list-item" onclick="openText('ziyarat','${z.textId || ""}', this)">
        <div class="meta"><div class="t">${title} ›</div><div class="s">${localizedText(z.to)}</div></div>
        ${sideArabic(z.ar, title)}
      </div>`;
    }).join("");
    return `<div class="page-head" style="margin-top:18px"><h1 style="font-size:17px">${tcat(c)}</h1></div>${cards}`;
  }).join("");
  v.innerHTML = head("m_ziyarat", "m_ziyarat_d") + sections;
}

// shared reader for both ziyarat and dua cards — opens sliding up from the bottom
async function openText(kind, id, row) {
  Stats.addTextRead(kind, id);   // track dua / ziyarat reads for the Progress dashboard
  const title = row.querySelector(".t").textContent.replace(" ›", "").trim();
  const arTitle = row.querySelector(".ar") ? row.querySelector(".ar").textContent.trim() : title;
  const backSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>';
  const topbar = (ttl) => `<div class="qr-topbar">
      <button class="dua-back" onclick="history.back()" aria-label="${localizedText("Back")}">${backSvg}</button>
      <span class="qr-title">${ttl}</span>
    </div>`;
  const body = openQuranReader(`<div class="qr-load"><div class="card">${t("loading")}</div></div>`);

  if (!id) {  // full text not bundled — dignified note (never a dead toast)
    body.innerHTML = `<div class="q-reader">${topbar(title)}<div class="qr-body">
      <div class="card" style="text-align:center;margin-bottom:14px">
        <h2 style="font-family:Amiri,serif;color:var(--text-0)">${arTitle}</h2>
        <div style="color:var(--text-2);font-size:14px">${title}</div>
      </div>
      <p style="color:var(--text-1);line-height:1.8">${localizedText("The full text for this item is not bundled yet.")}</p>
    </div></div>`;
    return;
  }
  try {
    const d = await api(`/${kind}/full/${id}`);
    body.innerHTML = `<div class="q-reader">${topbar(disp(d.en_title, d.ar_title, title))}<div class="qr-body">
      <div class="card" style="text-align:center;margin-bottom:16px">
        <h2 style="font-family:Amiri,serif;color:var(--text-0)">${d.ar_title}</h2>
        <p style="color:var(--text-2)">${disp(d.en_title, d.ar_title, title)} · ${d.count} ${t("passages")}</p>
      </div>
      ${d.verses.map((vrs) => {
        if (vrs.head) return `<h3 style="color:var(--text-0);margin:18px 0 8px;font-size:16px">${hadithTrans(vrs) || localizedText(vrs.en || "")}</h3>`;
        const ar = vrs.ar ? `<div class="ar">${vrs.ar}</div>` : "";
        const tr = hadithTrans(vrs);
        const en = tr ? `<div class="tr"${vrs.ar ? "" : ' style="font-size:16px;color:var(--text-1)"'}>${tr}</div>` : "";
        return `<div class="ayah-block">${ar}${en}</div>`;
      }).join("")}
    </div></div>`;
    const sb = el("#qrSheetBody"); if (sb) sb.scrollTop = 0;
  } catch {
    body.innerHTML = `<div class="q-reader">${topbar(title)}<div class="qr-body">
      <div class="card" style="color:var(--text-2)">${localizedText("Text unavailable. Please make sure the backend is running.")}</div>
    </div></div>`;
  }
}

// shared loader for corpus-backed dua/ziyarat text lists
async function loadCorpus(path, sel, pendingMsg) {
  try {
    const d = await api(path);
    const box = el(sel);
    if (!d.count) { box.innerHTML = `<div class="card" style="color:var(--text-2)">⏳ ${pendingMsg}</div>`; return; }
    box.innerHTML = d.results.slice(0, 80).map((h) => `
      <div class="ayah-block">
        ${h.ar ? `<div class="ar">${arHadithText(h.ar)}</div>` : ""}
        ${hadithTrans(h) ? `<div class="tr">${hadithTrans(h)}</div>` : ""}
        ${h.grading ? `<div class="translit">⚖️ ${localizedText(h.grading)}</div>` : ""}
        ${refLine(h)}
      </div>`).join("") + (d.count > 80 ? `<div class="card" style="text-align:center;color:var(--text-2)">+${d.count - 80} ${localizedText("more")}</div>` : "");
  } catch {
    el(sel).innerHTML = offlineBanner();
  }
}

// ---------- PRAYER ----------
// ---------- LIVE PRAYER TIMES (location-aware, default India) ----------
const HMS_TO_MIN = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
const PRAYER_KEYS = ["fajr", "sunrise", "dhuhr", "asr", "maghrib", "isha"];

// Current minutes-since-midnight in a given IANA timezone (falls back to device time).
function nowMinutesIn(tz) {
  try {
    const s = new Date().toLocaleTimeString("en-GB", { timeZone: tz, hour12: false, hour: "2-digit", minute: "2-digit" });
    const [h, m] = s.split(":").map(Number);
    return h * 60 + m;
  } catch {
    const n = new Date();
    return n.getHours() * 60 + n.getMinutes();
  }
}

// Active prayer times — live ones if loaded, else the bundled sample times.
function prayerTimes() {
  if (State.prayer && State.prayer.times) return State.prayer.times;
  return Object.fromEntries(PRAYERS.map((p) => [p.key, p.time]));
}

// The next upcoming prayer (skipping sunrise), based on the location's local time.
function nextPrayer() {
  const times = prayerTimes();
  const tz = State.prayer && State.prayer.tz;
  const nowMin = tz ? nowMinutesIn(tz) : (new Date().getHours() * 60 + new Date().getMinutes());
  const key = PRAYER_KEYS.find((k) => k !== "sunrise" && HMS_TO_MIN(times[k]) > nowMin) || "fajr";
  const seed = PRAYERS.find((p) => p.key === key) || {};
  return { key, time: times[key], en: seed.en, ar: seed.ar, emoji: seed.emoji };
}

const INDIA_DEFAULT = { lat: 28.6139, lng: 77.2090, label: "India · New Delhi (default)" };

// Approximate location from the user's IP — works even on file:// or when GPS
// is blocked/denied, so a click always resolves to a usable location.
async function ipLocate() {
  // Several free providers (different JSON shapes) — first one that responds wins.
  const sources = [
    ["https://ipapi.co/json/", (j) => [j.latitude, j.longitude]],
    ["https://ipwho.is/", (j) => [j.latitude, j.longitude]],
    ["https://get.geojs.io/v1/ip/geo.json", (j) => [j.latitude, j.longitude]],
    ["https://freeipapi.com/api/json", (j) => [j.latitude, j.longitude]],
    ["https://ipinfo.io/json", (j) => (j.loc ? j.loc.split(",") : [])],
  ];
  for (const [url, pick] of sources) {
    try {
      const j = await (await fetch(url, { cache: "no-store" })).json();
      const [a, b] = pick(j) || [];
      const lat = Number(a), lng = Number(b);
      if (isFinite(lat) && isFinite(lng) && (lat || lng)) return { lat, lng };
    } catch { /* try next */ }
  }
  return null;
}

// Resolve a location: precise GPS first, IP fallback otherwise. Resolves null only
// if everything fails. Saves the result so it persists across refreshes.
function getLocation(options = {}) {
  const highAccuracy = !!options.highAccuracy;
  const allowIpFallback = options.allowIpFallback !== false;
  const timeout = options.timeout ?? (highAccuracy ? 11000 : 6000);
  const maximumAge = options.maximumAge ?? (highAccuracy ? 0 : 600000);
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const viaIp = async () => {
      if (!allowIpFallback) { finish(null); return; }
      const c = await ipLocate();
      if (c) saveCoords(c.lat, c.lng, { source: "ip" });
      finish(c ? State.coords : null);
    };
    // Native app (Capacitor): use the Geolocation plugin so the OS permission prompt shows.
    const capGeo = (() => { try { return isNativeApp() ? window.Capacitor.Plugins.Geolocation : null; } catch { return null; } })();
    if (capGeo) {
      (async () => {
        try {
          let perm = await capGeo.checkPermissions();
          if (perm.location !== "granted" && perm.coarseLocation !== "granted") perm = await capGeo.requestPermissions();
          if (perm.location === "denied" && perm.coarseLocation === "denied") { viaIp(); return; }
          const pos = await capGeo.getCurrentPosition({ enableHighAccuracy: highAccuracy, timeout, maximumAge });
          saveCoords(pos.coords.latitude, pos.coords.longitude, { source: "gps", accuracy: pos.coords.accuracy });
          finish(State.coords);
        } catch { viaIp(); }
      })();
      setTimeout(() => { if (!done) viaIp(); }, timeout + 800);
      return;
    }
    if (!navigator.geolocation) { viaIp(); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        saveCoords(pos.coords.latitude, pos.coords.longitude, {
          source: "gps",
          accuracy: pos.coords.accuracy,
        });
        finish(State.coords);
      },
      () => viaIp(),  // denied / unavailable → IP fallback
      { enableHighAccuracy: highAccuracy, timeout, maximumAge },
    );
    // Safety net: geolocation can silently hang — fall back to IP after a moment.
    setTimeout(() => { if (!done) viaIp(); }, timeout + 500);
  });
}

// Get location and apply it to prayer times, Qibla & mosque finder.
async function requestLocation(announce) {
  if (State.coords) applyLocationEverywhere();   // reuse remembered location at once
  const c = await getLocation({ highAccuracy: !!announce, maximumAge: announce ? 0 : 600000 });
  applyLocationEverywhere();
  if (announce) toast(c ? "📍 " + t("loc_set") : t("loc_fail"));
}

function applyLocationEverywhere() {
  loadPrayerTimes();
  if (State.route === "qibla") RENDERERS.qibla(el("#view-qibla"));
}

// Fetch real times via the free Aladhan API for the shared location (default India).
async function loadPrayerTimes() {
  const c = State.coords || INDIA_DEFAULT;
  const label = State.coords ? "yours" : "india";
  try {
    // method=0 → Shia Ithna-Ashari (Leva Institute, Qum)
    const r = await fetch(`https://api.aladhan.com/v1/timings?latitude=${c.lat}&longitude=${c.lng}&method=0`);
    const j = await r.json();
    const tg = j.data.timings;
    const clean = (s) => (s || "").split(" ")[0]; // "04:12 (IST)" → "04:12"
    State.prayer = {
      times: { fajr: clean(tg.Fajr), sunrise: clean(tg.Sunrise), dhuhr: clean(tg.Dhuhr),
               asr: clean(tg.Asr), maghrib: clean(tg.Maghrib), isha: clean(tg.Isha) },
      tz: j.data.meta.timezone,
      label: label,
    };
  } catch { /* keep bundled fallback */ }
  try { scheduleAzanReminders(); } catch (e) { /* reminders optional */ }
  if (State.route === "home" || State.route === "prayer") {
    RENDERERS[State.route](el("#view-" + State.route));
  }
}

function renderPrayer(v) {
  const times = prayerTimes();
  const next = nextPrayer();
  const loc = State.prayer ? t(State.prayer.label === "yours" ? "loc_yours" : "loc_india") : t("loc_sample");
  const tz = (State.prayer && State.prayer.tz) || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const dateStr = new Date().toLocaleDateString(dateLocale(), { timeZone: tz, weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const prayed = Stats.getPrayers();
  // Current time in the prayer timezone → only allow marking a prayer once its time has entered.
  const nowStr = new Date().toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false });
  const toMin = (x) => { const m = (x || "").match(/(\d{1,2}):(\d{2})/); return m ? (+m[1]) * 60 + (+m[2]) : 0; };
  const nowMin = toMin(nowStr);
  const lockIco = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
  const rows = PRAYERS.map((p) => {
    const obligatory = p.key !== "sunrise";
    const done = prayed.includes(p.key);
    const entered = nowMin >= toMin(times[p.key] || p.time);   // has this prayer's time arrived today?
    return `<div class="prayer-row ${p.key === next.key ? "next" : ""}">
      <div class="pn">${langName(p)} ${p.key === next.key ? "· " + t("next_prayer") : ""}</div>
      <div class="pt">${times[p.key] || p.time}</div><span class="pray-slot"></span>
    </div>`;
  }).join("");
  const azanBtn = azanOn()
    ? `<button class="btn ghost" onclick="disableAzan()"><span class="btn-ic">${BELL_ICON}</span>${localizedText("Azan reminders on")} · ${localizedText("turn off")}</button>`
    : `<button class="btn" onclick="enableAzan()"><span class="btn-ic">${BELL_ICON}</span>${localizedText("Enable azan reminders")}</button>`;
  v.innerHTML = head("m_prayer", "m_prayer_d") + `
    <div class="card" style="margin-bottom:16px;text-align:center">
      <div style="color:var(--text-2);font-size:13px">${escapeHtml(loc)}${State.lang === "en" ? " · " + escapeHtml(tz) : ""} · ${t("method_shia")}</div>
      <div class="big" style="font-size:24px;margin-top:6px;font-weight:800">${dateStr}</div>
      <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:10px">
        <button class="btn ghost" onclick="requestLocation(true)"><span class="btn-ic">${PIN_ICON}</span>${t("use_location")}</button>
        ${azanBtn}
      </div>
    </div>${rows}`;
}
// Mark/unmark a prayer for today (live build) and refresh the view.
function togglePrayer(key) {
  Stats.togglePrayer(key);
  renderPrayer(el("#view-prayer"));
}

// ---------- QIBLA ----------
async function renderQibla(v) {
  v.innerHTML = head("m_qibla", "m_qibla_d") + `
    <div class="card" style="text-align:center">
      <div class="compass" id="compass">
        <span class="deg N">${dirLabel("N")}</span><span class="deg S">${dirLabel("S")}</span><span class="deg E">${dirLabel("E")}</span><span class="deg W">${dirLabel("W")}</span>
        <span class="kaaba">🕋</span>
        <div class="needle" id="needle"></div>
      </div>
      <div id="qiblaFacing" class="qibla-facing">✓ ${t("facing_qibla")}</div>
      <div class="stat-row" style="margin-top:10px">
        <div class="stat"><div class="big" id="qiblaDeg">—</div><div class="lbl">${t("qibla_dir")}</div></div>
        <div class="stat"><div class="big" id="kaabaDist">—</div><div class="lbl">${t("distance_kaaba")}</div></div>
      </div>
      <button class="btn" onclick="locateQibla()">🧭 ${t("calibrate")}</button>
      <a class="btn ghost" id="qiblaMapBtn" target="_blank" rel="noopener" style="margin-top:8px;display:inline-block">🗺️ ${t("qibla_map")}</a>
      <p id="qiblaHint" style="color:var(--text-2);font-size:12.5px;margin-top:12px">${t("qibla_hint")}</p>
      <p id="qiblaDebug" style="color:var(--text-2);font-size:11px;margin-top:6px;opacity:.8"></p>
      <p style="color:var(--text-2);font-size:12px;margin-top:6px">↻ ${t("qibla_drag")}</p>
    </div>`;
  attachQiblaDrag();
  if (State.coords) applyQibla(State.coords);
  await refreshQiblaLocation();
}

async function refreshQiblaLocation() {
  const hint = el("#qiblaHint");
  if (hint) hint.textContent = t("locating");
  const c = await getLocation({ highAccuracy: true, timeout: 12000, maximumAge: 0 });
  if (State.route !== "qibla") return null;
  if (c) {
    applyQibla(c);
    loadPrayerTimes();
  } else if (!State.coords && hint) {
    hint.textContent = t("loc_fail");
  }
  return c;
}
// Single place that rotates the needle and lights the "Facing Qibla" badge.
let _needleRot = 0;
function qiblaSetNeedle(deg) {
  deg = ((deg % 360) + 360) % 360;
  _needleRot = deg;
  const n = el("#needle"); if (n) n.style.transform = `rotate(${deg}deg)`;
  const f = el("#qiblaFacing"); if (f) f.classList.toggle("on", Math.min(deg, 360 - deg) <= 6);
}
// Drag the dial to rotate it manually (handy for testing on a laptop with no compass).
function attachQiblaDrag() {
  const c = el("#compass"); if (!c) return;
  let dragging = false;
  const angleAt = (e) => {
    const r = c.getBoundingClientRect();
    const x = e.clientX - (r.left + r.width / 2), y = e.clientY - (r.top + r.height / 2);
    return ((Math.atan2(x, -y) * 180 / Math.PI) + 360) % 360; // clockwise from up
  };
  c.addEventListener("pointerdown", (e) => { dragging = true; c.setPointerCapture(e.pointerId); qiblaSetNeedle(angleAt(e)); });
  c.addEventListener("pointermove", (e) => { if (dragging) { e.preventDefault(); qiblaSetNeedle(angleAt(e)); } });
  c.addEventListener("pointerup", () => { dragging = false; });
  c.style.cursor = "grab";
}
// Great-circle bearing + distance from {lat,lng} to the Kaaba.
function applyQibla(c) {
  const kLa = 21.4225, kLo = 39.8262, R = 6371;
  const toRad = (x) => (x * Math.PI) / 180;
  const la = Number(c.lat), lo = Number(c.lng);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return;
  const dLon = toRad(kLo - lo);
  const y = Math.sin(dLon) * Math.cos(toRad(kLa));
  const x = Math.cos(toRad(la)) * Math.sin(toRad(kLa)) - Math.sin(toRad(la)) * Math.cos(toRad(kLa)) * Math.cos(dLon);
  let brng = (Math.atan2(y, x) * 180) / Math.PI; brng = (brng + 360) % 360;
  const dLat = toRad(kLa - la);
  const aa = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(la)) * Math.cos(toRad(kLa)) * Math.sin(dLon / 2) ** 2;
  const dist = Math.round(R * 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1 - aa)));
  State.qibla = brng;
  const source = c.source === "gps" ? t("loc_precise") : t("loc_approx");
  const accuracy = c.accuracy ? ` ±${Math.round(c.accuracy)}m` : "";
  const dbg = el("#qiblaDebug");
  if (dbg) dbg.textContent = `${source}${accuracy}: ${la.toFixed(5)}, ${lo.toFixed(5)} → ${Math.round(brng)}°`;
  const dg = el("#qiblaDeg"); if (dg) dg.textContent = Math.round(brng) + "°";
  const ds = el("#kaabaDist"); if (ds) ds.textContent = dist.toLocaleString() + " " + t("km");
  const mb = el("#qiblaMapBtn");
  if (mb) mb.href = `https://www.google.com/maps/dir/?api=1&origin=${c.lat},${c.lng}&destination=21.4225,39.8262`;
  const hint = el("#qiblaHint");
  if (hint) hint.textContent = c.source === "gps" ? t("qibla_hint") : t("qibla_approx");
  // Visibly swing the needle from North to the Qibla bearing on open.
  qiblaSetNeedle(0);
  setTimeout(() => startQiblaCompass(brng), 90); // then live needle if the device has a compass
}

// Live compass: rotate the needle by (qibla − device heading) so it points to the
// real Qibla as the user turns. Falls back to a static bearing when no sensor.
let _qiblaHandler = null, _compassLive = false, _compassTimer = null, _motionPermissionGranted = false;
function stopQiblaCompass() {
  if (_qiblaHandler) {
    window.removeEventListener("deviceorientationabsolute", _qiblaHandler, true);
    window.removeEventListener("deviceorientation", _qiblaHandler, true);
    _qiblaHandler = null;
  }
  if (_compassTimer) { clearTimeout(_compassTimer); _compassTimer = null; }
}
function startQiblaCompass(qibla) {
  stopQiblaCompass();
  _compassLive = false;
  let usedAbsolute = false;
  qiblaSetNeedle(qibla); // static default (assumes screen-up = North)
  const D = window.DeviceOrientationEvent;
  if (D && typeof D.requestPermission === "function" && !_motionPermissionGranted) {
    const hint = el("#qiblaHint");
    if (hint) hint.textContent = t("qibla_permission");
    return;
  }
  // Non-secure pages (http over LAN) have the compass blocked outright.
  if (!window.isSecureContext) {
    const hint = el("#qiblaHint"); if (hint) hint.textContent = t("qibla_insecure");
    return;
  }
  _qiblaHandler = (e) => {
    if (State.route !== "qibla") return stopQiblaCompass();
    let heading = null;
    if (typeof e.webkitCompassHeading === "number") heading = e.webkitCompassHeading;      // iOS: from North, CW
    else if (e.absolute === true && typeof e.alpha === "number") { heading = 360 - e.alpha; usedAbsolute = true; }
    else if (!usedAbsolute && typeof e.alpha === "number") heading = 360 - e.alpha;          // relative fallback
    if (heading == null) return;
    const screenAngle = (screen.orientation && Number.isFinite(screen.orientation.angle))
      ? screen.orientation.angle
      : (Number.isFinite(window.orientation) ? window.orientation : 0);
    heading = (heading + screenAngle + 360) % 360;
    _compassLive = true;
    const hint = el("#qiblaHint");
    if (hint && hint.dataset.live !== "1") { hint.dataset.live = "1"; hint.textContent = t("qibla_live"); }
    qiblaSetNeedle(qibla - heading);
  };
  window.addEventListener("deviceorientationabsolute", _qiblaHandler, true);
  window.addEventListener("deviceorientation", _qiblaHandler, true);
  // Otherwise, if no sensor data arrives shortly, explain why (permission / no compass).
  _compassTimer = setTimeout(() => {
    if (!_compassLive) { const hint = el("#qiblaHint"); if (hint) hint.textContent = t("qibla_nosensor"); }
  }, 2800);
}

// iOS 13+ needs an explicit permission request from a user gesture.
async function enableCompassPermission() {
  const D = window.DeviceOrientationEvent;
  if (D && typeof D.requestPermission === "function") {
    try {
      const s = await D.requestPermission();
      _motionPermissionGranted = s === "granted";
      if (_motionPermissionGranted && State.qibla != null) startQiblaCompass(State.qibla);
      if (!_motionPermissionGranted) toast(t("compass_denied"));
      return _motionPermissionGranted;
    } catch {
      toast(t("compass_denied"));
      return false;
    }
  }
  _motionPermissionGranted = true;
  return true;
}

async function locateQibla() {
  await enableCompassPermission();              // user gesture → ask for motion sensor (iOS)
  toast("📍 " + t("locating"));
  const c = await refreshQiblaLocation();        // fresh GPS first, IP fallback only if needed
  if (!c) return toast(t("loc_fail"));
  toast("📍 " + t("qibla_set"));
}

// ---------- CALENDAR ----------
const EVENT_STYLE = {
  wiladat: { emoji: "⭐", color: "rgba(31,123,255,.45)", label: "Wiladat" },
  shahadat: { emoji: "🏴", color: "rgba(6,27,70,.62)", label: "Shahadat" },
  occasion: { emoji: "✨", color: "rgba(53,164,255,.45)", label: "Occasion" },
};
let _calFilter = "all";

function renderCalendar(v) {
  const counts = { wiladat: 0, shahadat: 0, occasion: 0 };
  EVENTS.forEach((e) => counts[e.type]++);
  const legend = `<div class="chips">
    <span class="chip ${_calFilter === "all" ? "active" : ""}" onclick="setCal('all')">${tcat("All")} (${EVENTS.length})</span>
    ${Object.entries(EVENT_STYLE).map(([k, s]) => `<span class="chip ${_calFilter === k ? "active" : ""}" onclick="setCal('${k}')">${localizedText(s.label)} (${counts[k]})</span>`).join("")}
  </div>`;

  const months = HIJRI_MONTHS.map((m, i) => {
    let evs = EVENTS.filter((e) => e.mi === i + 1 && (_calFilter === "all" || e.type === _calFilter))
      .sort((a, b) => a.day - b.day);
    if (!evs.length) return "";
    const items = evs.map((e) => {
      const s = EVENT_STYLE[e.type];
      return `<div class="list-item">
        <div class="badge-num" style="background:linear-gradient(135deg,${s.color},transparent)">${e.day}</div>
        <div class="meta"><div class="t">${localizedText(e.en)}</div><div class="s">${e.day} ${localizedText(m)} · ${localizedText(s.label)}</div></div>
      </div>`;
    }).join("");
    return `<div class="page-head" style="margin-top:18px"><h1 style="font-size:16px;color:var(--text-0)">${i + 1}. ${localizedText(m)}</h1></div>${items}`;
  }).join("");

  v.innerHTML = head("m_calendar", "m_calendar_d") + legend + months;
}
function setCal(f) { _calFilter = f; renderCalendar(el("#view-calendar")); }

// ---------- AHLUL BAYT ----------
// The 25 prophets named in the Qur'an, with localized names (ks→ur, prs→fa, sg→en).
const PROPHETS = [
  { en: "Adam", ar: "آدم", ur: "آدم", fa: "آدم", az: "Adəm", ms: "Adam" },
  { en: "Idris", ar: "إدريس", ur: "ادریس", fa: "ادریس", az: "İdris", ms: "Idris" },
  { en: "Nuh", ar: "نوح", ur: "نوح", fa: "نوح", az: "Nuh", ms: "Nuh" },
  { en: "Hud", ar: "هود", ur: "ہود", fa: "هود", az: "Hud", ms: "Hud" },
  { en: "Salih", ar: "صالح", ur: "صالح", fa: "صالح", az: "Saleh", ms: "Soleh" },
  { en: "Ibrahim", ar: "إبراهيم", ur: "ابراہیم", fa: "ابراهیم", az: "İbrahim", ms: "Ibrahim" },
  { en: "Lut", ar: "لوط", ur: "لوط", fa: "لوط", az: "Lut", ms: "Lut" },
  { en: "Ismail", ar: "إسماعيل", ur: "اسماعیل", fa: "اسماعیل", az: "İsmayıl", ms: "Ismail" },
  { en: "Ishaq", ar: "إسحاق", ur: "اسحاق", fa: "اسحاق", az: "İshaq", ms: "Ishaq" },
  { en: "Yaqub", ar: "يعقوب", ur: "یعقوب", fa: "یعقوب", az: "Yaqub", ms: "Yaakub" },
  { en: "Yusuf", ar: "يوسف", ur: "یوسف", fa: "یوسف", az: "Yusif", ms: "Yusuf" },
  { en: "Ayyub", ar: "أيوب", ur: "ایوب", fa: "ایوب", az: "Əyyub", ms: "Ayub" },
  { en: "Shuayb", ar: "شعيب", ur: "شعیب", fa: "شعیب", az: "Şüeyb", ms: "Syuaib" },
  { en: "Musa", ar: "موسى", ur: "موسیٰ", fa: "موسی", az: "Musa", ms: "Musa" },
  { en: "Harun", ar: "هارون", ur: "ہارون", fa: "هارون", az: "Harun", ms: "Harun" },
  { en: "Dhul-Kifl", ar: "ذو الكفل", ur: "ذوالکفل", fa: "ذوالکفل", az: "Zülkifl", ms: "Zulkifli" },
  { en: "Dawud", ar: "داود", ur: "داؤد", fa: "داوود", az: "Davud", ms: "Daud" },
  { en: "Sulayman", ar: "سليمان", ur: "سلیمان", fa: "سلیمان", az: "Süleyman", ms: "Sulaiman" },
  { en: "Ilyas", ar: "إلياس", ur: "الیاس", fa: "الیاس", az: "İlyas", ms: "Ilyas" },
  { en: "Al-Yasa", ar: "اليسع", ur: "الیسع", fa: "الیسع", az: "Əlyəsə", ms: "Alyasa" },
  { en: "Yunus", ar: "يونس", ur: "یونس", fa: "یونس", az: "Yunus", ms: "Yunus" },
  { en: "Zakariyya", ar: "زكريا", ur: "زکریا", fa: "زکریا", az: "Zəkəriyya", ms: "Zakaria" },
  { en: "Yahya", ar: "يحيى", ur: "یحییٰ", fa: "یحیی", az: "Yəhya", ms: "Yahya" },
  { en: "Isa", ar: "عيسى", ur: "عیسیٰ", fa: "عیسی", az: "İsa", ms: "Isa" },
  { en: "Muhammad ﷺ", ar: "محمد ﷺ", ur: "محمد ﷺ", fa: "محمد ﷺ", az: "Məhəmməd ﷺ", ms: "Muhammad ﷺ" },
];
// The Twelve Imams of the Ahl al-Bait, with localized names.
const IMAMS = [
  { en: "Ali ibn Abi Talib", ar: "علي بن أبي طالب", ur: "علی ابن ابی طالب", fa: "علی ابن ابی‌طالب", az: "Əli ibn Əbu Talib", ms: "Ali ibn Abi Talib" },
  { en: "Hasan al-Mujtaba", ar: "الحسن المجتبى", ur: "حسن المجتبیٰ", fa: "حسن مجتبیٰ", az: "Həsən Müctəba", ms: "Hasan al-Mujtaba" },
  { en: "Husayn ibn Ali", ar: "الحسين بن علي", ur: "حسین ابن علی", fa: "حسین ابن علی", az: "Hüseyn ibn Əli", ms: "Husain ibn Ali" },
  { en: "Ali Zayn al-Abidin", ar: "علي زين العابدين", ur: "علی زین العابدین", fa: "علی زین‌العابدین", az: "Əli Zeynalabidin", ms: "Ali Zainul Abidin" },
  { en: "Muhammad al-Baqir", ar: "محمد الباقر", ur: "محمد الباقر", fa: "محمد باقر", az: "Məhəmməd Baqir", ms: "Muhammad al-Baqir" },
  { en: "Jafar al-Sadiq", ar: "جعفر الصادق", ur: "جعفر الصادق", fa: "جعفر صادق", az: "Cəfər Sadiq", ms: "Jaafar as-Sadiq" },
  { en: "Musa al-Kazim", ar: "موسى الكاظم", ur: "موسیٰ الکاظم", fa: "موسی کاظم", az: "Musa Kazim", ms: "Musa al-Kazim" },
  { en: "Ali al-Rida", ar: "علي الرضا", ur: "علی الرضا", fa: "علی رضا", az: "Əli Rza", ms: "Ali ar-Ridha" },
  { en: "Muhammad al-Jawad", ar: "محمد الجواد", ur: "محمد الجواد", fa: "محمد جواد", az: "Məhəmməd Cavad", ms: "Muhammad al-Jawad" },
  { en: "Ali al-Hadi", ar: "علي الهادي", ur: "علی الہادی", fa: "علی هادی", az: "Əli Hadi", ms: "Ali al-Hadi" },
  { en: "Hasan al-Askari", ar: "الحسن العسكري", ur: "حسن العسکری", fa: "حسن عسکری", az: "Həsən Əsgəri", ms: "Hasan al-Askari" },
  { en: "Muhammad al-Mahdi", ar: "محمد المهدي", ur: "محمد المہدی", fa: "محمد مهدی", az: "Məhəmməd Mehdi", ms: "Muhammad al-Mahdi" },
];
// Children of the Prophet Muhammad ﷺ (s: honorific ع — Fatimah al-Zahra, of the Ahl al-Bait).
const CHILDREN = [
  { en: "Qasim ibn Muhammad", ar: "القاسم بن محمد", ur: "قاسم بن محمد", fa: "قاسم بن محمد", az: "Qasim ibn Muhammad", ms: "Qasim ibn Muhammad" },
  { en: "Zainab bint Muhammad", ar: "زينب بنت محمد", ur: "زینب بنت محمد", fa: "زینب بنت محمد", az: "Zeynəb bint Muhammad", ms: "Zainab binti Muhammad" },
  { en: "Ruqayyah bint Muhammad", ar: "رقية بنت محمد", ur: "رقیہ بنت محمد", fa: "رقیه بنت محمد", az: "Rüqəyyə bint Muhammad", ms: "Ruqayyah binti Muhammad" },
  { en: "Umm Kulthum bint Muhammad", ar: "أم كلثوم بنت محمد", ur: "ام کلثوم بنت محمد", fa: "ام کلثوم بنت محمد", az: "Ümmü Gülsüm bint Muhammad", ms: "Ummu Kalthum binti Muhammad" },
  { en: "Fatimah al-Zahra bint Muhammad", ar: "فاطمة الزهراء بنت محمد", ur: "فاطمہ الزہرا بنت محمد", fa: "فاطمه زهرا بنت محمد", az: "Fatimə Zəhra bint Muhammad", ms: "Fatimah az-Zahra binti Muhammad" },
  { en: "Abdullah ibn Muhammad", ar: "عبد الله بن محمد", ur: "عبداللہ بن محمد", fa: "عبدالله بن محمد", az: "Abdullah ibn Muhammad", ms: "Abdullah ibn Muhammad" },
  { en: "Ibrahim ibn Muhammad", ar: "إبراهيم بن محمد", ur: "ابراہیم بن محمد", fa: "ابراهیم بن محمد", az: "İbrahim ibn Muhammad", ms: "Ibrahim ibn Muhammad" },
];
// Documented, named wives of the prophets (Khadijah — wife of the Prophet ﷺ — first),
// including the Mothers of the Believers and the wives of Ibrahim.
const WIVES = [
  { en: "Khadijah bint Khuwaylid", ar: "خديجة بنت خويلد", ur: "خدیجہ بنت خویلد", fa: "خدیجه بنت خویلد", az: "Xədicə bint Xüveylid", ms: "Khadijah binti Khuwailid", of: "Muhammad ﷺ" },
  { en: "Sawda bint Zam'a", ar: "سودة بنت زمعة", ur: "سودہ بنت زمعہ", fa: "سوده بنت زمعه", az: "Sevdə bint Zəmə", ms: "Saudah binti Zam'ah", of: "Muhammad ﷺ" },
  { en: "Aisha bint Abi Bakr", ar: "عائشة بنت أبي بكر", ur: "عائشہ بنت ابی بکر", fa: "عایشه بنت ابی‌بکر", az: "Ayşə bint Əbu Bəkr", ms: "Aisyah binti Abu Bakar", of: "Muhammad ﷺ" },
  { en: "Hafsa bint Umar", ar: "حفصة بنت عمر", ur: "حفصہ بنت عمر", fa: "حفصه بنت عمر", az: "Həfsə bint Ömər", ms: "Hafsah binti Umar", of: "Muhammad ﷺ" },
  { en: "Zaynab bint Khuzayma", ar: "زينب بنت خزيمة", ur: "زینب بنت خزیمہ", fa: "زینب بنت خزیمه", az: "Zeynəb bint Xüzeymə", ms: "Zainab binti Khuzaimah", of: "Muhammad ﷺ" },
  { en: "Umm Salama bint Abi Umayya", ar: "أم سلمة بنت أبي أمية", ur: "ام سلمہ بنت ابی امیہ", fa: "ام سلمه بنت ابی‌امیه", az: "Ümmü Sələmə bint Əbu Üməyyə", ms: "Ummu Salamah binti Abu Umayyah", of: "Muhammad ﷺ" },
  { en: "Zaynab bint Jahsh", ar: "زينب بنت جحش", ur: "زینب بنت جحش", fa: "زینب بنت جحش", az: "Zeynəb bint Cəhş", ms: "Zainab binti Jahsy", of: "Muhammad ﷺ" },
  { en: "Juwayriya bint al-Harith", ar: "جويرية بنت الحارث", ur: "جویریہ بنت الحارث", fa: "جویریه بنت الحارث", az: "Cüveyriyə bint Haris", ms: "Juwairiyah binti al-Harith", of: "Muhammad ﷺ" },
  { en: "Umm Habiba bint Abi Sufyan", ar: "أم حبيبة بنت أبي سفيان", ur: "ام حبیبہ بنت ابی سفیان", fa: "ام حبیبه بنت ابی‌سفیان", az: "Ümmü Həbibə bint Əbu Süfyan", ms: "Ummu Habibah binti Abu Sufyan", of: "Muhammad ﷺ" },
  { en: "Safiyya bint Huyayy", ar: "صفية بنت حيي", ur: "صفیہ بنت حیی", fa: "صفیه بنت حیی", az: "Səfiyyə bint Hüyəy", ms: "Safiyah binti Huyai", of: "Muhammad ﷺ" },
  { en: "Maymunah bint al-Harith", ar: "ميمونة بنت الحارث", ur: "میمونہ بنت الحارث", fa: "میمونه بنت الحارث", az: "Meymunə bint Haris", ms: "Maimunah binti al-Harith", of: "Muhammad ﷺ" },
  { en: "Maria al-Qibtiyya", ar: "مارية القبطية", ur: "ماریہ قبطیہ", fa: "ماریه قبطیه", az: "Mariyə Qibtiyyə", ms: "Mariah al-Qibtiyah", of: "Muhammad ﷺ" },
  { en: "Hawwa", ar: "حواء", ur: "حوا", fa: "حوا", az: "Həvva", ms: "Hawa", of: "Adam" },
  { en: "Sarah", ar: "سارة", ur: "سارہ", fa: "ساره", az: "Sara", ms: "Sarah", of: "Ibrahim" },
  { en: "Hajar", ar: "هاجر", ur: "ہاجرہ", fa: "هاجر", az: "Hacər", ms: "Hajar", of: "Ibrahim" },
  { en: "Qantura", ar: "قنطورا", ur: "قنطورا", fa: "قنطورا", az: "Qantura", ms: "Qantura", of: "Ibrahim" },
  { en: "Rafqah", ar: "رفقة", ur: "رفقہ", fa: "رفقه", az: "Rifqə", ms: "Rafqah", of: "Ishaq" },
  { en: "Rahil", ar: "راحيل", ur: "راحیل", fa: "راحیل", az: "Rahil", ms: "Rahil", of: "Yaqub" },
  { en: "Layya", ar: "ليا", ur: "لیا", fa: "لیا", az: "Leya", ms: "Layya", of: "Yaqub" },
  { en: "Rahmah", ar: "رحمة", ur: "رحمہ", fa: "رحمه", az: "Rəhmə", ms: "Rahmah", of: "Ayyub" },
  { en: "Safura", ar: "صفورا", ur: "صفورہ", fa: "صفورا", az: "Səfura", ms: "Safura", of: "Musa" },
  { en: "Bilqis", ar: "بلقيس", ur: "بلقیس", fa: "بلقیس", az: "Bilqis", ms: "Balqis", of: "Sulayman" },
  { en: "Isha", ar: "إيشاع", ur: "ایشاع", fa: "ایشاع", az: "İşa", ms: "Isya", of: "Zakariyya" },
];
// Other notable women mentioned in Islam / the Qur'an (Maryam — mother of Isa — carries ع).
const WOMEN = [
  { en: "Maryam", ar: "مريم", ur: "مریم", fa: "مریم", az: "Məryəm", ms: "Maryam", of: "mother of Isa", s: true },
  { en: "Asiya", ar: "آسية", ur: "آسیہ", fa: "آسیه", az: "Asiyə", ms: "Asiah", of: "believing wife of Pharaoh" },
  { en: "Hannah", ar: "حنة", ur: "حنہ", fa: "حنه", az: "Hənnə", ms: "Hannah", of: "mother of Maryam" },
  { en: "Umm Musa", ar: "أم موسى", ur: "ام موسیٰ", fa: "ام موسی", az: "Ümmü Musa", ms: "Ummu Musa", of: "mother of Musa" },
  { en: "Zulaykha", ar: "زليخا", ur: "زلیخا", fa: "زلیخا", az: "Züleyxa", ms: "Zulaikha", of: "in the story of Yusuf" },
  { en: "Khawla", ar: "خولة", ur: "خولہ", fa: "خوله", az: "Xövlə", ms: "Khaulah", of: "al-Mujadila" },
  { en: "Umm Ayman", ar: "أم أيمن", ur: "ام ایمن", fa: "ام ایمن", az: "Ümmü Əymən", ms: "Ummu Aiman", of: "companion of the Prophet ﷺ" },
];
// Righteous men — companions of the Prophet ﷺ & the Imams, and early Shia scholars.
const MEN = [
  ["Salman al-Farsi", "سلمان الفارسي"],
  ["Abu Dharr al-Ghifari", "أبو ذر الغفاري"],
  ["Miqdad ibn al-Aswad", "المقداد بن الأسود"],
  ["Ammar ibn Yasir", "عمار بن ياسر"],
  ["Bilal ibn Rabah", "بلال بن رباح"],
  ["Uways al-Qarani", "أويس القرني"],
  ["Hudhayfah ibn al-Yaman", "حذيفة بن اليمان"],
  ["Abu Ayyub al-Ansari", "أبو أيوب الأنصاري"],
  ["Jabir ibn Abd Allah al-Ansari", "جابر بن عبد الله الأنصاري"],
  ["Malik al-Ashtar", "مالك الأشتر"],
  ["Kumayl ibn Ziyad", "كميل بن زياد"],
  ["Maytham al-Tammar", "ميثم التمار"],
  ["Rashid al-Hijri", "رشيد الهجري"],
  ["Qanbar", "قنبر"],
  ["Hujr ibn Adi", "حجر بن عدي"],
  ["Muslim ibn Aqil", "مسلم بن عقيل"],
  ["Habib ibn Muzahir", "حبيب بن مظاهر"],
  ["Zuhayr ibn al-Qayn", "زهير بن القين"],
  ["Burayr ibn Khudayr", "بریر بن خضیر"],
  ["Hurr ibn Yazid al-Riyahi", "الحر بن يزيد الرياحي"],
  ["John ibn Huwayy", "جون بن حوي"],
  ["Mukhtar al-Thaqafi", "المختار الثقفي"],
  ["Ali ibn Yaqtin", "علي بن يقطين"],
  ["Hisham ibn al-Hakam", "هشام بن الحكم"],
  ["Zurarah ibn Ayan", "زرارة بن أعين"],
  ["Muhammad ibn Muslim", "محمد بن مسلم"],
  ["Aban ibn Taghlib", "أبان بن تغلب"],
  ["Al-Fadl ibn Shadhan", "الفضل بن شاذان"],
  ["Al-Shaykh al-Mufid", "الشيخ المفيد"],
  ["Al-Sharif al-Murtada", "الشريف المرتضى"],
  ["Al-Shaykh al-Tusi", "الشيخ الطوسي"],
].map(([en, ar]) => ({ en, ar, ur: ar, fa: ar, az: en, ms: en }));
const prophetName = (p) => (p && (p[QUIZ_LANG()] || p.en)) || "";

// salamMode: "all" (every name), "allButLast" (all except the last), or "flag" (only items with s:true)
function storyBoxes(list, opener, salamMode) {
  return list.map((p, i) => {
    const salam = salamMode === "all" ? true
      : salamMode === "allButLast" ? (i < list.length - 1)
      : !!p.s;
    return `
    <button class="story-box" data-i="${i + 1}" onclick="${opener}(${i})">
      <span class="story-num">${i + 1}</span>
      <span class="story-name">${prophetName(p)}${salam ? `<span class="story-salam">ع</span>` : ""}</span>
    </button>`;
  }).join("");
}
function renderAhlulBayt(v) {
  v.innerHTML = head("m_ahl_d") + `
    <div id="storiesBody">
      <div class="stories-cat">${localizedText("Prophets")}</div>
      <div class="stories-scroll">${storyBoxes(PROPHETS, "openStory", "allButLast")}</div>
      <div class="stories-cat">${localizedText("The Twelve Imams")}</div>
      <div class="stories-scroll">${storyBoxes(IMAMS, "openImam", "all")}</div>
      <div class="stories-cat">${localizedText("Righteous Men")}</div>
      <div class="stories-scroll">${storyBoxes(MEN, "openMan", "none")}</div>
      <div class="stories-cat">${localizedText("Children of the Prophet ﷺ")}</div>
      <div class="stories-scroll">${storyBoxes(CHILDREN, "openChild", "flag")}</div>
      <div class="stories-cat">${localizedText("Wives of the Prophets")}</div>
      <div class="stories-scroll">${storyBoxes(WIVES, "openWife", "flag")}</div>
      <div class="stories-cat">${localizedText("Women in Islam")}</div>
      <div class="stories-scroll">${storyBoxes(WOMEN, "openWoman", "flag")}</div>
    </div>`;
}

// A prophet / imam story opens in the slide-up reader sheet.
function storyText(obj) {
  if (!obj) return "";
  const f = QUIZ_LANG();
  return (obj[f] || obj.en || "");
}
function storyToHtml(txt, rtl) {
  return String(txt).split(/\n\s*\n/).map((para) => {
    const p = para.trim();
    if (!p) return "";
    return `<p style="margin:0 0 14px;line-height:1.95;color:var(--text-1);font-size:15px;${rtl ? "direction:rtl;text-align:right" : ""}">${escapeHtml(p)}</p>`;
  }).join("");
}
function openStorySheet(name, withSalam, story) {
  const backSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>';
  const rtl = ARABIC_SCRIPT_LANGS.includes(State.lang);
  const txt = storyText(story);
  const bodyHtml = txt
    ? `<div class="card story-read">${storyToHtml(txt, rtl)}</div>`
    : `<div class="card" style="text-align:center;color:var(--text-2);padding:30px 18px">${localizedText("Story coming soon, insha’Allah.")}</div>`;
  openQuranReader(`<div class="q-reader">
    <div class="qr-topbar">
      <button class="dua-back" onclick="history.back()" aria-label="${localizedText("Back")}">${backSvg}</button>
      <span class="qr-title">${name}${withSalam ? '<span class="story-salam">ع</span>' : ""}</span>
    </div>
    <div class="qr-body">${bodyHtml}</div>
  </div>`);
}
function openStory(i) {
  const p = PROPHETS[i]; if (!p) return;
  const story = (typeof PROPHET_STORIES !== "undefined") ? PROPHET_STORIES[i] : null;
  openStorySheet(prophetName(p), i < PROPHETS.length - 1, story);
}
const _story = (v, i) => (typeof window[v] !== "undefined" && window[v][i]) ? window[v][i] : null;
function openImam(i) { const p = IMAMS[i]; if (p) openStorySheet(prophetName(p), true, _story("IMAM_STORIES", i)); }
function openMan(i) { const p = MEN[i]; if (p) openStorySheet(prophetName(p), false, _story("MEN_STORIES", i)); }
function openChild(i) { const p = CHILDREN[i]; if (p) openStorySheet(prophetName(p), !!p.s, _story("CHILD_STORIES", i)); }
function openWife(i) { const p = WIVES[i]; if (p) openStorySheet(prophetName(p), false, _story("WIFE_STORIES", i)); }
function openWoman(i) { const p = WOMEN[i]; if (p) openStorySheet(prophetName(p), !!p.s, _story("WOMAN_STORIES", i)); }

// ---------- AI ASSISTANT ----------
function renderAI(v) {
  v.innerHTML = head("m_ai", "m_ai_d") + `
    <div class="card" style="border-color:var(--gold);background:linear-gradient(135deg,rgba(31,123,255,.14),transparent);margin-bottom:16px">
      <strong>⚠️ ${t("ai_disclaimer")}</strong>
    </div>
    <div class="card">
      <div class="chips" style="margin-bottom:10px">${aiStatusBadge()}</div>
      <div class="chat" id="chat">
        <div class="bubble ai">${localizedText("Assalamu Alaikum! Ask me about the Quran, hadith of Ahlul Bayt (AS), duas or Islamic history.")} <span class="ref">${localizedText("I always cite references and never issue rulings.")}</span></div>
      </div>
      <div class="chat-input">
        <input id="aiInput" data-i18n-ph="ask_placeholder" placeholder="${t("ask_placeholder")}" onkeydown="if(event.key==='Enter')aiSend()">
        <button class="btn" onclick="aiSend()">${t("send")}</button>
      </div>
    </div>`;
  refreshAiStatus();
}
async function aiSend() {
  const inp = el("#aiInput"); const q = inp.value.trim(); if (!q) return;
  const chat = el("#chat");
  chat.insertAdjacentHTML("beforeend", `<div class="bubble user">${escapeHtml(q)}</div>`);
  inp.value = "";
  const typing = document.createElement("div");
  typing.className = "bubble ai"; typing.textContent = "…"; chat.appendChild(typing);
  chat.scrollTop = chat.scrollHeight;
  const rxId = "ai_" + hashCode(q);
  const render = (answer, ref, withReact) => {
    typing.innerHTML = escapeHtml(localizedText(answer)) +
      (ref ? `<span class="ref">${escapeHtml(localizedText(ref))}</span>` : "") +
      (withReact ? reactionBar(rxId) : "");
    chat.scrollTop = chat.scrollHeight;
  };

  // Try streaming the answer live; settle with a reaction bar when complete.
  let fullText = "";
  const streamed = await streamAsk(q, (full) => {
    fullText = full;
    const { answer, ref } = splitAnswerRef(full);
    render(answer || "…", ref, false);
  });
  if (streamed) {
    const { answer, ref } = splitAnswerRef(fullText);
    render(answer, ref, true);
    return;
  }

  // Fallback: live backend (/ask), else the client-side local brain.
  const d = await askOrLocal(q);
  typing.innerHTML = `${escapeHtml(localizedText(d.answer))}<span class="ref">${escapeHtml(localizedText(d.reference || ""))}</span>` +
    `${d.requires_scholar ? `<span class="ref">⚠️ ${localizedText("For any ruling, consult your marja al-taqlid.")}</span>` : ""}` +
    reactionBar(rxId);
  chat.scrollTop = chat.scrollHeight;
}

// ---------- LIBRARY (real downloaded books, categorized) ----------
const BOOK_CAT = {
  "Al-Kafi-Volume-1-Kulayni": "Theology", "Al-Kafi-Volume-2-Kulayni": "Ethics",
  "Al-Kafi-Volume-3-Kulayni": "Fiqh", "Al-Kafi-Volume-4-Kulayni": "Fiqh",
  "Al-Kafi-Volume-5-Kulayni": "Fiqh", "Al-Kafi-Volume-6-Kulayni": "Fiqh",
  "Al-Kafi-Volume-7-Kulayni": "Fiqh", "Al-Kafi-Volume-8-Kulayni": "Hadith",
  "Man-La-Yahduruh-al-Faqih-Volume-1-Saduq": "Fiqh", "Man-La-Yahduruh-al-Faqih-Volume-2-Saduq": "Fiqh",
  "Man-La-Yahduruh-al-Faqih-Volume-3-Saduq": "Fiqh", "Man-La-Yahduruh-al-Faqih-Volume-4-Saduq": "Fiqh",
  "Man-La-Yahduruh-al-Faqih-Volume-5-Saduq": "Fiqh",
  "Nahj-al-Balagha-Radi": "Ethics", "Risalat-al-Huquq-Abidin": "Ethics",
  "Al-Tawhid-Saduq": "Aqeedah", "Kitab-al-Ghayba-Numani": "Aqeedah", "Kitab-al-Ghayba-Tusi": "Aqeedah",
  "Kamal-al-Din-wa-Tamam-al-Nima-Saduq": "Aqeedah", "Fadail-al-Shia-Saduq": "Aqeedah", "Sifat-al-Shia-Saduq": "Aqeedah",
  "Kamil-al-Ziyarat-Qummi": "Ziyarat",
  "Uyun-akhbar-al-Rida-Volume-1-Saduq": "History", "Uyun-akhbar-al-Rida-Volume-2-Saduq": "History",
  "Al-Amali-Mufid": "History", "Al-Amali-Saduq": "History",
  "Al-Khisal-Saduq": "Ethics", "Maani-al-Akhbar-Saduq": "Theology",
  "Thawab-al-Amal-wa-iqab-al-Amal-Saduq": "Ethics", "Kitab-al-Zuhd-Ahwazi": "Ethics",
  "Kitab-al-Mumin-Ahwazi": "Ethics", "Kitab-al-Duafa-Ghadairi": "Rijal",
  "Mujam-al-Ahadith-al-Mutabara-Muhsini": "Hadith",
  "Peshawar-Nights-Shirazi": "History",
  "Man-La-Yahduruh-al-Faqih-Saduq": "Fiqh",
};
const catEmoji = { Fiqh: "⚖️", Ethics: "📗", Aqeedah: "🕌", Theology: "☪️", History: "📜", Ziyarat: "🤲", Rijal: "👤", Hadith: "📖" };
let _libFilter = "All";

async function renderLibrary(v) {
  v.innerHTML = head("m_library", "m_library_d") + `<div id="libBody"><div class="card">${t("loading_library")}</div></div>`;
  try {
    const d = await api("/hadith/books");
    const nCats = new Set(Object.values(BOOK_CAT)).size;
    const hlibAr = { istibsar: "الاستبصار", tahdhib: "تهذيب الأحكام", mizan: "ميزان الحكمة", mustadrak: "مستدرك الوسائل", wasail: "وسائل الشيعة", bihar: "بحار الأنوار" };
    const bookCards = d.books.map((b) => {
      const cat = BOOK_CAT[b.bookId] || "Hadith";
      return `<div class="module-card" style="opacity:1;transform:none" onclick="${b.downloaded ? `openBook('${b.bookId}')` : `toast(t('downloading'))`}">
        <span class="glow" style="--accent:var(--royal)"></span>
        <h3 style="font-size:15px">${disp(b.name, HADITH_AR[b.bookId] || b.name, t("nav_hadith"))}</h3>
        <p>${tcat(cat)} · ${b.count.toLocaleString()} ${t("narrations")}</p>
      </div>`;
    }).join("");
    const hlibCards = HLIB_LIST.map((tk, i) => `<div class="module-card" style="opacity:1;transform:none" onclick="openHlib(${i})">
        <span class="glow" style="--accent:var(--royal)"></span>
        <h3 style="font-size:15px">${disp(tk.name, hlibAr[tk.slug] || tk.name, t("nav_hadith"))}</h3>
        <p>${tcat("Hadith")} · ${(HLIB_NARR[tk.slug] || 0).toLocaleString()} ${t("narrations")}</p>
      </div>`).join("");
    const totalBooks = d.books.length + HLIB_LIST.length;
    const totalNarr = d.books.reduce((a, b) => a + b.count, 0) + hlibNarrTotal();
    el("#libBody").innerHTML = `
      <div class="lib-stats">
        <div class="lib-stat"><span class="lib-stat-ic">${BOOKS_ICON}</span><div class="lib-stat-n">${totalBooks}</div><div class="lib-stat-l">${t("total_books")}</div></div>
        <div class="lib-stat"><span class="lib-stat-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 21c3 0 7-1 7-8V5H4v6h4"/><path d="M14 21c3 0 7-1 7-8V5h-6v6h4"/></svg></span><div class="lib-stat-n">${totalNarr.toLocaleString()}</div><div class="lib-stat-l">${t("total_narr")}</div></div>
        <div class="lib-stat"><span class="lib-stat-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg></span><div class="lib-stat-n">${nCats}</div><div class="lib-stat-l">${t("categories")}</div></div>
      </div>
      <div class="grid modules">${bookCards}${hlibCards}</div>
      <div class="page-head" style="margin-top:26px"><h1 style="font-size:18px">${t("pdf_library")}</h1><p>${t("pdf_sub")}</p></div>
      <div class="grid modules" id="pdfGrid"></div>`;
    loadPdfs();
  } catch {
    el("#libBody").innerHTML = offlineBanner();
  }
}
function setLibFilter(c) { _libFilter = c; renderLibrary(el("#view-library")); }

async function loadPdfs() {
  try {
    const d = await api("/library/pdfs");
    el("#pdfGrid").innerHTML = d.pdfs.map((p) => `
      <div class="module-card" style="opacity:1;transform:none" onclick='openPdf(${JSON.stringify(p).replace(/'/g, "&#39;")})'>
        <span class="glow" style="--accent:var(--plum)"></span>
        <h3 style="font-size:15px">${disp(p.en, p.ar || p.en, t("nav_hadith"))}</h3>
        <p>${localizedText(p.cat)} · ${localizedText(p.author)} · PDF${p.edition ? " · " + editionLabel(p.edition) : ""}</p>
      </div>`).join("");
  } catch { /* backend offline */ }
}
function openPdf(p) {
  let m = el("#pdfModal");
  if (!m) {
    m = document.createElement("div");
    m.id = "pdfModal";
    m.style.cssText = "position:fixed;inset:0;z-index:200;background:rgba(3,8,16,.85);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);display:flex;flex-direction:column;padding:14px";
    document.body.appendChild(m);
  }
  m.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px;color:var(--text-0)">
      <strong style="flex:1">📕 ${disp(p.en, p.ar || p.en, t("nav_hadith"))} — ${localizedText(p.author)}</strong>
      <button class="btn" onclick="document.getElementById('pdfModal').remove()">✕</button>
    </div>
    <iframe src="${p.url}" style="flex:1;width:100%;border:none;border-radius:14px;background:var(--bg-0)"></iframe>`;
  m.style.display = "flex";
}

// ---------- COMMUNITY ----------
// reactions persist locally (no account / no server) — "complete access" toggling
const REACTIONS = JSON.parse(localStorage.getItem("wilayat.reactions") || "{}");
const saveReactions = () => localStorage.setItem("wilayat.reactions", JSON.stringify(REACTIONS));

// ----- Live-AI status badge (Claude vs built-in answers) -----
function aiStatusBadge() {
  return `<span class="chip ai-status" style="cursor:default">… ${localizedText("checking AI")}</span>`;
}
async function refreshAiStatus() {
  const badges = els(".ai-status");
  if (!badges.length) return;
  let label = "⚪ " + localizedText("Built-in answers");
  try {
    const d = await api("/ai/status");
    label = d.live ? `🟢 ${localizedText("Live AI")} · ${d.model}` : "⚪ " + localizedText("Built-in answers");
  } catch { label = "⚪ " + localizedText("Offline - built-in answers"); }
  badges.forEach((b) => (b.textContent = label));
}

// ----- Streaming answer consumer (SSE) with graceful fallback -----
// Splits the streamed text into answer + "REFERENCE: …" tail.
function splitAnswerRef(full) {
  const i = full.indexOf("REFERENCE:");
  if (i < 0) return { answer: full, ref: "" };
  return { answer: full.slice(0, i).trim(), ref: full.slice(i + "REFERENCE:".length).trim() };
}
// onChunk(fullText) per token; resolves true if streamed ok, false to fall back.
async function streamAsk(question, onChunk) {
  try {
    const r = await fetch(`${API_BASE}/ai/ask/stream`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, lang: State.lang }),
    });
    if (!r.ok || !r.body) return false; // e.g. 503 (no key) → caller falls back
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "", full = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        let obj;
        try { obj = JSON.parse(line.slice(5).trim()); } catch { continue; }
        if (obj.error) return false;       // mid-stream failure → fall back
        if (obj.done) return true;
        if (obj.t) { full += obj.t; onChunk(full); }
      }
    }
    return true;
  } catch {
    return false;
  }
}

// ----- Client-side "local brain" — works even with the backend offline -----
const OFFTOPIC_MSG = "This chat is only for Al-Wilayat - Islamic questions about the Quran, the Ahlul Bayt (AS) and matters of faith. Please ask about those.";
const LOCAL_BELIEFS = [
  { k: ["tawhid", "tawheed", "oneness", "monotheism", "unity of god"],
    a: "Tawhid is the absolute Oneness of Allah — One in His Essence, Attributes and actions, with no partner, equal or resemblance to creation. It is the first root of religion (Usul al-Din).",
    r: "Quran 112 (al-Ikhlas) · Nahj al-Balagha, Sermon 1 — Imam Ali (AS)." },
  { k: ["adl", "adalah", "divine justice", "justice"],
    a: "Adl means Divine Justice: Allah is absolutely just, never wrongs anyone and acts with wisdom. Humans have free will and are accountable for their deeds. It is the second root of religion.",
    r: "Quran 4:40 — 'Indeed Allah does not wrong [anyone] by an atom's weight.'" },
  { k: ["nubuwwah", "nubuwwat", "prophethood", "prophet", "messenger", "risalah"],
    a: "Nubuwwah is Prophethood: Allah sent prophets to guide humanity, from Adam (AS) to the final Messenger Muhammad (S). Prophets are infallible (masum) in conveying the message.",
    r: "Quran 33:40 — 'Muhammad is the Messenger of Allah and the Seal of the Prophets.'" },
  { k: ["imamah", "imamat", "imam", "wilayah", "wilayat", "successor", "ghadir", "twelve imams", "ali"],
    a: "Imamah is the divinely-appointed leadership after the Prophet (S). The twelve Imams, from Imam Ali (AS) to Imam al-Mahdi (AJ), are appointed by Allah, infallible, and the authoritative guides of the religion.",
    r: "Quran 5:55 · Hadith al-Ghadir · Hadith al-Thaqalayn." },
  { k: ["ma'ad", "maad", "resurrection", "hereafter", "qiyamah", "day of judgment", "akhirah", "afterlife"],
    a: "Maad is the Resurrection: every soul will be raised on the Day of Judgement and recompensed for its deeds — Paradise for the righteous, accountability for the wrongdoers. It is the fifth root of religion.",
    r: "Quran 99:7-8 — 'Whoever does an atom's weight of good or evil will see it.'" },
];
const LOCAL_GREET = ["hi", "hello", "hey", "salam", "salaam", "assalam", "asalam", "marhaba", "greetings", "salamun"];
const LOCAL_HINTS = ["allah", "god", "islam", "muslim", "shia", "quran", "qur'an", "surah", "ayah", "hadith",
  "sunnah", "prophet", "muhammad", "ahlul", "ahl al", "imam", "fatima", "zahra", "hasan", "husayn", "hussain",
  "sadiq", "baqir", "kazim", "rida", "mahdi", "ghadir", "dua", "munajat", "ziyarat", "namaz", "salah", "salat",
  "prayer", "fast", "sawm", "ramadan", "karbala", "ashura", "muharram", "marja", "fiqh", "aqeedah", "tawhid",
  "nubuwwah", "imamah", "jannah", "hajj", "kaaba", "masjid", "mosque", "zakat", "khums", "faith", "belief", "wudu"];
const LOCAL_RULING = ["fatwa", "ruling", "is it halal", "is it haram", "permissible", "wajib", "must i"];
const LOCAL_SMALLTALK = [
  { k: ["how are you", "how r u", "how do you do", "how's it going", "hows it going"],
    a: "Alhamdulillah, I'm well and at your service. Ask me about the Qur'an, the Ahlul Bayt (AS), duas or core beliefs." },
  { k: ["thank", "shukran", "jazak"],
    a: "You're most welcome — barakallahu fik. Is there anything else about Islam you'd like to know?" },
  { k: ["who are you", "what are you", "your name", "who r u", "what is this"],
    a: "I'm Wilayat Chat — a helper for questions about Islam in the school of the Ahlul Bayt (AS): the Qur'an, hadith, duas and beliefs, always with a reference." },
  { k: ["bye", "goodbye", "good night", "khuda hafiz", "fi amanillah", "see you"],
    a: "Fi amanillah — may Allah protect you. Come back any time with your questions." },
  { k: ["what can you do", "help", "what do you do"],
    a: "I can answer questions about the Qur'an, the hadith of the Ahlul Bayt (AS), duas, ziyarat, Islamic history and the core beliefs of Shia Islam — always with a reference." },
];

function localBrain(q) {
  const s = (q || "").toLowerCase().trim();
  const words = s.replace(/[?!.,]/g, " ").split(/\s+/).filter(Boolean);
  if (LOCAL_RULING.some((t) => s.includes(t)))
    return { answer: "This concerns a religious ruling. Wilayat Chat does not issue fatwas - please consult your marja al-taqlid or a qualified scholar.", reference: "Quran 16:43 - Ask the people of remembrance if you do not know.", requires_scholar: true };
  if (words.length <= 3 && (words.some((w) => LOCAL_GREET.includes(w)) || ["salam", "salaam", "marhaba"].some((x) => s.includes(x))))
    return { answer: "Wa alaykum as-salam! I'm Wilayat Chat. Ask me about the Qur'an, the Ahlul Bayt (AS), duas, ziyarat or the core beliefs of Shia Islam.", reference: "Al-Wilayat" };
  for (const st of LOCAL_SMALLTALK) if (st.k.some((t) => s.includes(t))) return { answer: st.a, reference: "Al-Wilayat" };
  for (const b of LOCAL_BELIEFS) if (b.k.some((t) => s.includes(t))) return { answer: b.a, reference: b.r };
  if (s.includes("knowledge") || s.includes("ilm"))
    return { answer: "The pursuit of knowledge is strongly emphasised in the school of the Ahlul Bayt (AS).", reference: "Al-Kafi — Imam al-Sadiq (AS): 'Seeking knowledge is an obligation upon every Muslim.'" };
  if (["husayn", "hussain", "ashura", "karbala"].some((t) => s.includes(t)))
    return { answer: "Imam al-Husayn (AS) was martyred at Karbala on the 10th of Muharram (Ashura), standing against tyranny so that truth and justice would live on.", reference: "Ziyarat Ashura · Mafatih al-Jinan." };
  if (LOCAL_HINTS.some((t) => s.includes(t)))
    return { answer: "I can help with the Qur'an, the hadith of the Ahlul Bayt (AS), duas, ziyarat and the core beliefs of Shia Islam — always with a reference. Could you give a little more detail about what you'd like to know?", reference: "Quran 16:43 — 'Ask the people of remembrance if you do not know.'" };
  return { answer: OFFTOPIC_MSG, reference: "Al-Wilayat" };
}

// Try the live backend (/ai/ask); if it's unreachable, answer with the local brain.
async function askOrLocal(q) {
  try {
    const r = await fetch(`${API_BASE}/ai/ask`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: q, lang: State.lang }),
    });
    if (!r.ok) throw new Error("bad status");
    const d = await r.json();
    if (!d || !d.answer) throw new Error("empty");
    return d;
  } catch {
    return localBrain(q);
  }
}

// Shia indicators in OSM names (denomination tags are often missing upstream)
const SHIA_RE = /shi'?[ai]|ja'?fari|jaffari|husayn|hussain|husain|hosseini|imam\s*barg|imambarg|imambara|husayniyy|hussainiyy|hosseiniy|ahl[- ]?al[- ]?bayt|ahlul\s*bayt|al-?zahra|az-?zahra|al-?mahdi|al-?askari|al-?kazim|ithna|twelver|fatemi|fatima|panjtan/i;

function renderCommunity(v) {
  v.innerHTML = head("m_community", "m_community_d") + `
    <div class="card info-card" style="margin-bottom:16px">
      <div class="info-card-head">
        <div class="info-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg></div>
        <div class="meta">
          <div class="t">${t("mosque_locator")}</div>
          <div class="s">${t("mosque_sub")}</div>
        </div>
      </div>
      <button class="btn info-btn" onclick="findMosques()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
        ${t("find_mosques")}
      </button>
      <div id="mosqueResults"></div>
    </div>

    <div class="card info-card">
      <div class="info-card-head">
        <div class="info-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg></div>
        <div class="meta">
          <div class="t">${t("license_privacy")}</div>
          <div class="s">${t("license_privacy_sub")}</div>
        </div>
      </div>
      <button class="btn info-btn" onclick="openPrivacy()">${t("privacy_open")}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>
      </button>
    </div>`;
}

// ---------- GLOBAL SEARCH (Quran · hadith · dua · ziyarat) ----------
// Run from the top-bar search box: finds the exact line and related ones,
// and every result jumps straight into the full surah / book / text.
// Live suggestions: matching app sections listed as you type (first-letter first).
function positionSuggest() {
  const box = el("#searchSuggest"), bar = el(".search"); if (!box || !bar) return;
  const r = bar.getBoundingClientRect();
  box.style.left = r.left + "px"; box.style.top = (r.bottom + 8) + "px"; box.style.width = r.width + "px";
}
function searchGoto(route) {
  el("#searchSuggest")?.classList.remove("open");
  const inp = el(".search input"); if (inp) inp.value = "";
  updateSearchMark();
  go(route);
}
function searchSuggest(q) {
  const box = el("#searchSuggest"); if (!box) return;
  q = (q || "").trim().toLowerCase();
  if (!q) { box.classList.remove("open"); box.innerHTML = ""; return; }
  const items = NAV.map(([r, k]) => ({ r, name: t(k) }))
    .filter((x) => x.name && x.name.toLowerCase().includes(q));
  items.sort((a, b) => {
    const ap = a.name.toLowerCase().startsWith(q) ? 0 : 1;   // first-letter matches on top
    const bp = b.name.toLowerCase().startsWith(q) ? 0 : 1;
    return ap - bp || a.name.localeCompare(b.name);
  });
  if (!items.length) { box.classList.remove("open"); box.innerHTML = ""; return; }
  box.innerHTML = items.slice(0, 8).map((x) => `
    <button class="ss-item" onmousedown="event.preventDefault()" onclick="searchGoto('${x.r}')">
      <span class="ss-ic">${icon(x.r)}</span>
      <span class="ss-name">${x.name}</span>
      <span class="ss-go" aria-hidden="true">›</span>
    </button>`).join("");
  positionSuggest();
  box.classList.add("open");
}

function globalSearch(q) {
  q = (q || "").trim();
  if (q.length < 2) return;
  State.searchQ = q;
  const input = el(".search input");
  if (input) input.value = q;
  go("search");
  updateSearchMark();
}

function updateSearchMark() {
  const btn = el("#searchBackBtn");
  const input = el(".search input");
  if (!btn || !input) return;
  btn.classList.toggle("show", State.route === "search" || input.value.trim().length > 0);
}

// Live-filter the home module boxes as the user types in the search bar.
function filterHomeModules(q) {
  const view = el("#view-home");
  if (!view) return;
  const query = (q || "").trim().toLowerCase();
  let shown = 0;
  view.querySelectorAll(".module-card").forEach((card) => {
    const match = !query || card.textContent.toLowerCase().includes(query);
    card.style.display = match ? "" : "none";
    if (match) shown += 1;
  });
  const grid = view.querySelector(".grid.modules");
  let empty = view.querySelector(".modules-empty");
  if (grid && query && shown === 0) {
    if (!empty) { empty = document.createElement("div"); empty.className = "modules-empty card"; grid.after(empty); }
    empty.textContent = t("no_matches"); empty.style.display = "";
  } else if (empty) { empty.style.display = "none"; }
}

function closeSearchFromBar() {
  const input = el(".search input");
  if (input) input.value = "";
  State.searchQ = "";
  updateSearchMark();
  filterHomeModules("");
  if (State.route === "search") appBack("home");
}

// Open a full dua / ziyarat text inline in the search results.
async function openSearchText(kind, id) {
  const ex = document.getElementById("textReader");
  if (ex && ex.dataset.key === kind + ":" + id) { ex.remove(); return; }
  if (ex) ex.remove();
  const box = document.createElement("div");
  box.id = "textReader"; box.dataset.key = kind + ":" + id; box.className = "card";
  box.style.marginTop = "12px"; box.innerHTML = t("loading");
  el("#searchBody").prepend(box);
  const close = `<button class="btn ghost" onclick="document.getElementById('textReader').remove()">✕</button>`;
  try {
    const d = await api(`/${kind}/full/${id}`);
    box.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
        <h2 style="flex:1;font-family:Amiri,serif;color:var(--text-0)">${d.ar_title || ""}</h2>${close}
      </div>
      <p style="color:var(--text-2);margin-bottom:14px">${disp(d.en_title, d.ar_title, t("passages"))} · ${d.count || 0} ${t("passages")}</p>
      ${(d.verses || []).map((vrs) => {
        if (vrs.head) return `<h3 style="color:var(--text-0);margin:18px 0 8px;font-size:16px">${hadithTrans(vrs) || localizedText(vrs.en || "")}</h3>`;
        const ar = vrs.ar ? `<div class="ar">${vrs.ar}</div>` : "";
        const tr = hadithTrans(vrs);
        const en = tr ? `<div class="tr"${vrs.ar ? "" : ' style="font-size:16px;color:var(--text-1)"'}>${tr}</div>` : "";
        return `<div class="ayah-block">${ar}${en}</div>`;
      }).join("")}`;
    box.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch {
    box.innerHTML = `<div style="display:flex;gap:10px"><span style='flex:1;color:var(--text-2)'>${localizedText("Text unavailable. Please make sure the backend is running.")}</span>${close}</div>`;
  }
}

// Modules (Quran, Hadith, …) whose name matches the query — shown as boxes.
function matchModules(q) {
  const ql = q.toLowerCase();
  return MODULES.filter((m) =>
    m.id.includes(ql) || ql.includes(m.id) ||
    t(m.titleKey).toLowerCase().includes(ql) || t(m.descKey).toLowerCase().includes(ql));
}
function moduleBoxes(mods) {
  if (!mods.length) return "";
  return `<div class="page-head"><h1 style="font-size:18px">${t("sections")}</h1></div>
    <div class="grid modules">${mods.map((m) => `
      <div class="module-card" style="opacity:1;transform:none" onclick="go('${routeFor(m.id)}')">
        <span class="glow" style="--accent:${m.accent}"></span>
        <h3>${t(m.titleKey)}</h3><p>${t(m.descKey)}</p>
      </div>`).join("")}</div>`;
}

async function renderSearch(v) {
  const q = State.searchQ || "";
  v.innerHTML = `<div class="page-head"><button class="screen-back" onclick="closeSearchFromBar()" aria-label="Back">←</button><div class="eyebrow wilayat-mark">Al-Wilayat</div>
      <h1>${t("search_title")}</h1><p>${t("results_for")} “${escapeHtml(q)}”</p></div>
    <div id="searchBody"></div>`;
  const body = el("#searchBody");
  if (!q) { body.innerHTML = `<div class="card">${t("type_to_search")}</div>`; return; }

  // If the query names a section (e.g. "hadith", "quran"), show only that box —
  // not the text lines. Text-line results are for actual verses / hadith phrases.
  const mods = matchModules(q);
  if (mods.length) { body.innerHTML = moduleBoxes(mods); return; }

  // Otherwise search the corpus for matching lines.
  body.innerHTML = `<div id="searchContent"><div class="card">${t("searching")}</div></div>`;
  const content = el("#searchContent");
  const enc = encodeURIComponent(q);
  const safe = (p) => api(p).catch(() => null); // a missing endpoint shouldn't sink the page
  try {
    const [hd, qr, du, zi] = await Promise.all([
      api(`/hadith/search?q=${enc}&limit=40`),   // these two define backend availability
      api(`/quran/search?q=${enc}&limit=30`),
      safe(`/dua/search?q=${enc}&limit=20`),
      safe(`/ziyarat/search?q=${enc}&limit=20`),
    ]);
    const hadith = hd.results || [], verses = qr.results || [];
    const duas = (du && du.results) || [], ziyarat = (zi && zi.results) || [];
    if (!hadith.length && !verses.length && !duas.length && !ziyarat.length) {
      content.innerHTML = `<div class="card">${t("no_matches")}</div>`;
      return;
    }
    const lineCard = (ar, en, foot, onclick) => `
      <div class="card" style="margin-bottom:12px;cursor:pointer" onclick="${onclick}">
        ${ar ? `<div class="ar" style="margin-bottom:8px">${ar}</div>` : ""}
        ${translatedContent(en) ? `<div class="tr">${escapeHtml(translatedContent(en))}</div>` : ""}
        <div class="s" style="margin-top:6px;color:var(--text-1)">${localizedText(foot)} ›</div>
      </div>`;
    const section = (label, n, html) => n
      ? `<div class="page-head" style="margin-top:18px"><h1 style="font-size:18px">${label} (${n})</h1></div>${html}` : "";

    const hadithHtml = hadith.map((h) =>
      lineCard(arHadithText(h.ar), h.en, `📖 ${escapeHtml((h.reference && h.reference.citation) || h.name || t("nav_hadith"))}`,
        `go('hadith');setTimeout(()=>openBook('${h.bookId}'),60)`)).join("");
    const verseHtml = verses.map((vv) =>
      lineCard(vv.ar, vv.en, `📖 ${t("nav_quran")} ${vv.surah}:${vv.ayah} (${escapeHtml(localizedText(vv.surahName || ""))})`,
        `go('quran');setTimeout(()=>openSurah(${vv.surah}),60)`)).join("");
    const duaHtml = duas.map((d) =>
      lineCard(d.ar, d.en, `🤲 ${escapeHtml(localizedText(d.title || t("nav_dua")))}`, `openSearchText('dua','${d.id}')`)).join("");
    const ziHtml = ziyarat.map((z) =>
      lineCard(z.ar, z.en, `🕋 ${escapeHtml(localizedText(z.title || t("nav_ziyarat")))}`, `openSearchText('ziyarat','${z.id}')`)).join("");

    content.innerHTML = section(t("nav_hadith"), hadith.length, hadithHtml)
      + section(t("nav_quran"), verses.length, verseHtml)
      + section(t("nav_dua"), duas.length, duaHtml)
      + section(t("nav_ziyarat"), ziyarat.length, ziHtml);
  } catch {
    content.innerHTML = offlineBanner();
  }
}

// ----- Mosque locator (browser geolocation → OpenStreetMap Overpass) -----
async function findMosques() {
  const box = el("#mosqueResults");
  box.innerHTML = `<div class="s status-line"><span class="stat-ic">${PIN_ICON}</span>${t("getting_loc")}</div>`;
  const c = State.coords || await getLocation(); // GPS → IP fallback
  if (!c) {
    box.innerHTML = `<div class="s">${t("no_loc")}</div>`;
    return;
  }
  box.innerHTML = `<div class="s status-line"><span class="stat-ic">${SEARCH_ICON}</span>${t("searching_near")}</div>`;
  queryMosques(c.lat, c.lng, box);
}

const haversine = (la1, lo1, la2, lo2) => {
  const R = 6371, d = (x) => x * Math.PI / 180;
  const a = Math.sin(d(la2 - la1) / 2) ** 2 +
    Math.cos(d(la1)) * Math.cos(d(la2)) * Math.sin(d(lo2 - lo1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
};

async function queryMosques(lat, lng, box) {
  box.innerHTML = `<div class="s status-line"><span class="stat-ic">${SEARCH_ICON}</span>${t("searching")}</div>`;
  const radius = 20000;
  const oql = `[out:json][timeout:25];(` +
    `node["amenity"="place_of_worship"]["religion"="muslim"](around:${radius},${lat},${lng});` +
    `way["amenity"="place_of_worship"]["religion"="muslim"](around:${radius},${lat},${lng});` +
    `);out center tags 300;`;
  try {
    const r = await fetch("https://overpass-api.de/api/interpreter",
      { method: "POST", body: "data=" + encodeURIComponent(oql) });
    const d = await r.json();
    const places = (d.elements || []).map((e) => {
      const c = e.center || e, tg = e.tags || {};
      return {
        name: tg.name || tg["name:en"] || localizedText("Unnamed mosque"),
        denom: (tg.denomination || "").toLowerCase(),
        lat: c.lat, lng: c.lon, dist: haversine(lat, lng, c.lat, c.lon),
      };
    });
    const shia = places
      .filter((p) => p.denom.includes("shia") || (SHIA_RE.test(p.name) && !p.denom.includes("sunni")))
      .sort((a, b) => a.dist - b.dist).slice(0, 25);
    if (!shia.length) {
      box.innerHTML = `<div class="s">${localizedText("No Shia-identified mosques were found nearby. Try again from a different area.")}</div>`;
      return;
    }
    const mapAll = `<a class="btn ghost" style="margin-bottom:12px;display:inline-block" target="_blank" rel="noopener"
       href="https://www.google.com/maps/search/shia+mosque/@${lat},${lng},13z">🗺️ ${t("view_map")}</a>`;
    box.innerHTML = mapAll + shia.map((p) => `
      <a class="list-item" style="text-decoration:none;color:inherit" target="_blank" rel="noopener"
         href="https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}">
        <div class="badge-num">🕌</div>
        <div class="meta"><div class="t">${escapeHtml(p.name)}</div>
          <div class="s">${p.dist.toFixed(1)} ${t("km")}${p.denom.includes("shia") ? " · " + t("shia_verified") : ""} · ${t("open_maps")} ›</div></div>
      </a>`).join("");
  } catch {
    box.innerHTML = `<div class="s">${t("map_err")}</div>`;
  }
}

const hashCode = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i) | 0; return Math.abs(h); };

// shared like/react bar — used by the Wilayat Chat and the AI assistant chat
function reactionBar(id) {
  const rx = REACTIONS[id] || { like: 0, heart: 0, mine: {} };
  return `<div class="chips react-bar" data-rxid="${id}" style="margin-top:8px">
    <span class="chip ${rx.mine.like ? "active" : ""}" onclick="react('${id}','like')">👍 ${rx.like}</span>
    <span class="chip ${rx.mine.heart ? "active" : ""}" onclick="react('${id}','heart')">❤️ ${rx.heart}</span></div>`;
}
function refreshReactionBars() {
  els(".react-bar").forEach((bar) => { bar.outerHTML = reactionBar(bar.dataset.rxid); });
}
function react(id, type) {
  const rx = REACTIONS[id] || { like: 0, heart: 0, mine: {} };
  if (rx.mine[type]) { rx[type] = Math.max(0, rx[type] - 1); rx.mine[type] = false; }
  else { rx[type] += 1; rx.mine[type] = true; }
  REACTIONS[id] = rx; saveReactions();
  refreshReactionBars();
}

// ----- License & privacy policy -----
const PRIVACY_TEXT = `
  <style>
    #privacyBody {
      background: rgba(3, 12, 28, .62);
      border: 1px solid rgba(148, 163, 184, .22);
      border-radius: 8px;
      padding: 14px;
      overflow-wrap: anywhere;
    }
    #privacyBody h4 { color: var(--text-0); font-size: 14px; margin: 18px 0 8px; letter-spacing:.3px }
    #privacyBody h4:first-child { margin-top: 0 }
    #privacyBody p { color: var(--text-2); line-height: 1.65; font-size: 14px; margin: 0 0 10px }
    #privacyBody ul { color: var(--text-2); line-height: 1.65; font-size: 14px; margin: 0; padding-left: 18px }
    #privacyBody li { margin-bottom: 7px; padding-left: 2px }
    #privacyBody .lic { color: var(--text-1); font-style: italic }
    #privacyBody .owner {
      color: var(--text-1);
      font-size: 13px;
      line-height: 1.6;
      margin: 10px 0 12px;
      padding: 9px 10px;
      border-left: 2px solid rgba(218, 165, 32, .75);
      background: rgba(255, 255, 255, .04);
      border-radius: 6px;
    }
    #privacyBody .owner span { display: block }
  </style>

  <h4>📖 Purpose &amp; License</h4>
  <p class="lic">Al-Wilayat is a free, non-commercial app made to spread the wisdom of the
  Holy Qur'an and the teachings of the Ahlul Bayt (peace be upon them) — for learning,
  remembrance and devotion.</p>
  <p class="owner">
    <span><strong>Al-Wilayat</strong> is an app powered by Aeba.</span>
    <span>Developer: Sayed Muhammad Hafeez.</span>
    <span>South Asia's first Shia Islamic library app, built for users around the world.</span>
    <span>Origin/Country: Pakistan.</span>
  </p>
  <ul>
    <li>Provided <strong>free of charge</strong> for educational and devotional use; you may use and
    share it for these purposes.</li>
    <li><strong>Available features</strong> — Al-Wilayat includes Qur'an, hadith, duas, ziyarat,
    tafsir, Qibla, prayer times, mosque locator and referenced Islamic learning tools.</li>
    <li>Texts, translations and publications remain the right of their respective compilers,
    translators and publishers.</li>
    <li>The app is offered <strong>"as is"</strong>, with no warranty. It is a study aid, not a source
    of religious rulings (fatwa) — always confirm matters of practice with a qualified scholar or
    your marja al-taqlid.</li>
    <li>Please use it respectfully, in a manner befitting its sacred content.</li>
  </ul>

  <h4>⚖️ App Rules &amp; How It Works</h4>
  <p>Al-Wilayat must be used with respect for the Qur'an, the Prophet (s), and the Ahlul Bayt (a).</p>
  <ul>
    <li><strong>Respect sacred content</strong> — do not misuse, mock, edit, or share the texts in a
    disrespectful way.</li>
    <li><strong>Learning only</strong> — the app provides Qur'an, hadith, dua, ziyarat, tafsir and
    reference tools for study and devotion. It does not replace scholars.</li>
    <li><strong>No fatwa</strong> — AI answers and search results are for guidance with references only.
    For religious rulings, follow your marja al-taqlid or a qualified scholar.</li>
    <li><strong>Check references</strong> — users must verify important narrations, translations and
    rulings before acting on them.</li>
    <li><strong>Location features</strong> — Qibla, prayer times and mosque search need your permission
    to use location. Without permission, results may be approximate.</li>
    <li><strong>No abuse</strong> — do not use the app for hate, harassment, false claims, sectarian
    provocation, or disrespect toward any sacred personality.</li>
    <li><strong>Local data</strong> — likes, reactions and saved preferences stay in this browser unless
    you clear your browser data.</li>
  </ul>`;

const PRIVACY_LOCALIZED = {
  ar: {
    title: "📖 الهدف والترخيص",
    body: "الولاية تطبيق مجاني غير تجاري للتعلّم والذكر والخدمة الدينية، يجمع القرآن والحديث والأدعية والزيارات والتفسير وأدوات القبلة والصلاة.",
    owner: ["الولاية تطبيق بدعم شركة Aeba.", "المطوّر: Sayed Muhammad Hafeez.", "أول مكتبة/تطبيق شيعي إسلامي في جنوب آسيا للمستخدمين حول العالم.", "المنشأ/الدولة: باكستان."],
    rulesTitle: "⚖️ القواعد والخصوصية",
    rules: ["استخدم المحتوى المقدّس باحترام ولا تسئ استخدامه.", "التطبيق للتعلّم والعبادة ولا يحل محل العلماء أو المرجع.", "الذكاء الاصطناعي والبحث يقدمان مراجع فقط ولا يصدران فتاوى.", "ميزات الموقع مثل القبلة والصلاة والمساجد تحتاج إذن الموقع، وقد تكون تقريبية بدونه.", "الإعجابات والتفضيلات تُحفظ في هذا المتصفح فقط ويمكن حذفها بمسح بيانات المتصفح."]
  },
  ur: {
    title: "📖 مقصد اور لائسنس",
    body: "الولایت ایک مفت غیر تجارتی ایپ ہے جو قرآن، حدیث، دعاؤں، زیارات، تفسیر، قبلہ، نماز اوقات اور اسلامی تعلیمی اوزار کو احترام کے ساتھ پیش کرتی ہے۔",
    owner: ["Al-Wilayat ایپ Aeba کے ذریعے powered ہے۔", "Developer: Sayed Muhammad Hafeez.", "جنوبی ایشیا کی پہلی شیعہ اسلامی لائبریری/ایپ، دنیا بھر کے صارفین کے لیے۔", "Origin/Country: Pakistan."],
    rulesTitle: "⚖️ اصول اور رازداری",
    rules: ["مقدس مواد کو احترام سے استعمال کریں۔", "ایپ تعلیم اور عبادت کے لیے ہے، علماء یا مرجع کا بدل نہیں۔", "AI اور سرچ صرف حوالہ دیتے ہیں، فتویٰ نہیں دیتے۔", "قبلہ، نماز اوقات اور مسجد تلاش کے لیے مقام کی اجازت درکار ہو سکتی ہے۔", "پسندیدگیاں اور ترجیحات صرف اسی براؤزر میں محفوظ رہتی ہیں۔"]
  },
  fa: {
    title: "📖 هدف و مجوز",
    body: "الولایت یک برنامه رایگان و غیرتجاری برای آموزش، ذکر و استفاده دینی است و قرآن، حدیث، دعا، زیارت، تفسیر، قبله، اوقات نماز و ابزارهای یادگیری را فراهم می‌کند.",
    owner: ["Al-Wilayat برنامه‌ای با پشتیبانی شرکت Aeba است.", "توسعه‌دهنده: Sayed Muhammad Hafeez.", "نخستین کتابخانه/برنامه اسلامی شیعه در جنوب آسیا برای کاربران جهان.", "منشأ/کشور: پاکستان."],
    rulesTitle: "⚖️ قوانین و حریم خصوصی",
    rules: ["با محتوای مقدس با احترام برخورد کنید.", "برنامه برای آموزش و عبادت است و جایگزین عالم یا مرجع نیست.", "AI و جستجو فقط با مرجع کمک می‌کنند و فتوا نمی‌دهند.", "قبله، اوقات نماز و مسجد‌یاب برای دقت به اجازه موقعیت نیاز دارند.", "پسندها و تنظیمات فقط در همین مرورگر ذخیره می‌شوند."]
  },
  az: {
    title: "📖 Məqsəd və lisenziya",
    body: "Al-Wilayat pulsuz və qeyri-kommersiya tətbiqidir. Quran, hədis, dua, ziyarət, təfsir, qiblə, namaz vaxtları və İslami öyrənmə alətlərini hörmətlə təqdim edir.",
    owner: ["Al-Wilayat Aeba tərəfindən dəstəklənən tətbiqdir.", "Tərtibatçı: Sayed Muhammad Hafeez.", "Cənubi Asiyanın dünyadakı istifadəçilər üçün ilk Şiə İslami kitabxana/tətbiqi.", "Mənşə/ölkə: Pakistan."],
    rulesTitle: "⚖️ Qaydalar və məxfilik",
    rules: ["Müqəddəs məzmunu hörmətlə istifadə edin.", "Tətbiq öyrənmə və ibadət üçündür, alim və ya mərceyi əvəz etmir.", "AI və axtarış yalnız istinadlı kömək verir, fətva vermir.", "Qiblə, namaz vaxtları və məscid axtarışı üçün məkan icazəsi lazım ola bilər.", "Bəyənmələr və seçimlər yalnız bu brauzerdə saxlanılır."]
  },
  ks: {
    title: "📖 مقصد تہٕ لائسنس",
    body: "Al-Wilayat اکھ مفت تہٕ غیر تجارتی ایپ چھ، یتھ منز قرآن، حدیث، دعا، زیارت، تفسیر، قبلہ، نماز وقت تہٕ اسلامی سیکھنک اوزار چھ۔",
    owner: ["Al-Wilayat ایپ Aeba سۭتۍ powered چھ۔", "Developer: Sayed Muhammad Hafeez.", "جنوبی ایشیاک گوڈنیک شیعہ اسلامی لائبریری/ایپ، دنیا بھر صارفن خٲطرٕ۔", "Origin/Country: Pakistan."],
    rulesTitle: "⚖️ قاعدہ تہٕ رازداری",
    rules: ["مقدس مواد عزت سۭتۍ استعمال کرو۔", "ایپ سیکھن تہٕ عبادت خٲطرٕ چھ، عالم یا مرجعک بدل نہٕ۔", "AI تہٕ تلاش صرف حوالہ دیتھ مدد کران، فتویٰ نہٕ۔", "قبلہ، نماز وقت تہٕ مسجد تلاش خٲطرٕ مقام اجازت ضرورت پزِ۔", "پسند تہٕ ترجیح صرف یتھ براؤزر منز محفوظ چھ۔"]
  },
  ms: {
    title: "📖 Tujuan & Lesen",
    body: "Al-Wilayat ialah aplikasi percuma dan bukan komersial untuk pembelajaran, zikir dan ibadah. Ia menyediakan Quran, hadis, doa, ziarah, tafsir, kiblat, waktu solat dan alat pembelajaran Islam.",
    owner: ["Al-Wilayat ialah aplikasi yang dikuasakan oleh Aeba.", "Pembangun: Sayed Muhammad Hafeez.", "Perpustakaan/aplikasi Islam Syiah pertama di Asia Selatan untuk pengguna seluruh dunia.", "Asal/Negara: Pakistan."],
    rulesTitle: "⚖️ Peraturan & Privasi",
    rules: ["Gunakan kandungan suci dengan hormat.", "Aplikasi ini untuk pembelajaran dan ibadah, bukan pengganti ulama atau marja.", "AI dan carian hanya memberi bantuan berserta rujukan, bukan fatwa.", "Kiblat, waktu solat dan pencari masjid mungkin memerlukan izin lokasi.", "Suka dan pilihan disimpan hanya dalam pelayar ini."]
  },
};

function privacyHtml() {
  const c = PRIVACY_LOCALIZED[State.lang];
  if (!c) return PRIVACY_TEXT;
  const style = (PRIVACY_TEXT.match(/<style>[\s\S]*?<\/style>/) || [""])[0];
  return `${style}
    <h4>${c.title}</h4>
    <p class="lic">${c.body}</p>
    <p class="owner">${c.owner.map((x) => `<span>${x}</span>`).join("")}</p>
    <h4>${c.rulesTitle}</h4>
    <ul>${c.rules.map((x) => `<li>${x}</li>`).join("")}</ul>`;
}

// App Info & Privacy opens as a slide-up reader sheet (bottom → top), same as the Quran/tafsir reader.
function openPrivacy() {
  const dir = ARABIC_SCRIPT_LANGS.includes(State.lang) ? "rtl" : "ltr";
  const html = `
    <div class="q-reader">
      <div class="qr-topbar">
        <button class="dua-back" onclick="history.back()" aria-label="${localizedText("Back")}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg></button>
        <span class="qr-title">${t("license_privacy")}</span>
      </div>
      <div class="qr-body" dir="${dir}">
        <div id="privacyBody">${privacyHtml()}</div>
      </div>
    </div>`;
  openQuranReader(html);
}

// ---------- MEDIA ----------
function renderMedia(v) {
  v.innerHTML = head("m_media", "m_media_d") + MEDIA.map((m) => `
    <div class="list-item" onclick="toast('▶ ' + t('play'))">
      <div class="badge-num">${m.emoji}</div>
      <div class="meta"><div class="t">${localizedText(m.en)}</div><div class="s">${localizedText(m.type)} · ${localizedText(m.by)} · ${m.dur}</div></div>
      <div style="font-size:20px">${ICON_PLAY}</div>
    </div>`).join("");
}

// ---------- TASBIH ----------
let tasbih = { count: 0, dhikrIdx: 0 };
function renderTasbih(v) {
  const d = DHIKR[tasbih.dhikrIdx];
  v.innerHTML = head("m_tasbih", "m_tasbih_d") + `
    <div class="chips" style="justify-content:center">
      ${DHIKR.map((x, i) => `<span class="chip ${i === tasbih.dhikrIdx ? "active" : ""}" onclick="setDhikr(${i})">${langName(x)}</span>`).join("")}
    </div>
    <div class="tasbih-wrap">
      <div class="tasbih-ring" id="tring" onclick="tap()">
        <div style="text-align:center">
          <div class="dhikr">${d.ar}</div>
          <div class="count" id="tcount">${tasbih.count}</div>
          <div style="color:var(--text-2);font-size:13px">${t("target")}: ${d.target}</div>
        </div>
      </div>
      <p style="color:var(--text-2)">${t("tap_count")}</p>
      <button class="btn ghost" onclick="resetTasbih()">↺ ${t("reset")}</button>
    </div>`;
  updateRing();
}
function setDhikr(i) { tasbih.dhikrIdx = i; tasbih.count = 0; renderTasbih(el("#view-tasbih")); }
function tap() {
  tasbih.count++;
  Stats.addDhikr(1);          // count toward "Dhikr Today"
  const d = DHIKR[tasbih.dhikrIdx];
  el("#tcount").textContent = tasbih.count;
  if (navigator.vibrate) navigator.vibrate(15);
  if (tasbih.count === d.target) { toast("✨ " + langName(d) + " × " + d.target + " " + localizedText("complete")); }
  if (tasbih.count % d.target === 0 && tasbih.count > 0) { /* keep counting */ }
  updateRing();
}
function updateRing() {
  const d = DHIKR[tasbih.dhikrIdx];
  const ring = el("#tring");
  if (ring) ring.style.setProperty("--ring", Math.min(360, (tasbih.count % d.target || (tasbih.count ? d.target : 0)) / d.target * 360) + "deg");
}
function resetTasbih() { tasbih.count = 0; renderTasbih(el("#view-tasbih")); }

// ---------- ADMIN ----------
function renderAdmin(v) {
  const stats = [
    { big: "1.2M", lbl: "Users" }, { big: "6,236", lbl: "Quran Verses" },
    { big: "41,220", lbl: "Hadiths" }, { big: "3,400", lbl: "Books" },
    { big: "98", lbl: "Pending Moderation" }, { big: "99.98%", lbl: "Uptime" },
  ];
  const panels = ["Users", "Quran Content", "Hadith Content", "Audio Files", "Notifications", "AI Moderation", "Analytics", "Reports"];
  v.innerHTML = head("m_admin", "m_admin_d") + `
    <div class="stat-row">${stats.map((s) => `<div class="stat"><div class="big">${s.big}</div><div class="lbl">${localizedText(s.lbl)}</div></div>`).join("")}</div>
    <div class="grid modules">${panels.map((p) => `
      <div class="module-card" onclick="toast(t('coming_soon'))" style="opacity:1;transform:none">
        <div class="m-ic">🛠️</div><h3>${localizedText(p)}</h3><p>${localizedText("Manage")} ${localizedText(p.toLowerCase())}</p>
      </div>`).join("")}</div>`;
}

// ---------------- Helpers ----------------
function escapeHtml(s) { return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

// ---------------- Boot ----------------
// Professional line icons (Lucide-style, MIT), stroke=currentColor.
const ICONS = {
  home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
  quran: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
  hadith: '<path d="m16 6 4 14"/><path d="M12 6v14"/><path d="M8 8v12"/><path d="M4 4v16"/>',
  ziyarat: '<line x1="3" x2="21" y1="22" y2="22"/><line x1="6" x2="6" y1="18" y2="11"/><line x1="10" x2="10" y1="18" y2="11"/><line x1="14" x2="14" y1="18" y2="11"/><line x1="18" x2="18" y1="18" y2="11"/><polygon points="12 2 20 7 4 7"/>',
  dua: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
  prayer: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  qibla: '<circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/>',
  calendar: '<rect width="18" height="18" x="3" y="4" rx="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/>',
  ahlulbayt: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  ahlquran: '<path d="M12 3 4 7v6c0 4 3.4 6.9 8 8 4.6-1.1 8-4 8-8V7z"/><path d="M12 8v6"/><path d="M9 11h6"/>',
  events: '<rect width="18" height="18" x="3" y="4" rx="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/><path d="m9 15 1.5 1.5L14 13"/>',
  journey: '<path d="M9 6l11 -2v12l-11 2z"/><path d="M9 6l-5 2v12l5 -2"/><path d="M9 6v14"/><path d="M15 4v12"/>',
  proofs: '<path d="M9 12l2 2 4-4"/><path d="M21 12c-1 0-3-1-3-3s2-3 3-3-1-2-3-2-3 2-3 2-1-2-3-2-3 1-3 2 2 1 2 3-2 3-3 3 1 2 3 2 3-2 3-2 1 2 3 2 3-1 3-2z"/>',
  science: '<path d="M9 3h6"/><path d="M10 3v6.5L5.2 18a2 2 0 0 0 1.8 3h10a2 2 0 0 0 1.8-3L14 9.5V3"/><path d="M7.5 15h9"/>',
  life: '<path d="M22 12h-4l-3 8L9 4l-3 8H2"/>',
  tafsir: '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/><path d="M8 7h8"/><path d="M8 11h5"/>',
  holy: '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/><path d="M11 2v6l2-1.3L15 8V2"/>',
  library: '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/><path d="M9.5 2v7l2.5-1.6L14.5 9V2"/>',
  community: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  tasbih: '<circle cx="12" cy="13" r="8"/><circle cx="12" cy="3" r="1.6" fill="currentColor" stroke="none"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  explore: '<circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/>',
  mahdi: '<path d="M4 22V4a1 1 0 0 1 1-1h14l-3 5 3 5H6"/><line x1="4" y1="22" x2="4" y2="15"/>',
  progress: '<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>',
  latmiya: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;

// [route, i18n-key, isPrimary]. Primary items show in the phone bottom nav; the
// rest live in the Settings sheet. The sidebar (desktop) shows them all.
const NAV = [
  ["home", "nav_home", true], ["quran", "nav_quran", true], ["hadith", "nav_hadith", true],
  ["tafsir", "nav_tafsir", false], ["holy", "nav_holy", false],
  ["life", "nav_life", false],
  ["science", "nav_science", false],
  ["proofs", "nav_proofs", false],
  ["journey", "nav_journey", false],
  ["events", "nav_events", false],
  ["ahlquran", "nav_ahlquran", false],
  ["dua", "nav_dua", false],
  ["ziyarat", "nav_ziyarat", false],
  ["ahlulbayt", "nav_ahl", false],
  ["mahdi", "nav_mahdi", false],
  ["prayer", "nav_prayer", false], ["qibla", "nav_qibla", false], ["calendar", "nav_calendar", false],
  ["community", "nav_community", false], ["tasbih", "nav_tasbih", false],
  ["progress", "nav_progress", true],  // bottom nav item
  ["explore", "nav_explore", true],   // opens the module grid (former Settings sheet)
];
const isPrimaryRoute = (route) => NAV.some((n) => n[0] === route && n[2]);

function buildNav() {
  el("#nav").innerHTML = NAV.map(([r, k]) => `
    <div class="nav-item ${r === "home" ? "active" : ""}" data-route="${r}" onclick="navClick('${r}')">
      <span class="ic">${icon(r)}</span><span data-i18n="${k}">${t(k)}</span>
    </div>`).join("");

  const bn = el("#bottomNav");
  if (bn) {
    bn.innerHTML = `<span class="bnav-pill" aria-hidden="true"></span>` + NAV.filter((n) => n[2]).map(([r, k]) => `
    <button class="bottom-item ${r === "home" ? "active" : ""}" data-route="${r}">
      <span class="bi">${icon(r)}</span><span class="bl" data-i18n="${k}">${t(k)}</span>
    </button>`).join("");
    requestAnimationFrame(moveBnavPill);
    setupBnavDrag(bn);
  }

  const sg = el("#settingsGrid");
  if (sg) sg.innerHTML = NAV.filter((n) => !n[2]).map(([r, k]) => `
    <button class="settings-item" data-route="${r}" onclick="openModuleFromSettings('${r}')">
      <span class="si">${icon(r)}</span><span data-i18n="${k}">${t(k)}</span>
    </button>`).join("");

  el("#views").innerHTML = NAV.map(([r]) => `<section class="view ${r === "home" ? "active" : ""}" id="view-${r}"></section>`).join("")
    + `<section class="view" id="view-search"></section>`;
}

function navClick(route) { go(route); }
// ---------- LATMIYAT (streamed audio from the Internet Archive) ----------
const LAT_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
const LAT_PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';
let _latAudio = null, _latIdx = -1, _latView = [], _latLang = null;
const LAT_LANGS = ["Urdu", "Arabic", "Farsi"];       // fixed language bars
function renderLatmiya(v) {
  const all = window.LATMIYAT || [];
  if (!_latLang) {                                   // three fixed language bars
    const g = {};
    all.forEach((x) => { const l = x.l || "Other"; g[l] = (g[l] || 0) + 1; });
    v.innerHTML = head("nav_latmiya") + LAT_LANGS.map((l) => `
      <div class="list-item" onclick="latmiyaOpenLang('${l}')">
        <div class="badge-num lat-ic">${icon("latmiya")}</div>
        <div class="meta"><div class="t">${localizedText(l)}</div><div class="s">${locNum(g[l] || 0, State.lang)} ${localizedText("latmiyat")}</div></div>
        <div style="color:var(--text-2);font-size:20px">›</div>
      </div>`).join("");
    return;
  }
  const list = all.filter((x) => (x.l || "Other") === _latLang);   // one language
  v.innerHTML = head("nav_latmiya") + `
    <button class="btn ghost" style="margin-bottom:12px" onclick="latmiyaBackLang()">← ${localizedText("Languages")}</button>
    <div style="font-weight:800;font-size:17px;margin-bottom:10px">${localizedText(_latLang)} <span style="color:var(--text-2);font-size:13px;font-weight:600">· ${locNum(list.length, State.lang)}</span></div>
    ${list.length ? `<label class="search" style="margin-bottom:12px"><span class="search-ic">${SEARCH_ICON}</span>
      <input id="latSearch" placeholder="${t("search")}" oninput="latmiyaSearch(this.value)"></label>` : ""}
    <div id="latList"></div>`;
  if (!list.length) el("#latList").innerHTML = `<div class="card" style="text-align:center;color:var(--text-2)">${localizedText("No latmiyat yet")}</div>`;
  else latmiyaRender(list);
}
function latmiyaOpenLang(l) { _latLang = l; renderLatmiya(el("#view-latmiya")); }
function latmiyaBackLang() { _latLang = null; renderLatmiya(el("#view-latmiya")); }
function latmiyaRender(list) {
  _latView = list;
  const body = el("#latList"); if (!body) return;
  if (!list.length) { body.innerHTML = `<div class="card">${localizedText("No matches")}</div>`; return; }
  const cap = 500;
  body.innerHTML = list.slice(0, cap).map((x, i) => `
    <div class="list-item lat-row ${i === _latIdx ? "playing" : ""}" onclick="latmiyaPlay(${i})">
      <div class="badge-num lat-ic">${i === _latIdx && _latAudio && !_latAudio.paused ? LAT_PAUSE : LAT_PLAY}</div>
      <div class="meta"><div class="t">${escapeHtml(x.t)}</div><div class="s">${[x.r ? escapeHtml(x.r) : "", x.d || (x.y ? "video" : "")].filter(Boolean).join(" · ")}</div></div>
    </div>`).join("")
    + (list.length > cap ? `<div style="text-align:center;color:var(--text-2);font-size:12px;margin:12px 0">${localizedText("Refine search to see more")}</div>` : "");
}
function latmiyaSearch(q) {
  q = (q || "").trim().toLowerCase();
  const all = (window.LATMIYAT || []).filter((x) => (x.l || "Other") === _latLang);
  latmiyaRender(!q ? all : all.filter((x) => (x.t + " " + (x.r || "")).toLowerCase().includes(q)));
}
// Clean YouTube player (no settings/branding): IFrame API with controls=0 + our own bar.
let _ytApiLoading = false, _ytPlayer = null, _ytTick = null;
function ensureYtApi(cb) {
  if (window.YT && window.YT.Player) { cb(); return; }
  if (!_ytApiLoading) { _ytApiLoading = true; const s = document.createElement("script"); s.src = "https://www.youtube.com/iframe_api"; document.head.appendChild(s); }
  const iv = setInterval(() => { if (window.YT && window.YT.Player) { clearInterval(iv); cb(); } }, 120);
}
function openLatYt(x) {
  let m = el("#latYt");
  if (!m) { m = document.createElement("div"); m.id = "latYt"; m.className = "lat-yt"; document.body.appendChild(m); }
  m.innerHTML = `<div class="lat-yt-inner">
      <button class="lat-yt-x" onclick="closeLatYt()" aria-label="Close">×</button>
      <div class="lat-yt-frame"><div id="latYtPlayer"></div><div class="lat-yt-shield"></div></div>
      <div class="lat-yt-bar">
        <button class="lat-yt-pp" id="latYtPP" onclick="latYtToggle()">${LAT_PAUSE}</button>
        <input class="lat-yt-seek" id="latYtSeek" type="range" min="0" max="1000" value="0" oninput="latYtSeek(this.value)">
        <span class="lat-yt-time" id="latYtTime">0:00</span>
      </div>
      <div class="lat-yt-t">${escapeHtml(x.t)}${x.r ? ` · <span>${escapeHtml(x.r)}</span>` : ""}</div>
    </div>`;
  requestAnimationFrame(() => m.classList.add("open"));
  ensureYtApi(() => {
    if (_ytPlayer) { try { _ytPlayer.destroy(); } catch (e) {} _ytPlayer = null; }
    _ytPlayer = new YT.Player("latYtPlayer", {
      videoId: x.y,
      playerVars: { controls: 0, modestbranding: 1, rel: 0, iv_load_policy: 3, fs: 0, disablekb: 1, playsinline: 1, autoplay: 1 },
      events: {
        onReady: (e) => { e.target.playVideo(); startYtTick(); },
        onStateChange: () => { const b = el("#latYtPP"); if (b && _ytPlayer) b.innerHTML = (_ytPlayer.getPlayerState && _ytPlayer.getPlayerState() === 1) ? LAT_PAUSE : LAT_PLAY; },
      },
    });
  });
}
function startYtTick() {
  clearInterval(_ytTick);
  _ytTick = setInterval(() => {
    if (!_ytPlayer || !_ytPlayer.getDuration) return;
    const d = _ytPlayer.getDuration() || 0, c = _ytPlayer.getCurrentTime() || 0;
    const s = el("#latYtSeek"), tm = el("#latYtTime");
    if (s && d) s.value = Math.round((c / d) * 1000);
    if (tm) tm.textContent = `${Math.floor(c / 60)}:${String(Math.floor(c % 60)).padStart(2, "0")}`;
  }, 500);
}
function latYtToggle() { if (!_ytPlayer) return; if (_ytPlayer.getPlayerState() === 1) _ytPlayer.pauseVideo(); else _ytPlayer.playVideo(); }
function latYtSeek(v) { if (_ytPlayer && _ytPlayer.getDuration) _ytPlayer.seekTo((v / 1000) * _ytPlayer.getDuration(), true); }
function closeLatYt() {
  clearInterval(_ytTick);
  if (_ytPlayer) { try { _ytPlayer.destroy(); } catch (e) {} _ytPlayer = null; }
  const m = el("#latYt"); if (m) { m.classList.remove("open"); m.innerHTML = ""; }
}
function latmiyaPlay(i) {
  const x = _latView[i]; if (!x) return;
  if (x.y) { openLatYt(x); return; }           // YouTube-hosted → embedded player
  if (_latIdx === i && _latAudio) {            // tapping the playing row toggles
    if (_latAudio.paused) _latAudio.play(); else _latAudio.pause();
    latmiyaRender(_latView); latmiyaBar(); return;
  }
  if (!_latAudio) {
    _latAudio = new Audio();
    _latAudio.onended = () => { const n = _latIdx + 1; if (_latView[n]) latmiyaPlay(n); };
    _latAudio.ontimeupdate = latmiyaBar;
    _latAudio.onplay = () => { latmiyaRender(_latView); latmiyaBar(); };
    _latAudio.onpause = () => { latmiyaRender(_latView); latmiyaBar(); };
    _latAudio.onerror = () => toast(localizedText("Audio unavailable"));
  }
  _latIdx = i; _latAudio.src = x.u;
  _latAudio.play().catch(() => toast(localizedText("Audio unavailable")));
  latmiyaRender(_latView); latmiyaBar();
}
function latmiyaBar() {
  let bar = el("#latBar");
  const x = _latView[_latIdx] || (window.LATMIYAT || [])[_latIdx];
  if (!_latAudio || !x) { if (bar) bar.remove(); return; }
  if (!bar) {
    bar = document.createElement("div"); bar.id = "latBar"; bar.className = "lat-bar";
    bar.innerHTML = `<button class="lat-btn" onclick="latmiyaToggle()" id="latToggle"></button>
      <div class="lat-meta"><div class="t" id="latNowT"></div><div class="s" id="latNowR"></div></div>
      <input id="latSeek" class="lat-seek" type="range" min="0" max="1000" value="0" oninput="latmiyaSeek(this.value)">
      <button class="lat-x" onclick="latmiyaClose()" aria-label="Close">×</button>`;
    document.body.appendChild(bar);
  }
  el("#latToggle").innerHTML = _latAudio.paused ? LAT_PLAY : LAT_PAUSE;
  el("#latNowT").textContent = x.t; el("#latNowR").textContent = x.r || "";
  const s = el("#latSeek");
  if (s && _latAudio.duration) s.value = Math.round((_latAudio.currentTime / _latAudio.duration) * 1000);
}
function latmiyaToggle() { if (!_latAudio) return; if (_latAudio.paused) _latAudio.play(); else _latAudio.pause(); }
function latmiyaSeek(v) { if (_latAudio && _latAudio.duration) _latAudio.currentTime = (v / 1000) * _latAudio.duration; }
function latmiyaClose() {
  if (_latAudio) { _latAudio.onerror = null; _latAudio.pause(); _latAudio.removeAttribute("src"); try { _latAudio.load(); } catch (e) {} }
  _latIdx = -1; el("#latBar")?.remove(); latmiyaRender(_latView);
}
// ---------- PROGRESS (ring widgets with a rotating disk in the middle) ----------
// One circular progress ring; a disk spins in the centre, value + label on top.
function progRing(pct, color, valText, label) {
  const r = 52, c = 2 * Math.PI * r, off = c * (1 - Math.min(1, pct / 100));
  const isGrad = Array.isArray(color);                 // [start, end] → gradient stroke
  const gid = "prg" + Math.random().toString(36).slice(2, 8);
  const stroke = isGrad ? `url(#${gid})` : color;
  const diskC = isGrad ? color[0] : color;
  const defs = isGrad
    ? `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${color[0]}"/><stop offset="1" stop-color="${color[1]}"/></linearGradient></defs>` : "";
  return `<div class="pring">
    <svg viewBox="0 0 120 120" class="pring-svg" aria-hidden="true">
      ${defs}
      <circle cx="60" cy="60" r="${r}" fill="none" stroke="rgba(255,255,255,.10)" stroke-width="10"/>
      <circle cx="60" cy="60" r="${r}" fill="none" stroke="${stroke}" stroke-width="10" stroke-linecap="round"
        stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" transform="rotate(-90 60 60)"
        style="transition:stroke-dashoffset 1s var(--ease)"/>
    </svg>
    <div class="pring-disk" style="--c:${diskC}"></div>
    <div class="pring-center"><div class="pring-val">${valText}</div><div class="pring-lbl">${label}</div></div>
  </div>`;
}
async function renderProgress(v) {
  const st = Stats.get();
  const dayStreak = st.streak || 1;
  const dToday = st.dhikrToday || 0;
  const hadithAll = (st.readHadithAll || []).length;
  const duaRead = Stats.readCount("dua"), duaTot = (typeof DUAS !== "undefined" ? DUAS.length : 0) || 1;
  const ziyRead = Stats.readCount("ziyarat"), ziyTot = (typeof ZIYARAT !== "undefined" ? ZIYARAT.length : 0) || 1;
  const ayahAll = (st.readAyatAll || []).length;
  const quranPct = Math.min(100, Math.round((ayahAll / QURAN_TOTAL) * 100));

  // Big round Qur'an-progress graph
  const quranCard = `<div class="card prog-quran">
    <div class="prog-quran-ring">${progRing(quranPct, ["#ffd86b", "#ff7a18"], locNum(quranPct, State.lang) + "%", t("nav_quran"))}</div>
    <div class="prog-quran-sub">${locNum(ayahAll, State.lang)} / ${locNum(QURAN_TOTAL, State.lang)} ${localizedText("ayat")}</div>
    <div class="prog-quran-note">${localizedText("Whole-Qur'an reading progress")}</div>
  </div>`;

  const rings = `<div class="card pring-grid">
    ${progRing(duaRead / duaTot * 100, ["#ff5fa2", "#c2185b"], locNum(duaRead, State.lang), t("nav_dua"))}
    ${progRing(ziyRead / ziyTot * 100, ["#ff5fa2", "#c2185b"], locNum(ziyRead, State.lang), t("nav_ziyarat"))}
  </div>`;

  v.innerHTML = head("nav_progress") + quranCard + `<div id="progHadith"></div>` + rings;
  // Hadith activity chart (weekly + top collections)
  try {
    const d = await api("/hadith/books");
    const g = hadithGraph(d.books);
    if (g) el("#progHadith").innerHTML = g;
  } catch { /* offline: skip the hadith chart */ }
}
// ---------- THE 313 — Imam al-Mahdi (AJ) : a 10-page introduction ----------
let _mahdiPage = 0;
function renderMahdi(v) {
  _mahdiPage = 0;
  v.innerHTML = head("nav_mahdi") + `<div id="mahdiBody"></div>`;
  showMahdiPage(0);
}
function showMahdiPage(i) {
  const base = window.MAHDI_PAGES || [];
  const tr = (State.lang !== "en" && window.MAHDI_TR && window.MAHDI_TR[State.lang]) || null;
  const pages = (tr && tr.length === base.length) ? tr : base;
  if (!pages.length) { const b = el("#mahdiBody"); if (b) b.innerHTML = `<div class="card">${t("loading")}</div>`; return; }
  _mahdiPage = Math.max(0, Math.min(pages.length - 1, i));
  const p = pages[_mahdiPage];
  const dir = ARABIC_SCRIPT_LANGS.includes(State.lang) ? "rtl" : "ltr";
  const body = el("#mahdiBody"); if (!body) return;
  const pnum = `${locNum(_mahdiPage + 1, State.lang)} / ${locNum(pages.length, State.lang)}`;
  body.innerHTML = `
    <div class="mahdi-pnum">${pnum}</div>
    <h2 class="mahdi-h" dir="${dir}">${p.t}</h2>
    <div class="mahdi-doc" dir="${dir}">${p.h}</div>
    <div class="mahdi-nav">
      <button class="btn ghost" ${_mahdiPage <= 0 ? "disabled" : ""} onclick="showMahdiPage(${_mahdiPage - 1})">← ${localizedText("Previous")}</button>
      <span class="mahdi-dots">${pages.map((_, k) => `<i class="${k === _mahdiPage ? "on" : ""}" onclick="showMahdiPage(${k})"></i>`).join("")}</span>
      <button class="btn" ${_mahdiPage >= pages.length - 1 ? "disabled" : ""} onclick="showMahdiPage(${_mahdiPage + 1})">${localizedText("Next")} →</button>
    </div>`;
  window.scrollTo({ top: 0 });   // normal page flow: reset to top on page change
}
// Explore is a normal full page (like Quran/Hadith): a grid of the remaining modules.
function renderExplore(v) {
  const boxes = NAV.filter((n) => !n[2]).map(([r, k]) => `
    <button class="settings-item" data-route="${r}" onclick="go('${r}')">
      <span class="si">${icon(r)}</span><span data-i18n="${k}">${t(k)}</span>
    </button>`).join("");
  v.innerHTML = head("nav_explore") + `<div class="settings-grid">${boxes}</div>`;
}
function openSettings() {
  el("#settingsPanel")?.classList.add("open");
  el("#settingsBackdrop")?.classList.add("open");
  document.body.classList.add("sheet-lock");
}
function closeSettings() {
  el("#settingsPanel")?.classList.remove("open");
  el("#settingsBackdrop")?.classList.remove("open");
  document.body.classList.remove("sheet-lock");
}
// Open a module from Settings; push a marker so Back / left-swipe returns to Settings.
function openModuleFromSettings(route) {
  if (window.history && history.pushState) {
    _navIndex += 1;
    history.pushState({ wilayat: true, route: State.route, index: _navIndex, settingsOpen: true },
                      "", routeUrl(State.route));
  }
  closeSettings();
  go(route);
}

function initialRoute() {
  return normalizeRoute(decodeURIComponent((location.hash || "").replace(/^#/, "")) || "home");
}

// ---------- AZAN PRAYER REMINDERS (native app + PWA notifications) ----------
const AZAN_KEY = "wilayat.azan";           // "on" | "off"
const isLoggedIn = () => { try { return !!JSON.parse(localStorage.getItem("wilayat.auth") || "null"); } catch { return false; } };
// Running inside the native app (Capacitor)? Then we can fire azan even when fully closed.
const isNativeApp = () => !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
const capLN = () => { try { return window.Capacitor.Plugins.LocalNotifications; } catch { return null; } };
function azanOn() {
  if (localStorage.getItem(AZAN_KEY) === "off" || !isLoggedIn()) return false;
  if (isNativeApp()) return localStorage.getItem(AZAN_KEY) === "on";
  return "Notification" in window && Notification.permission === "granted";
}

function registerAzanSW() {
  if (isNativeApp() || !("serviceWorker" in navigator)) return;   // native uses OS notifications, not SW
  navigator.serviceWorker.register("sw.js").catch(() => { /* not on https/localhost → skip */ });
}

// Native: schedule real OS local notifications for the next 7 days (fire when closed/locked).
async function scheduleAzanNative() {
  const ln = capLN(); if (!ln) return;
  try {
    const perm = await ln.requestPermissions();
    if (perm.display !== "granted") return;
    // clear our previously-scheduled azan ids, then rebuild
    const ids = [];
    for (let i = 1000; i < 1000 + 7 * 10 + 5; i++) ids.push({ id: i });
    await ln.cancel({ notifications: ids }).catch(() => {});
    const times = prayerTimes();
    const keys = ["fajr", "dhuhr", "asr", "maghrib", "isha"];
    const now = new Date();
    const list = [];
    for (let d = 0; d < 7; d++) {
      keys.forEach((key, ki) => {
        const hhmm = times[key]; if (!hhmm) return;
        const [h, m] = hhmm.split(":").map(Number); if (isNaN(h)) return;
        const when = new Date(now.getFullYear(), now.getMonth(), now.getDate() + d, h, m, 0);
        if (when <= now) return;
        const p = PRAYERS.find((x) => x.key === key) || {};
        list.push({
          id: 1000 + d * 10 + ki,
          title: "🕌 " + localizedText("Azan") + " · " + langName(p),
          body: localizedText("It's time for") + " " + langName(p) + " — " + localizedText("tap to mark it prayed."),
          schedule: { at: when, allowWhileIdle: true },
          sound: "azan.wav",            // add azan.wav to the native project for the real call
          smallIcon: "ic_stat_icon",
          extra: { url: "#prayer" },
        });
      });
    }
    if (list.length) await ln.schedule({ notifications: list });
    if (!window._azanTapHooked && ln.addListener) {
      window._azanTapHooked = true;
      ln.addListener("localNotificationActionPerformed", () => { location.hash = "prayer"; });
    }
  } catch (e) { /* scheduling optional */ }
}

let _azanTimers = [];
function clearAzanTimers() { _azanTimers.forEach((id) => clearTimeout(id)); _azanTimers = []; }
// Web: schedule a phone notification at each of today's prayer times (fires while the
// app is open or installed/backgrounded). Native path uses OS notifications instead.
function scheduleAzanReminders() {
  clearAzanTimers();
  if (!azanOn()) return;
  if (isNativeApp()) { scheduleAzanNative(); return; }   // real background azan in the app
  const times = prayerTimes();
  const now = new Date();
  ["fajr", "dhuhr", "asr", "maghrib", "isha"].forEach((key) => {
    const hhmm = times[key]; if (!hhmm) return;
    const [h, m] = hhmm.split(":").map(Number);
    const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
    const delay = target - now;
    if (delay <= 0 || delay > 24 * 3600 * 1000) return;   // only upcoming prayers today
    _azanTimers.push(setTimeout(() => fireAzan(key), delay));
  });
  // reschedule just after midnight for the next day
  const mid = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 30);
  _azanTimers.push(setTimeout(scheduleAzanReminders, mid - now));
}
function fireAzan(key) {
  const p = PRAYERS.find((x) => x.key === key) || {};
  const title = "🕌 " + localizedText("Azan") + " · " + langName(p);
  const opts = {
    body: localizedText("It's time for") + " " + langName(p) + " — " + localizedText("tap to mark it prayed."),
    tag: "azan-" + key, renotify: true, requireInteraction: true, vibrate: [200, 100, 200],
    icon: "assets/al-wilayat-logo.jpeg?v=5", badge: "assets/al-wilayat-logo.jpeg?v=5",
    data: { url: "./#prayer" },
  };
  if (navigator.serviceWorker && navigator.serviceWorker.ready) {
    navigator.serviceWorker.ready.then((reg) => reg.showNotification(title, opts)).catch(() => { try { new Notification(title, opts); } catch (e) {} });
  } else { try { new Notification(title, opts); } catch (e) {} }
  try { const a = new Audio("assets/azan.mp3"); a.play().catch(() => {}); } catch (e) { /* no azan file → silent notification */ }
}
// Called from a button tap (a user gesture) to turn reminders on.
async function enableAzan() {
  if (!isLoggedIn()) { toast(localizedText("Please sign in first.")); return; }
  if (isNativeApp()) {                       // native app path (real background azan)
    const ln = capLN();
    const perm = ln ? await ln.requestPermissions() : { display: "denied" };
    if (perm.display === "granted") {
      localStorage.setItem(AZAN_KEY, "on");
      await scheduleAzanNative();
      toast("🔔 " + localizedText("Azan reminders on"));
    } else {
      toast(localizedText("Notifications are blocked — enable them in your browser settings."));
    }
    if (State.route === "prayer") RENDERERS.prayer(el("#view-prayer"));
    return;
  }
  if (!("Notification" in window)) { toast(localizedText("Notifications are not supported here.")); return; }
  Notification.requestPermission().then((perm) => {
    if (perm === "granted") {
      localStorage.setItem(AZAN_KEY, "on");
      registerAzanSW();
      scheduleAzanReminders();
      toast("🔔 " + localizedText("Azan reminders on"));
    } else {
      toast(localizedText("Notifications are blocked — enable them in your browser settings."));
    }
    if (State.route === "prayer") RENDERERS.prayer(el("#view-prayer"));
  });
}
function disableAzan() {
  localStorage.setItem(AZAN_KEY, "off");
  clearAzanTimers();
  toast(localizedText("Azan reminders off"));
  if (State.route === "prayer") RENDERERS.prayer(el("#view-prayer"));
}

function init() {
  Stats.touchStreak();          // advance the daily streak once per app open
  registerAzanSW();             // PWA service worker (azan reminders)
  buildNav();
  applyTheme();
  try { applyLang(); } catch (e) { /* never block boot on a localization error */ }
  try { setupNumberLocalization(); } catch (e) { /* observer/regex optional */ }
  const startRoute = initialRoute();
  history.replaceState({ wilayat: true, route: startRoute, index: 0 }, "", routeUrl(startRoute));
  go(startRoute, { history: false });
  requestLocation(); // ask once on open → prayer times, Qibla & mosque finder auto-correct

  // Top-bar search → live section suggestions + exact hadith / verse lookup
  if (!el("#searchSuggest")) {
    const sg = document.createElement("div");
    sg.id = "searchSuggest"; sg.className = "search-suggest";
    document.body.appendChild(sg);
  }
  const searchInput = el(".search input");
  if (searchInput) {
    searchInput.addEventListener("input", () => { updateSearchMark(); searchSuggest(searchInput.value); });
    searchInput.addEventListener("focus", () => searchSuggest(searchInput.value));
    searchInput.addEventListener("blur", () => setTimeout(() => el("#searchSuggest")?.classList.remove("open"), 180));
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { el("#searchSuggest")?.classList.remove("open"); globalSearch(searchInput.value); }
      if (e.key === "Escape") el("#searchSuggest")?.classList.remove("open");
    });
  }
  window.addEventListener("resize", () => { if (el("#searchSuggest")?.classList.contains("open")) positionSuggest(); });
  const searchBackBtn = el("#searchBackBtn");
  if (searchBackBtn) searchBackBtn.onclick = (e) => {
    e.preventDefault();
    closeSearchFromBar();
  };

  // Move the language modal to <body> so its fixed positioning centers on the
  // whole screen (inside .topbar.glass its backdrop-filter trapped it up top).
  document.body.appendChild(el("#langMenu"));
  el("#langBtn").onclick = () => {
    const m = el("#langMenu");
    m.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.lang === State.lang));
    m.classList.toggle("open");
  };
  // tapping the dimmed backdrop (outside the box) closes the language modal
  el("#langMenu").onclick = (e) => { if (e.target === el("#langMenu")) el("#langMenu").classList.remove("open"); };
  el("#menuBtn").onclick = () => el("#sidebar").classList.toggle("open");
  const settingsBtn = el("#settingsBtn");
  if (settingsBtn) settingsBtn.onclick = openSettings;
  const settingsBackdrop = el("#settingsBackdrop");
  if (settingsBackdrop) settingsBackdrop.onclick = closeSettings;
  const settingsClose = el("#settingsClose");
  if (settingsClose) settingsClose.onclick = closeSettings;
  const duaBackdrop = el("#duaBackdrop");
  if (duaBackdrop) duaBackdrop.onclick = () => history.back();
  const qaBackdrop = el("#qaBackdrop");
  if (qaBackdrop) qaBackdrop.onclick = () => history.back();
  const qrBackdrop = el("#qrBackdrop");
  if (qrBackdrop) qrBackdrop.onclick = () => history.back();
  el("#langMenu").querySelectorAll("button").forEach((b) =>
    (b.onclick = () => {
      State.lang = b.dataset.lang;
      applyLang();
      el("#langMenu").classList.remove("open");
      RENDERERS[State.route] && RENDERERS[State.route](el("#view-" + State.route));
    })
  );
  // Account drop-down (round avatar in the top bar → name + Sign out, drops down).
  const acctMenu = el("#acctMenu");
  if (acctMenu) document.body.appendChild(acctMenu);   // out of the top bar so it isn't clipped
  function positionAcctMenu() {
    const m = el("#acctMenu"), btn = el("#acctBtn"); if (!m || !btn) return;
    const r = btn.getBoundingClientRect(), card = m.querySelector(".acct-card");
    const w = (card && card.offsetWidth) || 200;
    m.style.top = (r.bottom + 8) + "px";
    m.style.left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) + "px";
  }
  const acctBtn = el("#acctBtn");
  if (acctBtn) acctBtn.onclick = (e) => {
    e.stopPropagation();
    const m = el("#acctMenu");
    m.classList.toggle("open");
    if (m.classList.contains("open")) positionAcctMenu();
  };
  window.addEventListener("resize", () => { if (el("#acctMenu")?.classList.contains("open")) positionAcctMenu(); });

  document.addEventListener("click", (e) => {
    if (!e.target.closest("#langBtn") && !e.target.closest("#langMenu")) el("#langMenu").classList.remove("open");
    if (!e.target.closest("#sidebar") && !e.target.closest("#menuBtn")) el("#sidebar").classList.remove("open");
    if (!e.target.closest("#acctBtn") && !e.target.closest("#acctMenu")) el("#acctMenu")?.classList.remove("open");
  });

  window.addEventListener("popstate", (e) => {
    const route = normalizeRoute((e.state && e.state.route) || initialRoute());
    _navIndex = Number.isFinite(e.state && e.state.index) ? e.state.index : 0;
    go(route, { history: false });
    if (e.state && e.state.settingsOpen) openSettings(); else closeSettings();
    if (e.state && e.state.duaOpen) openDuaDay(); else closeDuaDay();
    if (e.state && e.state.qaOpen) openQA(); else closeQA();
    if (!(e.state && e.state.qrOpen)) closeQuranReader();
    // Tafsir: Back from a volume returns to that tafsir's volume list (not out of the reader)
    if (e.state && e.state.qrOpen && !e.state.tafRead && _tafReading) {
      _tafReading = false;
      showTafsirVolumes(_tafOpenIdx);
    }
    // Hadith library: Back from a volume returns to that book's volume list
    if (e.state && e.state.qrOpen && !e.state.tafRead && _hlibReading) {
      _hlibReading = false;
      showHlibVolumes(_hlibOpenIdx);
    }
    // Holy Books: Back from a chapter returns to that scripture's book list
    if (e.state && e.state.qrOpen && !e.state.tafRead && _holyReading) {
      _holyReading = false;
      showHolyBooks(_holyOpenIdx);
    }
  });
}

document.addEventListener("DOMContentLoaded", init);
