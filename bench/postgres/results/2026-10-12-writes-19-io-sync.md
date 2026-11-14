## Writes from identical snapshots: 17.11 vs 19beta4

Every run starts from the same database (recreated from one template, checkpointed, touched tables prewarmed) and runs the same seeded transactions: 8 clients, seed 42, 3 rounds alternating which server goes first.

### `listing_writes`: 16,000 transactions per run, end state identical everywhere: yes

| measure | 17 rounds | 19 rounds | 19 vs 17 |
| --- | --- | --- | --- |
| tps | 565, 515, 524 | 668, 675, 637 | **+27.6% better** |
| p50 ms | 2.20, 2.22, 2.26 | 2.22, 2.15, 2.29 | -0.0% inconclusive |
| p95 ms | 83.47, 87.00, 88.48 | 63.92, 66.47, 69.88 | **-23.6% better** |
| p99 ms | 191.18, 208.46, 203.58 | 161.48, 154.46, 163.71 | **-20.7% better** |
| server CPU ms/tx | 3.579, 3.819, 3.789 | 3.170, 3.178, 3.314 | **-16.1% better** |
| WAL bytes/tx | 7,329, 7,328, 7,326 | 7,326, 7,332, 7,324 | -0.0% inconclusive |
| table growth MB | 9.25, 9.24, 9.27 | 9.20, 9.21, 9.27 | – |
| index growth MB | 24.45, 24.56, 24.43 | 24.53, 24.51, 24.37 | – |
| dead tuples after | 20,564, 20,584, 20,705 | 20,616, 20,719, 20,714 | – |
| autovacuum runs | 1, 0, 1 | 0, 1, 1 | – |
| checkpoints | 0, 0, 0 | 0, 0, 0 | – |

Failed transactions: 0. End state: `{"bench_listings": "107225 214545967.1000000000000000", "daily_stats": "57816 0 0 307225 507542", "events": "listed=107225 updated=107225"}`

### `book_upsert`: 200,000 transactions per run, end state identical everywhere: yes

| measure | 17 rounds | 19 rounds | 19 vs 17 |
| --- | --- | --- | --- |
| tps | 8,074, 8,296, 8,363 | 7,982, 8,179, 8,054 | -2.9% inconclusive |
| p50 ms | 0.90, 0.87, 0.86 | 0.91, 0.89, 0.90 | +2.6% inconclusive |
| p95 ms | 1.62, 1.61, 1.60 | 1.65, 1.62, 1.62 | +0.9% inconclusive |
| p99 ms | 2.50, 2.42, 2.42 | 2.38, 2.47, 2.46 | +1.7% inconclusive |
| server CPU ms/tx | 0.269, 0.261, 0.262 | 0.265, 0.262, 0.261 | -0.2% inconclusive |
| WAL bytes/tx | 3,549, 3,549, 3,549 | 3,549, 3,549, 3,549 | +0.0% inconclusive |
| table growth MB | 9.76, 9.73, 9.77 | 9.75, 9.75, 9.76 | – |
| index growth MB | 58.73, 58.72, 58.73 | 58.72, 58.73, 58.72 | – |
| dead tuples after | 200,000, 200,000, 200,000 | 200,000, 200,000, 200,000 | – |
| autovacuum runs | 0, 0, 0 | 0, 0, 0 | – |
| checkpoints | 0, 0, 0 | 0, 0, 0 | – |

Failed transactions: 0. End state: `{"book": "1500000 054a7b2a17eacd93c77dedc9e50eb954"}`

