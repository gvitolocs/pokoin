import { useNavigate, useRouteMatches } from '@solidjs/router';
import { untrack } from 'solid-js';

/** Declarative redirect for a route whose `info.to` names the target (React `<Navigate replace>`). */
export default function RedirectTo() {
  const navigate = useNavigate();
  const matches = useRouteMatches();
  const to = untrack(() => matches().at(-1)?.route?.info?.to) || '/marketplace';
  navigate(to, { replace: true });
  return null;
}
