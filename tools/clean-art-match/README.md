# clean-art-match

Matches artofpkm clean artworks to Pokoin CLIP versions and carries figure
masks cut on the clean painting into each leftover scan's frame. Runs on
nezopt (path dependency on `pokoin-scanner/native/artwork_matcher` for ORB +
RANSAC). Full pipeline and thresholds: docs/FIGURE_MASKS.md, "Clean-art
silhouettes".

```sh
M=/home/nez/mnt/mybook/datasets/tcg/artofpkm/catalog668-20261020/match
clean-art-match match --dump $M/.. --work $M          # needs clean-clip.npy + candidates.tsv
clean-art-match prompts --matches $M/match.jsonl --qwen …/qwen-artwork-figures.jsonl --out $M/prompts.jsonl
clean-art-match composite --prompts $M/prompts.jsonl --dump $M/.. --out $M/composite
# SAM: scripts/build-clean-art-figure-masks.py --prompts $M/composite/prompts.jsonl --dump / --select guided
clean-art-match warp --prompts $M/composite/prompts.jsonl --clean-masks MASKS --out OUT \
  --ui-clip-objects /home/nez/data/pokoin-leftovers/objects
clean-art-match compare --prompts $M/prompts.jsonl --new OUT --out $M/cmp
```
