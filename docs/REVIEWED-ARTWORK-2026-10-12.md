# Reviewed artwork release — 12 October 2026

162 painting associations were visually approved (159 from the 185-pair audit, plus three explicit LEGEND-half associations); 26 audit pairs were rejected. The database plan collapses 250 old groups into 113 families and changes 273 of 673 affected printing memberships. Public IDs, prices, language and finish fields are preserved. The evidence ledger is docs/artwork-reviews/20261012.json.

Darkrai & Cresselia LEGEND Top 824982 and original Japanese Top 293014 map to original Top v260108; Bottom 824984 maps to original Bottom v260110. Top and Bottom never share a version. The erroneous identical composite scans for the two anniversary reprints are quarantined. Original split reference vectors are retained. No synthetic anniversary image is passed off as a physical-card reference; recognition of the physical reprints is not validated.

All 14 catalog printings named Blank Filler Card (10 artwork groups) are physically absent from the selected artwork vector bank. The clean immutable artifact is multilingual-framed-core-v2-20261012-reviewed-v2: 23,552 canonical reference vectors and 75,959 auxiliary localized vectors. Auxiliary identities remain unlinked and cannot produce public IDs. Five further incorrect references are absent: Pikachu/Paras, Zubat/Rattata, Charmander/Charmeleon, Charizard/Kricketune and the two composite LEGEND sources (the Pikachu reference was already excluded previously). Legacy artifacts are retained for audit. The existing whole-card matrices remain immutable; the reviewed exclusion overlay bars their invalid IDs from active Pokémon searches.

Reviewed alias overlay: 137 redirects and 113 excluded public IDs, with exact model, catalog, source-map and ledger hashes enforced at startup. Geometry fits use each original reference coordinate system before collapsing equivalent artwork winners. Shared art cannot falsely reject itself as an ambiguous painting. Printing/language indexes and expansion maps use the same canonical versions. Distinct-art ties retain their rejection checks.

Full-card remains the default, using the compact original geometry bank. Expanded multilingual geometry and artwork-only search are opt-in: the previous artwork-only result was 10/19, so it is not promoted. This model was trained on whole cards.

A paired ROCm benchmark on the 7900 XTX used the same reference MOV, 1,536 MB GPU cap, automatic selection and no expected labels at inference. All six requests recognized 19/19 names in order. Baseline processing times: 4.375, 3.546, 3.325 s (median 3.546). Candidate: 5.424, 3.209, 2.133 s (median 3.209). This small, variable sample suggests a 9.5% lower median, not a guaranteed speedup; the cold candidate run was slower. Data: merge-review-20261012/paired-v2-summary.json on the 15T volume.

Validation: 118 Python recognition tests with the native Rust matcher; six multilingual export tests; 56 phone JS unit tests; two database planner tests; primary database transaction tested with ROLLBACK; artifact hashes/row alignment verified, zero filler rows and distinct original LEGEND halves. Language/expansion accuracy is separate from the 19/19 name measurement. No live phone performance claim follows from this server-video benchmark.

Apply/deploy evidence and exact revisions are recorded after rollout in the same 15T review directory and Honcho. Database backups and guarded rollback SQL are written before any update. Updates run on the writable nezopt primary; Pi receives them through streaming replication.


## Completed rollout

Scanner code merged/pushed and bulk + public GPU workers deployed at c295e13486941f13f005f581b46ce23082fa848e. Bulk native library was built with the committed CPU flags; health confirms Rust geometry and ROCm inference. The private candidate was stopped.

Database changes committed: 273 memberships; 673 rows checked against their backups. All other card fields are preserved, apart from intended derived sort fields/timestamps. The sorting helper's automatic artist/illustrator fill on 24 rows was restored from backup; the committed job now prevents that side effect. The guarded forward and reverse transactions were exercised successfully without leaving test changes. Database job code: bf63482d on pokoin-web main.

The Pi replica confirms Top 824982→v260108, Bottom 824984→v260110, Japanese Top 293014→v260108; Houndoom 776446/776452→v776444; Lucario 665064→v239552. Public marketplace-version-set returned HTTP 200 and the new Top family. A real public scan of Houndoom 776446 returned HTTP 200, X-Scan-Worker: nezopt and artwork v776444. Public health confirms both GPU and Pi workers.

Installed-worker reference benchmark: 19/19 names in order in every run, 7.467, 7.831, 6.854 seconds (median 7.467). The server also had an unrelated FFmpeg process consuming roughly seven CPU cores at inspection. These production runs do not establish a speed improvement over the earlier paired test. Timings include automatic frame selection and printing checks.

Language remains unresolved: 18 ambiguous_language and one language_reference_unavailable, so all 19 final language fields were unknown, exactly as on the preceding baseline/candidate runs. Classifier guesses are not accepted as verified language. Expansion accuracy was not separately validated. This release corrects artwork/version associations and bad references; it does not make language/expansion auto recognition complete.

All evidence, immutable gallery manifests, database backups and rollback scripts are on the 15T volume in artwork-first-side/merge-review-20261012. Bulk remains loopback port 38877; exposing its route through the public Rust gateway is a separate deployment.
