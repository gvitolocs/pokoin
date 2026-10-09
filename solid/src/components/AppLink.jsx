import { useLinkState } from '@solidjs/router';
import { authAnchorRel, goMarket, marketUrl } from '@market/punchouts.js';

/**
 * Same-origin router link, or an absolute pokoin.com anchor when the SPA runs
 * on the dashboard host (React AppLink). The router claims plain anchors, so a
 * relative href is enough; `active` mirrors React NavLink's class for the one
 * rule that styles it (`.icon-nav a.active`).
 */
export default function AppLink(props) {
  const href = () => marketUrl(props.to);
  const external = () => String(href()).startsWith('http');
  const rel = () => [props.rel, authAnchorRel(props.to)].filter(Boolean).join(' ') || undefined;
  const link = useLinkState(() => (external() ? '' : href()));
  return (
    <a
      class={[props.class, { active: !external() && link.active() }]}
      href={href()}
      title={props.title}
      aria-label={props['aria-label']}
      rel={rel()}
      onClick={(event) => {
        if (!external()) return;
        event.preventDefault();
        goMarket(href());
      }}
    >
      {props.children}
    </a>
  );
}
