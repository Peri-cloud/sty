// sync.js — SyncProvider interface, GitHub Gist provider, Drive stub, backup/restore & compact codes

import { getMeta, setMeta, loadAllUserState } from './db.js';

const MAX_RECENT_EVENTS = 500;
const BACKUP_SCHEMA = 1;

function u8ToB64(u8) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    s += String.fromCharCode(...u8.subarray(i, i + chunk));
  }
  return btoa(s);
}

function b64ToU8(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

export async function deflateB64(obj, urlSafe = false) {
  const raw = new TextEncoder().encode(JSON.stringify(obj));
  const cs = new CompressionStream('deflate');
  const w = cs.writable.getWriter();
  w.write(raw);
  w.close();
  const buf = new Uint8Array(await new Response(cs.readable).arrayBuffer());
  let b64 = u8ToB64(buf);
  if (urlSafe) b64 = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return b64;
}

export async function inflateB64(b64, urlSafe = false) {
  let std = b64;
  if (urlSafe) {
    std = b64.replace(/-/g, '+').replace(/_/g, '/');
    while (std.length % 4) std += '=';
  }
  const u8 = b64ToU8(std);
  const ds = new DecompressionStream('deflate');
  const w = ds.writable.getWriter();
  w.write(u8);
  w.close();
  const text = await new Response(ds.readable).text();
  return JSON.parse(text);
}

function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// Per-field LWW merge: never replace a whole userState record by one ts
export function mergeUserStateFieldWise(localMap, remoteRecords) {
  const merged = new Map(localMap);
  const fields = ['result', 'mark', 'note', 'leitner', 'keyOverride'];
  for (const r of remoteRecords || []) {
    if (!r || !r.sid) continue;
    const cur = { ...(merged.get(r.sid) || { sid: r.sid }) };
    for (const f of fields) {
      if (!r[f]) continue;
      if (!cur[f] || (r[f].ts || 0) > (cur[f].ts || 0)) {
        cur[f] = r[f];
      }
    }
    merged.set(r.sid, cur);
  }
  return merged;
}

export function mergeEventsBounded(localEvents, remoteEvents) {
  const byId = new Map();
  for (const ev of [...(localEvents || []), ...(remoteEvents || [])]) {
    if (ev && ev.eventId) byId.set(ev.eventId, ev);
  }
  return [...byId.values()]
    .sort((a, b) => (a.ts || 0) - (b.ts || 0))
    .slice(-MAX_RECENT_EVENTS);
}

export class SyncProvider {
  async getState() { throw new Error('Not implemented'); }
  async applyState(_remoteState) { throw new Error('Not implemented'); }
  async lastModified() { return 0; }
  async pull() { throw new Error('Not implemented'); }
  async push(_state) { throw new Error('Not implemented'); }
}

export class GitHubGistProvider extends SyncProvider {
  constructor(token, gistId, dbHelpers) {
    super();
    this.token = token;
    this.gistId = gistId;
    this.db = dbHelpers;
    this.fileName = 'elms_pwa_sync_v1.b64';
  }

  headers() {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    };
  }

  async getState() {
    const userStateMap = await loadAllUserState();
    const events = await this.db.getAllEvents();
    return {
      schemaVersion: BACKUP_SCHEMA,
      updatedAt: Date.now(),
      deviceId: await getMeta('deviceId', 'unknown'),
      activeDays: await getMeta('activeDays', []),
      userState: [...userStateMap.values()],
      events: events.slice(-MAX_RECENT_EVENTS),
    };
  }

  async applyState(remote) {
    if (!remote || remote.schemaVersion !== BACKUP_SCHEMA) {
      throw new Error('Incompatible remote sync schema.');
    }
    const localMap = await loadAllUserState();
    const mergedMap = mergeUserStateFieldWise(localMap, remote.userState);
    const localEvents = await this.db.getAllEvents();
    const mergedEvents = mergeEventsBounded(localEvents, remote.events);
    const localDays = await getMeta('activeDays', []);
    const mergedDays = [...new Set([...localDays, ...(remote.activeDays || [])])].sort();
    await setMeta('activeDays', mergedDays);
    await this.db.replaceUserStateAndEvents([...mergedMap.values()], mergedEvents);
    return { states: mergedMap.size, events: mergedEvents.length };
  }

  async lastModified() {
    if (!this.gistId) return 0;
    const res = await fetch(`https://api.github.com/gists/${this.gistId}`, { headers: this.headers(), cache: 'no-store' });
    if (!res.ok) throw new Error(`Gist fetch failed (${res.status})`);
    const g = await res.json();
    return Date.parse(g.updated_at) || 0;
  }

  async pull() {
    if (!this.gistId) return null;
    const res = await fetch(`https://api.github.com/gists/${this.gistId}`, { headers: this.headers(), cache: 'no-store' });
    if (!res.ok) throw new Error(`Gist pull failed (${res.status})`);
    const gist = await res.json();
    const file = gist.files?.[this.fileName];
    if (!file) return null;
    let content = file.content || '';
    if (file.truncated && file.raw_url) {
      const rawRes = await fetch(file.raw_url, { cache: 'no-store' });
      if (!rawRes.ok) throw new Error(`Gist raw_url fetch failed (${rawRes.status})`);
      content = await rawRes.text();
    }
    if (!content.trim()) return null;
    return inflateB64(content.trim(), false);
  }

  async push(state) {
    const encoded = await deflateB64(state, false);
    const body = {
      description: 'ELMS & TNPSC PWA Sync State',
      public: false,
      files: { [this.fileName]: { content: encoded } },
    };
    const url = this.gistId ? `https://api.github.com/gists/${this.gistId}` : 'https://api.github.com/gists';
    const method = this.gistId ? 'PATCH' : 'POST';
    const res = await fetch(url, { method, headers: this.headers(), body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`Gist push failed (${res.status})`);
    const saved = await res.json();
    if (!this.gistId && saved.id) {
      this.gistId = saved.id;
      await setMeta('gistId', saved.id);
    }
    return saved.id;
  }
}

export class GoogleDriveAppDataProvider extends SyncProvider {
  async pull() { throw new Error('Google Drive appDataFolder provider is not configured yet.'); }
  async push() { throw new Error('Google Drive appDataFolder provider is not configured yet.'); }
}

export function validateBackupPayload(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('Backup is not a JSON object.');
  if (obj.schemaVersion !== BACKUP_SCHEMA) throw new Error(`Unsupported backup version: ${obj.schemaVersion}`);
  if (!Array.isArray(obj.userState) || !Array.isArray(obj.events)) {
    throw new Error('Backup missing required userState or events arrays.');
  }
  return {
    records: obj.userState.length,
    events: obj.events.length,
    exportedAt: obj.exportedAt || obj.updatedAt || null,
  };
}

export async function exportBackupJson(dbHelpers) {
  const userState = [...(await loadAllUserState()).values()];
  const events = await dbHelpers.getAllEvents();
  const payload = {
    schemaVersion: BACKUP_SCHEMA,
    app: 'elms-tnpsc-pwa',
    exportedAt: new Date().toISOString(),
    activeDays: await getMeta('activeDays', []),
    userState,
    events: events.slice(-MAX_RECENT_EVENTS),
  };
  await setMeta('lastBackupAt', Date.now());
  return payload;
}

export async function encodeCompactBackupCode(dbHelpers) {
  const payload = await exportBackupJson(dbHelpers);
  const body = await deflateB64(payload, true);
  return `ELMS1.${fnv1a32(body)}.${body}`;
}

export async function decodeCompactBackupCode(code) {
  const parts = String(code || '').trim().split('.');
  if (parts.length !== 3 || parts[0] !== 'ELMS1') {
    throw new Error('Invalid backup code format.');
  }
  const [, checksum, body] = parts;
  if (fnv1a32(body) !== checksum) {
    throw new Error('Backup code checksum mismatch (corrupted or truncated).');
  }
  const obj = await inflateB64(body, true);
  validateBackupPayload(obj);
  return obj;
}
