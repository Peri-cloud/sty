// db.js — IndexedDB storage, versioned gzip pack loader, legacy migration, and LWW state

const DB_NAME = 'elms_pwa_v1';
const DB_VERSION = 1;
const MAX_RECENT_EVENTS = 500;
const LEITNER_DAYS = [1, 3, 7, 14];

export const FL_DUP = 1;
export const FL_VER = 2;
export const FL_NOANS = 4;
export const FL_NOQ = 8;

let idb = null;

function openIDB() {
  if (idb) return Promise.resolve(idb);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('packs')) db.createObjectStore('packs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('userState')) db.createObjectStore('userState', { keyPath: 'sid' });
      if (!db.objectStoreNames.contains('events')) db.createObjectStore('events', { keyPath: 'eventId' });
      if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('customPacks')) db.createObjectStore('customPacks', { keyPath: 'id' });
    };
    req.onsuccess = () => { idb = req.result; resolve(idb); };
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function reqPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getMeta(key, fallback = null) {
  const db = await openIDB();
  const row = await reqPromise(db.transaction('meta', 'readonly').objectStore('meta').get(key));
  return row ? row.value : fallback;
}

export async function setMeta(key, value) {
  const db = await openIDB();
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put({ key, value });
  return txDone(tx);
}

async function fetchGzJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('Browser lacks DecompressionStream(gzip)');
  }
  const ds = new DecompressionStream('gzip');
  const text = await new Response(res.body.pipeThrough(ds)).text();
  return JSON.parse(text);
}

function mapLegacyIndex(srcIdx, removedSorted) {
  let lo = 0, hi = removedSorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (removedSorted[mid] < srcIdx) lo = mid + 1;
    else hi = mid;
  }
  if (removedSorted[lo] === srcIdx) return -1;
  return srcIdx - lo;
}

export async function runLegacyMigrationIfNeeded() {
  const already = await getMeta('migratedLegacy', false);
  if (already) return 0;

  const rawMarks = localStorage.getItem('elms_marks');
  const rawAtt = localStorage.getItem('elms_attempted');
  const rawRes = localStorage.getItem('elms_results');
  const migratedV2 = localStorage.getItem('elms_migrated_v2') === 'true';

  if (!rawMarks && !rawAtt && !rawRes) {
    await setMeta('migratedLegacy', true);
    return 0;
  }

  // Keep permanent backup of old keys; never delete old keys automatically
  if (!localStorage.getItem('elms_backup_v1')) {
    localStorage.setItem('elms_backup_v1', JSON.stringify({
      savedAt: new Date().toISOString(),
      elms_migrated_v2: migratedV2,
      elms_marks: rawMarks ? JSON.parse(rawMarks) : [],
      elms_attempted: rawAtt ? JSON.parse(rawAtt) : {},
      elms_results: rawRes ? JSON.parse(rawRes) : {},
    }));
  }

  const legacyMap = await fetchGzJson('data/legacy-map.json.gz');
  const sids = legacyMap.sids || [];
  const removed = legacyMap.removedIdx || [];
  const resolveSid = (rawIdx) => {
    const pos = migratedV2 ? Number(rawIdx) : mapLegacyIndex(Number(rawIdx), removed);
    return pos >= 0 && pos < sids.length ? sids[pos] : null;
  };

  const now = Date.now();
  const stateMap = new Map();
  const getOrInit = (sid) => {
    if (!stateMap.has(sid)) stateMap.set(sid, { sid });
    return stateMap.get(sid);
  };

  let migratedCount = 0;
  const marksArr = rawMarks ? JSON.parse(rawMarks) : [];
  for (const idx of marksArr) {
    const sid = resolveSid(idx);
    if (!sid) continue;
    getOrInit(sid).mark = { val: true, ts: now, deleted: false };
    migratedCount++;
  }

  const resObj = rawRes ? JSON.parse(rawRes) : {};
  const attObj = rawAtt ? JSON.parse(rawAtt) : {};
  const eventsToInsert = [];

  for (const [k, r] of Object.entries(resObj)) {
    const sid = resolveSid(k);
    if (!sid) continue;
    const ok = Boolean(r && r.ok);
    getOrInit(sid).result = { pick: r.pick || attObj[k] || '', cor: r.cor || '', ok, keySource: 'website', ts: now, deviceId: 'legacy' };
    const box = ok ? 2 : 1;
    getOrInit(sid).leitner = { box, dueTs: now + (ok ? LEITNER_DAYS[1] * 86400000 : 0), reps: 1, ts: now };
    eventsToInsert.push({ eventId: `leg-${sid}`, sid, pick: r.pick || '', cor: r.cor || '', ok, ts: now, deviceId: 'legacy' });
    migratedCount++;
  }

  const db = await openIDB();
  const tx = db.transaction(['userState', 'events'], 'readwrite');
  const usStore = tx.objectStore('userState');
  for (const rec of stateMap.values()) usStore.put(rec);
  const evStore = tx.objectStore('events');
  for (const ev of eventsToInsert.slice(-MAX_RECENT_EVENTS)) evStore.put(ev);
  await txDone(tx);

  await setMeta('migratedLegacy', true);
  return migratedCount;
}

export async function loadQuestionBank(onProgress = null) {
  const db = await openIDB();
  let manifest = null;
  try {
    const res = await fetch('data/manifest.json', { cache: 'no-cache' });
    if (res.ok) {
      manifest = await res.json();
      await setMeta('manifest', manifest);
    }
  } catch (_) {
    // Offline fallback to cached manifest in IndexedDB
  }
  if (!manifest) manifest = await getMeta('manifest', null);
  if (!manifest) throw new Error('No question manifest available offline.');

  // Read cached packs from IndexedDB
  const cachedPacks = await reqPromise(db.transaction('packs', 'readonly').objectStore('packs').getAll());
  const cachedById = new Map(cachedPacks.map(p => [p.id, p]));

  const totalPacks = manifest.packs.length;
  const colsList = new Array(totalPacks);
  let donePacks = 0;
  const toFetch = [];

  for (let i = 0; i < totalPacks; i++) {
    const pMeta = manifest.packs[i];
    const cached = cachedById.get(pMeta.id);
    if (cached && cached.sha256 === pMeta.sha256 && cached.version === pMeta.version) {
      colsList[i] = cached.columns;
      donePacks++;
    } else {
      toFetch.push({ i, pMeta });
    }
  }
  if (onProgress) onProgress(donePacks, totalPacks);

  const CONCURRENCY = 4;
  for (let start = 0; start < toFetch.length; start += CONCURRENCY) {
    const batch = toFetch.slice(start, start + CONCURRENCY);
    await Promise.all(batch.map(async ({ i, pMeta }) => {
      const columns = await fetchGzJson(`data/${pMeta.file}`);
      const tx = db.transaction('packs', 'readwrite');
      tx.objectStore('packs').put({ id: pMeta.id, version: pMeta.version, sha256: pMeta.sha256, columns });
      await txDone(tx);
      colsList[i] = columns;
      donePacks++;
      if (onProgress) onProgress(donePacks, totalPacks);
    }));
  }

  // Include in-app imported customPacks from IndexedDB
  const customPacks = await reqPromise(db.transaction("customPacks", "readonly").objectStore("customPacks").getAll());
  const subs = [...manifest.subs];
  const tops = [...manifest.tops];
  const subMap = new Map(subs.map((s, i) => [s, i]));
  const topMap = new Map(tops.map((t, i) => [t, i]));
  const extraConflicts = [];
  for (const cp of customPacks) {
    if (cp.columns) {
      const c = cp.columns;
      c.si = c.subNames.map(s => { if (!subMap.has(s)) { subMap.set(s, subs.length); subs.push(s); } return subMap.get(s); });
      c.ti = c.topNames.map(t => { if (!topMap.has(t)) { topMap.set(t, tops.length); tops.push(t); } return topMap.get(t); });
      colsList.push(c);
    }
    if (Array.isArray(cp.conflicts)) extraConflicts.push(...cp.conflicts);
  }
  manifest.subs = subs;
  manifest.tops = tops;
  manifest.conflicts = [...(manifest.conflicts || []), ...extraConflicts];

  // Merge into flat columnar arrays in memory
  const total = colsList.reduce((acc, c) => acc + c.sid.length, 0);
  const DB = {
    total,
    subs: manifest.subs,
    tops: manifest.tops,
    conflicts: manifest.conflicts || [],
    sid: new Array(total),
    sourceId: new Array(total),
    si: new Uint16Array(total),
    ti: new Uint16Array(total),
    yr: new Array(total),
    qe: new Array(total),
    qt: new Array(total),
    o: new Array(total),
    cor: new Array(total),
    keySource: new Array(total),
    xe: new Array(total),
    xt: new Array(total),
    imgCount: new Uint8Array(total),
    fl: new Uint8Array(total),
    qReason: new Array(total),
    sidToIdx: new Map(),
  };

  let ptr = 0;
  for (const c of colsList) {
    const len = c.sid.length;
    for (let j = 0; j < len; j++, ptr++) {
      const sid = c.sid[j];
      DB.sid[ptr] = sid;
      DB.sidToIdx.set(sid, ptr);
      DB.sourceId[ptr] = c.sourceId[j];
      DB.si[ptr] = c.si[j];
      DB.ti[ptr] = c.ti[j];
      DB.yr[ptr] = c.yr[j];
      DB.qe[ptr] = c.qe[j];
      DB.qt[ptr] = c.qt[j];
      DB.o[ptr] = c.o[j];
      DB.cor[ptr] = c.cor[j];
      DB.keySource[ptr] = c.keySource[j];
      DB.xe[ptr] = c.xe[j];
      DB.xt[ptr] = c.xt[j];
      DB.imgCount[ptr] = c.imgCount[j] || 0;
      DB.fl[ptr] = c.fl[j];
      DB.qReason[ptr] = c.qReason[j];
    }
  }

  return { DB, manifest };
}

export async function loadAllUserState() {
  const db = await openIDB();
  const rows = await reqPromise(db.transaction('userState', 'readonly').objectStore('userState').getAll());
  const map = new Map();
  for (const r of rows) map.set(r.sid, r);
  return map;
}

export async function updateUserStateField(sid, field, valueObj) {
  const db = await openIDB();
  const tx = db.transaction('userState', 'readwrite');
  const store = tx.objectStore('userState');
  const existing = (await reqPromise(store.get(sid))) || { sid };
  existing[field] = valueObj;
  store.put(existing);
  await txDone(tx);
  return existing;
}

export async function appendAnswerEvent(ev) {
  const db = await openIDB();
  const tx = db.transaction('events', 'readwrite');
  const store = tx.objectStore('events');
  store.put(ev);
  const allKeys = await reqPromise(store.getAllKeys());
  if (allKeys.length > MAX_RECENT_EVENTS) {
    const excess = allKeys.length - MAX_RECENT_EVENTS;
    for (let i = 0; i < excess; i++) store.delete(allKeys[i]);
  }
  return txDone(tx);
}

export async function saveActiveSession(sessionObj) {
  const db = await openIDB();
  const tx = db.transaction('sessions', 'readwrite');
  tx.objectStore('sessions').put({ id: 'active', ...sessionObj, updatedAt: Date.now() });
  return txDone(tx);
}

export async function loadActiveSession() {
  const db = await openIDB();
  return reqPromise(db.transaction('sessions', 'readonly').objectStore('sessions').get('active'));
}

export async function clearActiveSession() {
  const db = await openIDB();
  const tx = db.transaction('sessions', 'readwrite');
  tx.objectStore('sessions').delete('active');
  return txDone(tx);
}

export async function getAllEvents() {
  const db = await openIDB();
  return reqPromise(db.transaction('events', 'readonly').objectStore('events').getAll());
}

export async function replaceUserStateAndEvents(userStateRows, eventsRows, replaceAll = false) {
  const db = await openIDB();
  const tx = db.transaction(['userState', 'events'], 'readwrite');
  const us = tx.objectStore('userState');
  const ev = tx.objectStore('events');
  if (replaceAll) {
    us.clear();
    ev.clear();
  }
  for (const r of userStateRows) us.put(r);
  for (const e of eventsRows) ev.put(e);
  return txDone(tx);
}

export async function saveCustomPack(packObj) {
  const db = await openIDB();
  const tx = db.transaction('customPacks', 'readwrite');
  tx.objectStore('customPacks').put(packObj);
  return txDone(tx);
}
