import { useEffect } from 'react';
import TestDock from '../components/TestDock.jsx';
import data from '../../public/review/espurr.json';

function Flag({ lang }) {
  const label = { japanese: 'JP', western: 'EN', chinese: 'CN' }[lang] || lang;
  return <span className="espurr-flag">{label}</span>;
}

function Printing({ card }) {
  return (
    <figure className="sanitize-shot">
      <a className="sanitize-frame" href={card.desk} target="_blank" rel="noreferrer">
        <img src={card.image} alt={`${card.set} ${card.num}`} />
      </a>
      <figcaption>
        <strong>
          <Flag lang={card.lang} /> {card.set}
        </strong>
        <span>{card.num}</span>
        <span>
          <a className="linkish" href={card.desk} target="_blank" rel="noreferrer">
            {card.id}
          </a>
        </span>
      </figcaption>
    </figure>
  );
}

export default function Espurr() {
  useEffect(() => {
    document.title = 'Espurr versions · test.pokoin.com';
  }, []);

  const paired = data.groups.filter((group) => group.paired);
  const unpaired = data.groups.filter((group) => !group.paired);

  return (
    <div className="sanitize">
      <header className="sanitize-bar">
        <a className="brand" href="https://pokoin.com/" aria-label="Pokoin">
          <img src="/home/logo.png" alt="" width="40" height="40" />
          <span>Pokoin</span>
        </a>
        <p className="sanitize-host">
          test.pokoin.com · Espurr · {data.revision}
        </p>
      </header>
      <main className="sanitize-main">
        <p className="sanitize-kicker">CardTrader model</p>
        <h1>Espurr · same artwork, every language</h1>
        <p className="sanitize-lead">
          {data.counts.printings} printings ({data.counts.japanese} JP, {data.counts.western}{' '}
          EN, {data.counts.chinese} CN) clustered into {data.counts.artworks} artworks.
          Same illustration window matches JP, EN, CN, deck reprints, and stamp
          reverses. Each <code>public_id</code> still has its own desk page.
        </p>
        <p className="sanitize-note">{data.rule}</p>

        <section className="sanitize-block">
          <h2>{data.counts.paired} shared artworks</h2>
          {paired.map((group) => (
            <article
              key={group.printings.map((card) => card.id).join('-')}
              className="espurr-group"
            >
              <div className="espurr-head">
                <img src={group.artbox} alt="" className="espurr-artbox" />
                <div>
                  <p className="sanitize-kicker">{group.title}</p>
                  <p className="sanitize-note">{group.note}</p>
                </div>
              </div>
              <div className="espurr-row">
                {group.printings.map((card) => (
                  <Printing key={card.id} card={card} />
                ))}
              </div>
            </article>
          ))}
        </section>

        {unpaired.length ? (
          <section className="sanitize-block">
            <h2>{unpaired.length} unique artworks</h2>
            <p className="sanitize-note">
              No other language printing of this illustration in the Espurr list.
            </p>
            {unpaired.map((group) => (
              <article
                key={group.printings.map((card) => card.id).join('-')}
                className="espurr-group"
              >
                <div className="espurr-head">
                  <img src={group.artbox} alt="" className="espurr-artbox" />
                  <div>
                    <p className="sanitize-kicker">{group.title}</p>
                    <p className="sanitize-note">{group.note}</p>
                  </div>
                </div>
                <div className="espurr-row">
                  {group.printings.map((card) => (
                    <Printing key={card.id} card={card} />
                  ))}
                </div>
              </article>
            ))}
          </section>
        ) : null}
      </main>
      <TestDock />
    </div>
  );
}
