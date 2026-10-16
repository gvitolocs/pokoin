# Poko brain

The website chat (`POST /api/poko-chat`) can answer in-process inside the Pokoin Rust API. The brain makes one OpenAI-compatible chat call with native `tools`. Market tools run in this same process, in parallel. A second model call happens only when tools ran. A turn with no tools is one model call. A market turn is two, unless the model keeps calling tools up to the round cap.

Hermes stays available. Any brain error, or an empty reply, uses the existing Hermes HTTP path. The HTTP response shape does not change. When the brain answered, `source` is `poko-brain`. The assistant event stored in Firestore also gets a `metadata` map (`provider`, `model`, `elapsedMs`). That map is not copied into the JSON the website reads back.

## Flow

1. The chat handler still does sign-in, the rate limit, photo identification, personal context, and the transcript write.
2. `POKO_BRAIN_MODE` chooses the answerer (see Rollout).
3. The abuse screen runs on the user message. A hit returns `I can't help with that.` and does not call a model. The same user stays blocked for the life of the process.
4. If `POKO_GUARD_URL` and `POKO_GUARD_MODEL` are both set, a Qwen3Guard-Gen style check runs on the user message (3s). `Safety: Unsafe` is a short refusal and skips the main model. Transport errors and other failures are logged and ignored.
5. The model sees one system prompt, one extra system message with the handler's context blocks (market directive, personal intent, photo and card context, the reply-cards line), the last 10 chat events (oldest first, at most 6,000 characters), and the user message.
6. Tool calls in one round run together. Each tool has `POKO_BRAIN_TOOL_TIMEOUT_MS` (default 15000, 1000-30000; `top_sellers` takes 8-9 s on the Pi replica). A failure or a timeout is `{"ok":false,"error":...}` for the model. Each result is capped at 6,000 characters and a round at 16,000.
7. After the last allowed tool round, one more call uses `tool_choice: "none"` so the model has to answer.
8. The reply is sanitized (tool markup including DeepSeek DSML, raw tool names, markdown headings and emphasis). If the model leaks tool-call syntax into text on the forced final call, the brain retries once on the same provider without the `tools` field and a short system reminder; if that still fails, it tries the next provider the same way. A reply that still contains tool markup is an error (Hermes fallback). The output guard, when configured, can replace it. Reply cards are attached only when the model ends with a `[[cards: ...]]` line: each listed cardId or name is matched against tool results (names can be narrowed by set or collector number mentioned in the reply), capped at three cards (four when the reply asks which printing with a question mark and lists at least two ids). General observations without that line attach no cards. The handler still runs `attach_reply_cards` to resolve ids and strip the marker.

Provider order is `POKO_BRAIN_PROVIDERS` (default `deepseek,gemini`: DeepSeek Flash is paid and fastest in the 2026-10-16 test, 1.3 s for a tool call; Gemini free can run out of daily quota). A provider with no key, or no model, is skipped. The local provider's key is optional. The next provider is used on a transport error or timeout, HTTP 408, 409, 425, 429, or 5xx, HTTP 401 or 403, or an unusable body (no choices, or tool arguments that are still not JSON after one repair). HTTP 401 and 403 also mark that provider down for 10 minutes in this process. A turn that already ran tools retries the next call with the same messages, including the tool results.

Each model call is logged at info: provider, model, milliseconds, HTTP status, and how many tool calls were requested. The API key and the prompt are not logged.

The per-call timeout is `POKO_BRAIN_CALL_TIMEOUT_MS` (default 15000) and is also cut to whatever remains of `POKO_BRAIN_BUDGET_MS` (default 40000). When the turn budget is gone, the brain returns an error and the handler uses Hermes.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `POKO_BRAIN_MODE` | `hermes` | `hermes`, `canary`, or `rust`. Anything else is `hermes`. |
| `POKO_BRAIN_CANARY_UIDS` | empty | Comma-separated Firebase uids or account emails (emails match case-insensitively). Used only when mode is `canary`. |
| `POKO_BRAIN_PROVIDERS` | `deepseek,gemini` | Provider order. Unknown names are ignored. |
| `GEMINI_API_KEY` | none | Required or Gemini is skipped. |
| `POKO_BRAIN_GEMINI_MODEL` | `gemini-2.5-flash-lite` | Gemini model. Base URL `https://generativelanguage.googleapis.com/v1beta/openai`. |
| `DEEPSEEK_API_KEY` | none | Required or DeepSeek is skipped. |
| `POKO_BRAIN_DEEPSEEK_MODEL` | `deepseek-flash` | DeepSeek model. Base URL `https://api.deepseek.com/v1`. |
| `OPENROUTER_API_KEY` | none | Required or OpenRouter is skipped. |
| `POKO_BRAIN_OPENROUTER_MODEL` | none | Required or OpenRouter is skipped. Base URL `https://openrouter.ai/api/v1`. |
| `POKO_BRAIN_LOCAL_URL` | none | OpenAI-compatible base, for example `http://192.168.178.55:11436/v1`. Required or local is skipped. |
| `POKO_BRAIN_LOCAL_MODEL` | none | Required or local is skipped. |
| `POKO_BRAIN_LOCAL_KEY` | none | Optional bearer token. |
| `POKO_BRAIN_LOCAL_EXTRA` | none | JSON object merged into the local request body, for example `{"chat_template_kwargs":{"enable_thinking":false}}`. |
| `POKO_BRAIN_CALL_TIMEOUT_MS` | `15000` | Timeout for one model call. `0` or junk uses the default. |
| `POKO_BRAIN_BUDGET_MS` | `40000` | Budget for the whole brain turn. `0` or junk uses the default. |
| `POKO_BRAIN_TOOL_TIMEOUT_MS` | `15000` | Per-tool limit in ms (1000-30000). |
| `POKO_BRAIN_MAX_TOOL_ROUNDS` | `3` | Tool rounds before the forced `tool_choice: none` call. |
| `POKO_GUARD_URL` | none | OpenAI-compatible base for the guard. Both this and the model must be set. |
| `POKO_GUARD_MODEL` | none | Guard model name, for a Qwen3Guard-Gen style endpoint. |

Calls use `temperature` 0.4, `max_tokens` 700, and no streaming.

## Rollout

1. **hermes** (default). Every chat still goes to Hermes. Ship the binary with the variable unset.
2. **canary**. Set `POKO_BRAIN_MODE=canary` and `POKO_BRAIN_CANARY_UIDS` to the Firebase uids that should use the brain. Everyone else still uses Hermes. A canary uid falls back to Hermes if the brain errors or the reply is empty.
3. **rust**. Set `POKO_BRAIN_MODE=rust`. Every signed-in chat uses the brain, with the same Hermes fallback.

## Roll back

Set `POKO_BRAIN_MODE=hermes` (or unset it) and restart the API process. No data migration. In-process provider cooldowns and abuse blocks are memory only; a restart clears them. Hermes does not need a change.

To pull one person off the canary, remove their uid from `POKO_BRAIN_CANARY_UIDS` and restart.

## What this does not include

Hermes still answers Discord, Telegram, and the other non-website surfaces. The website falls back to Hermes when the brain errors or the reply is empty. Deliberately not ported:

- The JSON action planner and its 3–5 sequential model calls.
- The HTTP hop from Hermes back to `POST /api/poko-market`. Tools run in-process.
- Social posting, Discord admin, operator skills, Obscura web crawl, image generation, reminders, and Honcho or other private memory.
- The disk-backed `poko-abuse` stdin server. The same rules run in memory for the life of the API process.
- Per-day provider blocks. A 401 or 403 only cools that provider down for 10 minutes.
- Contract-address and social-post text rewriting, and the planner line that tells the model a reply used no tools.
