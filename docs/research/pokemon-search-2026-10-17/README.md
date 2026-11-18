# Pokémon card search demand and landing decisions

Checked 17 October 2026. These are public third-party estimates and observed Google suggestions, not Pokoin Search Console data or measured ChatGPT prompts.

## Measured keyword estimates

Semrush’s public domain reports display the following keyword volumes in their **September 2026** snapshot. Volume means an estimated average monthly Google search count over the preceding 12 months, in the specified country—not searches occurring only in September. These rows are a small sample from ranking domains, not a complete market study. Do not add overlapping variants or combine countries into a total.

| Query | Country | Estimated monthly searches | Public report |
| --- | --- | ---: | --- |
| pokemon | US | 1,220,000 | [pokemon.com](https://www.semrush.com/website/pokemon.com/overview/) |
| pokemon cards | US | 450,000 | [pokemon.com](https://www.semrush.com/website/pokemon.com/overview/) |
| pokemon sets | US | 14,800 | [pokedata.io](https://www.semrush.com/website/pokedata.io/overview/) |
| pokemon card value | UK | 12,100 | [pokecardvalues.co.uk](https://www.semrush.com/website/pokecardvalues.co.uk/overview/) |
| pokemon card values | UK | 4,400 | [pokecardvalues.co.uk](https://www.semrush.com/website/pokecardvalues.co.uk/overview/) |
| pokemon card value checker | UK | 4,400 | [pokecardvalues.co.uk](https://www.semrush.com/website/pokecardvalues.co.uk/overview/) |

[Semrush’s volume definition](https://www.semrush.com/kb/162-monthly-numbers). The raw transcribed rows are in `keyword-estimates.csv`; source pages can change after retrieval. We did not obtain verified volumes for scanner, tracker, trade-in, seller-fee or alternative queries. Broad Pokémon demand does not establish attainable traffic, keyword difficulty, or conversion rates for Pokoin.

## Observed tool language, without volume claims

`google-autocomplete.json` preserves responses from Google’s public suggestion endpoint, including seed, source URL and retrieval date. Requests used English and `gl=us`, but a suggestion mentioned Aarhus, so this is **not a controlled US sample**. Autocomplete can vary by location and time; position is not a popularity ranking.

| Seed | Relevant suggestions observed | Page/workflow |
| --- | --- | --- |
| pokemon card value | value checker, value scanner, value app, value lookup | `/features/pokemon-card-price-checker` |
| pokemon card scanner | scanner app, scanner free, scanner online, scanner website | `/features/card-scanner` |
| pokemon card collection | collection tracker, collection app, collection tracker app | `/features/collection-tracker` |
| sell pokemon cards | sell online, sell bulk, sell app, sell for cash | Seller inventory and selling-fee page; credit is distinct from cash |
| collectr alternative | alternative free, alternative UK, app alternative | `/alternatives/collectr` |

“Free” appeared in suggestions; this does not establish Pokoin’s pricing, so it was not added as an unverified offer. No numeric demand or AI recommendation frequency is claimed for these suggestions.

Google Trends returned HTTP 429 both in a normal browser and on its public endpoint. No Trends series, growth percentages, seasonality or relative rankings were obtained. [Google explains that Trends is normalized, sampled data](https://support.google.com/trends/answer/4365533?hl=en), not monthly search volume.

## What changed and why

Inference from this evidence: lead with scanning, collection tracking, price research and selling; make sets easy to reach. Use familiar task names alongside the Pokoin brand. Keep Poko and the extension visible without long explanations. Give value-checking intent a concise public page linked directly from the homepage.

Both [Rare Candy’s marketplace](https://rarecandy.com/) and [its app landing](https://get.rarecandy.com/) were inspected. The useful pattern is a short promise, dominant card/product visual, clear actions and compact feature entries. Pokoin keeps its existing black, yellow and blue identity, original copy and assets. No Rare Candy statistics, testimonials or app-store claims were reused.

The homepage uses four main blocks and short copy. Detailed workflows and sourced comparisons remain on their own crawlable pages. Search metadata, internal links, canonical URLs and sitemap inclusion remain intact. This improves clarity and coverage; it does not guarantee rankings or recommendations.

After release, evaluate Search Console queries, impressions, clicks and landing-page actions for each intent. Measure sign-ups, completed scans and seller activity separately from raw traffic. This research does not establish first-party baselines or install tracking.
