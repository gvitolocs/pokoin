import { authAnchorRel } from '@market/punchouts.js';

/** Sign-in anchor. rel=nofollow so crawlers do not queue /auth?from= URLs. */
export default function AuthLink(props) {
  const rel = () => [props.rel, authAnchorRel(props.to)].filter(Boolean).join(' ') || undefined;
  return <a class={props.class} href={props.to} rel={rel()}>{props.children}</a>;
}
