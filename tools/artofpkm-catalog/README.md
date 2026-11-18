# artofpkm-catalog

Polite, resumable archive of one artofpkm catalog (default 668, "TCG Gallery":
clean card artworks without card text). Same storage layout as the full-site
archive (`html/xx/HASH.html.gz`, `metadata/xx/HASH.json`, `assets/xx/HASH.EXT`
+ `.json`, HASH = SHA-256 of the URL), plus `artworks.jsonl` (one row per
artwork: titles EN/JA, collector number, illustrator, date, subjects, linked
card pages with set and number, every image with size and SHA-256).

```sh
cargo build --release
./target/release/artofpkm-catalog \
  --output /home/nez/mnt/mybook/datasets/tcg/artofpkm/catalog668-YYYYMMDD \
  --reuse /home/nez/mnt/mybook/datasets/tcg/artofpkm/full-20261016
```

Requests are sequential, 2 s apart (`--spacing-ms`); 429/5xx honour
Retry-After with backoff. `?lang=` copies are never requested (robots.txt).
Listing pages are always fetched fresh; artwork/card pages and images are
copied from `--reuse` when that archive has them (hash-checked). Re-run to
resume. `--limit N` for a scoped check. See docs/FIGURE_MASKS.md.
