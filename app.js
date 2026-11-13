import {
  FL_DUP, FL_NOANS, FL_NOQ,
  appendAnswerEvent, clearActiveSession, getMeta, loadActiveSession,
  loadAllUserState, loadQuestionBank, runLegacyMigrationIfNeeded,
  saveActiveSession, setMeta, updateUserStateField,
  getAllEvents, replaceUserStateAndEvents, saveCustomPack,
} from './db.js';
import {
  GitHubGistProvider, validateBackupPayload, exportBackupJson,
  encodeCompactBackupCode, decodeCompactBackupCode,
  mergeUserStateFieldWise, mergeEventsBounded,
} from './sync.js';

const LEITNER_DAYS = [1, 3, 7, 14];
const $ = (id) => document.getElementById(id);
const dayKey = (t = Date.now()) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
let ACTIVE_DAYS = [];

let DB = null;
let MANIFEST = null;
let USER_STATE = new Map();
let SETTINGS = { theme: 'system', excludeAi: true, tapSubmit: false, autoAdvance: false, includeQuarantine: false, dailyGoal: 30 };
let DEVICE_ID = 'dev-' + Math.random().toString(36).slice(2, 10);
let SELECTED_SUB = '';
let SELECTED_TOPIC = '';
let SESSION = null;
let TIMER_ID = null;

function toast(msg, ms = 4000) {
  const el = $('toastBanner');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), ms);
}

function applyTheme(theme) {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
}

function getEffectiveKey(qi) {
  const sid = DB.sid[qi];
  const ov = USER_STATE.get(sid)?.keyOverride;
  if (ov && ov.cor) return { cor: ov.cor, source: ov.keySource || 'user-verified' };
  return { cor: (DB.cor[qi] || '').trim().toUpperCase(), source: DB.keySource[qi] || '' };
}

function isQuarantined(qi) {
  return Boolean(DB.qReason[qi]) || Boolean(DB.fl[qi] & FL_NOQ);
}

function isScorable(qi) {
  const k = getEffectiveKey(qi);
  if (!k.cor || (DB.fl[qi] & FL_NOANS)) return false;
  if (SETTINGS.excludeAi && k.source === 'ai-suggested') return false;
  return true;
}

function isDueToday(sid) {
  const l = USER_STATE.get(sid)?.leitner;
  return l && l.dueTs <= Date.now();
}

function computeWeakTopics(limit = 10) {
  const stats = new Map();
  for (let i = 0; i < DB.total; i++) {
    const res = USER_STATE.get(DB.sid[i])?.result;
    if (!res) continue;
    const t = DB.tops[DB.ti[i]];
    const cur = stats.get(t) || { topic: t, right: 0, total: 0 };
    cur.total++;
    if (res.ok) cur.right++;
    stats.set(t, cur);
  }
  return [...stats.values()]
    .filter(x => x.total >= 3)
    .map(x => ({ ...x, acc: x.right / x.total }))
    .sort((a, b) => a.acc - b.acc)
    .slice(0, limit);
}

function filterPool(overridePool = null) {
  const q = $('fSearch').value.trim().toLowerCase();
  const words = q ? q.split(/\s+/).filter(Boolean) : null;
  const pool = overridePool || $('fPool').value;
  const avoidDup = $('fAvoidDup').checked;
  const weakSet = pool === 'weak' ? new Set(computeWeakTopics(5).map(x => x.topic)) : null;
  const seenHashes = avoidDup ? new Set() : null;
  const out = [];

  for (let i = 0; i < DB.total; i++) {
    if (!SETTINGS.includeQuarantine && isQuarantined(i)) continue;
    if (SELECTED_SUB && DB.subs[DB.si[i]] !== SELECTED_SUB) continue;
    if (SELECTED_TOPIC && DB.tops[DB.ti[i]] !== SELECTED_TOPIC) continue;
    const sid = DB.sid[i];
    const st = USER_STATE.get(sid);
    if (pool === 'marked' && !st?.mark?.val) continue;
    if (pool === 'wrong' && (!st?.result || st.result.ok)) continue;
    if (pool === 'unseen' && st?.result) continue;
    if (pool === 'due' && !isDueToday(sid)) continue;
    if (weakSet && !weakSet.has(DB.tops[DB.ti[i]])) continue;
    if (avoidDup && (DB.fl[i] & FL_DUP)) {
      const h16 = sid.split('-')[0];
      if (seenHashes.has(h16)) continue;
      seenHashes.add(h16);
    }
    if (words) {
      const hay = `${DB.qe[i] || ''} ${DB.qt[i] || ''} ${DB.subs[DB.si[i]]} ${DB.tops[DB.ti[i]]}`.toLowerCase();
      if (!words.every(w => hay.includes(w))) continue;
    }
    out.push(i);
  }
  return out;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function showView(name) {
  for (const id of ['viewHome', 'viewQuiz', 'viewResults', 'viewConflicts', 'viewImport', 'viewSettings']) {
    $(id).classList.add('hidden');
  }
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'home') { $('viewHome').classList.remove('hidden'); refreshHomeStats(); }
  else if (name === 'quiz') $('viewQuiz').classList.remove('hidden');
  else if (name === 'results') $('viewResults').classList.remove('hidden');
  else if (name === 'conflicts') { $('viewConflicts').classList.remove('hidden'); renderConflictsView(); }
  else if (name === 'import') $('viewImport').classList.remove('hidden');
  else if (name === 'settings') $('viewSettings').classList.remove('hidden');
}

function refreshHomeStats() {
  let wrong = 0, marked = 0, due = 0, todayCount = 0;
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const dayMs = startOfDay.getTime();

  for (const st of USER_STATE.values()) {
    if (st.mark?.val && !st.mark.deleted) marked++;
    if (st.result && !st.result.ok) wrong++;
    if (st.leitner && st.leitner.dueTs <= Date.now()) due++;
    if (st.result && st.result.ts >= dayMs) todayCount++;
  }

  const activeDays = new Set(ACTIVE_DAYS);
  for (const st of USER_STATE.values()) {
    if (st.result?.ts) activeDays.add(dayKey(st.result.ts));
  }
  let streak = 0;
  for (let d = 0; d < 365; d++) {
    const dt = new Date();
    dt.setDate(dt.getDate() - d);
    const k = dayKey(dt.getTime());
    if (activeDays.has(k)) streak++;
    else if (d > 0) break;
  }
  $('statStreak').textContent = `${streak}d`;
  $('statTotal').textContent = DB.total.toLocaleString();
  $('statToday').textContent = `${todayCount} / ${SETTINGS.dailyGoal}`;
  $('goalBarFill').style.width = `${Math.min(100, Math.round((todayCount / Math.max(1, SETTINGS.dailyGoal)) * 100))}%`;
  $('statDue').textContent = String(due);
  $('lblDueSub').textContent = `${due} due for review`;
  $('lblWrongSub').textContent = `${wrong} questions`;
  $('lblMarkedSub').textContent = `${marked} bookmarked`;
  $('poolCountBadge').textContent = `${filterPool().length.toLocaleString()} matching`;


  const openConflicts = (MANIFEST.conflicts || []).filter(c => !USER_STATE.get(c.sid)?.keyOverride).length;
  $('navConflictsBadge').textContent = openConflicts ? `(${openConflicts})` : '';

  $('provenanceFooter').innerHTML =
    `<b>Data provenance:</b> ${DB.total.toLocaleString()} questions across ${DB.subs.length} subjects. Answer keys come from <b>website</b> publications or are labelled <b>ai-suggested (unverified)</b> until you verify them. Always cross-check with official TNPSC/MRB keys.`;
}

async function startSession(mode, poolIndices) {
  if (!poolIndices.length) { toast('No questions match these filters.'); return; }
  let seq = ($('fRandom').checked || mode === 'test') ? shuffle(poolIndices) : poolIndices;
  if (mode === 'test') {
    const n = Math.max(5, Math.min(500, parseInt($('fCount').value || '50', 10)));
    seq = seq.slice(0, n);
  }
  SESSION = {
    mode,
    seq,
    pos: 0,
    answers: {},
    revealed: {},
    showTaOverride: {},
    negMark: parseFloat($('fNegMark').value || '0.3333'),
    remainSec: mode === 'test' ? seq.length * 60 : 0,
    totalSec: mode === 'test' ? seq.length * 60 : 0,
    paused: false,
    startedAt: Date.now(),
  };
  await saveActiveSession(SESSION);
  enterQuizView();
}

function enterQuizView() {
  showView('quiz');
  const isTest = SESSION.mode === 'test';
  $('quizTimer').classList.toggle('hidden', !isTest);
  $('btnPauseQuiz').classList.toggle('hidden', !isTest);
  $('btnPalette').classList.toggle('hidden', SESSION.seq.length > 500);
  $('btnFinishTest').classList.toggle('hidden', !isTest);
  if (isTest) startTimer();
  renderQuestion();
}

function startTimer() {
  clearInterval(TIMER_ID);
  const draw = () => {
    const m = Math.floor(SESSION.remainSec / 60);
    const s = SESSION.remainSec % 60;
    $('quizTimer').textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };
  draw();
  TIMER_ID = setInterval(async () => {
    if (!SESSION || SESSION.paused) return;
    SESSION.remainSec = Math.max(0, SESSION.remainSec - 1);
    draw();
    if (SESSION.remainSec % 10 === 0) saveActiveSession(SESSION);
    if (SESSION.remainSec === 0) { clearInterval(TIMER_ID); finishTest(); }
  }, 1000);
}

function renderQuestion() {
  const pos = SESSION.pos;
  const qi = SESSION.seq[pos];
  const sid = DB.sid[qi];
  const st = USER_STATE.get(sid) || {};
  const fl = DB.fl[qi];
  const keyInfo = getEffectiveKey(qi);
  const showTa = SESSION.showTaOverride[pos] ?? $('fShowTamil').checked;
  const picked = SESSION.answers[pos];
  const revealed = Boolean(SESSION.revealed[pos]);

  $('quizCounter').textContent = `${pos + 1} / ${SESSION.seq.length}`;
  $('quizProgressFill').style.width = `${Math.round(((pos + 1) / SESSION.seq.length) * 100)}%`;
  const revCnt = Object.keys(SESSION.revealed).length;
  if (SESSION.mode === 'practice' && revCnt > 0) {
    let okCnt = 0;
    for (const pStr of Object.keys(SESSION.revealed)) {
      const qIdx = SESSION.seq[Number(pStr)];
      const k = getEffectiveKey(qIdx);
      if (k.cor && SESSION.answers[pStr] === k.cor) okCnt++;
    }
    $('quizScoreMini').textContent = `${okCnt}/${revCnt} (${Math.round((okCnt / revCnt) * 100)}%)`;
    $('quizScoreMini').classList.remove('hidden');
  } else {
    $('quizScoreMini').classList.add('hidden');
  }
  $('btnPrev').disabled = pos === 0;
  $('btnNext').disabled = pos === SESSION.seq.length - 1;
  $('btnMark').textContent = st.mark?.val ? '★ Marked' : '☆ Mark';

  const meta = $('qMeta');
  meta.innerHTML = '';
  const addChip = (txt, cls = '') => {
    const sp = document.createElement('span');
    sp.className = `chip ${cls}`.trim();
    sp.textContent = txt;
    meta.appendChild(sp);
  };
  addChip(DB.subs[DB.si[qi]]);
  addChip(DB.tops[DB.ti[qi]]);
  if (DB.yr[qi]) addChip(DB.yr[qi]);
  if (fl & FL_DUP) addChip('Duplicate', 'warn');
  if (keyInfo.source === 'ai-suggested') addChip('AI key - verify', 'warn');
  else if (keyInfo.source === 'user-verified') addChip('User verified', 'ok');
  if (!keyInfo.cor || (fl & FL_NOANS)) addChip('No answer key', 'warn');

  const stem = $('qStem');
  stem.innerHTML = '';
  if (DB.qe[qi]) {
    const d = document.createElement('div');
    d.className = 'q-stem-en';
    d.textContent = DB.qe[qi];
    stem.appendChild(d);
  }
  if (DB.qt[qi] && showTa && DB.qt[qi] !== DB.qe[qi]) {
    const d = document.createElement('div');
    d.className = 'q-stem-ta';
    d.textContent = DB.qt[qi];
    stem.appendChild(d);
  }

  const imgsBox = $('qImgs');
  imgsBox.innerHTML = '';
  for (let k = 0; k < (DB.imgCount[qi] || 0); k++) {
    const im = document.createElement('img');
    im.className = 'q-img';
    im.alt = 'Question diagram';
    im.src = `data/assets/${sid}-${k}.png`;
    im.onerror = () => im.remove();
    imgsBox.appendChild(im);
  }

  const optsBox = $('qOpts');
  optsBox.innerHTML = '';
  const opts = DB.o[qi] || [];
  opts.forEach((pair, idx) => {
    const L = 'ABCDE'[idx];
    if (!L) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'opt';
    if (picked === L) btn.classList.add('selected');
    if (revealed && keyInfo.cor) {
      if (keyInfo.cor === L) btn.classList.add('correct');
      else if (picked === L) btn.classList.add('wrong');
    }
    btn.disabled = revealed && SESSION.mode === 'practice';
    const letSpan = document.createElement('span');
    letSpan.className = 'opt-letter';
    letSpan.textContent = L;
    const txtSpan = document.createElement('span');
    const primaryOpt = pair[0] || pair[1] || '';
    txtSpan.textContent = primaryOpt;
    if (showTa && pair[1] && pair[1] !== primaryOpt) {
      const taDiv = document.createElement('div');
      taDiv.className = 'muted small';
      taDiv.textContent = pair[1];
      txtSpan.appendChild(taDiv);
    }
    btn.append(letSpan, txtSpan);
    btn.onclick = () => onSelectOption(L);
    optsBox.appendChild(btn);
  });

  $('qSubmitRow').classList.toggle('hidden', !(SESSION.mode === 'practice' && SETTINGS.tapSubmit && picked && !revealed));

  const verdict = $('qVerdict');
  const keyActions = $('qKeyActions');
  const explWrap = $('qExplWrap');
  verdict.classList.add('hidden');
  keyActions.classList.add('hidden');
  explWrap.classList.add('hidden');

  if (revealed) {
    verdict.classList.remove('hidden', 'ok', 'bad', 'warn');
    if (!keyInfo.cor) {
      verdict.classList.add('warn');
      verdict.textContent = 'No answer key available (unscored).';
    } else {
      const ok = picked === keyInfo.cor;
      verdict.classList.add(ok ? 'ok' : 'bad');
      verdict.textContent = ok ? `Correct (${keyInfo.cor})` : `Incorrect — Answer: ${keyInfo.cor}`;
    }

    keyActions.innerHTML = '';
    keyActions.classList.remove('hidden');
    if (keyInfo.source === 'ai-suggested') {
      const vBtn = document.createElement('button');
      vBtn.type = 'button'; vBtn.className = 'btn small';
      vBtn.textContent = 'Verify this key';
      vBtn.onclick = async () => {
        const ov = { cor: keyInfo.cor, keySource: 'user-verified', ts: Date.now() };
        USER_STATE.set(sid, await updateUserStateField(sid, 'keyOverride', ov));
        toast('Key marked user-verified');
        renderQuestion();
      };
      keyActions.appendChild(vBtn);
    }
    const ovSel = document.createElement('select');
    ovSel.className = 'input'; ovSel.style.width = 'auto'; ovSel.style.minHeight = '36px';
    ovSel.innerHTML = '<option value="">Override key…</option>' + opts.map((_, k) => `<option value="${'ABCDE'[k]}">Set ${'ABCDE'[k]}</option>`).join('');
    ovSel.onchange = async () => {
      if (!ovSel.value) return;
      const ov = { cor: ovSel.value, keySource: 'user-verified', ts: Date.now() };
      USER_STATE.set(sid, await updateUserStateField(sid, 'keyOverride', ov));
      toast(`Overrode key to ${ovSel.value} (user-verified)`);
      renderQuestion();
    };
    keyActions.appendChild(ovSel);

    const xe = DB.xe[qi] || '';
    const xt = showTa ? (DB.xt[qi] || '') : '';
    if (xe || xt) {
      $('qExpl').textContent = [xe, xt && xt !== xe ? xt : ''].filter(Boolean).join('\n\n');
      explWrap.classList.remove('hidden');
      explWrap.open = Boolean(keyInfo.cor && picked !== keyInfo.cor);
    }
  }

  $('qNoteInput').value = st.note?.deleted ? '' : (st.note?.text || '');
}

async function onSelectOption(letter) {
  const pos = SESSION.pos;
  SESSION.answers[pos] = letter;
  if (SESSION.mode === 'practice' && !SETTINGS.tapSubmit) {
    await commitAnswer(pos);
  } else {
    await saveActiveSession(SESSION);
    renderQuestion();
  }
}

async function commitAnswer(pos) {
  const qi = SESSION.seq[pos];
  const sid = DB.sid[qi];
  const pick = SESSION.answers[pos];
  const keyInfo = getEffectiveKey(qi);
  SESSION.revealed[pos] = true;

  if (keyInfo.cor) {
    const ok = pick === keyInfo.cor;
    const now = Date.now();
    const resObj = { pick, cor: keyInfo.cor, ok, keySource: keyInfo.source, ts: now, deviceId: DEVICE_ID };
    USER_STATE.set(sid, await updateUserStateField(sid, 'result', resObj));

    const prevBox = USER_STATE.get(sid)?.leitner?.box || 1;
    const nextBox = ok ? Math.min(4, prevBox + 1) : 1;
    const dueTs = now + LEITNER_DAYS[nextBox - 1] * 86400000;
    const leitnerObj = { box: nextBox, dueTs, reps: (USER_STATE.get(sid)?.leitner?.reps || 0) + 1, ts: now };
    USER_STATE.set(sid, await updateUserStateField(sid, 'leitner', leitnerObj));
    await appendAnswerEvent({ eventId: `${now}-${DEVICE_ID}-${sid}`, sid, ...resObj });
    const todayK = dayKey(now);
    if (!ACTIVE_DAYS.includes(todayK)) {
      ACTIVE_DAYS = [...ACTIVE_DAYS, todayK].sort();
      await setMeta('activeDays', ACTIVE_DAYS);
    }
  }
  await saveActiveSession(SESSION);
  renderQuestion();
  if (SESSION.mode === 'practice' && SETTINGS.autoAdvance && keyInfo.cor && pick === keyInfo.cor && pos < SESSION.seq.length - 1) {
    setTimeout(() => { if (SESSION && SESSION.pos === pos) $('btnNext').click(); }, 700);
  }
}

async function finishTest() {
  clearInterval(TIMER_ID);
  let right = 0, wrong = 0, skipped = 0, unscored = 0;
  for (let p = 0; p < SESSION.seq.length; p++) {
    const qi = SESSION.seq[p];
    const pick = SESSION.answers[p];
    if (!isScorable(qi)) { unscored++; continue; }
    if (!pick) { skipped++; continue; }
    await commitAnswer(p);
    if (pick === getEffectiveKey(qi).cor) right++;
    else wrong++;
  }
  const net = (right - wrong * SESSION.negMark).toFixed(2);
  const scoredTotal = right + wrong + skipped;
  $('resScore').textContent = net;
  $('resAcc').textContent = scoredTotal ? `${Math.round((right / scoredTotal) * 100)}%` : '0%';
  const elapsed = Math.max(1, Math.round((SESSION.totalSec - SESSION.remainSec) / 60));
  $('resTime').textContent = `${elapsed}m`;
  $('resRight').textContent = `${right}/${scoredTotal}`;

  const weakEl = $('resWeakTopics');
  weakEl.innerHTML = '';
  for (const w of computeWeakTopics(5)) {
    const row = document.createElement('div');
    row.className = 'list-card row-between';
    row.innerHTML = `<div><b>${w.topic}</b><div class="muted small">${w.right}/${w.total} (${Math.round(w.acc * 100)}%)</div></div>`;
    const b = document.createElement('button');
    b.className = 'btn small'; b.textContent = 'Drill';
    b.onclick = () => { SELECTED_TOPIC = w.topic; startSession('practice', filterPool('all')); };
    row.appendChild(b);
    weakEl.appendChild(row);
  }

  renderResultsList('all');
  await clearActiveSession();
  showView('results');
  runAutoSync();
}

function renderResultsList(filter) {
  const box = $('resReviewList');
  box.innerHTML = '';
  SESSION.seq.forEach((qi, p) => {
    const sid = DB.sid[qi];
    const pick = SESSION.answers[p];
    const keyInfo = getEffectiveKey(qi);
    const isMarked = Boolean(USER_STATE.get(sid)?.mark?.val);
    const isWrong = Boolean(pick && keyInfo.cor && pick !== keyInfo.cor);
    const isSkipped = !pick;
    if (filter === 'wrong' && !isWrong) return;
    if (filter === 'skipped' && !isSkipped) return;
    if (filter === 'marked' && !isMarked) return;
    const card = document.createElement('div');
    card.className = 'list-card';
    card.textContent = `Q${p + 1}: ${(DB.qe[qi] || DB.qt[qi] || '').slice(0, 120)} — Pick: ${pick || '—'} | Key: ${keyInfo.cor || 'N/A'}`;
    box.appendChild(card);
  });
}

function renderIssuesView() {
  const box = $('issuesList');
  box.innerHTML = '';
  let shown = 0;
  for (let i = 0; i < DB.total && shown < 100; i++) {
    if (!isQuarantined(i)) continue;
    shown++;
    const div = document.createElement('div');
    div.className = 'list-card small';
    div.textContent = `${DB.sourceId[i]} (${DB.subs[DB.si[i]]}) — ${DB.qReason[i] || 'broken_record'}`;
    box.appendChild(div);
  }
  if (!shown) box.textContent = 'No quarantined records.';
}

function renderConflictsView() {
  const box = $('conflictsList');
  box.innerHTML = '';
  const list = MANIFEST.conflicts || [];
  if (!list.length) { box.textContent = 'No key conflicts.'; return; }
  for (const c of list) {
    const card = document.createElement('div');
    card.className = 'list-card row-between';
    const info = document.createElement('div');
    info.className = 'small';
    info.textContent = `${c.sid}: ${c.existing} (${c.sources?.existing || 'existing'}) vs ${c.incoming} (${c.sources?.incoming || 'incoming'})`;
    const btns = document.createElement('div');
    btns.className = 'row-gap';
    for (const opt of [c.existing, c.incoming]) {
      const b = document.createElement('button');
      b.className = 'btn small'; b.textContent = `Keep ${opt}`;
      b.onclick = async () => {
        USER_STATE.set(c.sid, await updateUserStateField(c.sid, 'keyOverride', { cor: opt, keySource: 'user-verified', ts: Date.now() }));
        toast(`Kept ${opt} (user-verified)`);
        renderConflictsView();
      };
      btns.appendChild(b);
    }
    card.append(info, btns);
    box.appendChild(card);
  }
}

function makeRingEl(info) {
  const pctNum = info.att ? Math.round((info.right / info.att) * 100) : 0;
  const ring = document.createElement('span');
  ring.className = 'ring';
  ring.style.setProperty('--p', String(pctNum));
  ring.title = info.att ? `${info.right}/${info.att} (${pctNum}%)` : 'Unattempted';
  const inner = document.createElement('span');
  inner.className = 'ring-in';
  inner.textContent = info.att ? `${pctNum}%` : '—';
  ring.appendChild(inner);
  return ring;
}

function openScopeSheet() {
  $('sheetOverlay').classList.remove('hidden');
  let drillSub = '';
  const draw = () => {
    const q = $('sheetSearch').value.trim().toLowerCase();
    const body = $('sheetBody');
    body.innerHTML = '';

    if (drillSub) {
      const back = document.createElement('button');
      back.className = 'sheet-item';
      back.innerHTML = `<span><b>← All subjects</b></span><span class="muted small">${drillSub}</span>`;
      back.onclick = () => { drillSub = ''; draw(); };
      body.appendChild(back);
    } else {
      const allBtn = document.createElement('button');
      allBtn.className = 'sheet-item';
      allBtn.innerHTML = `<span><b>All subjects &amp; topics</b> <span class="muted small">(${DB.total.toLocaleString()})</span></span>`;
      allBtn.onclick = () => { SELECTED_SUB = ''; SELECTED_TOPIC = ''; $('pickedScopeLabel').textContent = 'All subjects & topics'; $('sheetOverlay').classList.add('hidden'); refreshHomeStats(); };
      body.appendChild(allBtn);
    }

    const subStats = new Map();
    const topStats = new Map();
    for (let i = 0; i < DB.total; i++) {
      if (!SETTINGS.includeQuarantine && isQuarantined(i)) continue;
      const s = DB.subs[DB.si[i]];
      const t = DB.tops[DB.ti[i]];
      const res = USER_STATE.get(DB.sid[i])?.result;
      const sc = subStats.get(s) || { total: 0, right: 0, att: 0 };
      sc.total++; if (res) { sc.att++; if (res.ok) sc.right++; }
      subStats.set(s, sc);
      if (!drillSub || s === drillSub) {
        const key = `${s}\u0001${t}`;
        const tc = topStats.get(key) || { sub: s, top: t, total: 0, right: 0, att: 0 };
        tc.total++; if (res) { tc.att++; if (res.ok) tc.right++; }
        topStats.set(key, tc);
      }
    }

    if (!drillSub) {
      for (const [sub, info] of [...subStats.entries()].sort((a, b) => b[1].total - a[1].total)) {
        if (q && !sub.toLowerCase().includes(q)) continue;
        const row = document.createElement('div');
        row.className = 'sheet-item';
        const pickBtn = document.createElement('button');
        pickBtn.type = 'button'; pickBtn.className = 'btn ghost small'; pickBtn.style.flex = '1'; pickBtn.style.justifyContent = 'flex-start'; pickBtn.style.border = '0';
        pickBtn.innerHTML = `<span>${sub} <span class="muted small">(${info.total})</span></span>`;
        pickBtn.onclick = () => { SELECTED_SUB = sub; SELECTED_TOPIC = ''; $('pickedScopeLabel').textContent = sub; $('sheetOverlay').classList.add('hidden'); refreshHomeStats(); };
        const topicsBtn = document.createElement('button');
        topicsBtn.type = 'button'; topicsBtn.className = 'btn ghost small'; topicsBtn.textContent = 'Topics ›';
        topicsBtn.onclick = () => { drillSub = sub; draw(); };
        row.append(pickBtn, topicsBtn, makeRingEl(info));
        body.appendChild(row);
      }
    }

    if (drillSub || q) {
      for (const info of [...topStats.values()].sort((a, b) => b.total - a.total).slice(0, 120)) {
        if (q && !info.top.toLowerCase().includes(q) && !info.sub.toLowerCase().includes(q)) continue;
        const b = document.createElement('button');
        b.className = 'sheet-item';
        b.innerHTML = `<span>${info.top} <span class="muted small">(${info.total})</span></span>`;
        b.appendChild(makeRingEl(info));
        b.onclick = () => { SELECTED_SUB = info.sub; SELECTED_TOPIC = info.top; $('pickedScopeLabel').textContent = `${info.sub} › ${info.top}`; $('sheetOverlay').classList.add('hidden'); refreshHomeStats(); };
        body.appendChild(b);
      }
    }
  };
  $('sheetSearch').oninput = draw;
  draw();
}

function bindEvents() {
  document.querySelectorAll('.nav-btn').forEach(b => b.onclick = () => showView(b.dataset.view));
  $('btnBrand').onclick = () => showView('home');
  $('btnPickSubject').onclick = openScopeSheet;
  $('btnCloseSheet').onclick = () => $('sheetOverlay').classList.add('hidden');
  $('fSearch').oninput = () => refreshHomeStats();
  $('fPool').onchange = () => refreshHomeStats();
  $('fAvoidDup').onchange = () => refreshHomeStats();

  $('btnResetFilters').onclick = () => {
    SELECTED_SUB = ''; SELECTED_TOPIC = ''; $('pickedScopeLabel').textContent = 'All subjects & topics';
    $('fSearch').value = ''; $('fPool').value = 'all'; refreshHomeStats();
  };
  $('btnStart').onclick = () => startSession($('fMode').value, filterPool());
  $('btnQuickDrill').onclick = () => startSession('practice', shuffle(filterPool('unseen')).slice(0, 15));
  $('btnQuickDue').onclick = () => startSession('practice', filterPool('due'));
  $('btnQuickWrong').onclick = () => startSession('practice', filterPool('wrong'));
  $('btnQuickMarked').onclick = () => startSession('practice', filterPool('marked'));

  $('btnPrev').onclick = async () => { if (SESSION.pos > 0) { SESSION.pos--; await saveActiveSession(SESSION); renderQuestion(); } };
  $('btnNext').onclick = async () => { if (SESSION.pos < SESSION.seq.length - 1) { SESSION.pos++; await saveActiveSession(SESSION); renderQuestion(); } };
  $('btnSubmitQ').onclick = () => commitAnswer(SESSION.pos);
  $('btnFinishTest').onclick = finishTest;
  $('btnQuitQuiz').onclick = async () => { clearInterval(TIMER_ID); await saveActiveSession(SESSION); showView('home'); };
  $('btnPauseQuiz').onclick = () => { SESSION.paused = !SESSION.paused; $('btnPauseQuiz').textContent = SESSION.paused ? 'Resume' : 'Pause'; };
  $('btnToggleLangQ').onclick = () => { SESSION.showTaOverride[SESSION.pos] = !(SESSION.showTaOverride[SESSION.pos] ?? $('fShowTamil').checked); renderQuestion(); };

  $('btnMark').onclick = async () => {
    const sid = DB.sid[SESSION.seq[SESSION.pos]];
    const cur = Boolean(USER_STATE.get(sid)?.mark?.val);
    USER_STATE.set(sid, await updateUserStateField(sid, 'mark', { val: !cur, ts: Date.now(), deleted: cur }));
    renderQuestion();
  };
  $('btnNote').onclick = () => $('qNoteBox').classList.toggle('hidden');
  $('btnSaveNote').onclick = async () => {
    const sid = DB.sid[SESSION.seq[SESSION.pos]];
    const text = $('qNoteInput').value.trim();
    USER_STATE.set(sid, await updateUserStateField(sid, 'note', { text, ts: Date.now(), deleted: !text }));
    toast('Note saved');
  };

  $('btnPalette').onclick = () => {
    $('paletteOverlay').classList.remove('hidden');
    const g = $('paletteGrid');
    g.innerHTML = '';
    SESSION.seq.forEach((qi, p) => {
      const b = document.createElement('button');
      b.className = 'pal-btn';
      if (SESSION.answers[p]) b.classList.add('ans');
      if (p === SESSION.pos) b.classList.add('cur');
      if (USER_STATE.get(DB.sid[qi])?.mark?.val) b.classList.add('mrk');
      b.textContent = String(p + 1);
      b.onclick = () => { SESSION.pos = p; $('paletteOverlay').classList.add('hidden'); renderQuestion(); };
      g.appendChild(b);
    });
  };
  $('btnClosePalette').onclick = () => $('paletteOverlay').classList.add('hidden');

  $('btnResHome').onclick = () => showView('home');
  $('btnRetryWrong').onclick = () => {
    const wrong = SESSION.seq.filter((qi, p) => SESSION.answers[p] && getEffectiveKey(qi).cor && SESSION.answers[p] !== getEffectiveKey(qi).cor);
    startSession('practice', wrong);
  };
  $('btnResDrillWeak').onclick = () => startSession('practice', filterPool('weak'));
  document.querySelectorAll('[data-rfilter]').forEach(b => b.onclick = () => {
    document.querySelectorAll('[data-rfilter]').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    renderResultsList(b.dataset.rfilter);
  });

  // Settings
  $('setTheme').onchange = async () => { SETTINGS.theme = $('setTheme').value; applyTheme(SETTINGS.theme); await setMeta('settings', SETTINGS); };
  $('setExcludeAi').onchange = async () => { SETTINGS.excludeAi = $('setExcludeAi').checked; await setMeta('settings', SETTINGS); };
  $('setTapSubmit').onchange = async () => { SETTINGS.tapSubmit = $('setTapSubmit').checked; await setMeta('settings', SETTINGS); };
  $('setDailyGoal').onchange = async () => { SETTINGS.dailyGoal = Math.max(5, parseInt($('setDailyGoal').value || '30', 10)); await setMeta('settings', SETTINGS); refreshHomeStats(); };

  // Shortcuts modal & sync pill
  $('btnShortcuts').onclick = () => $('shortcutsOverlay').classList.remove('hidden');
  $('btnCloseShortcuts').onclick = () => $('shortcutsOverlay').classList.add('hidden');
  $('btnSyncPill').onclick = () => showView('settings');
  $('setAutoAdvance').onchange = async () => { SETTINGS.autoAdvance = $('setAutoAdvance').checked; await setMeta('settings', SETTINGS); };

  // Keyboard & swipe shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      $('sheetOverlay').classList.add('hidden');
      $('paletteOverlay').classList.add('hidden');
      $('shortcutsOverlay').classList.add('hidden');
      return;
    }
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
    if (e.key === '?' || (e.shiftKey && (e.key === '/' || e.code === 'Slash'))) { e.preventDefault(); $('shortcutsOverlay').classList.toggle('hidden'); return; }
    if ($('viewQuiz').classList.contains('hidden')) return;
    const k = e.key.toLowerCase();
    if (e.key === 'ArrowLeft' || k === 'k') { e.preventDefault(); $('btnPrev').click(); }
    else if (e.key === 'ArrowRight' || k === 'j') { e.preventDefault(); $('btnNext').click(); }
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!$('qSubmitRow').classList.contains('hidden')) $('btnSubmitQ').click();
      else if (!$('btnNext').disabled) $('btnNext').click();
    }
    else if (k === 'm') $('btnMark').click();
    else if (k === 't') $('btnToggleLangQ').click();
    else if (k === 'p' && !$('btnPauseQuiz').classList.contains('hidden')) $('btnPauseQuiz').click();
    else if (k === 'g' && !$('btnPalette').classList.contains('hidden')) $('btnPalette').click();
    else if (k === 'e' && !$('qExplWrap').classList.contains('hidden')) { $('qExplWrap').open = !$('qExplWrap').open; }
    else if (k === 'n') {
      e.preventDefault();
      $('qNoteBox').classList.remove('hidden');
      $('qNoteInput').focus();
    }
    else if (/^[a-e1-5]$/.test(k)) {
      const idx = /^[1-5]$/.test(k) ? Number(k) - 1 : k.charCodeAt(0) - 97;
      const btn = $('qOpts').children[idx];
      if (btn && !btn.disabled) btn.click();
    }
  });
  let touchX = 0;
  $('qCard').addEventListener('touchstart', e => { touchX = e.changedTouches[0].clientX; }, { passive: true });
  $('qCard').addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - touchX;
    if (Math.abs(dx) > 60) { if (dx < 0) $('btnNext').click(); else $('btnPrev').click(); }
  }, { passive: true });
}


const dbSyncHelpers = { getAllEvents, replaceUserStateAndEvents };
let PENDING_IMPORT = null;
let PENDING_BACKUP = null;

async function runAutoSync(manual = false) {
  const token = await getMeta('syncToken', '');
  const gistId = await getMeta('gistId', '');
  if (!token) {
    if (manual) toast('Paste a GitHub Gist token in Settings first.');
    return;
  }
  if (!navigator.onLine) {
    await setMeta('syncPending', true);
    $('syncStatusText').textContent = 'Offline — sync queued';
    $('btnSyncPill').textContent = 'Offline'; $('btnSyncPill').className = 'chip sync-pill warn';
    return;
  }
  try {
    $('syncStatusText').textContent = 'Syncing…';
    const provider = new GitHubGistProvider(token, gistId, dbSyncHelpers);
    const remote = await provider.pull();
    if (remote) await provider.applyState(remote);
    const mergedState = await provider.getState();
    const savedGistId = await provider.push(mergedState);
    if (savedGistId && !$('syncGistId').value) $('syncGistId').value = savedGistId;
    USER_STATE = await loadAllUserState();
    ACTIVE_DAYS = await getMeta('activeDays', []);
    const now = Date.now();
    await setMeta('lastSyncAt', now);
    await setMeta('syncPending', false);
    $('syncStatusText').textContent = `Last synced: ${new Date(now).toLocaleString()}`;
    $('btnSyncPill').textContent = 'Synced'; $('btnSyncPill').className = 'chip sync-pill ok';
    refreshHomeStats();
    if (manual) toast(`Sync complete (${USER_STATE.size} question states)`);
  } catch (err) {
    await setMeta('syncPending', true);
    $('syncStatusText').textContent = `Sync error: ${err.message}`;
    if (manual) toast(`Sync failed: ${err.message}`);
  }
}

async function normWeb(s) {
  return String(s || '').normalize('NFKC').toLowerCase().replace(/<[^>]+>/g, ' ').replace(/[^a-z0-9\u0b80-\u0bff]+/g, ' ').replace(/\s+/g, ' ').trim();
}

async function hash16Web(qe, qt, opts, blankTag) {
  const ne = await normWeb(qe);
  const nt = await normWeb(qt);
  const raw = (!ne && !nt)
    ? `BLANK|${blankTag}`
    : `${ne}|${nt}|${(await Promise.all((opts || []).map(async p => `${await normWeb(p[0])}/${await normWeb(p[1])}`))).join('|')}`;
  const dig = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return [...new Uint8Array(dig)].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function previewImportFile(file) {
  const txt = (await file.text()).trim();
  let recs = [];
  if (txt.startsWith('[')) recs = JSON.parse(txt);
  else if (txt.startsWith('{') && !txt.includes('\n')) { const o = JSON.parse(txt); recs = o.questions || [o]; }
  else recs = txt.split('\n').filter(Boolean).map(l => JSON.parse(l));

  const batch = $('importBatch').value.trim() || file.name.replace(/\.[^.]+$/, '');
  $('importBatch').value = batch;
  const defSrc = $('importKeySource').value;
  const dupRule = $('importDupRule').value;
  const existingHashes = new Map();
  for (let i = 0; i < DB.total; i++) {
    const h = DB.sid[i].split('-')[0];
    if (!existingHashes.has(h)) existingHashes.set(h, []);
    existingHashes.get(h).push({ sid: DB.sid[i], cor: DB.cor[i] });
  }

  const rows = [];
  const conflicts = [];
  let dupCount = 0, qCount = 0, newCount = 0;
  const localHashCnt = new Map();

  for (let idx = 0; idx < recs.length; idx++) {
    const r = recs[idx];
    const qe = r.question_en || '';
    const qt = r.question_ta || '';
    const opts = (r.options || []).map(o => [o.en || '', o.ta || '']);
    const cor = r.correct_option || '';
    const h16 = await hash16Web(qe, qt, opts, `${batch}:${r.index ?? idx}`);
    const existing = existingHashes.get(h16) || [];
    const seenLocal = localHashCnt.get(h16) || 0;
    const isDup = existing.length > 0 || seenLocal > 0;
    if (isDup && dupRule === 'skip') { dupCount++; continue; }

    const ord = existing.length + seenLocal;
    localHashCnt.set(h16, seenLocal + 1);
    const sid = `${h16}-${ord}`;
    let fl = Number(r.flags || 0);
    if (isDup) {
      fl |= FL_DUP;
      dupCount++;
      const diff = existing.find(e => e.cor && cor && e.cor !== cor);
      if (diff) conflicts.push({ sid, existing: diff.cor, incoming: cor, sources: { existing: 'bank', incoming: defSrc }, originKey: `${batch}:${r.index ?? idx}` });
    } else {
      newCount++;
    }
    if (!cor) fl |= FL_NOANS;
    let qReason = null;
    if (!qe.trim() && !qt.trim()) { fl |= FL_NOQ; qReason = 'empty_question_text'; qCount++; }
    else if (opts.length < 2) { fl |= FL_NOQ; qReason = 'missing_options'; qCount++; }

    rows.push({
      sid, sourceId: String(r.id || `${batch}-${idx}`), subName: (r.subject || 'Imported').trim(),
      topName: (r.topic || batch).trim(), yr: String(r.year || batch),
      qe, qt, o: opts, cor, keySource: cor ? (r.key_source || defSrc) : '',
      xe: r.explanation || '', xt: r.explanation_ta || '', imgCount: 0, fl, qReason,
    });
  }

  PENDING_IMPORT = { batch, rows, conflicts };
  const prev = $('importPreview');
  prev.classList.remove('hidden');
  prev.innerHTML = `<b>Preview (${recs.length} records):</b> New: ${newCount} · Duplicates: ${dupCount} · Conflicts: ${conflicts.length} · Quarantined: ${qCount}`;
  $('btnApplyImport').disabled = rows.length === 0;
}

function bindM4Events() {
  $('btnNudgeBackup').onclick = () => showView('settings');
  const saveSyncInputs = async () => {
    const tok = $('syncToken').value.trim();
    let gid = $('syncGistId').value.trim();
    if (gid.includes('/')) gid = gid.replace(/\/+$/, '').split('/').pop();
    $('syncGistId').value = gid;
    await setMeta('syncToken', tok);
    await setMeta('gistId', gid);
  };
  $('btnSaveSync').onclick = async () => {
    await saveSyncInputs();
    toast('Sync settings saved on-device');
  };
  $('btnSyncNow').onclick = async () => {
    await saveSyncInputs();
    await runAutoSync(true);
  };

  $('btnExportJson').onclick = async () => {
    const payload = await exportBackupJson(dbSyncHelpers);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `elms-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    $('backupNudge').classList.add('hidden');
    toast('Backup JSON downloaded');
  };

  $('importBackupFile').onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const obj = JSON.parse(await file.text());
      const info = validateBackupPayload(obj);
      PENDING_BACKUP = obj;
      const box = $('backupPreviewBox');
      box.classList.remove('hidden');
      box.innerHTML = `<div><b>Valid backup:</b> ${info.records} question states, ${info.events} recent events.</div>` +
        `<div class="row-gap" style="margin-top:6px"><button id="btnBkMerge" class="btn small primary" type="button">Merge</button><button id="btnBkReplace" class="btn small" type="button">Replace all</button></div>`;
      $('btnBkMerge').onclick = async () => {
        const mergedMap = mergeUserStateFieldWise(USER_STATE, PENDING_BACKUP.userState);
        const mergedEv = mergeEventsBounded(await getAllEvents(), PENDING_BACKUP.events);
        await replaceUserStateAndEvents([...mergedMap.values()], mergedEv, false);
        ACTIVE_DAYS = [...new Set([...ACTIVE_DAYS, ...(PENDING_BACKUP.activeDays || [])])].sort();
        await setMeta('activeDays', ACTIVE_DAYS);
        USER_STATE = await loadAllUserState();
        refreshHomeStats();
        toast('Backup merged');
      };
      $('btnBkReplace').onclick = async () => {
        await replaceUserStateAndEvents(PENDING_BACKUP.userState, PENDING_BACKUP.events, true);
        ACTIVE_DAYS = [...new Set(PENDING_BACKUP.activeDays || [])].sort();
        await setMeta('activeDays', ACTIVE_DAYS);
        USER_STATE = await loadAllUserState();
        refreshHomeStats();
        toast('Backup restored (replaced)');
      };
    } catch (err) {
      toast(`Rejected invalid backup: ${err.message}`);
    }
  };

  $('btnGenCode').onclick = async () => {
    const code = await encodeCompactBackupCode(dbSyncHelpers);
    await navigator.clipboard?.writeText(code).catch(() => {});
    $('backupCodeInput').value = code;
    $('backupNudge').classList.add('hidden');
    toast('Compact backup code copied');
  };

  $('btnRestoreCode').onclick = async () => {
    try {
      const obj = await decodeCompactBackupCode($('backupCodeInput').value);
      const mergedMap = mergeUserStateFieldWise(USER_STATE, obj.userState);
      const mergedEv = mergeEventsBounded(await getAllEvents(), obj.events);
      await replaceUserStateAndEvents([...mergedMap.values()], mergedEv, false);
      ACTIVE_DAYS = [...new Set([...ACTIVE_DAYS, ...(obj.activeDays || [])])].sort();
      await setMeta('activeDays', ACTIVE_DAYS);
      USER_STATE = await loadAllUserState();
      refreshHomeStats();
      toast(`Restored ${obj.userState.length} records from backup code`);
    } catch (err) {
      toast(`Invalid backup code: ${err.message}`);
    }
  };

  $('btnReqPersist').onclick = async () => {
    const granted = await navigator.storage?.persist?.();
    $('btnReqPersist').textContent = granted ? 'Storage persist: granted' : 'Storage persist: denied';
  };

  $('importFile').onchange = (e) => { if (e.target.files?.[0]) previewImportFile(e.target.files[0]); };
  $('btnApplyImport').onclick = async () => {
    if (!PENDING_IMPORT) return;
    const { batch, rows, conflicts } = PENDING_IMPORT;
    const keys = ['sid', 'sourceId', 'yr', 'qe', 'qt', 'o', 'cor', 'keySource', 'xe', 'xt', 'imgCount', 'fl', 'qReason'];
    const cols = { subNames: rows.map(r => r.subName), topNames: rows.map(r => r.topName) };
    for (const k of keys) cols[k] = rows.map(r => r[k]);
    await saveCustomPack({ id: `custom-${Date.now()}`, batch, columns: cols, conflicts });
    const reloaded = await loadQuestionBank();
    DB = reloaded.DB;
    MANIFEST = reloaded.manifest;
    refreshHomeStats();
    toast(`Imported ${rows.length} questions into IndexedDB`);
    showView('home');
  };

  window.addEventListener('online', async () => {
    if (await getMeta('syncPending', false)) runAutoSync();
  });
}

async function boot() {
  try {
    SETTINGS = { ...SETTINGS, ...(await getMeta('settings', {})) };
    applyTheme(SETTINGS.theme);
    $('setTheme').value = SETTINGS.theme;
    $('setExcludeAi').checked = SETTINGS.excludeAi;
    $('setTapSubmit').checked = SETTINGS.tapSubmit;
    $('setAutoAdvance').checked = SETTINGS.autoAdvance;
      $('setDailyGoal').value = String(SETTINGS.dailyGoal);

    DEVICE_ID = (await getMeta('deviceId')) || DEVICE_ID;
    await setMeta('deviceId', DEVICE_ID);

    const migrated = await runLegacyMigrationIfNeeded();
    const loaded = await loadQuestionBank((done, tot) => { if ($('splashMsg')) $('splashMsg').textContent = `Loading packs (${done} / ${tot})…`; });
    DB = loaded.DB;
    MANIFEST = loaded.manifest;
    USER_STATE = await loadAllUserState();

    const saved = await loadActiveSession();
    if (saved && Array.isArray(saved.seq) && saved.seq.length) {
      $('continueCard').classList.remove('hidden');
      $('continueTitle').textContent = `${saved.mode === 'test' ? 'Timed Test' : 'Practice'} · Q${saved.pos + 1} of ${saved.seq.length}`;
      $('continueSub').textContent = `Saved ${new Date(saved.updatedAt).toLocaleString()}`;
      $('btnResumeSession').onclick = () => { SESSION = saved; enterQuizView(); };
      $('btnDiscardSession').onclick = async () => { await clearActiveSession(); $('continueCard').classList.add('hidden'); };
    }

    bindEvents();
    bindM4Events();
    $('syncToken').value = await getMeta('syncToken', '');
    $('syncGistId').value = await getMeta('gistId', '');
    const lastSync = await getMeta('lastSyncAt', 0);
    if (lastSync) { $('syncStatusText').textContent = `Last synced: ${new Date(lastSync).toLocaleString()}`; $('btnSyncPill').textContent = 'Synced'; $('btnSyncPill').className = 'chip sync-pill ok'; }
    const lastBk = await getMeta('lastBackupAt', 0);
    if (!lastBk || Date.now() - lastBk > 7 * 86400000) $('backupNudge').classList.remove('hidden');
    if (navigator.storage?.persisted) {
      const p = await navigator.storage.persisted();
      $('btnReqPersist').textContent = p ? 'Storage persist: granted' : 'Storage persist: request';
      if (!p) navigator.storage?.persist?.().catch(() => {});
    }
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
    refreshHomeStats();
    $('splash').remove();
    runAutoSync();
    if (migrated > 0) toast(`Migrated ${migrated} records to offline IndexedDB (backup kept in elms_backup_v1)`, 6000);
  } catch (err) {
    $('splashMsg').textContent = `Failed to load: ${err.message}`;
  }
}

boot();