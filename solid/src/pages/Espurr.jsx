import { For, Show } from 'solid-js';
import data from '@market/../public/review/espurr.json';
import TestDock from '../components/TestDock.jsx';
import { BoardBar, usePageTitle } from './tools/board.jsx';

const FLAG = { japanese: 'JP', western: 'EN', chinese: 'CN' };

function Printing(props) {
  return (
    <figure class="sanitize-shot">
      <a class="sanitize-frame" href={props.card.desk} target="_blank" rel="noreferrer">
        <img src={props.card.image} alt={`${props.card.set} ${props.card.num}`} />
      </a>
      <figcaption>
        <strong>
          <span class="espurr-flag">{FLAG[props.card.lang] || props.card.lang}</span> {props.card.set}
        </strong>
        <span>{props.card.num}</span>
        <span>
          <a class="linkish" href={props.card.desk} target="_blank" rel="noreferrer">{props.card.id}</a>
        </span>
      </figcaption>
    </figure>
  );
}

function Group(props) {
  return (
    <article class="espurr-group">
      <div class="espurr-head">
        <img src={props.group.artbox} alt="" class="espurr-artbox" />
        <div>
          <p class="sanitize-kicker">{props.group.title}</p>
          <p class="sanitize-note">{props.group.note}</p>
        </div>
      </div>
      <div class="espurr-row">
        <For each={props.group.printings}>{(card) => <Printing card={card} />}</For>
      </div>
    </article>
  );
}

const PAIRED = data.groups.filter((group) => group.paired);
const UNPAIRED = data.groups.filter((group) => !group.paired);

/** Espurr same-artwork clusters across languages (market/src/pages/Espurr.jsx). */
export default function Espurr() {
  usePageTitle('Espurr versions · test.pokoin.com');

  return (
    <div class="sanitize">
      <BoardBar host={`test.pokoin.com · Espurr · ${data.revision}`} />
      <main class="sanitize-main">
        <p class="sanitize-kicker">CardTrader model</p>
        <h1>Espurr · same artwork, every language</h1>
        <p class="sanitize-lead">
          {data.counts.printings} printings ({data.counts.japanese} JP, {data.counts.western}{' '}
          EN, {data.counts.chinese} CN) clustered into {data.counts.artworks} artworks.
          Same illustration window matches JP, EN, CN, deck reprints, and stamp
          reverses. Each <code>public_id</code> still has its own desk page.
        </p>
        <p class="sanitize-note">{data.rule}</p>

        <section class="sanitize-block">
          <h2>{data.counts.paired} shared artworks</h2>
          <For each={PAIRED}>{(group) => <Group group={group} />}</For>
        </section>

        <Show when={UNPAIRED.length}>
          <section class="sanitize-block">
            <h2>{UNPAIRED.length} unique artworks</h2>
            <p class="sanitize-note">
              No other language printing of this illustration in the Espurr list.
            </p>
            <For each={UNPAIRED}>{(group) => <Group group={group} />}</For>
          </section>
        </Show>
      </main>
      <TestDock />
    </div>
  );
}
