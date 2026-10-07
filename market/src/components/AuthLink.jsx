import { Link } from 'react-router-dom';
import { authAnchorRel } from '../punchouts.js';

/** Sign-in anchor. rel=nofollow so crawlers do not queue /auth?from= URLs. */
export default function AuthLink({ to, rel, ...props }) {
  const merged = [rel, authAnchorRel(to)].filter(Boolean).join(' ');
  return <Link to={to} rel={merged || undefined} {...props} />;
}
