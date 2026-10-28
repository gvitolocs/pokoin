# Storage: Intel Optane vs the Crucial NVMe on nezopt (2026-10-28)

Question from the owner: do real Pokoin operations run faster from the Intel Optane drive or from the NVMe we use today?
Outcome: the Optane is now nezopt's **only swap** (owner decision, 2026-10-28). Pokoin's data stays on the Crucial NVMe.

## Hardware

| | nezopt system drive | Optane |
|---|---|---|
| Model | Crucial P310 2 TB (CT2000P310SSD8), DRAM-less | Intel Optane Memory M10 16 GB (MEMPEK1J016GAL, serial PHBT813101MY016N) |
| Attachment | M.2, PCIe 4.0 x4 | first: USB, Realtek RTL9210C enclosure; now: board's second M.2 slot, PCIe 3.0 x2 (`nvme1n1`) |
| Health (SMART) | 2% used, 0 media errors | 2% used, 100% spare, 0 media errors, 1,829 h, 133 unsafe shutdowns (earlier life) |

The "Samsung NVMe" in the original question is the Samsung 990 PRO 1 TB on **pi-home**, in a USB enclosure. nezopt's own NVMe is the Crucial.

Over USB the Optane only ever linked at **USB 2.0 (480 Mb/s, Bulk-Only, no UAS)**: on nezopt's port 1-3, behind a Genesys USB 2.1 hub on the Pi, and directly in a Pi port.
The Samsung's identical-chip enclosure reached 5 Gbps on the Pi, so the Optane's cable or connector is the likely culprit.
The Pi also forces Bulk-Only on every RTL9210 (`usb-storage.quirks=0bda:9210:u` in `cmdline.txt`).

## Where Pokoin data lives (unchanged)

| Data | Location | Size |
|---|---|---|
| Marketplace primary Postgres (`pokoin-marketplace-postgres-15t`, all game DBs; also the target of the Oracle CardTrader dump tunnel 15543→25433) | nezopt Crucial, `~/data/pokoin-marketplace-postgres-t2` | 24 GB on disk (`pokoin_marketplace` 20 GB); WAL ≈ 35 GB/day (249 GB written 2026-10-21→28) |
| `cardrails-postgres` | nezopt Crucial | 269 MB |
| `tcgprices-postgres-15t` | MyBook HDD (`~/mnt/mybook/tcgprices`) | 21 GB |
| Catalog refresh runs (`~/data/pokoin-catalog-refresh`) | nezopt Crucial | 14 GB; one day's 3,409 listing books = 200 MB |
| Scanner index `cdn_milo` + MILO/YOLO weights (`nezopt-cardscan`) | nezopt Crucial | 47 MB + 11 MB |
| price_book output (`~/data/cardrails-prices`) | nezopt Crucial | ~12 MB per game file |
| k3s (`~/pokoin-overflow`), CDN leftovers (`~/data/pokoin-leftovers`) | nezopt Crucial | 1.9 GB, 95 GB |
| Marketplace replica, pokoin-scan, redis, CDN images, Rust API | pi-home, Samsung 990 PRO (USB) | replica 20 GB |

## Method

- Everything ran on nezopt over SSH, against copies, never against live data in place.
  - The DB copy: a `pg_dump` of `pokoin_marketplace` (read-only transaction), restored into throwaway Postgres 17 containers (`optbench-*`).
  - What the copy left out: the two history tables were copied as schema only. They are 15 GB together, more than the Optane holds.
  - What the copy did include: a one-in-five sample of `cardtrader_market_listing_snapshots` (600,494 rows). The copy is 4.4 GB.
- Postgres settings matched the live server: `shared_buffers=256MB`, `synchronous_commit=on`, `max_wal_size=1GB`.
- Caches: there is no global `drop_caches` on a shared host. Before every run, each copy's files were flushed and dropped from the page cache (`dd iflag=nocache`), and every run used a fresh container. fio used `O_DIRECT`.
- Query mix:
  - The API reads were sampled from `pg_stat_activity` on the Pi replica and the nezopt primary: card URLs, cheapest-ask cache, card JSON, page snapshots, sold history, set neighbours.
  - The ingest has the shape of `refresh_cardtrader_market_listing_snapshots`: one transaction per 100 blueprints that reprices and requantifies listings, inserts new ones and deletes vanished ones.
  - The "small commits" test is per-blueprint updates plus the API's outbox claim and card event.
- Repeats: 3 runs per case, interleaved; the tables give medians.
- Heat: every step waited for Tctl < 90 °C. nezopt sat at 86–95 °C from other sessions' builds, so expect some noise.

## Results

### Phase 1: Optane over USB 2.0 vs Crucial (all workloads)

| Workload | Crucial P310 | Optane, USB 2.0 | WAL only on Optane |
|---|---|---|---|
| fio 4k random read, QD1 | 13,290 IOPS, p50 58 µs | 5,014 IOPS, 175 µs | |
| fio 4k random write, QD1 | 32,552 IOPS, 12 µs | 4,946 IOPS, 181 µs | |
| fio 8 KiB write + fdatasync (WAL pattern) | 319/s, sync p50 1.9 ms, p95 6.7 ms | **2,345/s**, sync p50 0.27 ms, p95 1.35 ms | |
| fio 128k sequential read / write, QD16 | 3,978 / 319 MB/s | 37 / 37 MB/s | |
| Postgres cold API reads (4 clients) | 81 tx/s | 67 tx/s | 84 tx/s |
| Postgres warm API reads | 77 tx/s | 74 tx/s | 86 tx/s |
| Postgres CardTrader ingest, 100 blueprints/tx | 4.8 tx/s (p50 0.48 s) | 0.6 tx/s | 0.8 tx/s |
| Postgres small commits, 8 clients | 214 tx/s (range 103–228) | 30 tx/s | 98 tx/s |
| Cold read of the 3,409 listing books (200 MB) | 0.69 s | 5.4 s | |
| `ctbook decode` of all books (4 parallel) | 122 s | 95 s (CPU-bound, noise) | |
| Scanner cold start (index + models on the drive) | 2.45 s | 3.56 s | |
| Scanner per-scan latency, 30 real photos × 3 | p50 0.28 s | p50 0.29 s | |
| price_book nightly, Pokémon | 26.0 s | 28.4 s (identical output) | |

What this phase shows:
- **API reads** are CPU-bound once loaded: cold and warm are within noise.
- **The ingest** is bound by how many MB of WAL and data pages it writes, not by fsync count. USB 2.0's 37 MB/s throttles it.
- **Small commits:** with 8 clients, group commit (one flush covering several concurrent commits) hides the P310's slow fsync.
- **Scanner and price_book** are CPU work; the drive barely matters.

### Phase 2: Optane in the M.2 slot (PCIe 3.0 x2)

| fio, median of 3 | Optane M10, M.2 | Crucial P310 (phase 1, normal load) |
|---|---|---|
| 4k random read, QD1 | **55,051 IOPS, p50 12 µs** | 13,290 IOPS, 58 µs |
| 4k random write, QD1 | 18,188 IOPS, 38 µs | 32,552 IOPS, 12 µs (lands in its write cache) |
| 8 KiB write + fdatasync | **11,778/s, sync p50 66 µs, p95 79 µs** | 319/s, 1.9 ms / 6.7 ms |
| 128k sequential read / write | 875 / 169 MB/s | 3,978 / 319 MB/s |

Two limits on this phase:
- **No usable NVMe numbers.** The NVMe fio run in this phase ran minutes after a reboot, under heavy load with 7.8 GB in swap on that drive. It stopped after 2 of 3 runs, so it isn't used: the comparison above uses phase 1's NVMe numbers.
- **No Postgres or file workloads on M.2.** Those rounds were stopped when the owner chose to give the whole drive to swap.

### Phase 3: swap, same 4 GB swap file on each drive

The test was a 3 GiB Rust program (`swapbench`) in a scope capped at 768 MB, so about 2.3 GB had to go to swap. The test swap file was the only one at top priority. Medians of 3 runs:

| | Crucial P310 | Optane M10, M.2 |
|---|---|---|
| Random swap-in (4k pages touched back) | 1,802 pages/s | **28,440 pages/s (16×)** |
| Swap-in latency p50 / p95 / p99 | 71 µs / 3.65 ms / 7.5 ms | **19 µs / 31 µs / 179 µs** |
| Swapping every page back in order | 44 MB/s | 124 MB/s |
| Swap-out while filling memory | 249 MB/s | 207 MB/s |

nezopt really does use its swap: it wrote ~9 GB to swap in the first 23 minutes after the 12:47 reboot, while 42 GB sat in page cache.

## Decision and what was done

**The Optane is nezopt's only swap** (owner decision; done 2026-10-28 ~13:35 UTC):
- `nvme1n1p1` (13.4 GiB, partition type Linux swap, label `optane-swap`, UUID `01f58561-0c62-4e63-a468-2e0476b05598`).
- fstab: `UUID=01f58561-… none swap sw,pri=100,nofail,x-systemd.device-timeout=10s 0 0`. `nofail` and the 10 s timeout keep a missing Optane from blocking boot.
- `/swap.img` and `/swapfile2` (8 GB each on the Crucial) were turned off (7.6 GB went back to RAM in 46 s). They are commented out in fstab and deleted, which freed 16 GB on `/`.
- Backup: `/etc/fstab.bak-20261028-optane-swap`.

**Pokoin data stays on the Crucial.** Reasons:
- The 24 GB primary doesn't fit on 13.4 GB.
- Moving only the WAL would make the primary depend on a second, non-redundant, second-hand drive: if it died, commits since the last checkpoint would be lost.
- The real ingest is write-bandwidth-bound, not fsync-bound (phase 1).
- The Optane's fsync advantage (37×) is real but unmeasured inside Postgres on M.2. It would matter for single-client, commit-heavy work.

### Risks and rollback

- **If the Optane fails:** processes whose pages are in swap crash; a reboot recovers. With `nofail`, a missing Optane boots with no swap at all.
- **Less swap:** 13.4 GB instead of 16 GB. The most seen in use today was 7.8 GB.
- **Rollback:**

  ```
  sudo fallocate -l 8G /swap.img && sudo chmod 600 /swap.img && sudo mkswap /swap.img && sudo swapon /swap.img
  ```

  then restore the fstab line from the backup.

## Incident: pi-home power loss (2026-10-28 ~12:05 and ~12:11 CET)

- **What happened:** with the Optane enclosure plugged into the Pi 4 next to the Samsung root disk, the Pi browned out twice. There were hard reboots, XFS log recovery on `/srv/pokoin`, and `throttled=0x50005`.
- **Recovery:** services came back each time (API 200, replica healthy, lag < 1 s).
- **Lesson:** the Pi 4's USB ports share about 1.2 A, which can't power a second NVMe enclosure. Never hang a second drive off it without a powered hub.
- **Open:** at last check the Samsung root disk was on the Genesys USB 2.0 hub (480 Mb/s), not on a blue port. Moving it back needs a clean shutdown.

## Follow-ups

- **Unexplained swapping:** a 61 GB host with 40+ GB of page cache swapping out 9 GB points at per-cgroup memory limits (`MemoryHigh`/`--memory`) forcing their own swap. Faster swap hides it; find the limits.
- **Optane cable:** if the Optane ever goes back on USB, use a known USB 3 cable and check for `uas` and SuperSpeed.

Scripts and raw results: nezopt `~/scratch/optane-bench/` (`results-usb2/`, `results/`, `results-swap/`, `summary-usb2.txt`, `swapbench/`).
