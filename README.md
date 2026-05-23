# Hermes

Hermes è un assistente conversazionale per Telegram e, opzionalmente, Discord. Usa un provider compatibile con le API ChatGPT/OpenAI per rispondere ai messaggi, Honcho per la memoria conversazionale e può integrare ComfyUI per generare immagini o Cursor Agent per lavorare su un progetto software.

Il progetto è pensato per girare localmente durante lo sviluppo e su un host Oracle peer1 in produzione.

## Funzionalità principali

- Bot Telegram basato su `telegraf`, con long polling o webhook HTTPS.
- Bot Discord opzionale basato su `discord.js`, attivo in DM o quando viene menzionato.
- Risposte testuali tramite API compatibili con OpenAI Chat Completions.
- Analisi di immagini ricevute su Telegram tramite endpoint di ispezione immagini del provider configurato.
- Memoria conversazionale con Honcho, disattivabile cambiando `MEMORY_PROVIDER`.
- Generazione immagini opzionale tramite ComfyUI e workflow JSON incluso.
- Esecuzione opzionale di task di sviluppo tramite Cursor Agent CLI.
- Endpoint HTTP `/health` per verificare lo stato del servizio.

## Stack tecnico

- Node.js ESM, con requisito `node >=20`.
- `telegraf` per Telegram.
- `discord.js` per Discord.
- `@honcho-ai/sdk` per la memoria.
- `dotenv` per caricare `.env.local` e `.env`.
- Script Bash per installazione Honcho e deploy su peer1.

## Prerequisiti

- Node.js 20 o superiore e npm.
- Un token Telegram Bot API (`TELEGRAM_BOT_TOKEN`).
- Una chiave API per il provider OpenAI-compatible (`OPENAI_API_KEY`).
- Facoltativo: Honcho raggiungibile da `HONCHO_URL` se si usa la memoria.
- Facoltativo: token Discord e Message Content Intent abilitato nel Discord Developer Portal.
- Facoltativo: Cursor Agent CLI e `CURSOR_API_KEY` per i task sul progetto.
- Facoltativo: un'istanza ComfyUI raggiungibile via HTTP per generare immagini.

Per il deploy su peer1 servono anche accesso SSH, `sudo` sull'host remoto e, per Honcho, Docker/Compose.

## Installazione

```bash
git clone https://github.com/gvitolocs/pokoin.git
cd pokoin
npm install
cp .env.example .env.local
```

Modifica `.env.local` inserendo almeno:

```env
OPENAI_API_KEY=...
TELEGRAM_BOT_TOKEN=...
```

Il file `.env.local` contiene segreti locali ed è ignorato da Git. Non va committato né condiviso.

## Configurazione

Le variabili disponibili sono documentate in `.env.example`.

### Servizio Hermes

- `NODE_ENV`: ambiente di runtime, default `development`.
- `HERMES_PORT`: porta HTTP del servizio, default `8788`.
- `HERMES_PUBLIC_URL`: se vuoto usa il long polling Telegram; se impostato a un URL HTTPS configura un webhook Telegram.
- `HERMES_CHAT_REGISTRY_PATH`: file JSON dove salvare i riferimenti alle chat Telegram viste dal bot.

### Provider OpenAI-compatible

- `OPENAI_API_KEY`: chiave API richiesta.
- `OPENAI_BASE_URL`: base URL del provider, default `https://api.openai.com/v1`.
- `OPENAI_MODEL`: modello da usare, default `gpt-4o-mini`.
- `OPENAI_REASONING_EFFORT`: opzione passata al provider se valorizzata.
- `OPENAI_TIMEOUT_MS`: timeout delle richieste, default `30000`.

Nota: l'analisi immagini usa l'endpoint `/v1/inspect` costruito a partire da `OPENAI_BASE_URL`; verifica che il provider configurato lo supporti.

### Telegram

- `TELEGRAM_BOT_TOKEN`: token richiesto per avviare il bot.
- `TELEGRAM_WEBHOOK_SECRET`: secret opzionale per webhook Telegram.
- `TELEGRAM_ALLOWED_CHAT_IDS`: lista separata da virgole per limitare le chat autorizzate. Se vuota, il bot risponde a tutte le chat.

### Discord opzionale

- `DISCORD_BOT_TOKEN`: abilita il bot Discord quando valorizzato.
- `DISCORD_ALLOWED_CHANNEL_IDS`: lista separata da virgole di canali autorizzati.
- `DISCORD_ALLOWED_USER_IDS`: lista separata da virgole di utenti autorizzati.

### Immagini opzionali

- `IMAGE_PROVIDER`: default `pokemon-artwork`; impostare `comfyui` per usare ComfyUI.
- `COMFYUI_BASE_URL`: URL pubblico dell'istanza ComfyUI.
- `COMFYUI_WORKFLOW_PATH`: workflow JSON, default `workflows/comfyui-text-to-image.json`.
- `IMAGE_TIMEOUT_MS`: timeout generazione immagini, default `180000`.

### Cursor Agent opzionale

- `HERMES_CURSOR_ENABLED`: impostare `true` per abilitare task Cursor.
- `CURSOR_API_KEY`: chiave API Cursor.
- `HERMES_CURSOR_AGENT_PATH`: percorso del binario Agent CLI.
- `HERMES_PROJECT_DIR`: workspace su cui eseguire i task.
- `HERMES_CURSOR_MODEL`: modello Agent CLI.
- `HERMES_CURSOR_TIMEOUT_MS`: timeout dei task; `0` disabilita il timeout.

### Memoria Honcho

- `MEMORY_PROVIDER`: default `honcho`.
- `HONCHO_URL`: URL Honcho, default `http://127.0.0.1:8000`.
- `HONCHO_API_KEY`: chiave Honcho opzionale.
- `HONCHO_WORKSPACE_ID`: workspace Honcho.
- `HONCHO_AGENT_PEER_ID`: peer ID dell'assistente.
- `HONCHO_USE_VECTOR_SEARCH`: abilita opzioni di ricerca vettoriale quando `true`.

### Deploy peer1

- `PEER1_HOST`: host remoto.
- `PEER1_USER`: utente SSH.
- `PEER1_SERVICE_USER`: utente con cui avviare il servizio systemd.
- `PEER1_REMOTE_DIR`: directory remota di Hermes.
- `PEER1_HONCHO_DIR`: directory remota di Honcho.
- `PEER1_KEY`: variabile opzionale per sovrascrivere il percorso della chiave SSH usata dagli script.

## Esecuzione

Controlla la sintassi dei file principali:

```bash
npm run check
```

Avvia in sviluppo caricando `.env.local`:

```bash
npm run dev
```

Avvio standard:

```bash
npm start
```

Con `HERMES_PUBLIC_URL` vuoto, Hermes rimuove eventuali webhook Telegram e usa il polling. Con `HERMES_PUBLIC_URL` impostato a un URL HTTPS, registra il webhook su `/telegram/<TELEGRAM_BOT_TOKEN>`.

L'endpoint di salute è disponibile su:

```text
GET /health
```

## Uso

Su Telegram, invia `/start` per verificare che il bot sia online. I messaggi testuali vengono trasformati in risposte, richieste di generazione immagini o task Cursor in base alla pianificazione del modello. Le foto ricevute vengono analizzate e memorizzate nella conversazione.

Su Discord, quando `DISCORD_BOT_TOKEN` è configurato, Hermes risponde ai DM e ai messaggi in cui il bot viene menzionato. Per leggere il contenuto dei messaggi nei server è necessario abilitare Message Content Intent nel portale Discord.

## Generazione immagini con ComfyUI

Hermes può usare una istanza temporanea ComfyUI su Google Colab.

1. Apri Google Colab e crea un runtime GPU.
2. Copia le celle da `notebooks/comfyui_colab_minimal.md` ed eseguile in ordine.
3. Copia il valore stampato `COMFYUI_BASE_URL=https://...trycloudflare.com`.
4. Aggiorna `.env.local`:

```env
IMAGE_PROVIDER=comfyui
COMFYUI_BASE_URL=https://your-colab-tunnel.trycloudflare.com
```

5. Riavvia Hermes o ridistribuisci il servizio.

Quando il runtime Colab si ferma, anche il tunnel scade: avvia nuovamente Colab e aggiorna `COMFYUI_BASE_URL`.

## Deploy su peer1

Installa o aggiorna Honcho sull'host peer1:

```bash
./scripts/install-honcho-peer1.sh
```

Distribuisci Hermes su peer1:

```bash
./scripts/deploy-peer1.sh
```

Gli script leggono la configurazione da `.env.local`, copiano il progetto remoto escludendo `node_modules`, `.git` e `apikeys`, installano le dipendenze di produzione e configurano un servizio systemd `hermes`.

## Struttura del progetto

```text
.
├── src/
│   ├── index.js              # Avvio servizio HTTP, Telegram e Discord
│   ├── config.js             # Lettura e validazione configurazione
│   ├── telegram.js           # Integrazione Telegram
│   ├── discord.js            # Integrazione Discord opzionale
│   ├── openai.js             # Chiamate al provider OpenAI-compatible
│   ├── image-generation.js   # Client ComfyUI
│   ├── cursor-agent.js       # Wrapper Cursor Agent CLI
│   └── memory/honcho.js      # Memoria Honcho
├── notebooks/                # Notebook/celle Colab per ComfyUI
├── workflows/                # Workflow ComfyUI
├── scripts/                  # Script deploy e installazione Honcho
├── data/                     # Dati runtime locali, ignorati da Git
└── .env.example              # Template configurazione
```

## Contribuire

Non sono presenti linee guida di contribuzione dedicate. Prima di proporre modifiche, esegui almeno:

```bash
npm run check
```

Mantieni fuori dal repository `.env.local`, `apikeys`, `node_modules` e i file generati in `data/`.

## Licenza

Nel repository non è presente un file di licenza. TODO: aggiungere una licenza se il progetto deve essere distribuito o riusato da terzi.
