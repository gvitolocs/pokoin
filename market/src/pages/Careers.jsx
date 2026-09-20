import { useEffect, useId, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { EmptyDesk } from '../components/Desk.jsx';
import { APP } from '../punchouts.js';
import {
  CAREERS_CONTACT,
  OPEN_ROLES,
  groupRolesByDepartment,
  roleHref,
  roleMeta,
} from '../careers-jobs.js';

const PRINCIPLES = [
  {
    title: 'Collectors first',
    body: 'Every desk, search hit, and listing flow should help a collector buy or sell — not pad a house account.',
  },
  {
    title: 'Stay honest',
    body: 'No invented prices, fake comps, or silent fallbacks. If the book is empty, the page says so.',
  },
  {
    title: 'Ship and iterate',
    body: 'Ship the smallest correct surface, then tighten. Catalog depth and chain settlement both move in public.',
  },
  {
    title: 'Own the stack',
    body: 'Marketplace, wallet, and scan stay one product. Prefer fixing the real path over bolting on a parallel one.',
  },
];

const REASONS = [
  {
    title: 'One product surface',
    body: 'Card Reserve, PKN wallet, and Scan share the same host and identity — not three disconnected apps.',
  },
  {
    title: 'Real catalog work',
    body: 'Printings, artists, eras, and leftovers are treated as product data, not marketing filler.',
  },
  {
    title: 'Native PKN settlement',
    body: 'Listings and checkout settle in PKN on PokoinPoS. Chain tooling stays public when it can.',
  },
  {
    title: 'Peer to peer',
    body: 'Collectors trade with collectors. Offers sit on the desk instead of a middleman inventory.',
  },
  {
    title: 'Public docs & explorer',
    body: 'Host-a-node notes, health, RPC, and the explorer stay reachable from the site.',
  },
  {
    title: 'Direct contact',
    body: 'Questions go to contact@pokoin.com. There is no opaque careers portal yet.',
  },
];

function IconChevron({ open }) {
  return (
    <svg
      className={`careers-chevron${open ? ' is-open' : ''}`}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function DepartmentAccordion({ department, roles, defaultOpen }) {
  const panelId = useId();
  const [open, setOpen] = useState(Boolean(defaultOpen));
  const count = roles.length;

  return (
    <div className={`careers-dept${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="careers-dept-toggle"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="careers-dept-name">{department}</span>
        <span className="careers-dept-count" aria-label={`${count} open ${count === 1 ? 'role' : 'roles'}`}>
          {count}
        </span>
        <IconChevron open={open} />
      </button>
      <div
        id={panelId}
        className="careers-dept-panel"
        hidden={!open}
        role="region"
        aria-label={`${department} openings`}
      >
        <ul className="careers-role-list">
          {roles.map((role) => {
            const href = roleHref(role);
            const meta = roleMeta(role);
            const external = /^https?:\/\//i.test(href);
            return (
              <li key={role.id || role.title}>
                <a
                  className="careers-role"
                  href={href}
                  {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                >
                  <span className="careers-role-title">{role.title}</span>
                  {meta ? <span className="careers-role-meta">{meta}</span> : null}
                  <span className="careers-role-cta" aria-hidden="true">View</span>
                </a>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

function OpenPositions({ roles }) {
  const groups = groupRolesByDepartment(roles);
  const total = roles.length;

  if (!total) {
    return (
      <EmptyDesk
        nested
        title="No open roles right now"
        lede="When a posting is ready it will land here. Until then, write if you want to talk about working on Pokoin."
      >
        <a className="btn" href={CAREERS_CONTACT}>Email contact@pokoin.com</a>
        <Link className="btn ghost" to={APP.about}>About Pokoin</Link>
      </EmptyDesk>
    );
  }

  return (
    <div className="careers-jobs">
      <p className="careers-jobs-count">
        {total} open {total === 1 ? 'role' : 'roles'}
      </p>
      <div className="careers-dept-list">
        {groups.map((group, index) => (
          <DepartmentAccordion
            key={group.department}
            department={group.department}
            roles={group.roles}
            defaultOpen={index === 0}
          />
        ))}
      </div>
    </div>
  );
}

export default function Careers() {
  const location = useLocation();
  const roles = OPEN_ROLES;

  useEffect(() => {
    document.title = 'Careers · Pokoin';
  }, []);

  useEffect(() => {
    const hash = String(location.hash || '').replace(/^#/, '');
    if (hash !== 'open-positions') return;
    const node = document.getElementById('open-positions');
    if (!node) return;
    node.scrollIntoView({ block: 'start' });
  }, [location.hash, roles.length]);

  return (
    <div className="page careers-page">
      <header className="careers-hero">
        <div>
          <p className="page-kicker">Careers</p>
          <h1 className="careers-title">
            <span>Careers at Pokoin</span>
            <span className="careers-gold">Build the collector market.</span>
          </h1>
          <p className="careers-lede">
            Designers, engineers, and collectors shaping a peer-to-peer Pokémon marketplace that settles in PKN.
          </p>
          <div className="careers-actions">
            <a className="btn" href="#open-positions">Browse open roles</a>
            <Link className="btn ghost" to={APP.about}>About Pokoin</Link>
          </div>
        </div>
        <img className="careers-mark" src="/home/logo.png" width="168" height="168" alt="" />
      </header>

      <section className="careers-section careers-story" aria-labelledby="careers-mission-heading">
        <div>
          <h2 id="careers-mission-heading">Help us keep the market with the collectors</h2>
          <p>
            Pokoin is peer-to-peer. You list a card. Another collector buys it.
            Settlement is native PKN on PokoinPoS — chain ID 26062026.
          </p>
          <p>
            We are building Card Reserve, the wallet, and Scan as one product:
            live seller offers on the desk, catalog depth that respects printings,
            and tooling that stays honest when data is missing.
          </p>
        </div>
        <ul className="careers-facts">
          <li>
            <strong>Mission</strong>
            <span>A collector market that feels fast, clear, and fair — not a listing farm.</span>
          </li>
          <li>
            <strong>How we work</strong>
            <span>Ship small, keep surfaces shared, and prefer public docs over private lore.</span>
          </li>
          <li>
            <strong>Where</strong>
            <span>Roles list a location when they open. Until then, contact stays global by email.</span>
          </li>
        </ul>
      </section>

      <section className="careers-section" aria-labelledby="careers-principles-heading">
        <p className="careers-chip">
          <span className="careers-chip-mark" aria-hidden="true">★</span>
          How we work
        </p>
        <h2 id="careers-principles-heading">Principles that guide the product</h2>
        <p className="careers-section-lede">
          These are product habits, not slogans. They show up in search ranking, sold graphs, and desk empty states.
        </p>
        <ul className="careers-principles">
          {PRINCIPLES.map((item) => (
            <li key={item.title} className="careers-principle">
              <h3>{item.title}</h3>
              <p>{item.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="careers-section" aria-labelledby="careers-reasons-heading">
        <h2 id="careers-reasons-heading">Why join</h2>
        <p className="careers-section-lede">
          Concrete reasons to work on Pokoin. Benefits and compensation land with each real posting —
          this page does not invent them.
        </p>
        <ul className="careers-reasons">
          {REASONS.map((item) => (
            <li key={item.title} className="careers-reason">
              <h3>{item.title}</h3>
              <p>{item.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section
        className="careers-section careers-open"
        id="open-positions"
        aria-labelledby="careers-open-heading"
      >
        <h2 id="careers-open-heading">Open positions</h2>
        <p className="careers-section-lede">
          Full-time and contract roles will group by team here when they exist.
        </p>
        <OpenPositions roles={roles} />
      </section>

      <section className="careers-cta" aria-labelledby="careers-next-heading">
        <h2 id="careers-next-heading">Want to talk before a posting lands?</h2>
        <p>
          Send a short note to{' '}
          <a href={CAREERS_CONTACT}>contact@pokoin.com</a>
          {' '}with what you build and why Pokoin.
        </p>
        <div className="careers-actions">
          <a className="btn" href={CAREERS_CONTACT}>Email us</a>
          <Link className="btn ghost" to="/marketplace">Explore the market</Link>
        </div>
      </section>
    </div>
  );
}
