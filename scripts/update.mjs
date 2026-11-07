// Povlači repertoar (i postere) za narednih 7 dana iz Cineplexx (Beograd), CineStar Ada Mall i Tuckwood,
// i upisuje ga u data.js koji čita index.html. Pokreće se svakog jutra preko GitHub Actions.
//   node scripts/update.mjs
import * as cheerio from "cheerio";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const OUT = fileURLToPath(new URL("../data.js", import.meta.url));
const UA = "film-za-manje-bot (+https://github.com/EmilijaNikolic333/film-za-manje)";
const DAYS_AHEAD = 7;
const MIN_SHOWS = 50; // ispod ovoga nešto ne valja: ne prepisujemo stare podatke

const sleep = ms => new Promise(r => setTimeout(r, ms));
const ymd = d => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Belgrade", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const addDays = (s, n) => { const d = new Date(s + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const TODAY = ymd(new Date());
const WINDOW = Array.from({ length: DAYS_AHEAD }, (_, i) => addDays(TODAY, i));
const inWindow = d => d >= WINDOW[0] && d <= WINDOW.at(-1);
const pad = (n) => String(n).padStart(2, "0");
const hhmm = t => { const [h, m] = t.split(":"); return pad(+h) + ":" + m; };

// Datum bez godine (CineStar piše "07.11.") -> godina koja je najbliža danas
function withYear(day, month) {
  const y0 = +TODAY.slice(0, 4);
  return [y0 - 1, y0, y0 + 1].map(y => `${y}-${pad(month)}-${pad(day)}`)
    .sort((a, b) => Math.abs(Date.parse(a) - Date.parse(TODAY)) - Math.abs(Date.parse(b) - Date.parse(TODAY)))[0];
}

async function get(url, as = "json") {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "sr" } });
      if (!r.ok) throw new Error(`HTTP ${r.status} za ${url}`);
      return as === "json" ? await r.json() : await r.text();
    } catch (e) {
      if (i >= 2) throw e;
      await sleep(2000 * (i + 1));
    }
  }
}

/* ---------- Spajanje istog filma iz različitih bioskopa ---------- */
const films = {}, byKey = new Map(), shows = [];
const norm = s => (s || "").toLowerCase().replace(/đ/g, "dj").normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/\(.*?\)/g, " ").replace(/\b[23]d\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim();

// Isti žanr se različito zove na različitim sajtovima
const GENRES = {
  akcijski: "Akcija", akcija: "Akcija", akcioni: "Akcija", animirani: "Animirani", avantura: "Avantura",
  biografski: "Biografski", "biografska drama": "Biografski", dokumentarni: "Dokumentarni", "dokumentarni film": "Dokumentarni",
  drama: "Drama", koncert: "Koncert", "koncert live": "Koncert",
  fantazija: "Fantazija", horor: "Horor", komedija: "Komedija", "kriminalisticki": "Krimi",
  "porodicni": "Porodični", "porodicni film": "Porodični", "romanticni": "Romantični", "romanticni/ljubavni": "Romantični",
  sf: "SF", triler: "Triler", opera: "Opera i balet", balet: "Opera i balet", muzicki: "Muzički", mjuzikl: "Muzički"
};
const genreOf = g => {
  const k = (g || "").trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (!k) return [];
  const out = [GENRES[k] || g.trim()[0].toUpperCase() + g.trim().slice(1).toLowerCase()];
  if (k === "biografska drama") out.push("Drama");
  return out;
};

function film({ title, orig, len, poster, genres = [] }) {
  const ev = /\b(live|uživo|uzivo)\b/i.test(title); // prenosi koncerata, opera i sl. imaju posebne cene
  title = title.replace(/\s*[-–]?\s*\b(pretpremijera|pretprodaja)\b/gi, "").trim();
  const keys = [norm(title), norm(orig)].filter(Boolean);
  let id = keys.map(k => byKey.get(k)).find(Boolean);
  // "Ramajana" i "Ramajana: Uspon legende" su isti film
  if (!id) for (const [k, v] of byKey) {
    if (keys.some(n => Math.min(n.length, k.length) >= 6 && (k.startsWith(n + " ") || n.startsWith(k + " ")))) { id = v; break; }
  }
  if (!id) {
    const base = keys[0].replace(/ /g, "-").slice(0, 40) || "film";
    id = base; for (let i = 2; films[id]; i++) id = `${base}-${i}`;
    films[id] = { n: title };
  }
  const f = films[id];
  if (!f.len && len) f.len = len;
  if (!f.poster && poster) f.poster = poster;
  if (!f.o && !ev && orig && norm(orig) !== norm(f.n)) f.o = orig.trim();
  const g = new Set([...(f.g || []), ...genres.flatMap(genreOf)]);
  if (g.size) f.g = [...g].sort((a, b) => a.localeCompare(b, "sr"));
  if (ev) f.ev = 1;
  keys.forEach(k => byKey.has(k) || byKey.set(k, id));
  return id;
}

function fxFrom(tags) {
  const fx = [];
  if (tags.includes("3D")) fx.push("3D");
  if (tags.includes("MX4D")) fx.push("MX4D");
  else if (tags.includes("4DX")) fx.push("4DX");
  if (tags.includes("IMAX")) fx.push("IMAX");
  if (tags.includes("SCREENX")) fx.push("SX");
  return fx;
}
const langFrom = tags => tags.includes("SINH") ? "sinh" : tags.some(t => t.startsWith("TITL")) ? "titl" : tags.includes("OV") ? "ov" : undefined;

function addShow(s) {
  const o = { f: s.f, c: s.c, d: s.d, t: hhmm(s.t) };
  if (s.fx?.length) o.fx = s.fx;
  if (s.l) o.l = s.l;
  if (s.ev) o.ev = 1;
  shows.push(o);
}

/* ---------- Cineplexx (javni API koji koristi i njihov sajt) ---------- */
const CPX_CINEMAS = { "1113": "usce", "1111": "delta", "1115": "big", "1118": "beo", "1119": "gal" };

async function cineplexx() {
  const API = "https://app.cineplexx.rs/api";
  const movies = new Map();
  for (const d of WINDOW) {
    for (const m of await get(`${API}/v2/movies?date=${d}&location=all`)) {
      if (m.cinemaIds?.some(c => CPX_CINEMAS[c])) movies.set(m.id, m);
    }
    await sleep(250);
  }
  for (const m of movies.values()) {
    const groups = await get(`${API}/v3/moviesweb/${m.id}/sessions?location=all`);
    let fid;
    for (const g of groups) for (const s of g.sessions || []) {
      const c = CPX_CINEMAS[s.cinemaId], d = s.showtime.slice(0, 10);
      if (!c || !inWindow(d)) continue;
      const tags = (s.technologies?.[0] || []).map(x => String(x).toUpperCase());
      fid ??= film({ title: m.title.trim(), orig: m.titleOriginalCalculated, len: m.runTime, poster: m.posterImage, genres: m.genres || [] });
      addShow({ f: fid, c, d, t: s.showtime.slice(11, 16), fx: fxFrom(tags), l: langFrom(tags) });
    }
    await sleep(250);
  }
}

/* ---------- CineStar Ada Mall (HTML stranica sa svim terminima) ---------- */
async function cinestar() {
  const $ = cheerio.load(await get("https://cinestarcinemas.rs/beograd-concept-cinema-ada-mall", "text"));
  for (const el of $(".movie-item").toArray()) {
    const $m = $(el);
    const title = $m.find(".movie-desc h2").first().text().trim();
    if (!title) continue;
    const dur = $m.find(".duration").first().text();
    const len = (+(dur.match(/(\d+)\s*h/)?.[1] || 0)) * 60 + (+(dur.match(/(\d+)\s*min/)?.[1] || 0));
    const poster = $m.find(".poster-wrapper img").first().attr("src");
    const genres = [$m.attr("data-genre")];
    const found = [];
    $m.find(".day-wrapper").each((_, dw) => {
      const dm = $(dw).find(".day").first().text().match(/(\d{1,2})\.(\d{1,2})\./);
      if (!dm) return;
      const d = withYear(+dm[1], +dm[2]);
      if (!inWindow(d)) return;
      $(dw).find("a.perf").each((_, p) => {
        const t = $(p).find(".time").first().text().trim();
        if (!/^\d{1,2}:\d{2}$/.test(t)) return;
        const tags = ($(p).attr("data-format") || "").toUpperCase().split("/").map(s => s.trim());
        found.push({ c: "ada", d, t, fx: fxFrom(tags), l: langFrom(tags), ev: tags.includes("LIVE") });
      });
    });
    if (!found.length) continue;
    // Izvorni naslov je samo na stranici filma; čitamo je kad film još ne znamo iz Cineplexx-a
    let orig;
    const link = $m.find(".poster-wrapper").attr("href");
    if (link && !byKey.has(norm(title.replace(/\s*[-–]?\s*\b(pretpremijera|pretprodaja)\b/gi, "")))) {
      try {
        const txt = cheerio.load(await get(link, "text"))("body").text().replace(/\s+/g, " ");
        orig = txt.match(/Izvorni naslov:\s*(.+?)\s+(?:Režiser|Režija|Uloge|Žanr|Trajanje|Izaberi)\b/)?.[1];
      } catch { /* bez originalnog naziva */ }
      await sleep(250);
    }
    const fid = film({ title, orig, len, poster, genres });
    found.forEach(s => addShow({ f: fid, ...s }));
  }
}

/* ---------- Tuckwood (WordPress stranica repertoara) ---------- */
const MONTHS = { januar: 1, februar: 2, mart: 3, april: 4, maj: 5, jun: 6, jul: 7, avgust: 8, septembar: 9, oktobar: 10, novembar: 11, decembar: 12 };

async function tuckwood() {
  const $ = cheerio.load(await get("https://www.tuck.rs/repertoar/", "text"));
  $(".amy-movie-item-inner").each((_, el) => {
    const $m = $(el);
    const raw = $m.find(".amy-movie-field-title").first().text().replace(/\s+/g, " ").trim();
    if (!raw) return;
    const [local, orig] = raw.split(" / ");
    const d3 = /[–-]\s*3D\b/i.test(local), sinh = /sinhro/i.test(local);
    const title = local.replace(/\(.*?\)/g, "").replace(/\s*[–-]\s*[23]D\s*$/i, "").replace(/\s+/g, " ").trim();
    const dur = $m.find(".amy-movie-field-duration").first().text();
    const len = (+(dur.match(/(\d+)\s*sat/)?.[1] || 0)) * 60 + (+(dur.match(/(\d+)\s*minut/)?.[1] || 0));
    const poster = $m.find(".amy-movie-item-poster img").first().attr("src");
    const genres = $m.find(".amy-movie-field-amy_genre a").toArray().map(a => $(a).text());
    let fid;
    $m.find(".amy-cell").each((_, cell) => {
      const dm = $(cell).find(".amy-head").text().toLowerCase().match(/(\d{1,2})\.\s*([a-z]+)\s+(\d{4})/);
      if (!dm || !MONTHS[dm[2]]) return;
      const d = `${dm[3]}-${pad(MONTHS[dm[2]])}-${pad(+dm[1])}`;
      if (!inWindow(d)) return;
      $(cell).find(".amy-intro-times > div").each((_, row) => {
        const t = $(row).text().trim().match(/(\d{1,2}:\d{2})$/)?.[1];
        if (!t) return;
        fid ??= film({ title, orig, len, poster, genres });
        addShow({ f: fid, c: "tuck", d, t, fx: d3 ? ["3D"] : [], l: sinh ? "sinh" : "titl" });
      });
    });
  });
}

/* ---------- Glavni deo ---------- */
const errors = [];
for (const [name, fn] of [["Cineplexx", cineplexx], ["CineStar", cinestar], ["Tuckwood", tuckwood]]) {
  const before = shows.length;
  try { await fn(); console.log(`${name}: ${shows.length - before} termina`); }
  catch (e) { console.error(`${name} NIJE uspeo:`, e.message); errors.push(name); }
}

// ukloni duplikate (isti film, bioskop, dan, vreme i format)
const seen = new Set();
const unique = shows.filter(s => { const k = [s.f, s.c, s.d, s.t, (s.fx || []).join()].join("|"); return !seen.has(k) && seen.add(k); })
  .sort((a, b) => (a.d + a.t).localeCompare(b.d + b.t));
const used = new Set(unique.map(s => s.f));
for (const id of Object.keys(films)) if (!used.has(id)) delete films[id];

if (unique.length < MIN_SHOWS) {
  console.error(`Pronađeno samo ${unique.length} termina — data.js NIJE promenjen.`);
  process.exit(1);
}

const data = { updated: new Date().toISOString(), from: WINDOW[0], to: WINDOW.at(-1), errors, films, shows: unique };
await writeFile(OUT, "// Automatski generisano skriptom scripts/update.mjs — ne menjati ručno.\nwindow.DATA=" + JSON.stringify(data) + ";\n");
console.log(`Upisano ${unique.length} termina, ${Object.keys(films).length} filmova (${data.from} – ${data.to}).`);
