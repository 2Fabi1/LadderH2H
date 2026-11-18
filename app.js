'use strict';

/* =====================================================================
   Ladder Head-to-Head — compares two TMUF logins using the UnitedLadder API
   Docs: https://api.ul.unitedascenders.xyz/docs
   ===================================================================== */

const API = 'https://api.ul.unitedascenders.xyz';
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const nf = new Intl.NumberFormat('en-US');
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------------------------------------------------------------------
   API client — the API allows 15 requests / minute, so everything goes
   through a sliding-window queue and responses are cached.
   --------------------------------------------------------------------- */
const RATE = { max: 13, windowMs: 60000, stamps: [], gate: Promise.resolve(), onWait: null };

function acquire() {
  const p = RATE.gate.then(async () => {
    for (;;) {
      const now = Date.now();
      RATE.stamps = RATE.stamps.filter(t => now - t < RATE.windowMs);
      if (RATE.stamps.length < RATE.max) {
        RATE.stamps.push(now);
        RATE.onWait?.(0);
        return;
      }
      const wait = RATE.stamps[0] + RATE.windowMs - now + 50;
      RATE.onWait?.(wait);
      await sleep(Math.min(wait, 500));
    }
  });
  RATE.gate = p.catch(() => {});
  return p;
}

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const cache = new Map();
function getJson(path) {
  if (cache.has(path)) return cache.get(path);
  const p = (async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      await acquire();
      let res;
      try { res = await fetch(API + path); }
      catch { throw new ApiError(0, 'Could not reach the UnitedLadder API. Check your connection and try again.'); }
      if (res.status === 429) {            // server says slow down → burn the whole window
        RATE.stamps = Array(RATE.max).fill(Date.now());
        continue;
      }
      let body = null;
      try { body = await res.json(); } catch { /* non-JSON body */ }
      if (!res.ok) throw new ApiError(res.status, body?.error || `The API answered with an error (${res.status}).`);
      return body;
    }
    throw new ApiError(429, 'The API rate limit keeps being hit. Wait a minute and try again.');
  })();
  cache.set(path, p);
  p.catch(() => cache.delete(path));
  return p;
}

async function loadPlayer(login) {
  const l = encodeURIComponent(login);
  const [profile, maps] = await Promise.all([getJson(`/player/${l}`), getJson(`/solomaps/${l}/0`)]);
  return { login: profile?.login || login, profile, maps: Array.isArray(maps) ? maps : [] };
}

/* ---------------------------------------------------------------------
   TrackMania nickname formatting ($f00 colours, $i, $o, $z …)
   Built with DOM nodes only, so nicknames can never inject HTML.
   --------------------------------------------------------------------- */
function readable(hex3) {
  const [r, g, b] = [...hex3].map(h => parseInt(h, 16) * 17);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  const m = lum < 0.55 ? Math.min(0.8, (0.55 - lum) * 1.7) : 0;   // lift colours that vanish on a dark page
  const mix = c => Math.round(c + (255 - c) * m);
  return `rgb(${mix(r)},${mix(g)},${mix(b)})`;
}

function tmNick(raw) {
  const root = document.createElement('span');
  const fresh = () => ({ color: null, bold: false, italic: false, upper: false });
  let st = fresh();
  let buf = '';
  const flush = () => {
    if (!buf) return;
    const s = document.createElement('span');
    s.textContent = st.upper ? buf.toUpperCase() : buf;
    if (st.color) s.style.color = readable(st.color);
    if (st.bold) s.style.fontWeight = '800';
    if (st.italic) s.style.fontStyle = 'italic';
    root.appendChild(s);
    buf = '';
  };
  const str = String(raw ?? '');
  for (let i = 0; i < str.length;) {
    const ch = str[i];
    if (ch !== '$') { buf += ch; i++; continue; }
    const nx = str[i + 1];
    if (nx === undefined) break;
    if (nx === '$') { buf += '$'; i += 2; continue; }
    flush();
    if (/[0-9a-f]/i.test(nx)) {
      const hex = str.slice(i + 1, i + 4);
      if (/^[0-9a-f]{3}$/i.test(hex)) { st.color = hex; i += 4; }
      else i += 1 + hex.match(/^[0-9a-f]*/i)[0].length;
      continue;
    }
    const c = nx.toLowerCase();
    if (c === 'z') st = fresh();
    else if (c === 'g') st.color = null;
    else if (c === 'i') st.italic = true;
    else if (c === 'o') st.bold = true;
    else if (c === 't') st.upper = true;
    else if ('lhp'.includes(c) && str[i + 2] === '[') {      // $l[url] link markup — drop the url
      const end = str.indexOf(']', i + 3);
      i = end < 0 ? str.length : end + 1;
      continue;
    }
    i += 2;
  }
  flush();
  return root;
}

const plainNick = (raw, fallback) => (tmNick(raw).textContent || '').trim() || fallback;

/* ---------------------------------------------------------------------
   Comparison logic
   Wins are decided on official skill points: a player's points on a track
   come from their leaderboard rank, so more points == faster time.
   --------------------------------------------------------------------- */
function buildRows(mapsA, mapsB) {
  const byUid = new Map();
  const add = (list, side) => {
    for (const m of list) {
      let r = byUid.get(m.uid);
      if (!r) {
        r = { uid: m.uid, name: m.name, envi: m.envi || '', campaign: m.campaign || 'Other', a: 0, b: 0, ghostA: null, ghostB: null };
        byUid.set(m.uid, r);
      }
      r[side] = Number(m.points) || 0;
      r[side === 'a' ? 'ghostA' : 'ghostB'] = m.ghost || null;
    }
  };
  add(mapsA, 'a');
  add(mapsB, 'b');
  return [...byUid.values()];
}

function classify(rows, bothOnly) {
  for (const r of rows) {
    const hi = Math.max(r.a, r.b);
    if (!hi || (bothOnly && (!r.a || !r.b))) r.res = 'none';
    else r.res = r.a > r.b ? 'A' : r.b > r.a ? 'B' : 'D';
    r.diff = Math.abs(r.a - r.b);
    r.pct = hi ? r.diff / hi : 0;
  }
}

function summarize(rows) {
  const played = rows.filter(r => r.res !== 'none');
  const wins = played.filter(r => r.res === 'A');
  const losses = played.filter(r => r.res === 'B');
  const draws = played.filter(r => r.res === 'D');
  const sum = (list, k) => list.reduce((t, r) => t + r[k], 0);
  const avgLead = list => list.length ? sum(list, 'diff') / list.length : 0;
  const biggest = list => list.reduce((best, r) => (!best || r.diff > best.diff ? r : best), null);
  return {
    played, wins, losses, draws,
    w: wins.length, d: draws.length, l: losses.length,
    ptsA: sum(played, 'a'), ptsB: sum(played, 'b'),
    avgLeadA: avgLead(wins), avgLeadB: avgLead(losses),
    bigA: biggest(wins), bigB: biggest(losses),
    skipped: rows.length - played.length,
  };
}

/* ---------------------------------------------------------------------
   Exact times (lazy) — a player's rank on a track follows from their skill
   points, so their record's leaderboard page can be located in a request or two.
   --------------------------------------------------------------------- */
const trackPage = (uid, page) => getJson(`/tracks/World/${encodeURIComponent(uid)}/${page}`);

async function findRecord(uid, login, points) {
  if (!points) return null;
  const first = await trackPage(uid, 0);
  const total = Number(first.recordCount) || 0;
  const lastPage = Math.max(0, Math.floor((total - 1) / 100));
  const want = login.toLowerCase();
  // Players tied on a track share rank + score, so a record with identical skill points is as good as their own.
  const inPage = d => {
    const recs = d.records || [];
    const own = recs.find(r => String(r.login).toLowerCase() === want);
    if (own) return { rec: own, meta: first };
    const tie = recs.find(r => r.skillpoints === points);
    return tie ? { rec: tie, tied: true, meta: first } : null;
  };

  // Skill points = 100·(N − rank) / rank, so rank ≈ 100·N / (points + 100) gives the page directly.
  // Rounding can miss by a page or two at deep ranks: nudge ±1, then bisect on the leaderboard's own points.
  let lo = 0, hi = lastPage;
  let page = Math.floor((Math.max(1, Math.round(100 * total / (points + 100))) - 1) / 100);
  const seen = new Set();
  for (let i = 0; i < 12 && lo <= hi; i++) {
    page = Math.min(Math.max(page, lo), hi);
    if (seen.has(page)) break;
    seen.add(page);
    const d = page === 0 ? first : await trackPage(uid, page);
    const recs = d.records || [];
    const hit = inPage(d);
    if (hit) return hit;
    if (!recs.length) break;
    const top = recs[0].skillpoints, bottom = recs[recs.length - 1].skillpoints;
    if (points > top) { hi = page - 1; page = i < 2 ? page - 1 : Math.floor((lo + hi) / 2); }
    else if (points < bottom) { lo = page + 1; page = i < 2 ? page + 1 : Math.floor((lo + hi) / 2); }
    else {                                   // points fall inside this page but no match → a tie group spans pages
      for (const n of [page - 1, page + 1]) {
        if (n < 0 || n > lastPage || seen.has(n)) continue;
        seen.add(n);
        const nd = await trackPage(uid, n);
        const nh = inPage(nd);
        if (nh) return nh;
      }
      break;
    }
  }
  return { rec: null, meta: first };
}

function fmtTime(ms) {
  const cs = Math.round(ms / 10);
  const m = Math.floor(cs / 6000);
  const s = ((cs % 6000) / 100).toFixed(2).padStart(5, '0');
  return `${m}:${s}`;
}
/* Stunts scores come back as a complement of 0xEEEEEEEE (higher score = lower raw value);
   Platform "points" are respawn counts (lower is better). Everything else is a time in ms. */
const STUNT_BASE = 0xEEEEEEEE;
function fmtScore(value, mode) {
  if (mode === 'Stunts') return `${nf.format(value > 1e9 ? STUNT_BASE - value : value)} pts`;
  if (mode === 'Platform') return `${nf.format(value)} ${value === 1 ? 'respawn' : 'respawns'}`;
  return fmtTime(value);
}
function fmtGap(a, b, mode) {
  const d = Math.abs(a - b);
  if (mode === 'Stunts') return `${nf.format(d)} pts`;
  if (mode === 'Platform') return `${nf.format(d)} ${d === 1 ? 'respawn' : 'respawns'}`;
  return d >= 60000 ? fmtTime(d) : `${(d / 1000).toFixed(2)}s`;
}

/* ---------------------------------------------------------------------
   State + rendering
   --------------------------------------------------------------------- */
const state = {
  A: null, B: null, rows: [], sum: null,
  bothOnly: false,
  view: { q: '', env: '', sort: 'pct', filter: 'all', open: new Set(), tracksOpen: false },
  runId: 0,
};

const CAMPAIGN_ORDER = ['United', 'Nations', 'Star', 'Stunts', 'Platform', 'Puzzle', 'Race', 'Custom'];
const nameA = () => state.A.login;
const nameB = () => state.B.login;
const zoneOf = p => (p?.path || '').split('|').slice(1).join(' · ') || 'No zone';

function soloRank(p) {
  // Normal profiles give [{rank, zonePath}]; "legacy" profiles give bare numbers like [60].
  const ranks = (Array.isArray(p?.solo?.ranks) ? p.solo.ranks : [])
    .map(r => typeof r === 'number' ? { rank: r, zonePath: '' } : { rank: r?.rank, zonePath: String(r?.zonePath ?? '') })
    .filter(r => Number.isFinite(Number(r.rank)))
    .sort((x, y) => x.zonePath.length - y.zonePath.length);
  if (!ranks.length) return '—';
  const r = ranks[0];
  const zone = r.zonePath.split('|').pop();
  return `#${nf.format(r.rank)}${zone ? `<small>${esc(zone)}</small>` : ''}`;
}

function leadClass(a, b, higherIsBetter = true) {
  if (a === b) return ['', ''];
  const aLeads = higherIsBetter ? a > b : a < b;
  return aLeads ? ['lead', ''] : ['', 'lead'];
}

function h2hRow(label, a, b, la = '', lb = '') {
  return `<div class="row"><div class="v a ${la}">${a}</div><div class="lab">${label}</div><div class="v b ${lb}">${b}</div></div>`;
}

function mapCell(r, side) {
  if (!r) return '—';
  const lead = side === 'A' ? r.a - r.b : r.b - r.a;
  return `${esc(r.name)}<small>+${compact.format(lead)} pts</small>`;
}

function renderAll() {
  const s = state.sum = (classify(state.rows, state.bothOnly), summarize(state.rows));
  const { A, B } = state;
  const total = s.w + s.d + s.l;
  const pct = n => total ? (n / total) * 100 : 0;
  const winRate = n => total ? `${Math.round(n / total * 100)}%` : '—';

  let verdict;
  if (!total) verdict = 'No official results to compare.';
  else if (s.w === s.l) verdict = `Dead level over <b>${total}</b> contested tracks.`;
  else {
    const lead = s.w > s.l ? A : B, ahead = Math.abs(s.w - s.l);
    verdict = `<b data-vname="${lead === A ? 'a' : 'b'}"></b> leads by <b>${ahead}</b> track${ahead === 1 ? '' : 's'} over <b>${total}</b> contested.`;
  }

  const [pl1, pl2] = leadClass(s.ptsA, s.ptsB);
  const [wr1, wr2] = leadClass(s.w, s.l);
  const [al1, al2] = leadClass(s.avgLeadA, s.avgLeadB);
  const [bg1, bg2] = leadClass(s.bigA?.diff ?? 0, s.bigB?.diff ?? 0);

  $('#result').innerHTML = `
    <section class="hero">
      <div class="pl a">
        <span class="tag">Player 1</span>
        <span class="nick" data-nick="a"></span>
        <div class="meta">${esc(A.login)} · ${esc(zoneOf(A.profile))}</div>
        <div class="big-pts"><b>${nf.format(A.profile?.solo?.points ?? s.ptsA)}</b> skill pts</div>
      </div>
      <div class="score">
        <div class="wdl" aria-label="${s.w} wins, ${s.d} draws, ${s.l} losses for ${esc(A.login)}">
          <div class="n w"><b>${s.w}</b><span>W</span></div><span class="dash">–</span>
          <div class="n d"><b>${s.d}</b><span>D</span></div><span class="dash">–</span>
          <div class="n l"><b>${s.l}</b><span>L</span></div>
        </div>
        <div class="split" aria-hidden="true"><i class="sa" style="width:${pct(s.w)}%"></i><i class="sd" style="width:${pct(s.d)}%"></i><i class="sb" style="width:${pct(s.l)}%"></i></div>
        <p class="verdict">${verdict}</p>
      </div>
      <div class="pl b">
        <span class="tag">Player 2</span>
        <span class="nick" data-nick="b"></span>
        <div class="meta">${esc(B.login)} · ${esc(zoneOf(B.profile))}</div>
        <div class="big-pts"><b>${nf.format(B.profile?.solo?.points ?? s.ptsB)}</b> skill pts</div>
      </div>
    </section>

    <div class="opts">
      <span>W-D-L is from <b data-vname="a"></b>’s side — one W for them is one L for <b data-vname="b"></b>.</span>
      <label><input type="checkbox" id="bothOnly" ${state.bothOnly ? 'checked' : ''}> Only tracks both players have driven</label>
    </div>

    <section class="h2h" aria-label="Head to head stats">
      ${h2hRow('Skill points', nf.format(s.ptsA), nf.format(s.ptsB), pl1, pl2)}
      ${h2hRow('Tracks won', s.w, s.l, wr1, wr2)}
      ${h2hRow('Win rate', winRate(s.w), winRate(s.l), wr1, wr2)}
      ${h2hRow('Avg lead when ahead', s.w ? `${compact.format(s.avgLeadA)} pts` : '—', s.l ? `${compact.format(s.avgLeadB)} pts` : '—', al1, al2)}
      ${h2hRow('Biggest win', mapCell(s.bigA, 'A'), mapCell(s.bigB, 'B'), bg1, bg2)}
      ${h2hRow('Solo rank', soloRank(A.profile), soloRank(B.profile))}
    </section>

    <details class="tracks" id="tracks" ${state.view.tracksOpen ? 'open' : ''}>
      <summary><span>Track-by-track breakdown<small>${total} tracks${s.skipped ? ` · ${s.skipped} skipped` : ''}</small></span><i class="chev"></i></summary>
      <div id="trackBody"></div>
    </details>`;

  fillNames();
  renderTrackBody();

  $('#bothOnly').addEventListener('change', e => { state.bothOnly = e.target.checked; renderAll(); });
  $('#tracks').addEventListener('toggle', e => { if (e.target.id === 'tracks') state.view.tracksOpen = e.target.open; });
}

function fillNames() {
  for (const side of ['a', 'b']) {
    const p = state[side.toUpperCase()];
    $(`[data-nick="${side}"]`)?.replaceChildren(tmNick(p.profile?.nickname || p.login));
    $$(`[data-vname="${side}"]`).forEach(el => { el.textContent = plainNick(p.profile?.nickname, p.login); });
  }
}

function renderTrackBody() {
  const v = state.view, rows = state.rows.filter(r => r.res !== 'none');
  const envs = [...new Set(rows.map(r => r.envi).filter(Boolean))].sort();
  const count = f => rows.filter(r => f === 'all' || r.res === f).length;

  $('#trackBody').innerHTML = `
    <div class="legend">
      <span><i class="dot a"></i>${esc(nameA())}</span>
      <span><i class="dot b"></i>${esc(nameB())}</span>
      <span class="sp"></span>
      <button type="button" id="expandAll">Expand all</button>
      <button type="button" id="collapseAll">Collapse all</button>
    </div>
    <div class="tools">
      <input type="search" id="q" placeholder="Search tracks…" value="${esc(v.q)}" aria-label="Search tracks">
      <select id="env" aria-label="Environment">
        <option value="">All environments</option>
        ${envs.map(e => `<option ${v.env === e ? 'selected' : ''}>${esc(e)}</option>`).join('')}
      </select>
      <select id="sort" aria-label="Sort tracks">
        <option value="pct" ${v.sort === 'pct' ? 'selected' : ''}>Biggest gap (%)</option>
        <option value="pts" ${v.sort === 'pts' ? 'selected' : ''}>Biggest gap (points)</option>
        <option value="name" ${v.sort === 'name' ? 'selected' : ''}>Track name</option>
      </select>
      <div class="pills" role="group" aria-label="Filter by result">
        <button type="button" class="pill" data-f="all" aria-pressed="${v.filter === 'all'}">All ${count('all')}</button>
        <button type="button" class="pill a" data-f="A" aria-pressed="${v.filter === 'A'}">${esc(nameA())} ${count('A')}</button>
        <button type="button" class="pill" data-f="D" aria-pressed="${v.filter === 'D'}">Draws ${count('D')}</button>
        <button type="button" class="pill b" data-f="B" aria-pressed="${v.filter === 'B'}">${esc(nameB())} ${count('B')}</button>
      </div>
    </div>
    <div id="groups"></div>
    <p class="note">Wins are decided on official skill points, which are earned from a player’s rank on each track — more points means a faster time. Open a track for the exact times. A track only one player has driven counts as a win for them${state.bothOnly ? ' (currently excluded)' : ''}; tracks nobody has driven are skipped.</p>`;

  $('#q').addEventListener('input', e => { v.q = e.target.value; renderGroups(); });
  $('#env').addEventListener('change', e => { v.env = e.target.value; renderGroups(); });
  $('#sort').addEventListener('change', e => { v.sort = e.target.value; renderGroups(); });
  $$('.pill').forEach(b => b.addEventListener('click', () => {
    v.filter = b.dataset.f;
    $$('.pill').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    renderGroups();
  }));
  $('#expandAll').addEventListener('click', () => { $$('#groups .grp').forEach(g => { g.open = true; v.open.add(g.dataset.c); }); });
  $('#collapseAll').addEventListener('click', () => { $$('#groups .grp').forEach(g => { g.open = false; }); v.open.clear(); });
  renderGroups();
}

function renderGroups() {
  const v = state.view;
  const q = v.q.trim().toLowerCase();
  const filtering = !!(q || v.env || v.filter !== 'all');
  const all = state.rows.filter(r => r.res !== 'none');
  const shown = all.filter(r =>
    (v.filter === 'all' || r.res === v.filter) &&
    (!v.env || r.envi === v.env) &&
    (!q || r.name.toLowerCase().includes(q)));

  const sorters = {
    pct: (x, y) => y.pct - x.pct || y.diff - x.diff,
    pts: (x, y) => y.diff - x.diff,
    name: (x, y) => x.name.localeCompare(y.name, undefined, { numeric: true }),
  };

  const byCampaign = new Map();
  for (const r of shown) {
    if (!byCampaign.has(r.campaign)) byCampaign.set(r.campaign, []);
    byCampaign.get(r.campaign).push(r);
  }
  const names = [...byCampaign.keys()].sort((x, y) => {
    const ix = CAMPAIGN_ORDER.indexOf(x), iy = CAMPAIGN_ORDER.indexOf(y);
    return (ix < 0 ? 99 : ix) - (iy < 0 ? 99 : iy) || x.localeCompare(y);
  });

  if (!names.length) { $('#groups').innerHTML = '<div class="empty">No tracks match those filters.</div>'; return; }

  $('#groups').innerHTML = names.map(c => {
    const list = byCampaign.get(c).sort(sorters[v.sort]);
    const full = all.filter(r => r.campaign === c);
    const gw = full.filter(r => r.res === 'A').length, gd = full.filter(r => r.res === 'D').length, gl = full.filter(r => r.res === 'B').length;
    const gt = full.length || 1;
    const open = filtering || v.open.has(c);
    return `
      <details class="grp" data-c="${esc(c)}" ${open ? 'open' : ''}>
        <summary>
          <span class="gname">${esc(c)}<small>${list.length}${list.length !== full.length ? ` of ${full.length}` : ''} tracks</small></span>
          <span class="gwdl"><span class="a">${gw}</span> – <span class="d">${gd}</span> – <span class="b">${gl}</span></span>
          <span class="gbar" aria-hidden="true"><i class="sa" style="width:${gw / gt * 100}%"></i><i class="sd" style="width:${gd / gt * 100}%"></i><i class="sb" style="width:${gl / gt * 100}%"></i></span>
          <i class="chev"></i>
        </summary>
        ${list.map(trackRow).join('')}
      </details>`;
  }).join('');
}

function trackRow(r) {
  const w = r.res === 'D' ? 0 : Math.max(2, r.pct * 100);
  const label = r.res === 'D' ? 'Draw' : `+${compact.format(r.diff)}`;
  const winA = r.res === 'A' ? 'win' : '', winB = r.res === 'B' ? 'win' : '';
  return `
    <details class="trk" data-uid="${esc(r.uid)}">
      <summary>
        <span class="tname"><b>${esc(r.name)}</b><i class="env">${esc(r.envi)}</i></span>
        <span class="pts a ${winA} ${r.a ? '' : 'zero'}">${r.a ? nf.format(r.a) : 'no time'}</span>
        <span class="vs" aria-hidden="true">
          <span class="l"><i style="width:${r.res === 'A' ? w : 0}%"></i></span>
          <span class="r"><i style="width:${r.res === 'B' ? w : 0}%"></i></span>
        </span>
        <span class="pts b ${winB} ${r.b ? '' : 'zero'}">${r.b ? nf.format(r.b) : 'no time'}</span>
        <span class="res ${r.res}" title="${r.res === 'A' ? esc(nameA()) + ' ahead' : r.res === 'B' ? esc(nameB()) + ' ahead' : 'Level'}">${r.res === 'B' ? '◀ ' : ''}${label}${r.res === 'A' ? ' ▶' : ''}</span>
        <i class="chev"></i>
      </summary>
      <div class="exact"><p class="msg">Loading exact times…</p></div>
    </details>`;
}

/* toggle doesn't bubble → listen in the capture phase */
document.addEventListener('toggle', e => {
  const el = e.target;
  if (!(el instanceof HTMLDetailsElement)) return;
  if (el.classList.contains('grp')) {
    el.open ? state.view.open.add(el.dataset.c) : state.view.open.delete(el.dataset.c);
  } else if (el.classList.contains('trk') && el.open && !el.dataset.loaded) {
    el.dataset.loaded = '1';
    loadExact(el);
  }
}, true);

async function loadExact(el) {
  const box = $('.exact', el);
  const row = state.rows.find(r => r.uid === el.dataset.uid);
  if (!row) return;
  box.innerHTML = '<p class="msg"><span class="spin"></span>Looking up exact times…</p>';
  try {
    const [fa, fb] = await Promise.all([
      findRecord(row.uid, nameA(), row.a),
      findRecord(row.uid, nameB(), row.b),
    ]);
    const meta = (fa || fb)?.meta;
    const mode = meta?.gameMode || 'Race';
    const ra = fa?.rec, rb = fb?.rec;
    const cell = (side, found, pts, ghost, login) => {
      const rec = found?.rec;
      const best = row.res === side ? 'best' : '';
      const cls = side === 'A' ? 'a' : 'b';
      if (!pts) return `<div class="ex ${cls}"><div class="who">${esc(login)}</div><span class="time">—</span><div class="sub">No official time</div></div>`;
      if (!rec) return `<div class="ex ${cls}"><div class="who">${esc(login)}</div><span class="time">?</span><div class="sub">Couldn’t locate this record</div></div>`;
      return `<div class="ex ${cls} ${best}">
        <div class="who">${esc(login)}</div>
        <span class="time">${esc(fmtScore(rec.points, mode))}</span>
        <div class="sub">Rank #${nf.format(rec.globalRank)}${found.tied ? ' (tied)' : ''}${meta?.recordCount ? ` of ${nf.format(meta.recordCount)}` : ''}${ghost ? ` · <a href="${esc(ghost)}" target="_blank" rel="noopener">ghost</a>` : ''}</div>
      </div>`;
    };
    let gap = '<div class="gap"><span>—</span></div>';
    if (ra && rb) {
      const leader = ra.globalRank < rb.globalRank ? nameA() : rb.globalRank < ra.globalRank ? nameB() : null;
      gap = leader
        ? `<div class="gap"><b>${esc(fmtGap(ra.points, rb.points, mode))}</b><span>${esc(leader)} ahead</span></div>`
        : `<div class="gap"><b>Equal</b><span>same rank</span></div>`;
    } else if (ra || rb) {
      gap = `<div class="gap"><b>${ra ? esc(nameA()) : esc(nameB())}</b><span>only one time set</span></div>`;
    }
    box.innerHTML = `<div class="exgrid">${cell('A', fa, row.a, row.ghostA, nameA())}${gap}${cell('B', fb, row.b, row.ghostB, nameB())}</div>`;
  } catch (err) {
    el.dataset.loaded = '';
    box.innerHTML = `<p class="msg err">Couldn’t load exact times: ${esc(err.message)} <button type="button" class="link">Retry</button></p>`;
    $('.link', box).addEventListener('click', () => { el.dataset.loaded = '1'; loadExact(el); });
  }
}

/* ---------------------------------------------------------------------
   Form + page wiring
   --------------------------------------------------------------------- */
const form = $('#form'), statusEl = $('#status'), resultEl = $('#result'), goBtn = $('#go');

function setStatus(html, kind = '') {
  statusEl.hidden = !html;
  statusEl.className = 'status' + (kind ? ' ' + kind : '');
  statusEl.innerHTML = html;
}

RATE.onWait = ms => {
  if (!goBtn.disabled) return;                     // only narrate while loading the main comparison
  setStatus(ms > 0
    ? `<span class="spin"></span>The API allows 15 requests a minute — resuming in ${Math.ceil(ms / 1000)}s…`
    : '<span class="spin"></span>Fetching official results…');
};

async function run(rawA, rawB) {
  const a = rawA.trim().toLowerCase(), b = rawB.trim().toLowerCase();
  if (!a || !b) return;
  if (a === b) { setStatus('Pick two different logins to compare.', 'error'); resultEl.hidden = true; return; }

  const id = ++state.runId;
  goBtn.disabled = true;
  resultEl.hidden = true;
  setStatus('<span class="spin"></span>Fetching official results…');

  try {
    const [A, B] = await Promise.all([loadPlayer(a), loadPlayer(b)]);
    if (id !== state.runId) return;
    state.A = A; state.B = B;
    state.rows = buildRows(A.maps, B.maps);
    state.view.open.clear();
    state.view.q = ''; state.view.env = ''; state.view.filter = 'all';
    renderAll();
    resultEl.hidden = false;
    setStatus('');
    const url = new URL(location.href);
    url.searchParams.set('a', a); url.searchParams.set('b', b);
    try { history.replaceState(null, '', url); } catch { /* file:// or sandboxed */ }
  } catch (err) {
    if (id !== state.runId) return;
    setStatus(esc(err.message || 'Something went wrong.'), 'error');
  } finally {
    if (id === state.runId) goBtn.disabled = false;
  }
}

form.addEventListener('submit', e => { e.preventDefault(); run($('#loginA').value, $('#loginB').value); });
$('#swap').addEventListener('click', () => {
  const x = $('#loginA'), y = $('#loginB');
  [x.value, y.value] = [y.value, x.value];
  if (!resultEl.hidden && x.value && y.value) run(x.value, y.value);
});
$('#example').addEventListener('click', () => {
  $('#loginA').value = 'redgreendevil';
  $('#loginB').value = 'fwo_axell';
  run('redgreendevil', 'fwo_axell');
});

const qs = new URLSearchParams(location.search);
if (qs.get('a') && qs.get('b')) {
  $('#loginA').value = qs.get('a');
  $('#loginB').value = qs.get('b');
  run(qs.get('a'), qs.get('b'));
}
