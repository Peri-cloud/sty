# Exam Practice PWA — Adding Questions & Deploying

**Requirements:** Python **3.10+** (standard library only, no third-party packages).

Commit `data/legacy-map.json.gz` and `seed/payload.b64` to Git—`legacy-map.json.gz` is the frozen identity authority for all 53,873 seed questions (`seed/` stays outside `data/` so GitHub Pages does not serve the raw seed blob).

## 3 Commands to Add New Questions

1. **Build/merge the new pack** (idempotent; preserves all existing `sid`s and only writes changed/new packs):
   ```bash
   python3 scripts/build_packs.py --input new_questions.json --batch batch_2026_11 --answers answer_keys.json
   ```
2. **Optional — refresh the emergency single-file offline export**:
   ```bash
   python3 scripts/export_single_file.py
   ```
3. **Commit and push to GitHub Pages**:
   ```bash
   git add data/ && git commit -m "Add batch_2026_11 questions" && git push
   ```

## Apply Answer Keys In-Place (Existing Batch)

```bash
python3 scripts/build_packs.py --apply-keys answer_keys.json --batch legacy
```

## Initial Seed Build (One-Time Only)

```bash
python3 scripts/build_packs.py --seed seed/payload.b64 --ai-keys answer_keys.json
```
