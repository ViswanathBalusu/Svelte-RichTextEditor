# Unit-cost sheet for the document service, 2026-11-06

**Status:** research note, 2026-11-06, written for story SPK-025; not reviewed by the project owner.

06 §10 asks for a sheet that estimates what it costs to run the document service, so that pricing, quotas and the choice between hosted and self-hosted (SPK-008) rest on numbers. This is that sheet, for the hosted mode on one cloud.

## 1. How to read it

- **Cloud and prices.** Microsoft Azure, region West Europe (`westeurope`). List prices in US dollars, pay-as-you-go, excluding tax, read on 2026-11-06 from Azure's public Retail Prices API. Azure was chosen because its price list can be queried and re-read exactly (section 9), and because 01 §7 already names Azure Blob as a storage adapter. Nothing in the design depends on one provider (01 §9); to cost another cloud, replace section 2.
- **Measured or assumed.** Every input is marked:
  - *Measured* means read from a primary source on 2026-11-06. Only prices qualify, because no code exists yet (PRODUCT.md, Evidence on hand).
  - *Assumed* means an estimate, a spec target or a spec rule; each names the story that will measure or enforce it.
- **Units.** GB is 10⁹ bytes in the arithmetic; using GiB instead changes no result by more than 7.4 %. A month is 730 hours, Azure's own convention. Where document size matters, the document has 20 pages.
- **Marginal and fixed.** Sections 4.1 to 4.5 give marginal unit costs at full use of what is provisioned. Section 5 gives the fixed floor that a small deployment pays regardless.
- **Re-running.** Every result in section 4 is a formula over the inputs of sections 2 and 3. Change an input and recompute; section 9 lists the formulas and the price queries.

## 2. Prices (measured, 2026-11-06)

| ID | Item | Price |
|---|---|---|
| P1 | Virtual machine D4as v6 (4 vCPU, 16 GiB), Linux, pay-as-you-go | $0.22 per hour, so $0.055 per vCPU-hour and $0.0000153 per vCPU-second |
| P2 | The same machine reserved | 1 year: $1,135, or $0.130 per hour (41 % less). 3 years: $2,193, or $0.0834 per hour (62 % less) |
| P3 | Azure Database for PostgreSQL Flexible Server, General Purpose Ddsv5 | $0.106 per vCore-hour; 4 vCores cost $0.424 per hour. With high availability the standby "is billed at the same rate as the primary server" (Azure reliability guide), so ×2 |
| P4 | PostgreSQL storage (Premium SSD) | $0.1369 per GB-month. Taken ×2 with high availability, since the standby has the primary's storage configuration; how the invoice splits it was not verified |
| P5 | PostgreSQL backup storage | Free up to 100 % of provisioned storage; above that $0.103 per GB-month |
| P6 | Blob storage, first 50 TB | Hot LRS $0.0196; Hot GRS $0.0392; Cool GRS $0.02; Cold GRS $0.0081 per GB-month |
| P7 | Blob operations | Writes: Hot LRS $0.054 and Hot GRS $0.108 per 10,000. Reads: Hot $0.0043 per 10,000 |
| P8 | Geo-replication data transfer for GRS | $0.02 per GB written |
| P9 | Internet egress, Microsoft network routing | First 100 GB a month free, then $0.087 per GB up to about 10 TB a month |
| P10 | Key Vault Premium | HSM-protected RSA 2048-bit key: $1 per key-month and $0.03 per 10,000 operations. Advanced keys (RSA 3072 or 4096, elliptic curve): $5 per key-month for the first 250, and $0.15 per 10,000 operations |
| P11 | Azure Kubernetes Service, Standard tier | $0.10 per cluster-hour |
| P12 | Log Analytics ingestion (reference only) | $2.99 per GB after 5 GB a month |

## 3. Product inputs (all assumed)

| ID | Input | Value used (range) | Basis | Measured or enforced by |
|---|---|---|---|---|
| A1 | Open documents per room-host node | 500 | Stage 1 target (06 §6) | FND-009 |
| A2 | Memory per open document | 20 MiB (5 to 100) | Unmeasured (06 §10, §16) | BE-084 |
| A3 | Memory available to rooms on a 16 GiB node | 12 GiB | Leaves room for the runtime, worker threads and the system | BE-084, FND-009 |
| A4 | Commits per open-document hour | 1,000 typical; 100 light; 10,000 heavy | "A busy typist produces a few commits a second" (06 §10) | SYN-038, BE-085 |
| A5 | CPU per commit on the room's event loop | 1 ms | "Well under a millisecond" for the authority (04 §12), plus serialisation and broadcast | SYN-040 |
| A6 | Event-loop CPU available per hour | 1,800 s (one loop at 50 %) | Stage 1 is one process; the authority cannot be pre-empted (06 §1, SYN-039) | FND-009 |
| A7 | Commits PostgreSQL absorbs per second on 4 vCores at 50 % CPU | 2,000 | Group commit (06 §2.3) | FND-009, SYN-040 |
| A8 | Connections per open document; bytes per acknowledgement and per broadcast | 2; 150 B; 500 B | | BE-086 |
| A9 | Bytes per commit in PostgreSQL | Metadata row with indexes 330, scope row 60, payload 200: 590 B for 30 days, then 390 B for the life of the document; payloads then 60 B each in cold segments | Schema of 06 §4.1; payloads move after 30 days (08 §11) | SYN-038, HIS-029, BE-085 |
| A10 | Checkpoints | 70 KB compressed per checkpoint (document and side file, 2 objects); 6 per active hour; all kept 30 days, then daily, then weekly | 06 §2.2 rule; 08 §11 thinning | BE-020, BE-085 |
| A11 | Bucket versioning overhead | +10 % | Buckets use versioning (06 §4.2) | BE-085 |
| A12 | Assets | 500 KB average object; each stored GB read twice a month by browsers | | BE-085 |
| A13 | Preview compile CPU, 20 pages, draft tagging, one pass | 4 vCPU-s | About 1.4 s for one page before tagging, tagging about three times slower (09 §8); previews use draft tagging and one pass (EXP-062). Measured by spike S4 on 2026-11-06 (report §4.4): one pass of the 22-page `s4-20p` took 5.4 s with draft tagging and 3.8 s with `tagging=off`, which keeps the final breaks and is what previews now use (ADR 0045). Medians of three runs of `node services/export-worker/scripts/measure.ts`, wall time in the Podman sandbox with one CPU per job on the development desktop (Intel Core i9-10900KF), so an upper bound of CPU time. The value used stays until section 9 is re-run | SPK-017, EXP-062 |
| A14 | Final compile CPU, 20 pages, tagging on, until references converge | 18 vCPU-s (three passes of 6 s) | 09 §8. Measured on 2026-11-06, wall time in the Podman sandbox with one CPU per job on the development desktop, medians of three runs of `measure.ts`: S4's `s4-20p` (22 pages) converged in three tagged passes of 6.85, 6.35 and 6.94 s, 20.1 s in all (S4 report §4.4); the shared corpus's `pages-20` (19 pages, corpus version 2) took 16.00, 14.42 and 19.63 s while other work ran on the same machine (ADR 0045). The value used stays until section 9 is re-run | SPK-017, EXP-060 |
| A15 | Overhead per compile job: sandbox start, conversion, upload | 1 vCPU-s | Measured by spike S4 on 2026-11-06 (report §4.4): 1.1 to 2.1 s of wall time per job outside the passes (median about 1.25 s) for container start, bundle transfer, the names-database copy and the output tar, on the WSL machine route of the development desktop; conversion at most 70 ms for 99 pages; upload not measured; not split into CPU time and waiting | SPK-017 |
| A16 | Compile pool utilisation, including the warm floor (09 §9.5) | 50 % | | EXP-060, BE-085 |
| A17 | Jobs per worker node | 4 (one vCPU and 1.5 GiB each) | Job limits (09 §8, §9.3) | SPK-017 |
| A18 | Preview compiles per hour while a preview is visible and someone edits | 120 (one per 30 s); at most 360 | At most one per document per ten seconds, skipped when the bundle is unchanged (06 §10) | EXP-006, EXP-008, BE-051, BE-085 |
| A19 | Share of open-document time with a view that needs previews visible | 25 % | | EXP-008, BE-085 |
| A20 | Output sizes | Preview PDF 0.3 MB; final PDF 1 MB; evidence bundle 0.5 MB | Measured by spike S4 on 2026-11-06 (report §4.4), PDFs from the Podman sandbox: with tagging on 68 KiB (1 page), 204 KiB (22 pages) and 669 KiB (99 pages); with `tagging=off`, as previews compile, 56, 136 and 393 KiB. The shared corpus (version 2) gave 277,174 bytes for `pages-20` and 678,779 bytes for `pages-100` with tagging on (`measure.ts`, ADR 0045). The evidence bundle was not measured | SPK-017, FRW-055 |
| A21 | Price of one RFC 3161 time-stamp | $0 to $0.10; depends on the authority and contract; not verified | | SPK-021 |
| A22 | Sealing work | 0.2 vCPU-s of signing service and one key operation per seal | | SPK-021, FRW-053 |
| A23 | Admission-control cap per connection | 50 ms of CPU per second | The spec gives no value (SYN-037 notes) | SYN-037, SYN-038 |
| A24 | Retention of outputs | Previews cached one day (Hot LRS); final PDFs kept on Hot GRS; sealed PDFs and evidence on Cool GRS, write-once | 06 §4.2 | EXP-006, FRW-054 |

## 4. Unit costs

### 4.1 Per open document hour

Formulas:

- rooms per node N = min(A1, A3 ÷ A2, A6 ÷ (A4 × A5))
- room share = P1 ÷ N
- database share = A4 × (P3 × 4 vCores × 2) ÷ (A7 × 3,600), which is $0.000000118 per commit
- socket egress = A4 × (150 B + (2 − 1) × 500 B) ÷ 10⁹ × P9
- checkpoint writes = 6 checkpoints × 2 objects × P7 Hot GRS write ÷ 10,000

| | Light (100 commits) | Typical (1,000) | Heavy (10,000) |
|---|---|---|---|
| N = min(500, 614, A6 ÷ (A4 × A5)) | min(500, 614, 18,000) = 500 | min(500, 614, 1,800) = 500 | min(500, 614, 180) = 180: the event loop binds |
| Room share | $0.00044 | $0.00044 | $0.00122 |
| Database share | $0.000012 | $0.000118 | $0.00118 |
| Socket egress | $0.000006 | $0.000057 | $0.00057 |
| Checkpoint writes | $0.00013 | $0.00013 | $0.00013 |
| **Total without previews** | **$0.00059** | **$0.00074** | **$0.0031** |

Preview compiles are added only for the time someone looks at a view that needs them (section 4.4). At A19 (visible 25 % of the time) and A18 (120 an hour while visible), they add 0.25 × 120 × $0.000196 = **$0.0059** to an editing hour, eight times everything else.

The admission-control cap (A23) bounds the worst case. Two connections spending their whole budget use 2 × 0.05 × 3,600 = 360 vCPU-s an hour, which costs $0.0055, and only 1,800 ÷ 360 = 5 such documents fit on one event loop. A per-connection cap at that level does not protect a shared process by itself; the per-tenant budget has to (SYN-037, SYN-038).

### 4.2 Per stored commit

| Part | Formula | Cost |
|---|---|---|
| Once, when written | database share + A5 × vCPU-second price = $0.000000118 + 0.001 × $0.0000153 | $0.000000133 |
| Each month of the first 30 days | 590 B ÷ 10⁹ × P4 × 2 | $0.000000162 |
| Each later month | 390 B ÷ 10⁹ × P4 × 2 + 60 B ÷ 10⁹ × Cold GRS | $0.000000107 |

So a million commits cost about $0.13 to write, $0.16 for their first month and $0.11 a month after that: about $4.05 over three years. Commit metadata stays in PostgreSQL for the life of the document (06 §4.1), and PostgreSQL storage with high availability costs $0.2738 per GB-month, seven times Hot GRS blob storage. Provisioned storage is billed whether used or not.

The commit log's volume follows from A4 and A9. A typical open-document hour adds 0.59 MB for 30 days and 0.39 MB for good. At full stage 1 use (section 5), that is about 52 GB of hot rows a month and 34 GB of permanent rows a month. After a year, about 410 GB of metadata costs about $113 a month with high availability.

### 4.3 Per gigabyte-month of checkpoints and assets

| Part | Formula | Cost |
|---|---|---|
| Stored, Hot GRS with versioning | P6 Hot GRS × 1.1 | $0.0431 per GB-month |
| Written, checkpoints (70 KB objects) | 10⁹ ÷ 70,000 objects × P7 GRS write ÷ 10,000, plus P8 | $0.154 + $0.02 = $0.174 per GB written |
| Written, assets (500 KB objects) | 10⁹ ÷ 500,000 objects × P7 GRS write ÷ 10,000, plus P8 | $0.0216 + $0.02 = $0.042 per GB written |
| Read by browsers | P9 | $0.087 per GB read, after the free 100 GB a month |
| Cold log segments | P6 Cold GRS | $0.0081 per GB-month. Azure's minimum storage periods for the Cool and Cold tiers apply; not checked for this sheet |

Examples:

- **Checkpoints.** Each is kept about one month before thinning (08 §11), so a stored GB costs $0.0431 + $0.174 = **$0.217** for its month. One document edited two hours a day for 30 days writes 6 × 70 KB × 60 hours = 25 MB of checkpoints, about $0.0055 for that month; after thinning, about 2 MB a month remain.
- **Assets** read twice a month: $0.0431 + 2 × $0.087 = **$0.217** per GB-month, plus $0.042 once per GB uploaded. Egress, not storage, dominates.

### 4.4 Per preview compile

| Part | Formula | Cost |
|---|---|---|
| Compute | (A13 + A15) × vCPU-second price ÷ A16 = 5 × $0.0000153 ÷ 0.5 | $0.000153 |
| Object writes and the viewer's read | 3 × P7 Hot LRS write ÷ 10,000 + P7 read ÷ 10,000 | $0.000017 |
| Storage for a day | 0.3 MB ÷ 10⁹ × P6 Hot LRS ÷ 30 | $0.0000002 |
| Egress to the viewer | 0.3 MB ÷ 10⁹ × P9 | $0.000026 |
| **Per preview compile (20 pages)** | | **$0.000196** |

Previews are costed only while someone is looking at a view that needs them (09 §9.1; 06 §10):

| Situation | Compiles | Cost per hour |
|---|---|---|
| Nobody is looking at a view that needs previews | none | $0 |
| Someone is looking, and nothing changed (bundle hash unchanged) | none (EXP-006) | $0 |
| Someone is looking while the document is edited | 120 (A18) | $0.0235 |
| The same, at the rule's ceiling of one per ten seconds | 360 | $0.0705 |

### 4.5 Per final export

| Export | Formula | Cost |
|---|---|---|
| Final PDF, not sealed | (A14 + A15) × vCPU-second price ÷ A16 = $0.000581; plus 3 Hot GRS writes ($0.000032) and a 1 MB download ($0.000087) | **$0.00070** once, then $0.000039 a month while kept |
| Sealed final PDF at workflow completion | The above, plus a second independent compile (EXP-079, $0.000581), signing CPU ($0.000006), one key operation ($0.000003), two more writes ($0.000022) and the evidence download ($0.000044) | **$0.00135** once without a time-stamp fee; up to **$0.101** with a $0.10 time-stamp (A21); then $0.00003 a month on Cool GRS |
| Fixed, per sealing party | P10 | $1 per key-month, or $5 for an advanced key. Per tenant if each tenant is the sealing party (SPK-011) |

A compile minute costs 60 × $0.0000153 ÷ 0.5 = **$0.0018** at A16. That is the natural unit for a tenant's monthly budget of compile minutes (EXP-009).

## 5. The fixed floor

Stage 1, hosted, one region, at list prices:

| Item | Formula | Per month |
|---|---|---|
| One room-host node | $0.22 × 730 | $160.60 |
| PostgreSQL, 4 vCores, high availability | 2 × 4 × $0.106 × 730 | $619.04 |
| PostgreSQL storage, 128 GB, high availability | 128 × $0.1369 × 2 | $35.05 |
| Compile workers, warm floor of two nodes | 2 × $0.22 × 730 | $321.20 |
| Kubernetes control plane, Standard tier | $0.10 × 730 | $73.00 |
| One sealing key | $1 | $1.00 |
| **Total** | | **about $1,210** |

At full stage 1 use, 500 open documents for 8 hours on 22 working days, a month has 88,000 open-document hours. The floor is then $1,210 ÷ 88,000 = **$0.0137** per open-document hour, about 18 times the marginal cost of a typical hour without previews (section 4.1). Below full use it rises in proportion. One-year reservations take 41 % off the machines.

Not priced:

- load balancer and public IP addresses, DNS;
- monitoring and logs (P12; volume unmeasured, BE-086);
- the asset worker and the indexer;
- backups above the free allowance;
- time-stamping contracts;
- support and on-call.

## 6. What dominates, and how sensitive it is

1. **Preview compiles**, while a preview is visible: about 90 % of the variable cost of an editing hour. The rule of 09 §9.1 is the largest cost control in the design, and compile seconds per preview (S4) scale this cost directly.
2. **The fixed floor** at stage 1, mainly PostgreSQL with high availability and the warm compile workers. This matters for SPK-008: a self-hosted customer carries its own floor.
3. **Commit metadata** in PostgreSQL, growing for the life of every document.
4. **Egress** for assets that are read often.
5. **Paid time-stamps**, which can cost more than everything else in a sealed export.

| If this input changes | to | the result changes to |
|---|---|---|
| A2, memory per open document | 100 MiB | N = min(500, 122, 1,800) = 122; room share $0.0018 an hour, four times higher |
| A13, preview CPU | 12 vCPU-s | $0.00044 per preview; $0.053 per visible editing hour |
| A14, final CPU | 60 vCPU-s | compute $0.0019 per final export |
| A16, compile pool utilisation | 25 % | every compile cost doubles |
| A7, PostgreSQL commits per second | 500 | $0.00000047 per commit; typical database share $0.00047 an hour |
| P1 | 1-year reservation (P2) for the three nodes | machine costs −41 %: 3 × $0.130 × 730 = $284 instead of $482; floor about $1,012 a month. PostgreSQL reservations were not priced for this sheet |

## 7. Inputs the review found the spec could only estimate

The first review (§6, item 5) listed four inputs the specification could only estimate. Each enters this sheet as follows.

| Input | Where it enters | Value assumed here | Story that will measure it |
|---|---|---|---|
| Compile cost with tagging | Preview and final export (4.4, 4.5); compile minutes | Preview 4 vCPU-s, final 18 vCPU-s, for 20 pages (A13, A14) | SPK-017 (S4 measures compile times with tagging on, including second and third passes); EXP-060; EXP-062 |
| Memory per open document | Rooms per node and the open-document hour (4.1) | 20 MiB (A2) | BE-084 |
| Log volume (the commit log) | The stored commit and PostgreSQL storage (4.2) | 1,000 commits per open-document hour; 590 B, then 390 B per commit (A4, A9) | SYN-038 (commits per minute and bytes of log from editing traces); HIS-029 (cold segments); BE-085 (per-tenant counters) |
| Admission-control budgets | The worst case of 4.1 and rooms per event loop | 50 ms of CPU per second per connection (A23) | SYN-037 (mechanism), SYN-038 (calibrated budgets), SYN-040 (CPU per commit) |

## 8. Use for pricing, quotas and the deployment decision

- **Both modes.** The units are the same hosted and self-hosted. Self-hosted, the customer pays the floor and the unit costs at its own prices, and the vendor's cost becomes releases and support (SPK-008).
- **Quotas.** The per-tenant quotas of 06 §12 map onto these units: commit rate onto stored commits, export minutes onto compile vCPU-seconds, storage onto GB-months, open documents onto room share. BE-085 meters them; BE-091 and BE-092 enforce them.
- **Re-pricing.** Once FND-009, BE-084, SYN-038 and SPK-017 report, replace A1, A2, A4, A7, A9, A13 and A14 with their measurements and re-run section 9.

## 9. How to re-run

**Prices.** Each price comes from `https://prices.azure.com/api/retail/prices?currencyCode='USD'&$filter=<filter>`, taking the Linux, non-Spot, consumption row where several appear:

| Price | Filter |
|---|---|
| P1 | `serviceName eq 'Virtual Machines' and armRegionName eq 'westeurope' and armSkuName eq 'Standard_D4as_v6' and priceType eq 'Consumption'` |
| P2 | the same with `priceType eq 'Reservation'` |
| P3 to P5 | `serviceName eq 'Azure Database for PostgreSQL' and armRegionName eq 'westeurope'`, rows "Flexible Server General Purpose Ddsv5 Series Compute", "Flex Server Storage" and "Flexible Server Backup Storage" |
| P6, P7 | `serviceName eq 'Storage' and armRegionName eq 'westeurope' and productName eq 'General Block Blob v2'` |
| P8 | `armRegionName eq 'westeurope' and contains(meterName,'Geo-Replication')`, row "Geo-Replication v2 Data Transfer" |
| P9 | `serviceName eq 'Bandwidth' and armRegionName eq 'westeurope'`, rows "Rtn Preference: MGN" |
| P10 | `serviceName eq 'Key Vault' and armRegionName eq 'westeurope'` |
| P11 | `serviceName eq 'Azure Kubernetes Service' and armRegionName eq 'westeurope'`, row "Standard Uptime SLA" |
| P12 | `serviceName eq 'Log Analytics' and armRegionName eq 'westeurope'` |

**Formulas**, with s the price of a vCPU-second (P1 ÷ 4 ÷ 3,600):

```
open document hour   = P1 / min(A1, A3/A2, A6/(A4*A5))
                     + A4 * (P3*4*2) / (A7*3600)
                     + A4 * (150 + 500*(connections-1)) / 1e9 * P9      (A8)
                     + 6 * 2 * P7_hot_grs_write / 1e4
                     + A19 * A18 * preview
stored commit        = once: (P3*4*2)/(A7*3600) + A5*s
                       per month: bytes/1e9 * P4 * 2   (590 B first month, 390 B after)
checkpoint GB-month  = P6_hot_grs*1.1 + (1e9/70e3) * P7_hot_grs_write/1e4 + P8
asset GB-month       = P6_hot_grs*1.1 + reads * P9        (+ once per GB: (1e9/500e3) * P7_hot_grs_write/1e4 + P8)
preview              = (A13 + A15) * s / A16 + 3*P7_hot_lrs_write/1e4 + P7_read/1e4
                     + 0.3e6/1e9 * P6_hot_lrs/30 + 0.3e6/1e9 * P9
final                = (A14 + A15) * s / A16 + 3*P7_hot_grs_write/1e4 + 1e6/1e9 * P9
sealed               = final + (A14 + A15) * s / A16 + 0.2 * s / A16 + P10_ops/1e4
                     + 2*P7_hot_grs_write/1e4 + 0.5e6/1e9 * P9 + A21
```

## 10. Criteria of SPK-025

| Criterion | Where it is met |
|---|---|
| Estimates the cost per open document hour, per stored commit, per gigabyte-month of checkpoints and assets, per preview compile and per final export (06 §10) | Sections 4.1, 4.2, 4.3, 4.4 and 4.5, with the arithmetic shown; section 5 adds the fixed floor that the unit costs leave out |
| Every input is marked as measured or assumed; assumptions name the story that will measure them | Section 2 (prices, measured on 2026-11-06) and section 3 (every product input assumed, each with its story). No product input is measured, because no code exists yet |
| Lists the inputs the review found the spec could only estimate: compile cost with tagging, memory per open document, log volume and admission-control budgets (review §6) | Section 7, with where each enters the sheet and which story measures it |
| Preview compiles are costed only while someone is looking at a view that needs them (09 §9.1) | Section 4.4 costs previews per visible hour and as zero otherwise; section 4.1 adds them only for the visible share of an editing hour (A19) |

## Sources

All consulted on 2026-11-06.

- Azure Retail Prices API: https://prices.azure.com/api/retail/prices, with the filters of section 9.
- Azure Database for PostgreSQL, reliability guide (cost of high availability; page updated 2026-09-30): https://learn.microsoft.com/en-us/azure/reliability/reliability-database-postgresql
- Azure Database for PostgreSQL, backup and restore (free backup storage up to 100 % of provisioned storage): https://learn.microsoft.com/en-us/azure/postgresql/backup-restore/concepts-backup-restore
- Dasv6 sizes (D4as v6: 4 vCPU, 16 GiB; nested virtualisation supported): https://learn.microsoft.com/en-us/azure/virtual-machines/sizes/general-purpose/dasv6-series
- The specification: 00 §9; 01 §7, §9; 04 §12; 06 §1, §2, §4, §6, §10, §12, §16; 08 §11; 09 §8, §9; the pitfall review of 2026-09-18, §6 and finding PD-6.
- Stories named as measuring an input: FND-009, BE-020, BE-051, BE-084, BE-085, BE-086, BE-091, BE-092, SYN-037, SYN-038, SYN-039, SYN-040, HIS-029, SPK-011, SPK-017, SPK-021, EXP-006, EXP-008, EXP-009, EXP-060, EXP-062, EXP-079, FRW-053, FRW-054, FRW-055.
