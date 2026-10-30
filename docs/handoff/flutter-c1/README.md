# Handoff: risposte compatte `c1` nell'app Flutter di Pokoin

> **Stato: non avviato.** Questa guida è per l'agente di codifica della collega
> (e per la collega stessa) che porta nell'app Flutter la codifica JSON compatta
> `c1` di Pokoin. L'agente esegue la guida passo per passo. La guida è
> autosufficiente: chi la legge non ha visto nessuna conversazione e può non
> sapere cosa sia `c1`.
>
> Stato dei sorgenti letti: repository `gvitolocs/pokoin` a `33eff96` (main) e
> repository `gvitolocs/cardvault` a `8a88881` (app in `pokemon_card_vault/`).
> La lettura è del 2026-10-12. Nessun SDK Flutter era disponibile nell'ambiente
> che ha scritto la guida: nulla del lato Dart è stato compilato o eseguito.
> Tutto ciò che non è stato letto o misurato è marcato **da verificare**.
>
> Convenzioni: KB = 1.024 byte salvo dove indicato. Le percentuali sono
> arrotondate. I percorsi sono relativi alla radice del repository indicato.

## Indice

1. Scopo e risultato atteso
2. Come funziona il formato
3. Verifica dell'app attuale (audit)
4. Piano di integrazione
5. Test di correttezza
6. Benchmark tra vecchia e nuova versione
7. Criteri di accettazione e consegna
8. Riferimenti

## Regole che vincolano l'agente

1. **Il formato è una sola fonte di verità**: `docs/rust-migration/COMPACT_ENCODING.md`
   (da qui in avanti "la specifica"). Dove il decoder del browser
   (`market/src/compact.js`) e il decoder Rust
   (`pokoin-rust/crates/api-common/src/compact/decode.rs`) differiscono, vale la
   specifica; le differenze note sono elencate al §2.12.
2. **Il server non cambia.** Il corpo JSON predefinito è un contratto congelato
   condiviso con il sito e con l'app. `c1` è una seconda rappresentazione, scelta
   dal client. Questa guida non richiede nessuna modifica a `pokoin-rust/`.
3. **L'agente non tocca `pokoin`.** Tutto il lavoro avviene in `cardvault`
   (cartella `pokemon_card_vault/`), su un ramo di lavoro. Il backend di
   produzione è solo Rust (`AGENTS.md` di pokoin, "Production runtime — Rust
   only"): nessuna parte di questa integrazione introduce un runtime Node.
4. **Niente push né deploy senza istruzione esplicita** della collega. La
   consegna di una build mobile segue il processo di cardvault.
5. **Questa guida non è la guida del dizionario dei nomi per la barra di
   ricerca.** Quel tema è in
   [`docs/handoff/flutter-suggest-dictionary/README.md`](../flutter-suggest-dictionary/README.md)
   (dizionario locale per il typeahead, formato PKD1, ranker in Dart). Le due
   guide si incontrano in tre punti, e solo in questi:
   - la barra di ricerca dell'app usa `POST /api/marketplace-autocomplete` e
     `POST /api/searchbar-token-predict`; nessuna delle due ha una forma `c1`
     (§3.3). `c1` non cambia nulla lì;
   - `GET /api/marketplace-suggest?format=c1` esiste ed è usata dal sito, ma
     l'app non la chiama (§3.3). Se la guida del typeahead la adotterà, il
     decoder di questa guida è già pronto a leggerla;
   - il dizionario dei codici di `c1` (§2.8) **non** è il dizionario dei nomi
     del typeahead: sono due cose diverse con lo stesso nome comune.
   Il problema F1 di quella guida (`Uri.base.resolve` che su Android e iOS
   potrebbe non puntare a `api.pokoin.com`) riguarda anche questa integrazione:
   cfr. §3.2 e il passo 0 del §4.

---

## 1. Scopo e risultato atteso

### 1.1 Cos'è `c1`

`c1` è una rappresentazione alternativa, opt-in, degli stessi corpi JSON delle
letture più grandi del catalogo. Il corpo predefinito `application/json` è fatto
di centinaia di righe quasi identiche: 42 chiavi per riga, 13 delle quali
duplicati esatti di un'altra chiave della stessa riga, 6 delle quali URL con un
prefisso lungo in comune (specifica §1). `c1` trasforma quel corpo in forma
**colonnare**: una sola volta i nomi delle chiavi, una colonna per chiave, i
valori ripetuti internati, i duplicati rappresentati come riferimenti, i numeri
ordinati come differenze, i testi frequenti come codici di un dizionario
condiviso. Il client ricostruisce **esattamente** il JSON predefinito, con lo
stesso ordine delle chiavi.

Il client chiede `c1` aggiungendo `?format=c1` (o `?format=c1v2`) all'URL. Il
server risponde con `content-type: application/json; charset=utf-8` e con
l'intestazione `x-pokoin-format`. Una route che non conosce `c1` risponde con il
JSON normale alla stessa richiesta: il client può sempre tornare indietro
(`pokoin-rust/crates/api-common/src/compact/mod.rs`).

### 1.2 Perché conta su un telefono

| Costo | Cosa cambia con `c1` |
| --- | --- |
| Byte sulla rete | Meno byte dopo la compressione, molti meno byte prima. Contano il piano dati e le reti lente. |
| Memoria | Il testo da parsare è più piccolo; gli oggetti internati sono condivisi tra righe invece di essere copiati. |
| Tempo di parsing | `jsonDecode` materializza meno chiavi e meno stringhe; poi un ciclo stretto ricostruisce le righe. Nel browser il tempo totale è uguale a `JSON.parse` del corpo normale (misura sotto). Su Dart **non è ancora misurato** (§6). |

### 1.3 Numeri misurati in produzione

Tutte le misure di questa tabella sono state fatte sul sito in produzione e
sull'API, non in questa sessione; la guida le riporta e non ne aggiunge altre
non marcate.

| Misura | JSON normale | `c1` | Nota |
| --- | --- | --- | --- |
| Intero negozio di un venditore, 9.981 inserzioni, byte grezzi | circa 8 MB | 1,35 MB (`c1v2`) | `marketplace-seller-shop?book=1&format=c1v2` |
| Stesso negozio, byte sul filo dopo compressione | — | circa 425 KB | |
| Test API con 10.000 righe sintetiche | 7,3 MB | 625 KB | decodifica a dati identici |
| Pagina di ricerca (pikachu), dopo brotli | 6,2 KB | 3,6 KB | |
| Banco di un set (base-set), dopo brotli | 9,8 KB | 4,8 KB | |
| Indice delle espansioni, dopo brotli | 24,3 KB | 18,1 KB | |
| `marketplace-card-versions` (charizard), dopo brotli | 22,9 KB | 15,8 KB (`c1v2`: 13,9 KB) | |
| Pagina di ricerca, byte grezzi | 72 KB | 21 KB (`c1v2`: 13 KB) | |
| `marketplace-card-versions`, byte grezzi | 325 KB | 79 KB (`c1v2`: 63 KB) | |
| Banco di un set, byte grezzi | 140 KB | 15 KB | |
| Decodifica nel browser | `JSON.parse` | uguale | circa 0,2 ms (pagina di ricerca), 0,6 ms (card-versions) |

Misura aggiuntiva fatta per questa guida, perché **l'app Dart potrebbe non
ricevere brotli** (§3.5): `gzip -6` sulle 11 risposte catturate in
`docs/handoff/compact-c1/fixtures/` (JSON normale) contro le stesse in
`docs/handoff/compact-c1/c1/` (formato 1):

| Insieme | JSON + gzip -6 | `c1` + gzip -6 | Differenza |
| --- | --- | --- | --- |
| 11 fixture, totale | 147.954 B | 86.039 B | -41,8% |
| `artist-arita` (400 righe) | 53.325 B | 34.002 B | -36,2% |
| `card-versions-expansion` (268 righe) | 29.184 B | 18.030 B | -38,2% |
| `expansion-destined-rivals` (244 righe) | 25.164 B | 10.875 B | -56,8% |
| `search-charizard` (106 righe) | 12.756 B | 7.877 B | -38,2% |

Comando per riprodurla, da una copia di `pokoin`:

```sh
cd docs/handoff/compact-c1
for n in artist-arita card-versions-expansion expansion-destined-rivals search-charizard; do
  echo "$n $(gzip -6 -c fixtures/$n.json | wc -c) $(gzip -6 -c c1/$n.c1.json | wc -c)"
done
```

### 1.4 Risultato atteso

- L'app chiede `c1` solo sulle route che lo supportano e **solo** quelle che oggi
  chiama (§3.3): `marketplace-card-versions`, `marketplace-artist-cards`,
  `marketplace-expansions`, `marketplace-home`, `marketplace-home-page`.
- Il resto del codice dell'app (modelli, schermate, provider) non cambia: riceve
  gli stessi `Map<String, dynamic>` e `List<dynamic>` di prima.
- Qualunque problema (documento non decodificabile, codice sconosciuto,
  interruttore spento) riporta alla lettura in JSON normale senza errori
  visibili all'utente.
- Il benchmark del §6 dice, con numeri, se la nuova versione è migliore. Se non
  lo è, l'interruttore (§4.7) basta a tornare indietro senza rilasciare nulla
  sul server.

---

## 2. Come funziona il formato

Fonti: la specifica (§3), `market/src/compact.js` (decoder del browser, il
modello migliore per il porting), `pokoin-rust/crates/api-common/src/compact/`
(`decode.rs`, `encode.rs`, `dict.rs`, `template.rs`, `mod.rs`) e i test
`market/src/compact.test.js`. I nomi sotto sono quelli del codice.

### 2.1 Busta e versione

```json
{ "c1": 1, "dict": "1", "b": <scheletro>, "t": [<tabella>, ...] }
```

| Campo | Significato |
| --- | --- |
| `c1` | Versione del formato. `1` = codec 0-4. `2` = il documento usa anche i **template** (codec 5). Qualunque altro valore non è `c1`: `isC1` restituisce falso, `decodeC1` fallisce con "unsupported c1 version". |
| `dict` | Versione del dizionario dei codici contro cui il documento è stato codificato (oggi `"1"`). |
| `b` | Lo **scheletro**: il JSON originale in cui ogni array che vale la pena rendere colonnare è sostituito da `{"$c1": <indice>}`. |
| `t` | Le **tabelle**, in ordine. Se manca, equivale a un array vuoto. |

Formato 2 si chiede con `?format=c1v2` (oppure `v=2` sul media type `c1` in
`Accept`). Chi chiede `c1` riceve sempre il formato 1, quindi un client che non
sa leggere il codec 5 non lo incontra mai (specifica §3.5). Un oggetto della
sorgente che contiene davvero una chiave che inizia per `$c1` è avvolto come
`{"$c1x": {...}}`, così il segnaposto non si confonde mai con i dati veri.

Nel decoder `rebuild` percorre lo scheletro: un array è ricostruito elemento per
elemento; un oggetto con **una sola** chiave `$c1` è sostituito dalla tabella
decodificata con quell'indice (indice fuori intervallo = errore); un oggetto con
una sola chiave `$c1x` è un oggetto letterale le cui chiavi sono dati, ma i cui
valori possono ancora contenere segnaposto.

### 2.2 Tabelle e colonne

```text
{ "n": <righe>, "k": ["id", ...], "c": [<colonna>, ...] }   // array di oggetti
{ "n": <lunghezza>,               "c": [<colonna>] }        // array di scalari ("vettore")
```

- `n` è il numero di righe, un intero non negativo.
- `k` sono i nomi delle chiavi, uno per colonna. **Senza `k` la tabella è un
  vettore**: deve avere esattamente una colonna e nessuna cella assente.
- La riga *i* si ricostruisce inserendo `k[j] -> colonna[j][i]` **nell'ordine
  delle colonne**, che è l'ordine delle chiavi di ogni riga. L'ordine delle
  chiavi fa parte del contratto congelato, per questo i test confrontano stringhe
  serializzate e non uguaglianza profonda.
- `k.length` deve essere uguale al numero di colonne, altrimenti errore.

Ogni colonna è un oggetto con un codec `c` e dei modificatori:

| Campo | Significato |
| --- | --- |
| `m` | Maschera di presenza, `0`/`1` per riga; omessa se ogni riga ha la chiave. Lunghezza = `n`. Una riga con `0` non riceve la chiave. I valori della colonna sono solo per le righe presenti. |
| `ns` | I valori decodificati sono interi che vanno resi come stringhe decimali (`668126` diventa `"668126"`). |
| `prei` / `pre` | Prefisso da anteporre: prima il codice della tabella dei prefissi URL, poi il letterale. |
| `sufi` / `suf` | Suffisso da aggiungere: prima il codice della tabella dei prefissi URL, poi il letterale. |

L'ordine di applicazione nel decoder è fisso: **residui del codec → `ns` →
prefisso e suffisso**. Prefisso e suffisso richiedono che i valori siano
stringhe (altrimenti "affix column holds a non-string").

### 2.3 I codec di colonna

| Codec | Nome | Payload | Trasformazione |
| --- | --- | --- | --- |
| `0` | costante | `v` | Un solo valore per ogni riga presente. |
| `1` | array semplice | `v: []` | Un valore per ogni riga presente. La lunghezza di `v` deve essere uguale al numero di righe presenti. |
| `2` | palette | `p: []`, `x: []`, `t?` | Internamento per risposta: `p` sono le voci distinte, `x` l'indice nella palette per ogni riga presente. Con `t` (nome di una tabella del dizionario) una voce **intera** è un codice del dizionario e una voce **stringa** è un letterale che la tabella non contiene. |
| `3` | delta intero | `z`, `d: []` | Il primo valore è `z`; poi `v[i] = v[i-1] + d[i-1]`. `d.length + 1` deve essere uguale al numero di righe presenti. |
| `4` | riferimento | `r` | Stessi residui e stessa maschera della colonna `r`. `r` deve puntare a una colonna **precedente** della stessa tabella (un riferimento in avanti è un errore). |
| `5` | template (solo formato 2) | `s`, `h`, `x?`, `l`, `m?` | Cfr. §2.6. |

Il codificatore sceglie il codec **serializzando tutti i candidati applicabili e
tenendo il più corto**, quindi nessun codec rende mai una colonna più grande
dell'array semplice (specifica §3). Il decoder non deve indovinare: legge il
codec dichiarato.

Il codec `4` sopra la rimozione di prefissi e suffissi è dove sta la maggior
parte del guadagno: le coppie alias (`id`/`card_id`, `set`/`set_name`,
`number`/`card_number`, `canonicalPath`/`canonical_path`, `artist`/`illustrator`)
e tutta la famiglia `imageUrl`/`previewImageUrl`/`homepageImageUrl`/
`gridImageUrl`/`heroImageUrl`/`tileImageUrl` collassano su un solo array di
residui, per esempio `668126_levincia`.

### 2.4 Colonne costanti e colonne alias

- **Costante** (codec 0): `set` ha un solo valore in una pagina di set, quindi è
  `{"c":0,"v":"Base Set"}`.
- **Alias** (codec 4): `card_id` è `{"c":4,"r":0,"ns":1}` se la colonna 0 è `id`.
  Il riferimento porta con sé residui **e maschera**; poi `ns`, `pre`, `suf` della
  colonna che riferisce si applicano ai residui ereditati. Per questo `id` e
  `card_id` possono avere forme diverse a partire dallo stesso array.

### 2.5 Interi restituiti come stringhe (`ns`) e delta

`id` è una stringa decimale canonica ("668126", "668127", ...). Il codificatore
la memorizza come intero più differenze (codec 3) con `ns: 1`. È canonica solo se
non ha zeri iniziali, segno `+`, spazi, né supera 2^53-1: così
`value.to_string()` è identico all'originale. Il decoder converte ogni valore con
la sua rappresentazione decimale; un valore non intero in una colonna `ns` è un
errore.

### 2.6 Template (codec 5, formato 2)

Una colonna URL o slug che è una funzione deterministica di altre colonne della
stessa riga è memorizzata come ricetta. Esempio dalla specifica:
`canonicalPath = "/marketplace/en/cards/" + {id} + "/card-" + slug{name} + "-" + slug{card_number} + "-" + slug{set}`.

```text
{ "c": 5, "s": [[col, forma], ...], "h": [[slot, ...], ...], "x": [forma_riga, ...],
  "l": [[<colonna>, ...], ...], "m"? }
```

- `s`: gli **slot**: un'altra colonna della riga e una *forma*: `0` il suo testo
  (una stringa, o un intero sicuro in decimale), `1` il suo slug ASCII.
- `h`: le **forme** (shape): gli slot di cui un valore è fatto, in ordine.
- `x`: una forma per ogni riga presente; si omette quando c'è una sola forma.
- `l`: per ogni forma, i letterali prima di ogni slot e dopo l'ultimo
  (`shape.length + 1` colonne ordinarie di codec 0-3, calcolate sulle righe di
  quella forma).
- Slug (`c1Slug` in JS, `template::slug` in Rust): minuscole ASCII alfanumeriche;
  ogni sequenza di altri caratteri tra due alfanumerici diventa un solo `-`;
  agli estremi non resta nessun `-`. `Gold Secret Rare | 244/182` diventa
  `gold-secret-rare-244-182`; `  Pokémon: Mega Lucario ex!  ` diventa
  `pok-mon-mega-lucario-ex` (la `é` non è ASCII); `---` diventa `` (vuoto).
- Un'uscita di template che non può leggere il testo di una cella
  ("template slot has no text in this row") è un errore.

**Ordine di decodifica di una tabella** (identico in JS e in Rust): prima le
colonne semplici in ordine (un riferimento a una colonna "in attesa" viene a sua
volta rimandato), poi i template (leggono colonne semplici della stessa riga),
poi i riferimenti a template. Uno slot non è mai un template né un riferimento a
un template.

### 2.7 Palette, prefissi e suffissi, dizionario

- **Palette per risposta** (codec 2): le voci `p` sono internate nel documento
  stesso. Senza `t` le voci sono valori letterali (stringhe, interi, oggetti, ad
  esempio `card_palette`).
- **Palette con tabella** (`t`): una voce intera è `tabella[codice - 1]`. Una
  voce stringa è un letterale. Il codificatore codifica una palette solo se **tutte**
  le sue voci sono stringhe, così codice e letterale non si confondono mai.
- **Prefissi/suffissi per colonna** (`pre`/`suf`): letterali che il codificatore
  ha estratto da una colonna.
- **Tabella dei prefissi URL** (`prei`/`sufi`): codice intero in
  `urlPrefixes[codice - 1]`. Nel dizionario versione 1 le 9 voci sono, nell'ordine:
  `https://cdn.pokoin.com/`, `https://cdn.pokoin.com/card-images/`,
  `https://cdn.pokoin.com/card-images/previews/`,
  `https://cdn.pokoin.com/expansions/symbols/`,
  `https://cdn.pokoin.com/expansions/logos/`, `/card-images/`,
  `/card-images/previews/`, `/marketplace/en/cards/`, `/marketplace/`.

### 2.8 Il dizionario dei codici (`codeBase` e regola append-only)

`GET /api/dictionary` (`pokoin-rust/crates/catalog-api/src/reads/dictionary.rs`,
tabelle in `pokoin-rust/crates/api-common/src/compact/dict.rs`) risponde 200 con:

```json
{ "version": "1", "format": "c1", "codeBase": 1, "appendOnly": true,
  "tables": { "games": [...], "languages": [...], "conditions": [...], "printings": [...],
              "nationalities": [...], "artLayouts": [...], "rarityKinds": [...],
              "itemKinds": [...], "productTypes": [...], "rarities": [...] },
  "flags": { "firstEdition": 1, "signed": 2, "altered": 4, "reverse": 8, "graded": 16,
             "sealed": 32, "nftAvailable": 64, "shippingAvailable": 128, "reserveAvailable": 256 },
  "urlPrefixes": [ ... ] }
```

Dimensioni della versione 1 (file `market/src/compact-dictionary.json`, 2.902 byte):
`games` 25 voci, `languages` 16, `conditions` 6, `printings` 4,
`nationalities` 9, `artLayouts` 5, `rarityKinds` 3, `itemKinds` 2,
`productTypes` 12, `rarities` 27, `urlPrefixes` 9.

- `codeBase: 1`: un codice è `indice + 1`; `0` non è mai un codice.
- `appendOnly: true`: le voci si **aggiungono soltanto**, mai rinumerate,
  riordinate né rimosse, perché un documento decodificato con un'istantanea
  vecchia deve continuare a decodificare le stesse stringhe per sempre. Ritirare
  un valore significa lasciarlo al suo posto.
- `version` sale quando una tabella guadagna voci; ogni documento `c1` dichiara
  in `dict` la versione contro cui è stato codificato.
- Un valore sconosciuto **non** è un errore di formato: `rarity` è testo libero
  nel catalogo (57 valori distinti su 11 fixture), la tabella `rarities` è
  volutamente parziale e quello che manca resta un letterale nella palette.
- Caching (specifica §3.1): `GET /api/dictionary` è rivalidato
  (`cache-control: public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800`,
  `ETag: "c1-dict-<versione>"`, `304` con `If-None-Match`).
  `GET /api/dictionary?v=<versione>` è la versione fissata: `max-age=31536000,
  immutable`; una `v` diversa dalla corrente risponde `409` con corpo
  `{"error":"Unknown dictionary version.","requested":...,"version":...}`.
  Le due risposte hanno le intestazioni CORS di lettura.
- **Da non confondere** con `GET /api/c1-dictionary`
  (`pokoin-rust/apps/api/src/lists.rs`, funzione `dictionary`): è un file binario
  `application/octet-stream` per la compressione condivisa RFC 9842 (`dcb`) delle
  istantanee di lista. Non è il dizionario dei codici, **non è attivo in
  produzione** (Cloudflare in modalità passthrough è stato disattivato il
  2026-10-10, specifica §3.5) e gli stack HTTP mobili non negoziano `dcb`. L'app
  non lo usa mai.

### 2.9 Condivisione strutturale dei valori decodificati

Dove il codificatore ha internato (una voce di palette, una colonna costante,
una colonna alias), due righe possono contenere **lo stesso oggetto**. È ciò che
rende la decodifica economica: `compact.js` lo dichiara nell'intestazione
("Treat the result as read-only; clone before mutating"). Conseguenze per Dart:

- un `Map` o una `List` che arriva da una colonna palette/costante può essere la
  stessa istanza in più righe;
- la mutazione in loco di un valore annidato di una riga muta tutte le altre;
- il codice esistente fa `Map<String, dynamic>.from(row)` (copia **superficiale**
  della riga, per esempio in `lib/services/card_service.dart:3053`): le righe
  restano indipendenti, ma gli oggetti annidati restano condivisi.

### 2.10 Codice sconosciuto

Due casi, entrambi con un errore tipizzato, mai un valore sbagliato in silenzio:

- `dictionary <tabella> has no code <n>; refetch /api/dictionary`: una voce
  intera di palette con `t` non esiste nell'istantanea (il documento è stato
  codificato contro un dizionario più nuovo);
- `url prefix <n> is unknown; refetch /api/dictionary`: un `prei`/`sufi` fuori
  dalla tabella `urlPrefixes`.

La specifica (§6, punto 6) dice di trattare questo errore come "riscarica il
dizionario corrente", non come un fallimento. Cfr. il passo (c) del §4.

Qualunque altro errore di decodifica (versione sconosciuta, tabella fuori
intervallo, codec sconosciuto, lunghezze incoerenti, riferimento in avanti,
`ns` su un non intero, "a vector table cannot have absent cells") significa
documento malformato: il client rilegge la route in JSON normale.

### 2.11 Esempio svolto

È l'esempio del test "a table rebuilds rows in column order" di
`market/src/compact.test.js`, con il formato 1 e la versione `"1"` del dizionario.

Documento:

```json
{
  "c1": 1, "dict": "1",
  "b": { "cards": { "$c1": 0 } },
  "t": [{
    "n": 3,
    "k": ["id", "card_id", "set", "nationality", "imageUrl"],
    "c": [
      { "c": 3, "z": 100, "d": [1, 1], "ns": 1 },
      { "c": 4, "r": 0, "ns": 1 },
      { "c": 0, "v": "Base Set" },
      { "c": 2, "t": "nationalities", "p": [1, 2], "x": [0, 1, 0] },
      { "c": 1, "v": ["a", "b", "c"], "prei": 6, "suf": ".jpg" }
    ]
  }]
}
```

Passi:

1. Lo scheletro `b` contiene `{"cards": {"$c1": 0}}`: `cards` sarà la tabella 0.
2. `id` (codec 3): residui `100`, `100+1=101`, `101+1=102`; `ns` li rende
   `"100"`, `"101"`, `"102"`.
3. `card_id` (codec 4, `r: 0`): stessi residui di `id`, poi `ns`: stesse tre stringhe.
4. `set` (codec 0): `"Base Set"` per le tre righe.
5. `nationality` (codec 2, `t: "nationalities"`): la palette `[1, 2]` diventa
   `nationalities[0] = "western"`, `nationalities[1] = "japanese"`; gli indici
   `[0, 1, 0]` danno `western`, `japanese`, `western`.
6. `imageUrl` (codec 1): `["a","b","c"]`, prefisso `prei: 6` =
   `urlPrefixes[5] = "/card-images/"`, suffisso `.jpg`.

Risultato, con l'ordine delle chiavi `id, card_id, set, nationality, imageUrl`:

```json
{ "cards": [
  { "id": "100", "card_id": "100", "set": "Base Set", "nationality": "western",  "imageUrl": "/card-images/a.jpg" },
  { "id": "101", "card_id": "101", "set": "Base Set", "nationality": "japanese", "imageUrl": "/card-images/b.jpg" },
  { "id": "102", "card_id": "102", "set": "Base Set", "nationality": "western",  "imageUrl": "/card-images/c.jpg" }
] }
```

Altri tre casi dello stesso file di test, utili come test di porting:

- *palette con letterale*: `{c:2, t:"rarities", p:[2,"WCD 2006"], x:[0,1,1]}` dà
  `Common`, `WCD 2006`, `WCD 2006` (il codice 2 è `rarities[1] = "Common"`; la
  stringa resta letterale);
- *maschera di presenza*: `{c:1, v:["x","z"], m:[1,0,1]}` con `n: 3` e `k:["a"]`
  dà `[{"a":"x"}, {}, {"a":"z"}]`;
- *vettore*: `{n:3, c:[{c:3, z:612454, d:[10,5], ns:1}]}` senza `k` dà
  `["612454","612464","612469"]`.

### 2.12 Differenze note tra decoder web e decoder Rust

Vale la specifica; dove la specifica tace vale il Rust (è il riferimento da cui
è scritto il JS, `decode.rs` righe 1-8). Il porting Dart deve seguire la colonna
"Dart".

| Punto | JS (`compact.js`) | Rust (`decode.rs`) | Dart |
| --- | --- | --- | --- |
| Overflow in un delta | nessun controllo | `checked_add`, errore "delta overflows" | Errore se il valore esce da ±(2^53-1) (vale anche su Flutter web, dove gli interi sono `double`) |
| Valore di `ns` | `Number.isInteger` | `as_i64()` | Solo `int`; un `double` è errore |
| Valore della maschera | vero/falso (truthy) | `as_u64() != 0` (un non numero vale 0, riga assente) | `v is num && v != 0` |
| Versione mancante | "unsupported c1 version undefined" | "missing c1 version" | Un solo errore per entrambi |
| Segnaposto `$c1` non intero | "table ... is out of range" | "table placeholder is not an index" | Errore con uno dei due messaggi |
| Dizionario | argomento opzionale (default: istantanea inclusa) | compilato nel binario | Argomento opzionale come in JS |
| Tabella condivisa | restituisce la stessa istanza se referenziata due volte | clona | Come in JS (condivisione); cfr. §2.9 |

Disaccordi tra documentazione e codice trovati leggendo (da segnalare nel
rapporto finale, §7):

- La specifica (intestazione e §3.4, §6) e l'intestazione di `compact.js` dicono
  che nulla in `market/` richiede `c1`. È superato: `market/src/api.js`
  (`C1_READS = true`, `getJsonC1`, `fetchListSnapshot`, `fetchSellerShop`) lo
  richiede.
- La specifica §3.2 dice `x-pokoin-format: c1`. `apps/api/src/lists.rs` (riga
  153) risponde `c1v2` per le istantanee di lista in formato 2. Le altre route
  rispondono sempre `c1`, anche a una richiesta `c1v2`
  (`api-common/src/compact/mod.rs`, costante `C1_FORMAT_HEADER`). Il client
  riconosce `c1` dalla chiave del corpo (§4, passo b), non dal valore
  dell'intestazione.
- Né `docs/API.md` né `docs/SELLER_API.md` menzionano `c1`
  (nessuna occorrenza di `format=c1`); la fonte è solo la specifica.

---

## 3. Verifica dell'app attuale (audit)

Repository letto: `gvitolocs/cardvault`, checkout in `/home/user/cardvault`, HEAD
`8a88881` ("fix(api): read user listings from the central marketplace DB"),
cartella `pokemon_card_vault/`. **Il repository era raggiungibile.** Ogni riga di
"Verificato leggendo il codice" cita file e riga letti il 2026-10-12. Le righe
possono spostarsi: l'agente le riverifica con `grep -n` prima di modificare.

### 3.1 Verificato leggendo il codice

| # | Fatto | Evidenza |
| --- | --- | --- |
| A1 | **Client HTTP:** `package:http ^1.1.2`. Le chiamate del catalogo usano le funzioni di primo livello `http.get(uri).timeout(...)` (nessun `http.Client` condiviso, nessun `IOClient`, nessun `cronet_http`/`cupertino_http`). Esiste `PokoinApiClient` con un `http.Client` proprio e timeout 15 s, ma è per le chiamate autenticate. | `pubspec.yaml` (dipendenza `http`); `lib/services/card_service.dart:2132`, `:2972`, `:3046`, `:3160`, `:3195`, `:3286`, `:3302`, `:3398`, `:4701`, `:4750`; `lib/services/pokoin_api_client.dart:7-27` |
| A2 | **Parsing JSON:** `jsonDecode(response.body)` direttamente nel metodo di servizio, 24 occorrenze in `card_service.dart` (righe 1779-4756), tutte sul **thread UI**. Poi ogni riga è copiata con `Map<String, dynamic>.from(row)` e convertita da `_cardFromVersionRow` (`:2252`) o `_cardFromMarketplaceRow`. | `lib/services/card_service.dart` (es. `:3050`, `:3403`, `:3245`, `:3164`) |
| A3 | **Nessun isolate** in `lib/`: nessuna occorrenza di `Isolate.run`, `compute(` o `Isolate.spawn` (le uniche corrispondenze di `Isolate` in `lib/scan_v2/scan_verify.dart:298,321,337` sono la parola "isolated" nel nome di `isIsolatedCard`). | `grep -rn "Isolate\|compute(" lib` |
| A4 | **URL base:** `lib/services/card_service.dart:16-18` definisce `_marketplaceApiBaseUrl` da `String.fromEnvironment('MARKETPLACE_API_BASE_URL', defaultValue: 'https://api.pokoin.com')`; `:20-22` `_competitiveApiBaseUrl` (stesso default). L'helper `_marketplaceApiUri` (`:25-42`) usa l'origine della pagina solo se `kIsWeb`, altrimenti `_marketplaceApiBaseUrl`. Ma **26 punti di `card_service.dart` usano `Uri.base.resolve('/api/...')`** (e 102 nell'intera `lib/`), compresi tutti quelli di §3.3 tranne la home. Su Android e iOS `Uri.base` è l'URI `file:` della directory di lavoro, quindi `Uri.base.resolve('/api/...')` darebbe `file:///api/...`: **da verificare su dispositivo** (è il punto F1 della guida del typeahead). | `card_service.dart:16-42`, `:2127`, `:2966`, `:3039`, `:3154`, `:3187`, `:3228`, `:3296`, `:3391`, `:4698`, `:4747`; home: `:1897` usa `_marketplaceApiUri` |
| A5 | **Cache attuale:** Hive. Box `marketplace_card_list_cache` (`_listCacheBoxName`, `:1604`) con TTL di 3 giorni (`_listCacheTtl`, `:1612`), schema `_cacheSchemaVersion = 2`; i valori salvati sono `PokemonCard.toJson()` (`_saveCardList`, `:3586`), cioè il risultato **già convertito**, non il JSON di rete. Altri box: `pokemon_cards`, `marketplace_home_snapshot` (TTL 2 minuti), `pokoin_cache_meta`. Nessuna cache in memoria delle risposte di rete: ogni schermata che ricarica rifà la richiesta. | `card_service.dart:1600-1614`, `:3565-3601` |
| A6 | **Nessuna richiesta `format=`** e nessuna occorrenza di `c1` in `lib/`. | `grep -rn "format=c1\|c1" lib` (solo nomi non correlati) |
| A7 | **Pubspec/SDK:** `pubspec.yaml` dichiara `sdk: '>=3.6.0 <4.0.0'`; `pubspec.lock` richiede Dart `>=3.12.0 <4.0.0` e Flutter `>=3.44.0` (ultime righe del lock). Il decoder è Dart semplice e non richiede pacchetti nuovi. `Isolate.run` esiste da Dart 2.19. | `pubspec.yaml`, `pubspec.lock` (sezione `sdks`) |
| A8 | **Test:** 18 file `.dart` in `test/` più la cartella `test/fixtures`, nessuna cartella `integration_test/`. Un mock HTTP esiste (`MockClient`) solo in `test/flutter_debug_log_test.dart`; i test di `card_service_test.dart` non mockano la rete. | `ls test`; `test/flutter_debug_log_test.dart:62-106` |
| A9 | **Nessun pacchetto di configurazione remota:** `pubspec.yaml` ha `firebase_core`, `firebase_auth`, `cloud_firestore` ma non `firebase_remote_config`. Un flag remoto richiederebbe un pacchetto nuovo o una lettura Firestore. | `pubspec.yaml` |
| A10 | **Schermate che consumano le route con forma `c1`:** `lib/screens/collection_screen.dart:544` (set per slug, `getMarketplaceExpansionSnapshotBySlug`), `:554` (indice espansioni), `:559` (indice artisti); la home passa da `lib/providers/card_provider.dart:478` e `:1322` (`getMarketplaceHomeSnapshot`). Le schermate `lib/screens/card_versions_screen.dart` e `lib/screens/artist_collection_screen.dart` esistono. Quali di queste chiami davvero `getExpansionVersionCards`, `getCardsByExpansion` e `getMarketplaceArtistSnapshotBySlug` va confermato (D4). | `grep -rn` sui nomi dei metodi |
| A11 | **Debug:** `lib/services/search_debug_trace.dart` registra eventi di ricerca con `elapsedMs`; `lib/services/flutter_debug_log.dart` invia log a `/api/flutter-debug-logs`. Utili per il benchmark ma non pensati per il tempo di decodifica. | `lib/services/` |
| A12 | **Esistono molti `Uri.base.resolve` anche per route che non c'entrano con `c1`** (autocomplete, token predict, listings, ecc.): fuori ambito, ma l'agente non deve toccarli in questa integrazione. | `card_service.dart`, `card_listing_service.dart:159,188` |

### 3.2 Cosa blocca o condiziona l'integrazione

1. **F1 (URL base nativo).** Se `Uri.base.resolve('/api/...')` non raggiunge
   l'API su Android e iOS, l'app attuale non è un riferimento valido per il
   benchmark e `c1` non verrebbe nemmeno chiesto. Va confermato per primo
   (checklist D1 sotto). Se F1 è reale, i punti di §3.3 che l'agente tocca
   passano a `_marketplaceApiUri(path, queryParameters: ...)`; la scelta di
   usare per il benchmark la build "così com'è" o una con solo l'URL base
   corretto è la domanda Q2 della guida del typeahead
   ([`flutter-suggest-dictionary` §9](../flutter-suggest-dictionary/README.md)):
   l'agente la lascia alla collega e usa la stessa risposta.
2. **Nessun isolate e `jsonDecode` sul thread UI.** Va deciso dove gira la
   decodifica (§4, passo d). Non è un blocco: è la ragione del passo.
3. **Cache su disco di dati già convertiti.** Il box Hive tiene `PokemonCard`
   convertite, quindi la cache in memoria di §4 (passo e) deve stare **a monte** di
   `_cardFromVersionRow` e non sostituire quella su disco.
4. **Possibile assenza di brotli sul filo.** Cfr. §3.5: cambia l'ordine di
   grandezza del guadagno in byte.
5. **Il formato `c1` non esiste per la barra di ricerca** (§3.3): nessun beneficio
   su `marketplace-autocomplete` e `searchbar-token-predict`.

### 3.3 Endpoint Pokoin chiamati dall'app e loro forma `c1`

"`c1` nel codice" significa che il gestore Rust legge la richiesta con
`Wanted`/`util::wanted` o `catalog_api::wanted` e risponde con
`json_cache_c1`/`json_with`/`prebuilt` o equivalente: letto in
`pokoin-rust/`, non provato con una richiesta (cfr. §3.4).

| Route | Dove l'app la chiama | `c1` nel codice | Riga del gestore Rust |
| --- | --- | --- | --- |
| `marketplace-card-versions` | `card_service.dart:2966` (`cardId`, `limit=1`), `:3039` (`sameAsCardId`, `limit=100`), `:3391` (`expansionName`, `limit=1000`), `:4747` (ricerca versioni) | **sì** | `crates/catalog-api/src/reads/card_versions.rs:23,48` |
| `marketplace-artist-cards` | `card_service.dart:3228` (artista per slug), `:3296` (`summaries=1`, `limit=1000`) | **sì** (riepiloghi, tessere preconfezionate `tiles=1`, payload) | `crates/catalog-api/src/reads/artist_cards.rs:515-540` |
| `marketplace-expansions` | `card_service.dart:3154` (indice), `:3187` (`includeCards=1`, `limit=1200`) | **sì** (entrambi i rami) | `crates/catalog-api/src/reads/expansions.rs:23-35` |
| `marketplace-home` | `card_service.dart:1892` | **sì** | `crates/catalog-api/src/reads/home.rs:738` |
| `marketplace-home-page` | `card_service.dart:1893` (ripiego) | **sì** | `crates/catalog-api/src/pages/home_page.rs:257,320,329` |
| `marketplace-cards` | `:2129`, `:3880`, `:4698` | **no** (`crates/search-api/src/lookup/mod.rs` non usa `Wanted`/`compact`) | — |
| `marketplace-autocomplete`, `searchbar-token-predict`, `marketplace-event`, `searchbar-cancel` | `:4011`, `:4174`, `:4235`, `:4786`, `:4815` | no (sono POST) | — |
| `marketplace-card-url`, `-card-sales`, `-blueprint-price`, `-card-cheapest-price`, `-hot-blueprints`, `-search-candidates`, `-competitive`, `deck-card-version-lookup` | `:2815`, `:2844`, `:2883`, `:1920`, `:3905`, `:3736`, `:3353`, `:3787` | **non trovato nel codice** (nessun `Wanted` in `card_url.rs`, `blueprint_price.rs`, `hot_blueprints.rs`) | — |
| `marketplace-listings`, `marketplace-orders`, route di wallet e forum | `card_listing_service.dart:159,188`, ecc. | no | — |

Route che hanno una forma `c1` ma che **l'app non chiama oggi**:
`marketplace-search-page`, `marketplace-expansion-page`, `marketplace-list`
(`kind=set|artist|name`), `marketplace-seller-shop` con `book=1`,
`marketplace-suggest`, `marketplace-rails`,
`marketplace-version-set`, `marketplace-related`
(verificate nel codice come al §3.4; `grep` su `lib/` non trova nessuno di
questi percorsi). Il decoder di questa guida li legge comunque: servono se
l'app adotterà quelle route in futuro.

### 3.4 Lista delle route `c1` dichiarate nell'incarico: cosa è stato confermato

| Route | Esito | Dove nel codice |
| --- | --- | --- |
| `marketplace-search-page` | confermata (formato 1 e 2) | `pokoin-rust/apps/api/src/search_page.rs:37` (`wanted`), `:374` (`response_c1`) |
| `marketplace-card-versions` | confermata | `catalog-api/src/reads/card_versions.rs:23,48` |
| `marketplace-expansion-page` | confermata (anche istantanee preconfezionate) | `catalog-api/src/pages/expansion_page.rs:46,91,121,239` |
| `marketplace-artist-cards` | confermata | `catalog-api/src/reads/artist_cards.rs:515-540` |
| `marketplace-list` (`c1v2`) | confermata: serve `c1v2` se l'istantanea lo ha, altrimenti `c1`; può rispondere con `Content-Encoding: br` | `apps/api/src/lists.rs:92-170` |
| `marketplace-seller-shop?book=1&format=c1v2` | confermata; **il formato è letto solo dalla query `format`**, non da `Accept` (riga 754); anche `format=c1` è accettato; risposta `cache-control: private, no-store` | `crates/commerce/src/handlers/seller.rs:360-400`, `:435-445`, `:754-774`; `seller_book.rs` (libro memorizzato in formato `c1v2`) |
| `marketplace-suggest?format=c1` | confermata (anche `c1v2`, `Accept`) | `apps/api/src/suggest.rs:58`, `:618-626` |

Le stesse route e in più `marketplace-expansions`, `marketplace-home`,
`marketplace-home-page`, `marketplace-rails`, `marketplace-version-set` e
`marketplace-related` compaiono nella tabella delle route cablate della
specifica (§3.3); le prime tre sono confermate nel codice (§3.3 sopra).

**Non verificato dal vivo.** La sessione che ha scritto la guida non ha potuto
raggiungere `https://api.pokoin.com`: le richieste `curl` (ricerca, `/api/dictionary`,
`marketplace-suggest`) hanno ricevuto `403 Forbidden` con `content-type:
text/plain` e `x-content-type-options: nosniff` dal proxy di uscita
dell'ambiente, prima di arrivare all'API. Quindi **nessuna intestazione di
risposta in questa guida è stata osservata dal vivo**: sono quelle lette nel
codice. L'agente le conferma con il passo D6 sotto.

### 3.5 Da verificare dall'agente (checklist con comandi)

Ogni voce dice cosa fare e cosa registrare. L'agente scrive i risultati in
`audit/C1-AUDIT.md` sul ramo di lavoro, riga per riga.

| # | Domanda | Comando o azione | Cosa registrare |
| --- | --- | --- | --- |
| D1 | F1: le richieste di §3.3 raggiungono `api.pokoin.com` su Android e iOS? | Build `flutter run --profile -d <dispositivo>`, aprire un set e un artista, osservare DevTools → Network e `adb logcat \| grep -i "failed"` | Per ognuna delle 9 chiamate: URL effettivo, stato, byte |
| D2 | Con quale `accept-encoding` parte la richiesta e che codifica risponde il filo? | DevTools → Network sulla richiesta di `marketplace-card-versions`; in alternativa un proxy TLS di debug (mitmproxy) sul dispositivo | Intestazioni `accept-encoding` (richiesta) e `content-encoding` (risposta) |
| D3 | `dart:io` decomprime brotli? Conoscenza dell'autore, **non letta in un file**: `HttpClient` di `dart:io` negozia `gzip` e non `br`; `cronet_http` (Android) e `cupertino_http` (iOS) usano lo stack di piattaforma | Leggere D2: se `content-encoding` è `gzip` e non `br`, le misure del §1.3 (brotli) sono ottimistiche e la tabella gzip del §1.3 è quella pertinente | Esito D2 e decisione: restare su `package:http` standard |
| D4 | Quali schermate usano i metodi di §3.3? | `grep -rn "getExpansionVersionCards\|getCardsByExpansion\|getOtherVersionCards\|getMarketplaceArtistSnapshotBySlug\|getMarketplaceExpansionSnapshotBySlug\|getMarketplaceArtistSummaries\|getMarketplaceExpansions\b\|getMarketplaceHomeSnapshot" lib` | Metodo → schermata → dimensione tipica della risposta |
| D5 | Dimensioni reali dei corpi che l'app riceve oggi | Con `curl` dal computer dello sviluppatore, esempi in §5.2 | `Content-Length` o byte scaricati, per route |
| D6 | Intestazioni reali di `c1` | `curl -s -D - -o /dev/null "https://api.pokoin.com/api/marketplace-card-versions?sameAsCardId=<id>&productType=card&limit=100&format=c1"` | `content-type`, `x-pokoin-format`, `vary`, `cache-control`, `content-encoding` |
| D7 | Toolchain | `cd pokemon_card_vault && flutter --version && flutter pub get && flutter analyze && flutter test` | Versioni, conteggio test passati/falliti (base di partenza) |
| D8 | Il libro del negozio venditore serve all'app? | `grep -rn "seller-shop" lib` (oggi nessuna corrispondenza) | Sì/no; se sì, schermata |
| D9 | Memoria base | DevTools → Memory prima di aprire una schermata pesante | Heap Dart, esterna, RSS |

---

## 4. Piano di integrazione

Struttura proposta. L'agente può spostare i file se la convenzione del
repository lo richiede, ma tiene separati decoder (puro), client (rete),
cache e configurazione.

```text
pokemon_card_vault/
  lib/services/c1/
    c1_config.dart        # interruttore, soglie, costanti
    c1_dictionary.dart    # istantanea inclusa (const) + parsing di un documento /api/dictionary
    c1_decoder.dart       # decodifica pura: nessuna rete, nessun Flutter
    c1_client.dart        # getC1(): richiesta, riconoscimento, ripiego, isolate
    c1_cache.dart         # cache in memoria delle risposte decodificate
  test/c1/
    c1_decoder_test.dart  c1_golden_test.dart  c1_client_test.dart  c1_cache_test.dart
  test/fixtures/c1/       # copiate da pokoin/docs/handoff/compact-c1/{fixtures,c1} + catture nuove
```

### Passo 0 — precondizioni (nessun codice)

1. Creare un ramo di lavoro in cardvault; annotare l'SHA di partenza (sarà la
   versione "vecchia" del benchmark).
2. Eseguire D7 (§3.5) e salvare l'esito.
3. Eseguire D1: se F1 è reale, concordare con la collega il trattamento
   (§3.2, punto 1) **prima** di proseguire. Non basta aggiungere `format=c1`
   a un URL che non arriva al server.
4. Eseguire D2 e D3 per sapere se il filo porta gzip o brotli.

### Passo (a) — decoder puro in Dart

**File:** `lib/services/c1/c1_decoder.dart`, `lib/services/c1/c1_dictionary.dart`.

**Comportamento.** Porting di `market/src/compact.js` (538 righe, di cui circa
60 sono l'istantanea del dizionario) con le regole del §2.12. API:

```dart
/// True quando il corpo già parsato è un documento c1 (versione 1 o 2).
bool isC1(Object? payload);

/// Ricostruisce il JSON normale. Lancia [C1Error] se il documento è malformato,
/// [C1UnknownCodeError] se un codice non è nel [dictionary] passato.
Object? decodeC1(Map<String, dynamic> payload, {C1Dictionary? dictionary});

class C1Error implements Exception { C1Error(this.message); final String message; }
class C1UnknownCodeError extends C1Error {          // "refetch /api/dictionary"
  C1UnknownCodeError(super.message, {required this.table, required this.code});
  final String table; final int code;               // table == 'urlPrefixes' per prei/sufi
}

class C1Dictionary {                                // immutabile
  const C1Dictionary({required this.version, required this.tables, required this.urlPrefixes, required this.flags});
  final String version;
  final Map<String, List<String>> tables;
  final List<String> urlPrefixes;
  final Map<String, int> flags;
  factory C1Dictionary.fromJson(Map<String, dynamic> json); // valida: format == 'c1', codeBase == 1
}
```

Struttura interna, nello stesso ordine del JS:

1. `decodeC1`: controlla che `payload` sia un oggetto, che `c1` sia 1 o 2, che il
   dizionario abbia `tables`; decodifica ogni elemento di `t` con `_decodeTable`;
   richiede la chiave `b`; chiama `_rebuild(b, tables)`.
2. `_rebuild`: ricorsivo su `List`, su `Map` con una sola chiave `$c1`
   (indice intero in `[0, tables.length)`) e su `Map` con una sola chiave `$c1x`
   (oggetto interno: stesse chiavi come dati, valori ricostruiti).
3. `_decodeTable`: legge `n`, `c`; applica l'ordine di decodifica del §2.6
   (colonne semplici, template, riferimenti a template); poi vettore (senza `k`)
   o righe.
4. Una colonna decodificata è un piccolo oggetto `_Column { List<int>? slots;
   List<Object?> residuals; List<Object?> values; }`. `slots` mappa riga →
   indice nei valori, `-1` per riga assente, `null` quando non c'è maschera.
5. Codec 0-3 come da §2.3; codec 4 copia `slots` e `residuals` della colonna `r`
   (deve essere `< earlier.length` e già decodificata); codec 5 come §2.6 con
   `c1Slug`.
6. `ns`, poi prefisso, poi suffisso (§2.2).
7. Ogni riga è un `Map<String, Object?>` creato con il literal `{}` (cioè un
   `LinkedHashMap`, che mantiene l'ordine di inserimento): l'ordine delle chiavi
   è il contratto. Non usare `SplayTreeMap` né `Map.fromEntries` ordinati.
8. I valori internati (palette, costanti, alias) **non** si copiano: la
   condivisione è voluta (§2.9). Un `Map` interno condiviso è lo stesso oggetto
   in più righe.

**Dizionario nell'app, in RAM per tutta la sessione.** `c1_dictionary.dart`
contiene `const C1Dictionary kBundledC1Dictionary = C1Dictionary(version: '1',
tables: {...}, urlPrefixes: [...], flags: {...});` con i valori **identici** a
`market/src/compact-dictionary.json` (versione 1). Dimensione: **2.902 byte** di
JSON, 25+16+6+4+9+5+3+2+12+27 = 109 stringhe di tabella e 9 prefissi; in memoria
sono poche migliaia di byte, come costante di compilazione nell'immagine
dell'app, senza costo di avvio. Per questo è fattibile tenerla **sempre in
memoria per l'intera sessione e non leggere mai il disco sul percorso caldo**:
l'istantanea è `const`; l'eventuale versione più nuova ottenuta dalla rete
(passo c) vive in un campo statico e, al più, viene scritta su disco **in
background** per il prossimo avvio, mai letta mentre una risposta è in
decodifica.

Cosa non fare: non caricare il dizionario da `rootBundle`, non rileggerlo dal
disco a ogni richiesta, non ricostruire le tabelle a ogni `decodeC1`.

**Verifica.** `flutter test test/c1/c1_decoder_test.dart` (§5.1). Un test
confronta il `const` con il JSON di `market/src/compact-dictionary.json` copiato
in `test/fixtures/c1/compact-dictionary.json`: se la versione o una voce cambiano,
il test fallisce e dice di rigenerare il `const`.

Rigenerazione del `const` quando il server alza la versione (comando in pokoin,
dalla specifica §3.1):

```sh
cd pokoin-rust
cargo run --quiet --example c1_dictionary > ../market/src/compact-dictionary.json
```

### Passo (b) — lato richiesta

**File:** `lib/services/c1/c1_client.dart`, poi i punti di chiamata in
`lib/services/card_service.dart`.

**Comportamento.** Una sola funzione, usata dai metodi di servizio al posto di
`http.get(uri).timeout(...)` + `jsonDecode(response.body)`:

```dart
class C1Result {
  const C1Result({required this.statusCode, required this.json,
                  required this.wasC1, this.cacheMaxAge});
  final int statusCode;       // dello stesso GET
  final Object? json;         // JSON normale (decodificato se era c1); null se corpo non JSON
  final bool wasC1;           // per statistiche e benchmark
  final Duration? cacheMaxAge; // da cache-control, per il passo (e)
}

Future<C1Result> getC1(Uri uri, {
  required Duration timeout,
  C1Format format = C1Format.v1,   // v1 = ?format=c1, v2 = ?format=c1v2
  http.Client? client,             // per i test (MockClient)
});
```

Regole, in ordine:

1. **Solo route con forma `c1`.** `getC1` si usa solo per le route della tabella
   §3.3 marcate "sì". Una lista bianca `kC1Routes` in `c1_config.dart`
   (`/api/marketplace-card-versions`, `/api/marketplace-artist-cards`,
   `/api/marketplace-expansions`, `/api/marketplace-home`,
   `/api/marketplace-home-page`) fa da guardia: un percorso fuori lista non
   riceve `format=`. Nessun'altra route (`marketplace-cards`, POST, autenticate) viene toccata.
2. **Interruttore.** Se `C1Config.enabled` è falso (passo g) la richiesta è
   esattamente quella di oggi, senza `format`.
3. **Parametro nell'URL, non nell'intestazione.** Aggiungere `format=c1`
   all'URL con `uri.replace(queryParameters: {...uri.queryParameters, 'format': 'c1'})`.
   Il motivo (specifica §3.2): Cloudflare e la cache di bordo usano l'URL come
   chiave e ignorano `Vary`, quindi solo il parametro tiene separate le due
   rappresentazioni. Non inviare `Accept: application/vnd.pokoin.c1+json` da solo.
   Formato 1 (`c1`) per tutte le route dell'app; `c1v2` solo se il benchmark
   mostra un guadagno sulla route (card-versions passa da 15,8 a 13,9 KB dopo
   brotli, §1.3) e solo dopo che i test del codec 5 passano.
4. **Stato prima di tutto.** Se `statusCode >= 400` il corpo è JSON normale
   (gli errori e i 405 restano `application/json`, specifica §3.2): niente
   decodifica `c1`, lo stesso comportamento di oggi.
5. **Riconoscimento.** Parsare il corpo con `jsonDecode`. È un documento `c1`
   se e solo se `isC1(parsed)` (cioè `parsed is Map` e `parsed['c1']` è `1` o
   `2`). L'intestazione `x-pokoin-format` (`c1` oppure, per le istantanee di
   lista, `c1v2`) serve come conferma e per le statistiche; **non** decide.
   Motivo: la specifica dice che il documento si marca da sé e che il client deve
   ramificare su `isC1`.
6. **JSON normale: passa invariato.** Se non è `c1` (route senza forma `c1`,
   risposta di ripiego, errore 200 con corpo normale) il valore parsato è
   restituito senza modifiche. Una richiesta con `format=c1` a una route che non
   lo sa fare risponde col JSON normale.
7. **Ripiego su errore.** Se `decodeC1` lancia (qualunque `C1Error`) e il caso
   non è risolto dal passo (c), `getC1` **rilegge la stessa route senza
   `format`** e restituisce quel JSON. Il ripiego avviene una sola volta per
   chiamata. Ogni ripiego incrementa un contatore di sessione
   (`C1Config.fallbackCount`); superata la soglia dell'interruttore automatico
   (passo g) `c1` si spegne fino al riavvio.
8. **Timeout e riprova invariati.** Il timeout del metodo di servizio resta
   quello attuale (4-12 s secondo la route). La riprova di
   `_getMarketplaceArtistCardsResponse` (`card_service.dart:3285`, una volta su
   5xx dopo 250 ms) continua a valere: `getC1` va chiamata dentro quella
   funzione, non intorno.

Punti di chiamata da modificare, ognuno con il comportamento "sostituire
`http.get(uri).timeout(t)` + `jsonDecode(response.body)` con `getC1(uri, timeout: t)`
e usare `result.json`", **preservando** il controllo `statusCode >= 400` e le
conversioni `Map<String, dynamic>.from(row)` esistenti:

| Riga (verificare con `grep -n`) | Metodo | Route | Note |
| --- | --- | --- | --- |
| `:2966` | recupero di una carta per `cardId` | `marketplace-card-versions` (`limit=1`) | risposta piccola: probabilmente non conviene (§4 d) |
| `:3039` | `getOtherVersionCards` (`sameAsCardId`, `limit=100`) | `marketplace-card-versions` | |
| `:3391` | `getCardsByExpansion` (`limit=1000`) | `marketplace-card-versions` | la risposta più grande dell'app: **primo punto da integrare** |
| `:4747` | ricerca versioni | `marketplace-card-versions` | |
| `:3154` | `getMarketplaceExpansions` | `marketplace-expansions` | |
| `:3187` | `getMarketplaceExpansionSnapshotBySlug` (`includeCards=1`, `limit=1200`) | `marketplace-expansions` | |
| `:3228` | `getMarketplaceArtistSnapshotBySlug` | `marketplace-artist-cards` | 400 righe, 822 KB grezzi nella cattura della specifica |
| `:3296` | `getMarketplaceArtistSummaries` (`summaries=1`) | `marketplace-artist-cards` | |
| `:1892-1893` | `_getMarketplaceHomeResponse` | `marketplace-home`, poi `marketplace-home-page` | oggi restituisce `http.Response`: va rifatto restituendo `C1Result`, oppure `getC1` espone anche un `http.Response` ricostruito; scegliere la via con meno diff |

Ordine di rollout consigliato: `:3391` → `:3187` → `:3228` → `:3039` → home →
resto. Ogni punto è un commit separato con il suo test (§5).

Se il passo 0 conferma F1, ogni punto qui sopra smette di usare
`Uri.base.resolve('/api/...')` e costruisce l'URI con `_marketplaceApiUri(path,
queryParameters: {...})` (`card_service.dart:25`). Il cambio è un'unica riga per
punto e fa parte dello stesso commit.

**Verifica.** Test di `getC1` con `MockClient` (§5.3): richiesta con
`format=c1`, risposta `c1`, risposta JSON normale, errore 500, documento corrotto,
codice sconosciuto. In più, per ogni punto di chiamata, il golden test del §5.2.

### Passo (c) — aggiornamento del dizionario su codice sconosciuto

**File:** `lib/services/c1/c1_client.dart`, `lib/services/c1/c1_dictionary.dart`.

**Comportamento.**

1. Un campo statico `C1Dictionary _current = kBundledC1Dictionary;` letto da
   `decodeC1`. Nessun accesso a disco, nessun `await` per leggerlo.
2. Se `decodeC1` lancia `C1UnknownCodeError`: eseguire **una sola** rilettura
   del dizionario per versione, con richieste concorrenti unite (un unico
   `Future` in volo):
   1. `GET /api/dictionary?v=<payload['dict']>` se `payload['dict']` è una
      stringa non vuota: risposta immutabile, una richiesta per sempre.
      Un `409` (versione non più corrente) o un errore di rete passano al punto 2;
   2. `GET /api/dictionary` (corrente; `ETag: "c1-dict-<versione>"`).
   Valida con `C1Dictionary.fromJson`: `format == 'c1'`, `codeBase == 1`,
   `appendOnly == true`, `tables` presente.
3. **Regola append-only.** Il nuovo dizionario sostituisce quello corrente solo
   se `int.parse(nuova.version) >= int.parse(corrente.version)` e se ogni tabella
   contiene come prefisso le voci della precedente. Se non è così, il dizionario
   è rifiutato come corrotto (le voci non si rinumerano mai: una violazione è un
   errore del server, da segnalare) e si passa al ripiego del passo (b), punto 7.
4. Dopo l'aggiornamento: ritentare `decodeC1` **una volta** sullo stesso
   documento già scaricato (nessuna nuova richiesta della route). Se fallisce di
   nuovo: ripiego su JSON normale.
5. Su successo, scrivere il dizionario in Hive in background
   (`pokoin_cache_meta`, chiave `c1_dictionary_v<versione>`), in un `unawaited`
   con `try/catch`. All'avvio **successivo** l'app può leggerlo una volta, dopo il
   primo frame, e adottarlo se la versione è più nuova della costante. Non si
   legge mai dal disco mentre si decodifica una risposta.
6. Proattivo, facoltativo: se `payload['dict']` è diverso dalla versione corrente,
   avviare l'aggiornamento in background anche quando la decodifica riesce
   (documento codificato contro un dizionario più nuovo ma con soli codici noti).
   Con la regola append-only la decodifica con un dizionario più vecchio
   riesce sui codici che conosce.

**Verifica.** Test (§5.4): documento con `p: [9999]` e `t: "nationalities"` →
`C1UnknownCodeError` → il client rilegge `/api/dictionary` (finto) → ritenta →
esito corretto; dizionario di risposta con versione più bassa → rifiutato;
`409` sulla versione fissata → ripiego sul dizionario corrente.

### Passo (d) — dove gira la decodifica

**Decisione.** Per corpi `c1` **piccoli** (meno di `kC1IsolateThresholdBytes`)
parsing e decodifica girano sul thread UI; per corpi **grandi** girano in un isolate
in background, e all'isolate si passano i **byte** del corpo.

Soglia iniziale: **64 KB di corpo `c1`** (circa il corpo di
`marketplace-card-versions` charizard, 79 KB, che resterebbe in isolate; la
pagina di ricerca da 21 KB e `marketplace-home` no). È un valore di partenza
**non misurato su Dart**: il benchmark (§6) lo conferma o lo corregge.

Motivo. Il budget di un fotogramma a 60 Hz è 16,7 ms. `jsonDecode` più la
ricostruzione di centinaia di righe su un telefono di fascia bassa può
avvicinarsi a quel valore; una sola decodifica lunga sul thread UI produce
fotogrammi saltati proprio mentre una schermata sta comparendo. Un isolate
costa un po' di avvio per chiamata, quindi non conviene per risposte piccole.
Nel browser la decodifica di `c1` è paragonabile a `JSON.parse` (§1.3), ma il
browser non la porta sul thread principale in un worker; per questo la soglia
non può essere copiata dal web.

Comportamento:

```dart
Future<Object?> _decodeBody(Uint8List bytes, C1Dictionary dictionary) {
  if (bytes.length < C1Config.isolateThresholdBytes) {
    return Future.value(_parseAndDecode(bytes, dictionary));       // thread UI
  }
  return Isolate.run(() => _parseAndDecode(bytes, dictionary));    // isolate
}
Object? _parseAndDecode(Uint8List bytes, C1Dictionary d) {
  final parsed = jsonDecode(utf8.decode(bytes));
  return isC1(parsed) ? decodeC1(parsed as Map<String, dynamic>, dictionary: d) : parsed;
}
```

Note per l'agente:

- Passare `bodyBytes` (non `body`) all'isolate evita di copiare una stringa
  UTF-16 grande. `Isolate.run` restituisce il risultato senza copia profonda
  (`Isolate.exit`): **da verificare con il benchmark** che non appaia comunque
  un costo di trasferimento sul risultato.
- `C1Dictionary` deve essere inviabile a un isolate: solo `String`, `List`,
  `Map`, `int` (nessuna chiusura, nessun oggetto di Flutter). Il `const` lo è.
- Una `C1Error` lanciata nell'isolate riemerge nel chiamante come eccezione dello
  stesso tipo solo se la classe è inviabile; in caso contrario arriva come
  `RemoteError`. L'agente verifica con un test (§5.4) e, se serve, cattura
  l'errore **dentro** l'isolate e restituisce un valore `{error: 'unknown_code',
  table:..., code:...}`.
- Anche per i corpi **normali** (senza `format`, quindi ripiego) il parsing grande
  può usare lo stesso isolate: conviene farlo ora che l'infrastruttura c'è, ma è
  fuori dall'ambito di questa guida se cambia il comportamento delle schermate
  non toccate.
- Su Flutter web non esistono isolate nel senso nativo: lì `Isolate.run` può non
  essere disponibile. Se il target web fa parte della build, `c1_client.dart`
  usa un import condizionale e decodifica sul thread principale (**da verificare**).

### Passo (e) — cache in memoria delle risposte decodificate e del libro del negozio

**File:** `lib/services/c1/c1_cache.dart`.

**Cosa si mette in cache.** Il JSON già decodificato (`Object?`), a monte di
`_cardFromVersionRow`, con chiave = URL completo **senza** `format`
(`format=c1` e JSON normale danno gli stessi dati, quindi la chiave è la
richiesta logica). Non sostituisce il box Hive di `card_service.dart`
(`marketplace_card_list_cache`, 3 giorni), che tiene le `PokemonCard` già
convertite per uso fuori rete.

Regole:

1. **Validità.** Il TTL è `min(max-age da cache-control della risposta, 60 s)`;
   senza `cache-control` leggibile, 20 s. Motivo: i valori di `max-age` del server
   sono 10 s (home), 20 s (`card-versions`), 60 s (`artist-cards`,
   `expansions`) e la cache del client non deve rendere i dati più vecchi di
   quanto il server già ammette.
2. **Espulsione LRU con peso.** Il peso di una voce è `lunghezza del corpo c1 in
   byte × kC1DecodedWeightFactor`. Il fattore iniziale è **6**: è un'ipotesi
   di lavoro **non misurata**; il benchmark (§6, memoria di picco) lo calibra
   misurando heap prima/dopo. Tetto rigido: **24 MB di peso complessivo**
   e **16 voci**; superato il tetto si espelle dalla meno usata di recente. Una
   singola voce più pesante del 50% del tetto non entra in cache.
3. **Condivisione e sola lettura.** Il valore in cache è **lo stesso oggetto**
   restituito a ogni chiamante, e i valori decodificati sono condivisi (§2.9):
   nessun chiamante muta in loco né il valore restituito né i suoi oggetti
   annidati. Tutto il codice esistente che modifica una riga la copia prima
   (`Map<String, dynamic>.from(row)`); l'agente controlla con `grep` che
   nessun metodo di `card_service.dart` scriva su `row[...] = ` prima di quella
   copia. In modalità debug la cache può restituire una vista congelata
   (funzione `deepFreeze` solo per i test e per `assert`) per far fallire
   subito una mutazione involontaria.
4. **Richieste in volo.** Le richieste identiche concorrenti condividono lo
   stesso `Future` (come fa `sellerShopInflight` in `market/src/api.js`).
5. **Le risposte `c1` e normali non si mescolano** perché la chiave non contiene
   `format` e il valore è lo stesso JSON.
6. **Cosa non si mette in cache:** risposte con `statusCode >= 400`, risposte
   con `cache-control: private` o `no-store` (il libro del negozio, sotto),
   risposte autenticate, e le richieste in cui è intervenuto il ripiego dopo un
   errore di decodifica.

**Libro del negozio venditore (oggi nessun consumatore nell'app, D8).**
`GET /api/marketplace-seller-shop?sellerUsername=<u>&book=1&format=c1v2[&sellerUid=<uid>][&game=<g>]`
restituisce **tutte** le inserzioni del venditore in una sola risposta
(`book: true`, `listings`, `total`, `unique`, `copies`, `maxUpdatedAt`,
`limit`, `offset: 0`, `seller`, `game`), con `cache-control: private,
no-store`. Il server lo costruisce una volta e lo serve da un libro memorizzato
(`seller_book.rs`). Se l'app lo adotterà, valgono queste regole:

- **Una sola voce** (o due) in memoria, chiave `(sellerUsername, game)`; mai su
  disco. Un libro da 9.981 inserzioni era 1,35 MB come `c1v2` (circa 425 KB sul
  filo) e 8 MB come JSON normale: si tiene il **decodificato**, non il testo.
- **Rinfresco:** `maxUpdatedAt` è il timbro dell'ultima modifica; l'app rifà la
  richiesta quando la schermata torna in primo piano e sostituisce la voce se il
  timbro è cambiato. Il server risponde col libro memorizzato e ne ricostruisce uno
  nuovo in background se il timbro si è mosso (`seller_book.rs`, intestazione del
  file).
- **Filtri e ordinamenti in locale**, come fa il sito: il porting di
  `market/src/seller-shop-filter.js` (150 righe) calcola una volta per libro le
  chiavi (prezzo numerico, nome minuscolo, quantità, date, testo di ricerca) e
  una volta per ordinamento (`price-desc`, `qty`, `name`, `price-asc`)
  l'ordine, poi ogni filtro è un solo passaggio. I filtri (`q`, `condition`
  con la mappa `NM→[NM,M]`, `SP→[SP,LP]`, `MP`, `PL→[PL,HP]`, `POOR→...`,
  `language` per prefisso maiuscolo, `reverse`, `firstEdition`, `rarity` con le
  regole di `matchesRarity`) hanno le stesse regole del server
  (`seller.rs`). Il libro decodificato si decodifica in un isolate (passo d) e
  si indicizza lì.
- Non fa parte del piano base: l'agente lo implementa solo se la collega lo
  chiede (D8).

**Verifica.** Test §5.5: TTL, espulsione per peso, tetto di voci, condivisione
dello stesso oggetto, nessuna cache su `>= 400`, richieste in volo unite.

### Passo (f) — cosa tenere in RAM e cosa no

| Cosa | In RAM | Perché |
| --- | --- | --- |
| Dizionario `kBundledC1Dictionary` | sì, per sempre (costante) | 2.902 byte di sorgente JSON, nessuna lettura di disco sul percorso caldo |
| Dizionario aggiornato dalla rete | sì, per la sessione | stessa ragione; una sola istanza |
| JSON decodificato delle ultime risposte (§4 e) | sì, con tetto | evita richieste e decodifiche ripetute |
| Testo o byte del corpo `c1` | **no**, dopo la decodifica | il decodificato lo sostituisce; i byte non servono più |
| Tabelle `t` intermedie | **no** | servono solo durante `decodeC1` |
| Il libro del negozio | sì, una sola voce, solo decodificato | §4 e |
| Indici del filtro del libro | sì, insieme alla sua voce | si buttano con essa |
| `PokemonCard` convertite | come oggi (Hive su disco + liste dei provider) | invariato |
| Risposte `private`/`no-store`, autenticate | **no** | |

**Stima di memoria e tetto rigido.** L'unica stima basata su numeri letti è
che il libro intero decodificato rappresenta gli stessi 9.981 oggetti del
JSON da 8 MB; la dimensione in memoria degli oggetti Dart **non è stata
misurata**. Per questo il tetto è definito in peso (§4 e): **24 MB di peso
con fattore iniziale 6** (circa 4 MB di corpo `c1` equivalenti, il triplo del
libro più grande misurato), da calibrare. Se il benchmark mostra che il picco
RSS dell'app supera quello della versione vecchia di oltre 10 MB (soglia del
§6.5), il tetto si abbassa a 12 MB e si riesegue. L'agente non alza mai il
tetto senza una misura.

### Passo (g) — interruttore

**File:** `lib/services/c1/c1_config.dart`.

```dart
abstract final class C1Config {
  /// Interruttore principale. false = tutte le richieste tornano a JSON normale.
  static bool enabled = const bool.fromEnvironment('POKOIN_C1', defaultValue: true);
  static const int isolateThresholdBytes = 64 * 1024;
  static const int maxFallbacksPerSession = 3;
  static int fallbackCount = 0;
  static bool get active => enabled && fallbackCount < maxFallbacksPerSession;
}
```

- **Costante di compilazione.** `--dart-define=POKOIN_C1=false` produce una
  build che non chiede mai `c1` (tutto il codice del decoder resta compilato ma
  non raggiunto). È l'interruttore di emergenza: un rilascio con la costante a
  `false` riporta il comportamento attuale **senza toccare il server**.
- **Interruttore automatico.** Dopo `maxFallbacksPerSession` ripieghi nella
  stessa sessione `active` diventa falso fino al riavvio: un documento che il
  decoder non sa leggere non deve costare una seconda richiesta per ogni chiamata.
- **Flag remoto.** Nessun pacchetto di configurazione remota è in `pubspec.yaml`
  (A9). Un flag remoto richiede una scelta della collega (Firestore o un pacchetto
  nuovo): l'agente lo propone e non lo implementa senza risposta. Il decoder
  espone `C1Config.enabled` come variabile scrivibile proprio per quel caso.
- **Ritorno al JSON normale lato server:** nessuna operazione. Le route
  rispondono JSON normale a ogni richiesta senza `format`, e questo non richiede
  un rilascio del server (specifica "Backing out").

**Verifica.** Test §5.3: con `enabled = false` l'URL richiesto non contiene
`format`; con 3 ripieghi `active` è falso.

---

## 5. Test di correttezza

Tutti i comandi si lanciano da `pokemon_card_vault/` nel repository cardvault.
Il SDK Flutter richiesto è quello di `pubspec.lock` (Flutter `>=3.44.0`, Dart
`>=3.12.0`).

```sh
flutter pub get
flutter analyze lib/services/c1 test/c1
flutter test test/c1                         # tutti i test c1
flutter test test/c1/c1_decoder_test.dart    # decoder, codec, errori
flutter test test/c1/c1_golden_test.dart     # c1 contro JSON normale, per ogni route
flutter test test/c1/c1_client_test.dart     # richiesta, ripiego, interruttore, dizionario
flutter test test/c1/c1_cache_test.dart      # cache e peso
flutter test                                 # l'intera suite, prima e dopo
```

### 5.1 Test del decoder (`c1_decoder_test.dart`)

Portare uno a uno i test di `market/src/compact.test.js`:

- `isC1`: `{c1:1,...}` e `{c1:2}` sì; `{c1:3}`, `[]`, `null`, `'c1'`, `{cards: []}` no.
- Tabella in ordine di colonna: l'esempio svolto del §2.11, confrontato con
  `jsonEncode(decoded) == jsonEncode(expected)` (stringhe: l'ordine delle chiavi conta).
- Palette con letterale (`rarities`, `[2, 'WCD 2006']`).
- Maschera di presenza.
- Vettore.
- Scheletro con `$c1x`.
- Template (formato 2), con l'esempio del test "template columns rebuild values
  from other columns of the row" (3 righe, due forme, riferimento a un template,
  colonna con maschera) e `c1Slug` con i tre casi del §2.6.
- Errori, uno per messaggio: versione non supportata, `missing body`, `t is not
  an array`, tabella fuori intervallo, lunghezza non coerente, riferimento in
  avanti, codice sconosciuto (`refetch /api/dictionary`), prefisso sconosciuto,
  codec sconosciuto, "absent cells", documento non oggetto, template che legge
  una colonna non decodificata.
- Dizionario vecchio: con `nationalities: ['western']` il documento con codici
  `[1, 2]` lancia `C1UnknownCodeError`; con il dizionario incluso passa.
- Differenze del §2.12: delta fuori da ±(2^53-1) → errore; `ns` con un `double` →
  errore; maschera con un valore non numerico → riga assente.

### 5.2 Test golden contro il JSON normale

**Cosa si prova.** Per ogni route della tabella §3.3 marcata "sì" e per le
route `c1` che l'app non chiama ma che il decoder deve saper leggere, il
documento `c1` decodificato è **identico** al JSON normale della stessa
richiesta, con lo stesso ordine delle chiavi.

**Fixture già pronte.** In `pokoin`, `docs/handoff/compact-c1/` contiene 11
risposte catturate in produzione (`fixtures/*.json`, 2.047.472 byte in totale) e
le stesse codificate dall'encoder Rust (`c1/*.c1.json`, formato 1):
`artist-arita`, `card-versions-card`, `card-versions-expansion`,
`card-versions-pikachu`, `expansion-base-set`, `expansion-destined-rivals`,
`home-page`, `rails-best-sellers`, `rails-new-cards`, `rails-spotlight`,
`search-charizard`. L'agente le copia in `test/fixtures/c1/` **così come sono** e
scrive un test per ogni coppia:

```dart
for (final name in kFixtureNames) {
  test('decodeC1 ricostruisce $name esattamente', () {
    final expected = jsonDecode(File('test/fixtures/c1/fixtures/$name.json').readAsStringSync());
    final payload  = jsonDecode(File('test/fixtures/c1/c1/$name.c1.json').readAsStringSync()) as Map<String, dynamic>;
    expect(payload['c1'], 1);
    expect(payload['dict'], kBundledC1Dictionary.version);
    expect(jsonEncode(decodeC1(payload)), jsonEncode(expected));   // stringhe, non uguaglianza profonda
  });
}
```

Le fixture sono vecchie catture della specifica: coprono i codec 0-4, non il
codec 5, e non includono `marketplace-expansions`, `marketplace-home` né
`marketplace-artist-cards?summaries=1`. Per quelle e per il formato 2 si
catturano fixture nuove.

**Catturare fixture nuove da produzione con `curl`.** Da una macchina che
raggiunge `api.pokoin.com` (l'ambiente che ha scritto la guida non poteva).
Solo GET pubblici, nessuna credenziale, nessun POST, nessun carico:

```sh
mkdir -p test/fixtures/c1/live && cd test/fixtures/c1/live
BASE=https://api.pokoin.com/api
cap () {   # $1 nome, $2 percorso con query (senza format)
  curl -s -H 'accept-encoding: identity' "$BASE/$2" -o "$1.json"
  curl -s -H 'accept-encoding: identity' -D "$1.c1.headers" "$BASE/$2$([[ $2 == *\?* ]] && echo '&' || echo '?')format=c1"   -o "$1.c1.json"
  curl -s -H 'accept-encoding: identity' "$BASE/$2$([[ $2 == *\?* ]] && echo '&' || echo '?')format=c1v2" -o "$1.c1v2.json"
}
cap card-versions-set     "marketplace-card-versions?expansionName=Base%20Set&productType=card&limit=1000"
cap card-versions-same    "marketplace-card-versions?sameAsCardId=<ID>&productType=card&limit=100"
cap expansions-index      "marketplace-expansions?limit=1000"
cap expansions-includecards "marketplace-expansions?slug=<SLUG>&includeCards=1&productType=card&limit=1200"
cap artist-cards          "marketplace-artist-cards?artistSlug=<SLUG>&limit=300"
cap artist-summaries      "marketplace-artist-cards?summaries=1&limit=1000"
cap home                  "marketplace-home"
cap home-page             "marketplace-home-page"
curl -s "$BASE/dictionary" -o dictionary.json
```

Note per l'agente:

- Sostituire `<ID>` e `<SLUG>` con valori letti da una risposta reale (per esempio
  un `card_id` da `card-versions-set.json`, uno slug da `expansions-index.json`).
- `accept-encoding: identity` serve a ottenere il corpo non compresso, così le
  due catture sono confrontabili byte per byte; la dimensione compressa si misura
  nel §6.
- Il JSON normale e il `c1` vanno catturati **a pochi secondi di distanza**: le
  route hanno `max-age` da 10 a 60 secondi e i dati possono cambiare tra le due.
  Se il confronto fallisce, ricatturare prima di sospettare il decoder.
- Controllare nell'intestazione salvata (`*.c1.headers`) `content-type:
  application/json; charset=utf-8` e `x-pokoin-format: c1`; è la verifica D6.
- Non committare dati personali: le route sopra sono pubbliche e senza utente.
- Le fixture da 800 KB sono grandi: tenerne al massimo una per route; limitare
  `limit=` per tenerle sotto 300 KB quando non serve il caso massimo.

**Confronto nel test.** Per ogni fixture nuova: `jsonEncode(decodeC1(c1)) ==
jsonEncode(plain)` e lo stesso per `c1v2`. Se il confronto per una route fallisce
per un campo che cambia tra le due richieste (timestamp, prezzi), il test
confronta le due letture dopo aver tolto quei campi, e lo dichiara in un commento
con il nome del campo.

Per le route che l'app non chiama (`marketplace-search-page`,
`marketplace-expansion-page`, `marketplace-list`, `marketplace-suggest`) le
fixture del repository `pokoin` bastano; aggiungere una cattura nuova solo se il
decoder deve leggere un formato 2 di quelle route:

```sh
cap search-page   "marketplace-search-page?query=pikachu&limit=5&productType=card"
cap suggest       "marketplace-suggest?q=pika"
cap list-set      "marketplace-list?kind=set&key=<SLUG>"
```

### 5.3 Test del client (`c1_client_test.dart`)

Con `MockClient` di `package:http/testing.dart` (già usato in
`test/flutter_debug_log_test.dart`), riprodurre i test di `market/src/api-c1.test.js`:

- `getC1` chiede `…&format=c1` (o `?format=c1` se non c'è query) e restituisce il
  JSON normale decodificato; la query originale resta intatta.
- Risposta JSON normale: restituita invariata, `wasC1 == false`, `decodeC1` non
  chiamata.
- Risposta con `statusCode >= 400`: nessuna decodifica, `statusCode` preservato.
- Documento `c1` non decodificabile: seconda richiesta **senza** `format`,
  risultato di quella; `fallbackCount` incrementato.
- Errore di rete o timeout: l'eccezione risale come oggi (nessun ripiego
  silenzioso a metà).
- Route fuori da `kC1Routes`: nessun `format` aggiunto.
- `C1Config.enabled = false`: l'URL richiesto è esattamente quello originale.
- Tre ripieghi: `C1Config.active == false`; la quarta chiamata non chiede `c1`.
- Intestazione `x-pokoin-format: c1` con corpo JSON normale: nessuna eccezione, JSON passa.

### 5.4 Test dei percorsi di codice sconosciuto e di ripiego

- Documento con `{"c":2,"t":"nationalities","p":[9999],"x":[0]}`: `getC1`
  rilegge `/api/dictionary?v=<dict>` (finto), valida, ritenta la decodifica e
  restituisce il risultato corretto **senza** rifare la richiesta della route.
- Il finto `/api/dictionary` risponde 409: `getC1` prova `/api/dictionary`
  (corrente).
- Il finto dizionario ha versione più bassa o una tabella accorciata: rifiutato,
  ripiego su JSON normale.
- Due documenti con codice sconosciuto in volo insieme: **una** sola richiesta di
  dizionario.
- Documento grande (oltre la soglia): decodifica in isolate; un `C1UnknownCodeError`
  nell'isolate arriva al chiamante come `C1UnknownCodeError` (o, se non
  inviabile, come errore gestito dentro l'isolate e rilanciato: §4 d).
- Il dizionario nuovo scritto su Hive non viene mai letto durante `decodeC1`.

### 5.5 Test di proprietà per codec

Test generativi con `Random(seed)` fisso (il seed è registrato nel nome del test).
Non esiste in Dart un encoder `c1`: per ogni codec il test costruisce da una
colonna di valori una colonna codificata **a mano** nel test, la decodifica con
`decodeC1` e confronta con i valori di partenza.

| Codec | Proprietà |
| --- | --- |
| 0 | per ogni `n` in `0..50` e valore (stringa, intero, `null`, oggetto, lista): la tabella ha `n` righe uguali |
| 1 | colonna di lunghezza = numero di righe presenti, con maschera casuale: i valori finiscono solo sulle righe presenti, nell'ordine |
| 2 | palette casuale e indici casuali: ogni valore è `p[x[i]]`; con `t` e codici validi, ogni valore è `tabella[codice-1]`; stringhe letterali restano invariate; un indice fuori intervallo lancia |
| 3 | sequenza casuale di interi (anche negativi, anche con delta 0): `z` e `d` ricostruiscono la sequenza; con `ns`, la sequenza delle stringhe decimali; fuori da ±(2^53-1) lancia |
| 4 | per ogni colonna `r` casuale (con maschera): la colonna che la riferisce ha gli stessi residui e la stessa maschera; un `r` in avanti lancia |
| 5 | per slot, forme e letterali casuali con testi ASCII e non ASCII: il risultato è `letterale + testo/slug + ...`; uno slot assente lancia |
| affissi | `pre`/`suf` letterali e `prei`/`sufi` da 1 a 9: stringa attesa; un codice fuori tabella lancia |
| maschera | per maschere casuali (anche tutte `0` e tutte `1`): le righe assenti non hanno la chiave e le altre hanno l'ordine delle colonne |

Un ultimo test di invarianti: per ogni fixture, il numero di righe di ogni tabella
del documento è uguale alla lunghezza dell'array corrispondente nel JSON normale
e la serializzazione conserva l'ordine delle chiavi.

### 5.6 Test della cache (`c1_cache_test.dart`)

TTL da `cache-control`, espulsione per peso (inserire voci fino al tetto),
tetto di voci, richieste in volo unite, nessuna cache su `>= 400` e su
`private/no-store`, condivisione dello stesso oggetto (`identical(a, b)`), e in
debug la vista congelata che lancia alla mutazione.

### 5.7 Regressione

`flutter analyze` e `flutter test` interi passano come prima (D7). I test
esistenti di `card_service_test.dart` e `marketplace_top_search_test.dart` non
devono cambiare.

---

## 6. Benchmark tra vecchia e nuova versione

**Domanda a cui risponde.** La nuova versione (decoder `c1` attivo, passi a-g) è
migliore della vecchia (stesso codice con `POKOIN_C1=false`) sulle schermate
che usano le route di §3.3, in byte, tempo, memoria e fluidità? L'agente non
dichiara riuscita l'integrazione senza questi numeri.

### 6.1 Cosa si confronta

- **Vecchia:** build dell'SHA di partenza annotato al passo 0, oppure la build
  nuova con `--dart-define=POKOIN_C1=false` (equivalente: stesso codice, `c1`
  spento). Si usa la seconda per il confronto "a parità di codice" e la prima come
  controllo che la nuova build con `c1` spento non regredisca.
- **Nuova:** stessa build con `--dart-define=POKOIN_C1=true`.
- Se F1 è reale e la collega ha deciso di correggere l'URL base solo nella build
  di confronto, **entrambe** le build lo includono.

### 6.2 Cosa si misura e come

| Metrica | Come | Strumento |
| --- | --- | --- |
| Byte sul filo, per richiesta | somma di intestazioni e corpo ricevuti, e `content-encoding` | DevTools → Network (profile), oppure proxy TLS (mitmproxy/Charles) sul dispositivo |
| Byte grezzi dopo decompressione | lunghezza del corpo che arriva a `jsonDecode` | `Stopwatch` + `bytes.length` in un log di prova |
| Tempo al primo dato utilizzabile | da `getC1()` chiamata al primo `setState`/aggiornamento del provider con i dati della schermata | `Stopwatch`, e `dart:developer` `Timeline.startSync/finishSync` con nomi `c1.request`, `c1.parse`, `c1.decode`, `c1.convert` |
| Tempo di decodifica | `jsonDecode` e `decodeC1` separati; versione vecchia: solo `jsonDecode` | `Timeline` + `Stopwatch` |
| Memoria di picco | heap Dart, memoria esterna e RSS prima e dopo la schermata, con istantanea di Memory | DevTools → Memory; su Android anche `adb shell dumpsys meminfo com.vitologic.pokoin` |
| Fotogrammi saltati | numero di fotogrammi oltre 16,7 ms (60 Hz) o 8,3 ms (120 Hz) durante il caricamento della schermata | DevTools → Performance (profile) o `flutter drive --profile` con `traceAction` |
| Stato di successo | numero di ripieghi e di errori | contatori `C1Config.fallbackCount`, log |

L'agente aggiunge i `Timeline`/`Stopwatch` in `c1_client.dart` dietro un flag di
debug; nessun log di benchmark resta in produzione.

### 6.3 Su quali schermate e richieste

Le richieste in tabella con la dimensione attesa dalla specifica (non misurata
sull'app):

| Scenario | Richiesta | Dimensione grezza di riferimento (JSON → `c1`) |
| --- | --- | --- |
| Set con molte carte (`getCardsByExpansion`) | `marketplace-card-versions?expansionName=…&productType=card&limit=1000` | 325 KB → 79 KB (charizard); 397,7 KB → 83,4 KB (espansione, specifica §4) |
| Pagina di un set (`getMarketplaceExpansionSnapshotBySlug`) | `marketplace-expansions?slug=…&includeCards=1&limit=1200` | da misurare (D5) |
| Artista con molte carte | `marketplace-artist-cards?artistSlug=…&limit=300` | 822,2 KB → 164,4 KB (arita, specifica §4) |
| Altre versioni di una carta | `marketplace-card-versions?sameAsCardId=…&limit=100` | da misurare |
| Home | `marketplace-home`, `marketplace-home-page` | 111,4 KB → 13,6 KB (`home-page`, specifica §4) |
| Indici | `marketplace-expansions?limit=1000`, `marketplace-artist-cards?summaries=1` | da misurare |

Schermate: `collection_screen.dart` (set, indici espansioni e artisti),
`card_versions_screen.dart`, `artist_collection_screen.dart`, la home
(`home_screen.dart` via `card_provider.dart`). L'agente conferma quali schermate
usano quali richieste con D4.

### 6.4 Esecuzioni, caldo e freddo

- **Freddo:** processo avviato da zero (`adb shell am force-stop
  com.vitologic.pokoin` e riavvio), cache Hive svuotata
  (`adb shell pm clear com.vitologic.pokoin` o disinstallazione), cache in memoria
  vuota, prima richiesta della sessione. **10 esecuzioni** per richiesta e per
  versione.
- **Caldo:** stessa richiesta ripetuta senza riavviare, ma oltre il TTL
  della cache in memoria (§4 e) per misurare di nuovo rete e decodifica, e una
  serie **entro** il TTL per misurare la cache. **30 esecuzioni** per richiesta
  e per versione, scartando la prima.
- Alternare le versioni (A, B, A, B, ...) per non far coincidere una versione con
  un periodo di rete migliore.
- Riportare **mediana e 95° percentile**, mai la media. Nessuna esecuzione
  scartata in silenzio: se se ne scarta una, la riga della tabella lo dice.

### 6.5 Classi di dispositivi

| Classe | Esempio di criterio | Perché |
| --- | --- | --- |
| Bassa | Android con 3-4 GB di RAM, SoC di fascia entry, Android 8 (il `minSdk` è 26: A7/`android/app/build.gradle*`) | è dove la decodifica sul thread UI costa di più |
| Media | Android con 6-8 GB, SoC di fascia media | il caso tipico |
| Alta | iPhone recente | riferimento; iOS ha un deployment target 12.0 |

Almeno un dispositivo fisico per classe. Gli emulatori non valgono per tempi e
memoria.

### 6.6 Come mantenere il confronto equo

1. **Stessa rete.** Stesso Wi-Fi e stesso momento, e in più un profilo di rete
   lenta riproducibile (per esempio 1,6 Mbit/s e 150 ms di latenza con un proxy
   di throttling o con le impostazioni di rete del dispositivo). I numeri di
   Wi-Fi veloce e di rete lenta stanno in due tabelle separate.
2. **Build `--profile`** (`flutter run --profile` o `flutter build apk --profile`).
   Mai `--debug`: i tempi di debug non significano nulla.
3. **Stesso dato.** Stessi identificatori e slug per le due versioni; la risposta
   è servita dalla cache di bordo in entrambe (ripetere la richiesta una volta
   prima di misurare, e registrare `cf-cache-status` se presente).
4. **Stato del dispositivo.** Modalità aereo spento, batteria oltre il 50%,
   nessuna app in primo piano, luminosità e risparmio energetico fissati,
   dispositivo a temperatura ambiente tra una serie e l'altra.
5. **Stessa configurazione di sessione.** Utente non autenticato (le route
   sono pubbliche), stesso `MARKETPLACE_API_BASE_URL`.
6. **Compressione.** Registrare `accept-encoding` e `content-encoding`
   (D2/D3). Se la versione vecchia ricevesse brotli e la nuova gzip, o viceversa,
   la differenza non sarebbe attribuibile a `c1`.
7. **Una variabile per volta.** Lo stato "c1 attivo, decodifica sul thread UI
   (soglia altissima)" e "c1 attivo, isolate (soglia 64 KB)" si confrontano
   separatamente per validare il passo (d).

### 6.7 Strumenti

- **Flutter DevTools**: Performance (fotogrammi, `Timeline`), Memory
  (istantanee e RSS), Network (profile, `dart:io`), App Size.
- **`Stopwatch`** per le durate in codice; **`dart:developer`** `Timeline.startSync`
  e `Timeline.finishSync` con i nomi del §6.2, visibili in DevTools e nei file
  di traccia.
- **Test di integrazione** in `integration_test/` (la cartella non esiste, A8):
  uno scenario per richiesta del §6.3 che apre la schermata, attende il primo dato
  e registra i tempi con `IntegrationTestWidgetsFlutterBinding.traceAction` e
  `reportTimeline`. Si lancia con:

  ```sh
  flutter drive --profile --driver=test_driver/perf_driver.dart \
    --target=integration_test/c1_benchmark_test.dart -d <dispositivo> \
    --dart-define=POKOIN_C1=true            # e poi =false
  ```

- Avvio e dimensione: `flutter run --profile --trace-startup -d <dispositivo>`
  (scrive `build/start_up_info.json`) e `flutter build apk --release
  --analyze-size --target-platform android-arm64` per l'impatto del decoder sulla
  dimensione dell'app. Il decoder non aggiunge risorse (la costante del dizionario
  è di pochi KB di codice).
- Dimensioni del filo per l'intera sessione: mitmproxy/Charles con il certificato
  di debug sul dispositivo di prova.

### 6.8 Modello della tabella dei risultati

Una tabella per dispositivo e per profilo di rete; ogni cella riporta
**mediana (p95)**. Le celle in corsivo sono da riempire.

| Richiesta | Esecuzione | Versione | Byte sul filo | Byte grezzi | Tempo al primo dato (ms) | Decodifica (ms) | RSS di picco (MB) | Fotogrammi saltati |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| card-versions, set | freddo | vecchia (`POKOIN_C1=false`) | *…* | *…* | *…* | *…* (solo `jsonDecode`) | *…* | *…* |
| card-versions, set | freddo | nuova | *…* | *…* | *…* | *…* (`jsonDecode` + `decodeC1`) | *…* | *…* |
| card-versions, set | caldo | vecchia | *…* | *…* | *…* | *…* | *…* | *…* |
| card-versions, set | caldo | nuova | *…* | *…* | *…* | *…* | *…* | *…* |
| artist-cards | freddo / caldo | vecchia / nuova | *…* | *…* | *…* | *…* | *…* | *…* |
| expansions `includeCards` | freddo / caldo | vecchia / nuova | *…* | *…* | *…* | *…* | *…* | *…* |
| home | freddo / caldo | vecchia / nuova | *…* | *…* | *…* | *…* | *…* | *…* |

Riga di riepilogo per dispositivo:

| Dispositivo | Classe | OS | Build (SHA) | Rete | Data |
| --- | --- | --- | --- | --- | --- |
| *…* | *…* | *…* | *…* | *…* | *…* |

### 6.9 Soglie di superamento

Sono **proposte** per questa integrazione; la collega le conferma o le cambia
prima di iniziare. Si valutano sulle richieste del §6.3 che superano 50 KB grezzi
(le piccole possono non guadagnare nulla senza che sia un difetto), per ogni
classe di dispositivi, a mediana.

| # | Criterio | Soglia di superamento |
| --- | --- | --- |
| 1 | Byte sul filo | la nuova versione ne usa **almeno il 25% in meno** della vecchia sulle richieste grandi, con la stessa codifica di trasferimento. Riferimento da misurare in gzip (§1.3): da -36% a -57% sulle fixture |
| 2 | Tempo al primo dato, rete lenta | la nuova non è **peggiore** della vecchia; deve migliorare di almeno il 10% sulle richieste grandi |
| 3 | Tempo al primo dato, rete veloce | la nuova è peggiore **al più del 5%** (p95 compreso) |
| 4 | Decodifica | `jsonDecode` + `decodeC1` della nuova non supera **1,5×** il solo `jsonDecode` della vecchia sulla stessa richiesta; fuori dal thread UI, il tempo bloccante sul thread UI scende sotto 4 ms |
| 5 | Memoria di picco | RSS di picco della nuova al più **+10 MB** rispetto alla vecchia, sullo stesso scenario |
| 6 | Fluidità | **nessun** fotogramma saltato in più, attribuibile alla decodifica, durante il caricamento di una schermata (confronto delle tracce) |
| 7 | Correttezza | 0 ripieghi e 0 errori di decodifica sulle 30 esecuzioni calde di ogni richiesta; golden test tutti verdi |
| 8 | Nessuna regressione | `flutter test` intero uguale alla base di partenza (D7) |

Esito: **superato** se tutti gli 8 criteri sono soddisfatti su almeno le classi
bassa e media. Un criterio fallito va nel rapporto con il numero e con la causa
probabile. Se il criterio 4, 5 o 6 fallisce, l'agente prova prima il passo (d)
(soglia e isolate) e il tetto del passo (f); se il criterio 1 non è soddisfatto
perché il filo porta gzip e il guadagno è sotto soglia, riporta il numero e
lascia la decisione alla collega: l'interruttore (§4 g) è lì per questo.

---

## 7. Criteri di accettazione e consegna

### 7.1 Lista di accettazione

- [ ] Il ramo di lavoro parte dall'SHA annotato e non tocca `pokoin`.
- [ ] D1 eseguita: l'esito su F1 (URL base nativo) è registrato in
      `audit/C1-AUDIT.md`, e i punti di chiamata di §4 usano un URL che raggiunge
      `api.pokoin.com`.
- [ ] D2, D3 e D6 eseguite: `accept-encoding`, `content-encoding`,
      `content-type`, `x-pokoin-format`, `vary` e `cache-control` reali sono
      registrati.
- [ ] `lib/services/c1/c1_decoder.dart` e `c1_dictionary.dart` esistono; il
      dizionario è una costante `const` identica a `market/src/compact-dictionary.json`
      (versione `"1"`) e il test di uguaglianza passa.
- [ ] Il decoder gestisce codec 0-5, `ns`, `m`, `prei`/`pre`/`sufi`/`suf`, `$c1x`,
      vettori e template, e le differenze del §2.12 sono implementate come da
      colonna "Dart".
- [ ] `getC1` chiede `format=c1` solo sulle route di `kC1Routes`, lascia passare
      il JSON normale, non decodifica gli errori, ritenta in JSON normale su
      errore di decodifica.
- [ ] Un codice sconosciuto provoca la rilettura del dizionario (versione fissata
      poi corrente), un solo ritentativo, e se fallisce il ripiego.
- [ ] La decodifica sopra la soglia gira in un isolate; la soglia è una costante
      confermata dal benchmark.
- [ ] La cache in memoria rispetta TTL, tetto di peso (24 MB, 16 voci, o i valori
      ricalibrati) ed espulsione; nessun chiamante muta i valori condivisi.
- [ ] L'interruttore `POKOIN_C1=false` riporta le richieste a quelle di oggi
      (nessun `format=`); l'interruttore automatico dopo 3 ripieghi funziona.
- [ ] `flutter test test/c1` passa; i golden test coprono tutte le fixture
      del repository `pokoin` e le fixture nuove per le route di §3.3.
- [ ] `flutter analyze` senza nuovi avvisi; `flutter test` intero come la base.
- [ ] Il benchmark del §6 è stato eseguito su almeno due classi di dispositivi, e
      gli 8 criteri del §6.9 sono riportati con numeri.
- [ ] Nessuna route fuori da `kC1Routes` è stata modificata; nessun file di
      `pokoin` è stato toccato; nessun push né deploy senza istruzione.

### 7.2 Cosa l'agente riporta alla collega

1. **File modificati e creati**, con un commit per punto di chiamata (SHA e
   messaggio).
2. **Esito di `flutter analyze` e `flutter test`**, con i conteggi della base di
   partenza accanto: l'output integrale dei test `test/c1`.
3. **La tabella del benchmark** del §6.8, per dispositivo e rete, e l'esito degli 8
   criteri del §6.9.
4. **Esito dell'audit** `audit/C1-AUDIT.md`: ogni riga D1-D9 con il dato.
5. **Limiti noti**: cosa non è stato fatto o misurato (per esempio la web, il
   libro del negozio non adottato, il flag remoto, le classi di dispositivi non
   coperte), le differenze del §2.12 che hanno prodotto un comportamento diverso
   dal JS, le route dell'app senza forma `c1` (§3.3, `marketplace-cards`) dove
   il peso maggiore resta in JSON normale.
6. **Disaccordi** trovati tra questa guida e il codice o tra la guida e la
   specifica.
7. Le **domande aperte** per la collega: Q2 del typeahead (URL base), flag remoto,
   soglie del §6.9, adozione di `c1v2` per `card-versions`, adozione del libro del
   negozio.

---

## 8. Riferimenti

Repository `pokoin` (percorsi dalla radice):

| File | In una riga |
| --- | --- |
| `docs/rust-migration/COMPACT_ENCODING.md` | Specifica del formato `c1`/`c1v2`: motivazioni, codec, dizionario, negoziazione, misure, test, rollout. Fonte di verità. |
| `market/src/compact.js` | Decoder del browser (538 righe): il modello del porting Dart; contiene l'istantanea del dizionario. |
| `market/src/compact.test.js` | Test del decoder: le 11 fixture, i casi di codec, maschere, vettori, errori, template, `c1Slug`. |
| `market/src/compact-dictionary.json` | Istantanea del dizionario versione 1 (2.902 byte), uguale alle tabelle Rust. |
| `pokoin-rust/crates/api-common/src/compact/decode.rs` | Decoder di riferimento in Rust (difensivo: ogni indice è controllato). |
| `pokoin-rust/crates/api-common/src/compact/encode.rs` | Codificatore: scelta del codec per colonna, `EncodeOptions { templates }`, versioni 1 e 2. |
| `pokoin-rust/crates/api-common/src/compact/dict.rs` | Tabelle del dizionario (`VERSION = "1"`), `document()`, prefissi URL, flag. |
| `pokoin-rust/crates/api-common/src/compact/template.rs` | Slug e testo di cella dei template (codec 5). |
| `pokoin-rust/crates/api-common/src/compact/mod.rs` | Negoziazione: `?format=c1`, `?format=c1v2`, `Accept: application/vnd.pokoin.c1+json[; v=2]`, intestazione `x-pokoin-format`, content type `application/json`. |
| `pokoin-rust/crates/api-common/src/compact/tests.rs` | Test Rust di round trip e dei limiti. |
| `market/src/api.js` | Come il sito legge `c1`: `C1_READS`, `getJsonC1` (ripiego su JSON normale), `fetchListSnapshot`, `fetchSellerShop` (`book`, `format=c1v2`), `fetchSuggest`. |
| `market/src/api-c1.test.js` | Test del lettore del sito: modello dei test di `getC1`. |
| `pokoin-rust/crates/commerce/src/handlers/seller.rs`, `seller_book.rs` | Il libro dell'intero negozio: costruzione, cache, libro memorizzato, `book_response`. |
| `market/src/seller-shop-filter.js` | Filtri e ordinamenti locali del libro. |
| `pokoin-rust/apps/api/src/suggest.rs` | Route `marketplace-suggest` con `c1`. |
| `pokoin-rust/crates/catalog-api/src/reads/dictionary.rs` | `GET /api/dictionary` (e `?v=`, `ETag`, `409`). |
| `pokoin-rust/apps/api/src/lists.rs` | `marketplace-list` (c1/c1v2, `br`) e `GET /api/c1-dictionary` (dizionario binario `dcb`, non attivo). |
| `pokoin-rust/crates/catalog-api/src/reads/card_versions.rs`, `artist_cards.rs`, `expansions.rs`, `home.rs`, `pages/home_page.rs`, `pages/expansion_page.rs`, `apps/api/src/search_page.rs` | Gestori che rispondono `c1`. |
| `docs/handoff/compact-c1/` | Fixture catturate (`fixtures/`), le stesse codificate (`c1/`), `measure-sizes.py`, `analyze.py`. |
| `docs/handoff/flutter-suggest-dictionary/README.md` | Guida sull'altro tema Flutter (dizionario locale del typeahead): stile e domanda Q2. |
| `docs/API.md`, `docs/SELLER_API.md` | Documentazione API; non menzionano `c1`. |

Repository `cardvault` (percorsi da `pokemon_card_vault/`):

| File | In una riga |
| --- | --- |
| `AGENTS.md` | Regole di deploy e di lavoro del repository. |
| `pubspec.yaml`, `pubspec.lock` | Dipendenze (`http`, `hive`, Firebase) e vincoli di SDK. |
| `lib/services/card_service.dart` | Servizio del catalogo: URL base (`:16-42`), chiamate di §3.3, `jsonDecode`, cache Hive. |
| `lib/services/pokoin_api_client.dart` | Client autenticato con `http.Client` proprio. |
| `lib/providers/card_provider.dart` | Provider che chiamano il servizio (home `:478`, `:1322`). |
| `lib/screens/collection_screen.dart` | Schermata che consuma set, indice espansioni e indice artisti. |
| `test/flutter_debug_log_test.dart` | Unico uso di `MockClient`: modello per i test del client. |
