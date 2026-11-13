#!/usr/bin/env python3
"""
export_single_file.py — Bundles the PWA into a single emergency offline HTML file.
Usage: python3 scripts/export_single_file.py
"""

import base64
import gzip
import json
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DIST_DIR = ROOT / "dist"


def main():
    DIST_DIR.mkdir(exist_ok=True)
    manifest = json.loads((DATA_DIR / "manifest.json").read_text(encoding="utf-8"))

    # Merge all packs into a compact single-file payload
    merged = {
        "subs": manifest["subs"],
        "tops": manifest["tops"],
        "si": [], "ti": [], "qe": [], "qt": [], "o": [], "cor": [],
        "xe": [], "xt": [], "yr": [], "fl": [], "img": [],
    }
    assets_dir = DATA_DIR / "assets"
    for p_meta in manifest["packs"]:
        cols = json.loads(gzip.open(DATA_DIR / p_meta["file"], "rb").read().decode("utf-8"))
        for k in ["si", "ti", "qe", "qt", "o", "cor", "xe", "xt", "yr", "fl"]:
            merged[k].extend(cols[k])
        for i, sid in enumerate(cols["sid"]):
            cnt = cols["imgCount"][i] or 0
            if cnt:
                imgs = []
                for k in range(cnt):
                    p = assets_dir / f"{sid}-{k}.png"
                    if p.exists():
                        imgs.append("data:image/png;base64," + base64.b64encode(p.read_bytes()).decode("ascii"))
                merged["img"].append(imgs or None)
            else:
                merged["img"].append(None)

    payload_b64 = base64.b64encode(
        zlib.compress(json.dumps(merged, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), 9)
    ).decode("ascii")

    # Inject into emergency template based on ELMS_Question_Practice_Pro_Final.html if present
    template_candidates = [
        ROOT / "artifacts/file_generation/ttl=63d/output/ELMS_Question_Practice_Pro_Final.html",
        ROOT / "user_uploaded_files/ttl=63d/user_uploaded/ELMS_Question_Practice_Pro__1_.html",
    ]
    out_path = DIST_DIR / "ELMS_PWA_Emergency_Offline.html"
    for cand in template_candidates:
        if cand.exists():
            import re
            html = cand.read_text(encoding="utf-8")
            html = re.sub(r'const PAYLOAD_B64\s*=\s*"[^"]+";', f'const PAYLOAD_B64 = "{payload_b64}";', html, count=1)
            out_path.write_text(html, encoding="utf-8")
            print(f"Exported emergency single-file HTML: {out_path} ({len(merged['si'])} questions, {out_path.stat().st_size / (1024*1024):.2f} MB)")
            return

    # Fallback minimal standalone HTML wrapper
    out_path.write_text(
        f"<!doctype html><html><body><p>Emergency Offline Export ({len(merged['si'])} questions)</p>"
        f"<script>window.EMERGENCY_PAYLOAD_B64='{payload_b64}';</script></body></html>",
        encoding="utf-8",
    )
    print(f"Exported minimal emergency HTML: {out_path}")


if __name__ == "__main__":
    main()