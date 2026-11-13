#!/usr/bin/env python3
"""
build_packs.py — Stdlib-only pack builder for the ELMS/TNPSC Offline PWA (Python 3.10+).

Seed mode (run once from seed/payload.b64):
  python3 scripts/build_packs.py --seed seed/payload.b64 --ai-keys answer_keys.json

Incremental mode (add/update questions idempotently):
  python3 scripts/build_packs.py --input new_questions.json --batch batch_04 [--answers answer_keys.json]

Apply keys in-place to existing records:
  python3 scripts/build_packs.py --apply-keys answer_keys.json --batch legacy
"""

import argparse
import base64
import bisect
import gzip
import hashlib
import json
import re
import sys
import unicodedata
import zlib
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

if sys.version_info < (3, 10):
    sys.exit("ERROR: Python 3.10+ is required.")

FL_DUP = 1
FL_VER = 2
FL_NOANS = 4
FL_NOQ = 8

PACK_SIZE = 2500
DATA_DIR = Path("data")
ASSETS_DIR = DATA_DIR / "assets"
MANIFEST_PATH = DATA_DIR / "manifest.json"
LEGACY_MAP_PATH = DATA_DIR / "legacy-map.json.gz"
CHANGELOG_PATH = DATA_DIR / "CHANGELOG.json"

# 101 pre-final indices removed before payload.b64 (used to map pre-prune indices -> legacy position)
REMOVED_IDX_DEFAULT = [
    2445, 2514, 2516, 10352, 16553, 20515, 20516, 21685, 22810, 22812, 22813,
    22814, 22823, 22824, 22825, 22826, 22827, 22829, 22830, 22831, 22832, 22833,
    22835, 22839, 22840, 22841, 22843, 22845, 22846, 22847, 22849, 22850, 22852,
    22855, 22858, 22859, 22860, 22864, 22867, 22869, 22870, 22871, 22872, 22873,
    22874, 22876, 22877, 22879, 22880, 22885, 22886, 22887, 22888, 22890, 22894,
    22896, 22897, 22899, 22905, 22906, 22908, 22911, 22912, 22913, 22917, 22918,
    22921, 22923, 22924, 22926, 22928, 22929, 22930, 22931, 22933, 22937, 22940,
    22942, 22946, 22947, 22948, 22949, 22950, 24701, 25409, 25883, 27821, 35478,
    36220, 36224, 36282, 37309, 42582, 43546, 43548, 43549, 44347, 44496, 44498,
    45654, 51365,
]
REMOVED_IDX_SET = set(REMOVED_IDX_DEFAULT)


def map_legacy_index(src_index: int) -> int | None:
    """Map pre-prune source index to shifted legacy array position (0..53872)."""
    if src_index in REMOVED_IDX_SET:
        return None
    return src_index - bisect.bisect_left(REMOVED_IDX_DEFAULT, src_index)


def norm_text(s: str) -> str:
    if not s:
        return ""
    s = unicodedata.normalize("NFKC", str(s)).lower()
    s = re.sub(r"<[^>]+>", " ", s)
    s = re.sub(r"[^a-z0-9\u0b80-\u0bff]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def content_hash16(qe: str, qt: str, opts: list, blank_tag: str = "") -> str:
    ne = norm_text(qe)
    nt = norm_text(qt)
    if not ne and not nt:
        raw = f"BLANK|{blank_tag}"
    else:
        norm_opts = [f"{norm_text(p[0])}/{norm_text(p[1])}" for p in (opts or [])]
        raw = f"{ne}|{nt}|{'|'.join(norm_opts)}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def write_gz_json(path: Path, obj: object) -> str:
    payload = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    with open(path, "wb") as raw_f:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw_f, mtime=0) as gz:
            gz.write(payload)
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_gz_json(path: Path) -> object:
    with gzip.open(path, "rb") as gz:
        return json.loads(gz.read().decode("utf-8"))


def detect_quarantine(qe: str, qt: str, opts: list, fl: int) -> str | None:
    if (fl & FL_NOQ) or (not norm_text(qe) and not norm_text(qt)):
        return "empty_question_text"
    if not opts or len(opts) < 2:
        return "missing_options"
    if norm_text(qe) == "na" and not norm_text(qt):
        return "placeholder_na"
    return None


def verify_existing_state() -> tuple[dict, dict, list[tuple[dict, dict]], dict[str, tuple[int, int]], dict[str, list[str]], dict[str, str]]:
    if not LEGACY_MAP_PATH.exists():
        sys.exit("ERROR: data/legacy-map.json.gz is missing. Aborting to prevent sid corruption.")
    if not MANIFEST_PATH.exists():
        sys.exit("ERROR: data/manifest.json is missing. Run --seed first.")

    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    expected_sha = manifest.get("legacyMap", {}).get("sha256")
    actual_sha = hashlib.sha256(LEGACY_MAP_PATH.read_bytes()).hexdigest()
    if expected_sha and actual_sha != expected_sha:
        sys.exit(f"ERROR: data/legacy-map.json.gz sha256 mismatch ({actual_sha} != {expected_sha}). Aborting.")

    legacy_map = read_gz_json(LEGACY_MAP_PATH)
    frozen_sids = set(legacy_map["sids"])

    existing_packs = []
    origin_to_loc = {}
    hash_to_sids = defaultdict(list)
    sid_to_cor = {}
    seen_existing_sids = set()

    for p_meta in manifest["packs"]:
        p_cols = read_gz_json(DATA_DIR / p_meta["file"])
        existing_packs.append((p_meta, p_cols))
        for idx, sid in enumerate(p_cols["sid"]):
            seen_existing_sids.add(sid)
            origin_to_loc[p_cols["originKey"][idx]] = (len(existing_packs) - 1, idx)
            h16 = sid.split("-")[0]
            hash_to_sids[h16].append(sid)
            sid_to_cor[sid] = p_cols["cor"][idx]

    pruned_sids = set(manifest.get('prunedQuarantinedSids', []))
    if not (frozen_sids - pruned_sids).issubset(seen_existing_sids):
        sys.exit("ERROR: Existing legacy sid set mismatch! Aborting.")

    return manifest, legacy_map, existing_packs, origin_to_loc, hash_to_sids, sid_to_cor


def seed_from_payload(payload_path: Path, ai_keys_path: Path | None) -> None:
    if LEGACY_MAP_PATH.exists() or MANIFEST_PATH.exists():
        sys.exit("ERROR: data/legacy-map.json.gz or data/manifest.json already exists. Aborting seed to protect frozen sids.")

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    ASSETS_DIR.mkdir(parents=True, exist_ok=True)

    b64_text = payload_path.read_text(encoding="utf-8").strip()
    raw = zlib.decompress(base64.b64decode(b64_text))
    cols = json.loads(raw)

    subs = cols["subs"]
    tops = cols["tops"]
    n = len(cols["si"])
    imgs = cols.get("img") or [None] * n

    # Map --ai-keys source indices -> shifted legacy positions
    ai_positions = set()
    if ai_keys_path:
        ai_items = json.loads(ai_keys_path.read_text(encoding="utf-8"))
        for item in ai_items:
            pos = map_legacy_index(int(item["index"]))
            if pos is not None and 0 <= pos < n:
                ai_positions.add(pos)

    hash_counts = Counter()
    sids = []
    img_counts = []
    key_sources = []
    q_reasons = []
    aliases = [[] for _ in range(n)]
    origin_keys = []
    quarantined = 0
    ai_applied = 0

    for i in range(n):
        qe = cols["qe"][i] or ""
        qt = cols["qt"][i] or ""
        opts = cols["o"][i] or []
        cor = cols["cor"][i] or ""
        fl = cols["fl"][i]

        h16 = content_hash16(qe, qt, opts, blank_tag=f"legacy:{i}")
        ord_n = hash_counts[h16]
        hash_counts[h16] += 1
        sid = f"{h16}-{ord_n}"
        sids.append(sid)
        origin_keys.append(f"legacy:{i}")

        q_imgs = imgs[i] or []
        saved_imgs = 0
        for k, src in enumerate(q_imgs):
            if isinstance(src, str) and src.startswith("data:image/png;base64,"):
                png_bytes = base64.b64decode(src.split(",", 1)[1])
                (ASSETS_DIR / f"{sid}-{k}.png").write_bytes(png_bytes)
                saved_imgs += 1
        img_counts.append(saved_imgs)

        if not cor or (fl & FL_NOANS):
            key_sources.append("")
        elif i in ai_positions:
            key_sources.append("ai-suggested")
            ai_applied += 1
        else:
            key_sources.append("website")

        qr = detect_quarantine(qe, qt, opts, fl)
        q_reasons.append(qr)
        if qr:
            quarantined += 1

    legacy_map_obj = {
        "version": 1,
        "count": n,
        "sids": sids,
        "removedIdx": REMOVED_IDX_DEFAULT,
    }
    legacy_sha = write_gz_json(LEGACY_MAP_PATH, legacy_map_obj)

    packs_meta = []
    for p_idx, start in enumerate(range(0, n, PACK_SIZE), 1):
        end = min(start + PACK_SIZE, n)
        pack_id = f"pack-{p_idx:04d}"
        pack_file = f"{pack_id}.json.gz"
        pack_cols = {
            "packId": pack_id,
            "sid": sids[start:end],
            "legacyIdx": list(range(start, end)),
            "sourceId": [f"legacy position {x + 1}" for x in range(start, end)],
            "originKey": origin_keys[start:end],
            "aliases": aliases[start:end],
            "si": cols["si"][start:end],
            "ti": cols["ti"][start:end],
            "yr": cols["yr"][start:end],
            "qe": cols["qe"][start:end],
            "qt": cols["qt"][start:end],
            "o": cols["o"][start:end],
            "cor": cols["cor"][start:end],
            "keySource": key_sources[start:end],
            "xe": cols["xe"][start:end],
            "xt": cols["xt"][start:end],
            "imgCount": img_counts[start:end],
            "fl": cols["fl"][start:end],
            "qReason": q_reasons[start:end],
        }
        sha = write_gz_json(DATA_DIR / pack_file, pack_cols)
        packs_meta.append({
            "id": pack_id,
            "file": pack_file,
            "version": 1,
            "sha256": sha,
            "count": end - start,
            "bytes": (DATA_DIR / pack_file).stat().st_size,
        })

    now = datetime.now(timezone.utc).isoformat()
    manifest = {
        "schemaVersion": 1,
        "version": 1,
        "updatedAt": now,
        "totalQuestions": n,
        "uniqueContentHashes": len(hash_counts),
        "quarantinedCount": quarantined,
        "subs": subs,
        "tops": tops,
        "legacyMap": {"file": "legacy-map.json.gz", "sha256": legacy_sha, "count": n},
        "packs": packs_meta,
        "conflicts": [],
    }
    MANIFEST_PATH.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    changelog = [{
        "version": 1,
        "timestamp": now,
        "action": "seed",
        "added": n,
        "updated": 0,
        "duplicate": sum(1 for f in cols["fl"] if f & FL_DUP),
        "quarantined": quarantined,
        "aiKeysApplied": ai_applied,
        "conflicts": 0,
    }]
    CHANGELOG_PATH.write_text(json.dumps(changelog, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Seeded {n} questions ({len(hash_counts)} unique hashes) into {len(packs_meta)} packs. Quarantined: {quarantined}. AI keys applied: {ai_applied}.")


def load_input_records(paths: list[Path]) -> list[dict]:
    records = []
    for p in paths:
        txt = p.read_text(encoding="utf-8").strip()
        if not txt:
            continue
        if txt.startswith("["):
            records.extend(json.loads(txt))
        elif txt.startswith("{") and "\n" not in txt:
            obj = json.loads(txt)
            records.extend(obj.get("questions", [obj]))
        else:
            for line in txt.splitlines():
                if line.strip():
                    records.append(json.loads(line))
    return records


def apply_keys_in_place(keys_path: Path, batch: str, key_source: str) -> None:
    manifest, _, existing_packs, origin_to_loc, _, _ = verify_existing_state()
    items = json.loads(keys_path.read_text(encoding="utf-8"))

    dirty_pack_indices = set()
    new_conflicts = []
    updated = 0
    skipped = 0
    missing = 0

    for item in items:
        raw_idx = int(item["index"])
        pos = map_legacy_index(raw_idx) if batch == "legacy" else raw_idx
        if pos is None:
            missing += 1
            continue
        origin_key = f"{batch}:{pos}"
        if origin_key not in origin_to_loc:
            missing += 1
            continue

        pi, qi = origin_to_loc[origin_key]
        p_cols = existing_packs[pi][1]
        sid = p_cols["sid"][qi]
        new_cor = (item.get("correct_option") or "").strip()
        new_expl = (item.get("explanation") or "").strip()
        cur_cor = p_cols["cor"][qi] or ""
        cur_src = p_cols["keySource"][qi] or ""

        # Protect website & user-verified keys from being overwritten or relabelled by ai-suggested
        if key_source == "ai-suggested" and cur_src in ("website", "user-verified"):
            if new_cor and new_cor != cur_cor:
                new_conflicts.append({
                    "sid": sid,
                    "existing": cur_cor,
                    "incoming": new_cor,
                    "sources": {"existing": cur_src, "incoming": key_source},
                    "originKey": origin_key,
                })
            else:
                skipped += 1
            continue

        if cur_src == "user-verified" and key_source != "user-verified" and new_cor and new_cor != cur_cor:
            new_conflicts.append({
                "sid": sid,
                "existing": cur_cor,
                "incoming": new_cor,
                "sources": {"existing": cur_src, "incoming": key_source},
                "originKey": origin_key,
            })
            continue

        if cur_cor == new_cor and cur_src == key_source and (not new_expl or new_expl in (p_cols["xe"][qi] or "")):
            skipped += 1
            continue

        if new_cor:
            p_cols["cor"][qi] = new_cor
            p_cols["keySource"][qi] = key_source
            p_cols["fl"][qi] &= ~FL_NOANS
        if new_expl:
            old_xe = (p_cols["xe"][qi] or "").strip()
            p_cols["xe"][qi] = f"{old_xe}\n{new_expl}".strip() if old_xe and new_expl not in old_xe else (old_xe or new_expl)

        dirty_pack_indices.add(pi)
        updated += 1

    if not dirty_pack_indices and not new_conflicts:
        print("No changes (idempotent).")
        return

    for pi in dirty_pack_indices:
        p_meta, p_cols = existing_packs[pi]
        sha = write_gz_json(DATA_DIR / p_meta["file"], p_cols)
        if sha != p_meta["sha256"]:
            p_meta["sha256"] = sha
            p_meta["version"] += 1
            p_meta["bytes"] = (DATA_DIR / p_meta["file"]).stat().st_size

    now = datetime.now(timezone.utc).isoformat()
    manifest["version"] += 1
    manifest["updatedAt"] = now
    manifest["conflicts"].extend(new_conflicts)
    MANIFEST_PATH.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    changelog = json.loads(CHANGELOG_PATH.read_text(encoding="utf-8")) if CHANGELOG_PATH.exists() else []
    changelog.append({
        "version": manifest["version"],
        "timestamp": now,
        "action": "apply-keys",
        "batch": batch,
        "updated": updated,
        "skipped": skipped,
        "missing": missing,
        "conflicts": len(new_conflicts),
    })
    CHANGELOG_PATH.write_text(json.dumps(changelog, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Applied keys to batch '{batch}': updated={updated}, skipped={skipped}, missing={missing}, conflicts={len(new_conflicts)}.")


def incremental_merge(input_paths: list[Path], batch: str, answers_path: Path | None) -> None:
    manifest, _, existing_packs, origin_to_loc, hash_to_sids, sid_to_cor = verify_existing_state()

    ans_by_index = {}
    if answers_path:
        for a in json.loads(answers_path.read_text(encoding="utf-8")):
            ans_by_index[a["index"]] = a

    subs = list(manifest["subs"])
    tops = list(manifest["tops"])
    sub_idx_map = {s: i for i, s in enumerate(subs)}
    top_idx_map = {t: i for i, t in enumerate(tops)}

    records = load_input_records(input_paths)
    added_rows = []
    dirty_pack_indices = set()
    new_conflicts = []
    counts = {"added": 0, "updated": 0, "duplicate": 0, "quarantined": 0, "quarantine_delta": 0, "skipped_idempotent": 0}

    for pos, rec in enumerate(records):
        src_idx = rec.get("index", pos)
        origin_key = f"{batch}:{src_idx}"
        qe = rec.get("question_en") or ""
        qt = rec.get("question_ta") or ""
        opts_raw = rec.get("options") or []
        opts = [[o.get("en") or "", o.get("ta") or ""] for o in opts_raw]
        fl = int(rec.get("flags") or 0)

        ans_override = ans_by_index.get(src_idx)
        cor = (ans_override["correct_option"] if ans_override else rec.get("correct_option")) or ""
        xe = (ans_override.get("explanation") if ans_override else rec.get("explanation")) or ""
        xt = rec.get("explanation_ta") or ""
        key_src = "ai-suggested" if ans_override else (rec.get("key_source") or ("website" if cor else ""))

        if not cor:
            fl |= FL_NOANS
        else:
            fl &= ~FL_NOANS

        qr = detect_quarantine(qe, qt, opts, fl)
        if qr:
            fl |= FL_NOQ

        h16 = content_hash16(qe, qt, opts, blank_tag=f"{batch}:{src_idx}")

        if origin_key in origin_to_loc:
            pi, qi = origin_to_loc[origin_key]
            p_cols = existing_packs[pi][1]
            old_sid = p_cols["sid"][qi]
            if (p_cols["qe"][qi] == qe and p_cols["qt"][qi] == qt and p_cols["o"][qi] == opts and p_cols["cor"][qi] == cor):
                counts["skipped_idempotent"] += 1
                continue

            if h16 != old_sid.split("-")[0] and h16 not in p_cols["aliases"][qi]:
                p_cols["aliases"][qi].append(h16)
            p_cols["qe"][qi] = qe
            p_cols["qt"][qi] = qt
            p_cols["o"][qi] = opts

            if cor and p_cols["cor"][qi] and p_cols["cor"][qi] != cor:
                new_conflicts.append({"sid": old_sid, "existingCor": p_cols["cor"][qi], "incomingCor": cor, "originKey": origin_key})
            elif cor:
                p_cols["cor"][qi] = cor
                p_cols["keySource"][qi] = key_src

            p_cols["xe"][qi] = xe or p_cols["xe"][qi]
            # Preserve existing FL_DUP bit
            p_cols["fl"][qi] = (fl & ~FL_DUP) | (p_cols["fl"][qi] & FL_DUP)

            was_q = bool(p_cols["qReason"][qi])
            now_q = bool(qr)
            if now_q and not was_q:
                counts["quarantined"] += 1
                counts["quarantine_delta"] += 1
            elif was_q and not now_q:
                counts["quarantine_delta"] -= 1
            p_cols["qReason"][qi] = qr

            dirty_pack_indices.add(pi)
            counts["updated"] += 1
            continue

        if qr:
            counts["quarantined"] += 1
            counts["quarantine_delta"] += 1

        existing_sids_for_h = hash_to_sids[h16]
        sid = f"{h16}-{len(existing_sids_for_h)}"
        if existing_sids_for_h:
            fl |= FL_DUP
            counts["duplicate"] += 1
            for esid in existing_sids_for_h:
                ecor = sid_to_cor.get(esid, "")
                if cor and ecor and cor != ecor:
                    new_conflicts.append({"sid": sid, "matchedSid": esid, "existingCor": ecor, "incomingCor": cor, "originKey": origin_key})
                    break

        hash_to_sids[h16].append(sid)
        sid_to_cor[sid] = cor

        sub_name = (rec.get("subject") or "General").strip()
        top_name = (rec.get("topic") or batch).strip()
        if sub_name not in sub_idx_map:
            sub_idx_map[sub_name] = len(subs)
            subs.append(sub_name)
        if top_name not in top_idx_map:
            top_idx_map[top_name] = len(tops)
            tops.append(top_name)

        added_rows.append({
            "sid": sid,
            "legacyIdx": None,
            "sourceId": str(rec.get("id") or f"{batch}-{src_idx}"),
            "originKey": origin_key,
            "aliases": [],
            "si": sub_idx_map[sub_name],
            "ti": top_idx_map[top_name],
            "yr": str(rec.get("year") or batch),
            "qe": qe,
            "qt": qt,
            "o": opts,
            "cor": cor,
            "keySource": key_src,
            "xe": xe,
            "xt": xt,
            "imgCount": 0,
            "fl": fl,
            "qReason": qr,
        })
        counts["added"] += 1

    if counts["added"] == 0 and counts["updated"] == 0 and not new_conflicts:
        print("No changes (idempotent).")
        return

    for pi in dirty_pack_indices:
        p_meta, p_cols = existing_packs[pi]
        sha = write_gz_json(DATA_DIR / p_meta["file"], p_cols)
        if sha != p_meta["sha256"]:
            p_meta["sha256"] = sha
            p_meta["version"] += 1
            p_meta["bytes"] = (DATA_DIR / p_meta["file"]).stat().st_size

    next_pack_num = len(existing_packs) + 1
    for start in range(0, len(added_rows), PACK_SIZE):
        chunk = added_rows[start:start + PACK_SIZE]
        pack_id = f"pack-{next_pack_num:04d}"
        pack_file = f"{pack_id}.json.gz"
        next_pack_num += 1
        keys = ["sid", "legacyIdx", "sourceId", "originKey", "aliases", "si", "ti", "yr", "qe", "qt", "o", "cor", "keySource", "xe", "xt", "imgCount", "fl", "qReason"]
        pack_cols = {"packId": pack_id}
        for k in keys:
            pack_cols[k] = [r[k] for r in chunk]
        sha = write_gz_json(DATA_DIR / pack_file, pack_cols)
        manifest["packs"].append({
            "id": pack_id,
            "file": pack_file,
            "version": 1,
            "sha256": sha,
            "count": len(chunk),
            "bytes": (DATA_DIR / pack_file).stat().st_size,
        })

    now = datetime.now(timezone.utc).isoformat()
    manifest["version"] += 1
    manifest["updatedAt"] = now
    manifest["totalQuestions"] += counts["added"]
    manifest["quarantinedCount"] += counts["quarantine_delta"]
    manifest["subs"] = subs
    manifest["tops"] = tops
    manifest["conflicts"].extend(new_conflicts)
    MANIFEST_PATH.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    changelog = json.loads(CHANGELOG_PATH.read_text(encoding="utf-8")) if CHANGELOG_PATH.exists() else []
    changelog.append({
        "version": manifest["version"],
        "timestamp": now,
        "batch": batch,
        "added": counts["added"],
        "updated": counts["updated"],
        "duplicate": counts["duplicate"],
        "quarantined": counts["quarantined"],
        "skipped_idempotent": counts["skipped_idempotent"],
        "conflicts": len(new_conflicts),
    })
    CHANGELOG_PATH.write_text(json.dumps(changelog, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Merged batch '{batch}': added={counts['added']}, updated={counts['updated']}, duplicate={counts['duplicate']}, quarantined={counts['quarantined']}, conflicts={len(new_conflicts)}.")


def main():
    ap = argparse.ArgumentParser(description="Build versioned offline question packs (Python 3.10+).")
    ap.add_argument("--seed", type=Path, help="Seed from seed/payload.b64 (53,873 records)")
    ap.add_argument("--ai-keys", type=Path, help="Seed option: mark matching source indices as keySource='ai-suggested'")
    ap.add_argument("--input", type=Path, nargs="+", help="Extraction JSON/JSONL files to merge")
    ap.add_argument("--batch", type=str, help="Unique batch name (e.g. tnpsc_2026_11, or 'legacy' for --apply-keys)")
    ap.add_argument("--answers", type=Path, help="Optional answer_keys.json for --input")
    ap.add_argument("--apply-keys", type=Path, help="Update cor/keySource in-place for existing records")
    ap.add_argument("--key-source", type=str, default="ai-suggested", choices=["website", "ai-suggested", "user-verified"], help="keySource label for --apply-keys")
    args = ap.parse_args()

    if args.seed:
        seed_from_payload(args.seed, args.ai_keys)
    elif args.apply_keys:
        if not args.batch:
            sys.exit("ERROR: --batch is required when using --apply-keys.")
        apply_keys_in_place(args.apply_keys, args.batch, args.key_source)
    elif args.input:
        if not args.batch:
            sys.exit("ERROR: --batch is required when using --input.")
        incremental_merge(args.input, args.batch, args.answers)
    else:
        ap.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()