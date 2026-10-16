import { For, Show } from 'solid-js';
import TestDock from '../components/TestDock.jsx';
import { BoardBar, usePageTitle } from './tools/board.jsx';

const VIDEOS = [
  { id: 'chatterbox_en_all_v5', label: 'Chatterbox V3 · English training · episodes 1–7 · 1 min test', lang: 'en', src: 'https://cdn.pokoin.com/poko-video/ep5/chatterbox/en_all_ft_v5/pokemon30-chatterbox-preview-60s.mp4', voiceover: 'https://cdn.pokoin.com/poko-video/ep5/chatterbox/en_all_ft_v5/pokemon30-chatterbox-voiceover-60s.wav', voiceSource: 'voice source: newPoko sample dataset (vo/dataset-en-001, episodes 1–7), Chatterbox Multilingual V3, LoRA fine-tuned EN only' },
  { id: 'chatterbox_en_ep7_v4', label: 'Chatterbox V3 · English-only training on ep7 · 123 clips · 1 min test', lang: 'en', src: 'https://cdn.pokoin.com/poko-video/ep5/chatterbox/en_ep7_ft_v4/pokemon30-chatterbox-preview-60s.mp4', voiceover: 'https://cdn.pokoin.com/poko-video/ep5/chatterbox/en_ep7_ft_v4/pokemon30-chatterbox-voiceover-60s.wav', voiceSource: 'voice source: newPoko sample dataset (vo/dataset-en-001, ep7), Chatterbox Multilingual V3, LoRA fine-tuned EN only' },
  { id: 'chatterbox_en', label: 'Pokémon 30th Anniversary — Chatterbox V3 (newPoko) · English · 1 min', lang: 'en', src: 'https://cdn.pokoin.com/poko-video/ep5/chatterbox/en_zeroshot/pokemon30-chatterbox-preview-60s.mp4', voiceover: 'https://cdn.pokoin.com/poko-video/ep5/chatterbox/en_zeroshot/pokemon30-chatterbox-voiceover-60s.wav', voiceSource: 'voice source: newPoko sample dataset (vo/dataset-en-001), Chatterbox Multilingual V3, zero-shot' },
  { id: 'chatterbox_it', label: 'Pokémon 30th Anniversary — Chatterbox V3 (newPoko) · Italiano · 1 min', lang: 'it', src: 'https://cdn.pokoin.com/poko-video/ep5/chatterbox/it_zeroshot/pokemon30-chatterbox-preview-60s.mp4', voiceover: 'https://cdn.pokoin.com/poko-video/ep5/chatterbox/it_zeroshot/pokemon30-chatterbox-voiceover-60s.wav', voiceSource: 'voice source: newPoko sample dataset (vo/dataset-it-001), Chatterbox Multilingual V3, zero-shot' },
  { id: 'fenrir', label: 'Gemini 3.8 · Fenrir · English · 1 min', lang: 'en', src: 'https://cdn.pokoin.com/poko-video/ep5/gemini38/gemini_fenrir_1m.mp4' },
  { id: 'fenrir_it', label: 'Gemini 3.8 · Fenrir · Italiano · 1 min', lang: 'it', src: 'https://cdn.pokoin.com/poko-video/ep5/gemini38/gemini_fenrir_it_1m.mp4' },
  { id: 'azure1m', label: 'Azure · excited · English · 1 min baseline', lang: 'en', src: 'https://cdn.pokoin.com/poko-video/ep5/gemini38/azure_excited_1m.mp4' },
  { id: 'azure_it', label: 'Azure · excited · Italiano · 1 min baseline', lang: 'it', src: 'https://cdn.pokoin.com/poko-video/ep5/gemini38/azure_excited_it_1m.mp4' },
  { id: 'puck', label: 'Gemini 3.8 · Puck (upbeat) · EN · 1 min', lang: 'en', src: 'https://cdn.pokoin.com/poko-video/ep5/gemini38/gemini_puck_1m.mp4' },
  { id: 'leda', label: 'Gemini 3.8 · Leda (youthful) · EN · 1 min', lang: 'en', src: 'https://cdn.pokoin.com/poko-video/ep5/gemini38/gemini_leda_1m.mp4' },
  { id: 'achird', label: 'Gemini 3.8 · Achird (friendly) · EN · 1 min', lang: 'en', src: 'https://cdn.pokoin.com/poko-video/ep5/gemini38/gemini_achird_1m.mp4' },
  { id: 'en', label: 'Full episode · English · Azure excited', lang: 'en', src: 'https://cdn.pokoin.com/poko-video/ep5/poko_30th_excited_en_720p.mp4' },
  { id: 'it', label: 'Full episode · Italiano · Azure excited', lang: 'it', src: 'https://cdn.pokoin.com/poko-video/ep5/poko_30th_excited_it_720p.mp4' },
  { id: 'before', label: 'Full episode · English · Alloy Turbo (before)', lang: 'en', src: 'https://cdn.pokoin.com/poko-video/ep5/poko_30th_alloy_turbo_en_720p.mp4' },
];
const POSTER = 'https://cdn.pokoin.com/poko-video/ep5/poster.jpg';
const AUDIO_BASE = 'https://cdn.pokoin.com/poko-video/ep5/chatterbox/auditions-v2-20261008';
const EP7_AUDIO_BASE = 'https://cdn.pokoin.com/poko-video/ep5/chatterbox/en-ep7-v4-20261008';
const COMPARISONS = [
  { lang: 'it', label: 'Italiano', clips: [
    { tag: 'it_gemini_target', label: 'Gemini Fenrir · riferimento originale' },
    { tag: 'it_gemini_reference', label: 'Chatterbox V3 · riferimento Gemini · senza training' },
    { tag: 'it_ft_v2', label: 'Chatterbox V3 · previous bilingual experiment · 50 EN + IT samples' },
  ] },
  { lang: 'en', label: 'English', clips: [
    { tag: 'en_gemini_target', label: 'Gemini Fenrir · original reference' },
    { tag: 'en_gemini_reference', label: 'Chatterbox V3 · Gemini reference · zero-shot' },
    { tag: 'en_ft_v2', label: 'Chatterbox V3 · previous bilingual experiment · 50 EN + IT samples' },
  ] },
];

const AB = [
  {
    title: 'Gemini Fenrir',
    chips: ['reference'],
    aria: 'Gemini Fenrir · original reference',
    src: `${AUDIO_BASE}/en_gemini_target.mp3`,
  },
  {
    title: 'Chatterbox V3',
    chips: ['word match 100/100/95 %', 'similarity 0.952'],
    sub: 'LoRA · trained on English episodes 1–7',
    aria: 'Chatterbox V3 · same phrases',
    src: 'https://cdn.pokoin.com/poko-video/ep5/chatterbox/en-all-v5-20261008/en_all_ft_samephrase_v5.mp3',
  },
  {
    title: 'Qwen3-TTS 1.7B',
    chips: ['word match 100/100/95 %', 'similarity 0.922'],
    sub: 'single-speaker fine-tune · English episodes 1–7',
    aria: 'Qwen3-TTS · same phrases',
    src: 'https://cdn.pokoin.com/poko-video/ep5/qwen/en-all-v1-20261009/en_qwen_samephrase_v1.mp3',
  },
];

const CLIP_GROUPS = [
  {
    chip: 'EN · new phrases (ep1–7 test)',
    lang: 'en',
    clips: [
      { tag: 'en_gemini_target', label: 'Gemini Fenrir · voice reference from the previous test, with different words', aria: 'Gemini Fenrir voice reference', src: `${AUDIO_BASE}/en_gemini_target.mp3` },
      { tag: 'en_all_zero_v5', label: 'Chatterbox V3 · zero-shot', aria: 'New English phrases · zero-shot', src: 'https://cdn.pokoin.com/poko-video/ep5/chatterbox/en-all-v5-20261008/en_all_zero_v5.mp3' },
      { tag: 'en_ep7_ft_newtext_v5', label: 'Chatterbox V3 · trained on ep7 only', aria: 'New English phrases · ep7 training', src: 'https://cdn.pokoin.com/poko-video/ep5/chatterbox/en-all-v5-20261008/en_ep7_ft_newtext_v5.mp3' },
      { tag: 'en_all_ft_v5', label: 'Chatterbox V3 · trained on English episodes 1–7', aria: 'New English phrases · episodes 1–7 training', src: 'https://cdn.pokoin.com/poko-video/ep5/chatterbox/en-all-v5-20261008/en_all_ft_v5.mp3' },
      { tag: 'en_azure_same_newtext_v1', label: 'Azure · Alloy Dragon HD · excited · same new phrases', aria: 'New English phrases · Azure Alloy Dragon HD', src: 'https://cdn.pokoin.com/poko-video/ep5/chatterbox/en-all-v5-20261008/en_azure_same_newtext_v1.mp3' },
    ],
    caption: 'New phrases for comparing the voices. These paragraphs are absent from all seven episode scripts. All three Chatterbox versions read the same new text, with natural pacing. The first video below also shows the new voice on the familiar episode 5 timeline. voice source: newPoko sample dataset (vo/dataset-en-001, Gemini Fenrir), Chatterbox Multilingual V3; zero-shot, ep7 EN training, or episodes 1–7 EN training according to the label.',
  },
  {
    chip: 'EN · ep7 training test',
    lang: 'en',
    clips: [
      { tag: 'en_gemini_target', label: 'Gemini Fenrir · original reference', aria: 'Gemini Fenrir · original English reference', src: `${AUDIO_BASE}/en_gemini_target.mp3` },
      { tag: 'en_ep7_zero_v4', label: 'Chatterbox V3 · ep7 voice reference · zero-shot', aria: 'English ep7 reference · zero-shot', src: `${EP7_AUDIO_BASE}/en_ep7_zero_v4.mp3` },
      { tag: 'en_ep7_ft_pilot_v4', label: 'Chatterbox V3 · trained on English ep7 audio only', aria: 'English-only ep7 training', src: `${EP7_AUDIO_BASE}/en_ep7_ft_pilot_v4.mp3` },
      { tag: 'en_all_ft_samephrase_v5', label: 'Chatterbox V3 · trained on English episodes 1–7 · same phrases', aria: 'English episodes 1–7 training · same phrases', src: 'https://cdn.pokoin.com/poko-video/ep5/chatterbox/en-all-v5-20261008/en_all_ft_samephrase_v5.mp3' },
    ],
    caption: 'English-only comparison using the same test phrases. The ep7 model uses 123 clips; the episodes 1–7 model uses the aligned 1,041-clip dataset. These ep5 phrases were absent from ep7 training and present in episodes 1–7 training. Natural pacing for these short comparisons. The first video below tests the new voice on the original one-minute timeline. voice source: newPoko sample dataset (vo/dataset-en-001, ep7), Chatterbox Multilingual V3, zero-shot or LoRA fine-tuned EN only according to the label.',
  },
  {
    chip: 'IT · earlier',
    lang: 'it',
    clips: COMPARISONS[0].clips,
    caption: "Prove brevi per confrontare pronuncia e timbro. Le versioni Chatterbox leggono le stesse frasi iniziali con ritmo naturale, senza accelerazione. Il riferimento è l'audio pulito del test Gemini Fenrir. Esperimento precedente bilingue: newPoko sample dataset (vo/dataset-en-001 + vo/dataset-it-001), 50 campioni; 46 training + 4 validazione.",
  },
  {
    chip: 'EN · earlier',
    lang: 'en',
    clips: COMPARISONS[1].clips,
    caption: "Riferimento Chatterbox: Gemini Fenrir Poko test, Chatterbox Multilingual V3; zero-shot oppure LoRA fine-tuned secondo l'etichetta.",
  },
];

/** Side-by-side review: Gemini Fenrir EN/IT 1-min auditions on Part 5 visuals.
 * */
export default function PokoVideoBoard() {
  usePageTitle('Poko · Voice auditions · test.pokoin.com');

  return (
    <div class="sanitize poko-video-board">
      <BoardBar host="test.pokoin.com · poko" />

      <main class="sanitize-main">
        <p class="sanitize-kicker">Internal review boards</p>
        <h1>Poko Part 5 — Voice auditions</h1>
        <p class="sanitize-lead">
          Current comparison on top: the same opening phrases of Part 5 read by the original Gemini Fenrir voice and by two local
          voices trained on Gemini Fenrir lines from episodes 1–7. Earlier tests are in the Test archive below.
        </p>

        <section id="voice-ab-current" class="poko-video" lang="en">
          <h2>Current A/B · same phrases · Part 5 opening</h2>
          <p>Lines 1–8 of Part 5 in three blocks: same words, same split, natural pace, constant-gain level match.</p>
          <div class="poko-tiles poko-ab">
            <For each={AB}>
              {(tile) => (
                <div class="poko-tile">
                  <strong>{tile.title}</strong>
                  <span class="poko-chip-row">
                    <For each={tile.chips}>{(chip) => <span class="poko-chip">{chip}</span>}</For>
                  </span>
                  <Show when={tile.sub}><span class="poko-tile-sub">{tile.sub}</span></Show>
                  <audio controls preload="metadata" aria-label={tile.aria} src={tile.src} />
                </div>
              )}
            </For>
          </div>
          <p class="poko-caption">Speaker similarity is an identity estimate against a Gemini Fenrir clip, not a quality score; the 95 % block is Whisper writing Poko as Poco. Your ears decide.</p>
          <p class="poko-caption">voice source: newPoko dataset (vo/dataset-en-001, Gemini Fenrir, episodes 1–7); Chatterbox Multilingual V3 LoRA / Qwen3-TTS-12Hz-1.7B-Base SFT.</p>
        </section>

        <details class="poko-test-archive">
          <summary>Test archive · earlier voice tests (8–9 October)</summary>

          <section class="poko-block">
            <h3>Voice comparisons</h3>
            <For each={CLIP_GROUPS}>
              {(group) => (
                <div class="poko-clip-group" lang={group.lang}>
                  <ul class="poko-tiles poko-clips">
                    <For each={group.clips}>
                      {(clip) => (
                        <li class="poko-tile">
                          <span class="poko-chip">{group.chip}</span>
                          <strong>{clip.label}</strong>
                          <audio controls preload="metadata" aria-label={clip.aria || clip.label} src={clip.src || `${AUDIO_BASE}/${clip.tag}.mp3`} />
                        </li>
                      )}
                    </For>
                  </ul>
                  <p class="poko-caption">{group.caption}</p>
                </div>
              )}
            </For>
          </section>

          <section class="poko-block">
            <h3>1-minute videos</h3>
            <ul class="poko-tiles poko-videos">
              <For each={VIDEOS}>
                {(v) => (
                  <li class="poko-tile" lang={v.lang}>
                    <strong>{v.label}</strong>
                    <video controls preload="metadata" playsinline poster={POSTER} src={v.src} />
                    <Show when={v.voiceSource}><p class="poko-caption">{v.voiceSource}</p></Show>
                    <p class="poko-tile-links">
                      <a href={v.src} target="_blank" rel="noopener noreferrer">Open MP4</a>
                      <Show when={v.voiceover}>
                        <a href={v.voiceover} target="_blank" rel="noopener noreferrer">Download voiceover WAV · PCM 24-bit</a>
                      </Show>
                    </p>
                  </li>
                )}
              </For>
            </ul>
          </section>

          <section class="poko-block">
            <h3>newPoko voice archive</h3>
            <div class="poko-tiles">
              <div class="poko-tile">
                <a class="poko-tile-title" href="/poko/archive">newPoko archive</a>
                <span class="poko-tile-sub">1,091 Gemini Fenrir clips · dataset + episodes 1–7</span>
                <p class="poko-caption">Dataset phrases and remade episode lines</p>
              </div>
            </div>
          </section>
        </details>
      </main>

      <TestDock />
    </div>
  );
}
