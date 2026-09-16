import { NavLink } from 'react-router-dom';
import tests from '../../public/review/tests.json';

export default function TestDock() {
  return (
    <nav className="test-dock" aria-label="Previous tests">
      {tests.tests.map((entry) => (
        <NavLink
          key={entry.path}
          to={entry.path}
          className={({ isActive }) => (isActive ? 'on' : undefined)}
          end
        >
          <strong>{entry.label}</strong>
          <span>{entry.note}</span>
          <time dateTime={entry.date}>{entry.date}</time>
        </NavLink>
      ))}
    </nav>
  );
}
