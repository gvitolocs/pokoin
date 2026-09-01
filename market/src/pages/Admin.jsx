import { useEffect, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { fetchExpansionSymbols, saveExpansionSymbol } from '../api.js';
import { useAuth } from '../auth.jsx';
import { authFrom } from '../punchouts.js';

export default function Admin() {
  const location = useLocation();
  const navigate = useNavigate();
  const { ready, signedIn, admin, getBearer } = useAuth();
  const [rows, setRows] = useState([]);
  const [filter, setFilter] = useState('');
  const [query, setQuery] = useState('');
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const edit = location.pathname.includes('/edit');

  useEffect(() => {
    document.title = 'Admin · Pokoin';
  }, []);

  useEffect(() => {
    if (!signedIn || !admin || !edit) {
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    getBearer()
      .then((token) => fetchExpansionSymbols(token, { query, missingOnly: missing }))
      .then((data) => {
        if (cancelled) return;
        setRows((data.expansions || []).map((row) => ({
          name: row.name || '',
          symbolImageUrl: row.symbolImageUrl || row.symbol_image_url || '',
          logoImageUrl: row.logoImageUrl || row.logo_image_url || '',
          sourceAssetCode: row.sourceAssetCode || row.source_asset_code || '',
        })));
        setError('');
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Admin load failed.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [signedIn, admin, edit, query, missing, getBearer]);

  if (!ready) {
    return <div className="page"><p className="muted">Checking session…</p></div>;
  }
  if (!signedIn) {
    return <Navigate to={authFrom(location.pathname || '/admin')} replace />;
  }

  async function save(row) {
    try {
      const token = await getBearer();
      await saveExpansionSymbol({
        name: row.name,
        symbolImageUrl: row.symbolImageUrl,
        logoImageUrl: row.logoImageUrl,
        sourceAssetCode: row.sourceAssetCode,
      }, token);
    } catch (err) {
      setError(err.message || 'Save failed.');
    }
  }

  return (
    <div className="page app-page">
      <div className="comp-head">
        <div>
          <p className="eyebrow">Ops</p>
          <h1>Admin</h1>
          <p className="muted">{admin ? 'Admin role active.' : 'This account is signed in without the admin role.'}</p>
        </div>
      </div>
      {!admin ? (
        <p className="muted">No admin tools on this session.</p>
      ) : !edit ? (
        <div className="link-list">
          <Link to="/marketplace/admin/edit">Marketplace logo editor</Link>
          <Link to="/marketplace">Open marketplace</Link>
        </div>
      ) : (
        <>
          <form className="actions" onSubmit={(event) => { event.preventDefault(); setQuery(filter); }}>
            <label className="sell-field">
              Filter
              <input value={filter} onChange={(event) => setFilter(event.target.value)} />
            </label>
            <label className="muted">
              <input type="checkbox" checked={missing} onChange={(event) => setMissing(event.target.checked)} /> Missing logo only
            </label>
            <button className="btn" type="submit">Load</button>
            <button className="btn ghost" type="button" onClick={() => navigate('/admin')}>Back</button>
          </form>
          {error ? <p className="status error">{error}</p> : null}
          {loading ? <p className="muted">Loading expansions…</p> : null}
          <div className="forum-list">
            {rows.map((row) => (
              <form
                className="forum-row admin-row"
                key={row.name}
                onSubmit={(event) => {
                  event.preventDefault();
                  save(row);
                }}
              >
                <strong>{row.name}</strong>
                <label className="sell-field">
                  Symbol URL
                  <input
                    value={row.symbolImageUrl}
                    onChange={(event) => {
                      const next = event.target.value;
                      setRows((current) => current.map((item) => (item.name === row.name ? { ...item, symbolImageUrl: next } : item)));
                    }}
                  />
                </label>
                <label className="sell-field">
                  Logo URL
                  <input
                    value={row.logoImageUrl}
                    onChange={(event) => {
                      const next = event.target.value;
                      setRows((current) => current.map((item) => (item.name === row.name ? { ...item, logoImageUrl: next } : item)));
                    }}
                  />
                </label>
                <button className="btn" type="submit">Save</button>
              </form>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
