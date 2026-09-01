import { useEffect, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { fetchExpansionSymbols, saveExpansionSymbol } from '../api.js';
import { useAuth } from '../auth.jsx';
import { authFrom } from '../punchouts.js';
import { Alert, DeskPanel, EmptyDesk, PageHead, SessionWait, Thread } from '../components/Desk.jsx';

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
    return <SessionWait />;
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
    <div className="page desk">
      <PageHead
        kicker="Ops"
        title="Admin"
        lede={admin ? 'Admin role active. Expansion symbols only.' : 'Signed in without the admin role.'}
      />
      {!admin ? (
        <EmptyDesk title="No admin tools" lede="This Firebase uid is not marked admin." />
      ) : !edit ? (
        <DeskPanel flush title="Tools">
          <div className="thread-list">
            <Thread to="/marketplace/admin/edit" title="Marketplace logo editor" meta="Expansion symbols" />
            <Thread to="/marketplace" title="Open marketplace" meta="Public shop" />
          </div>
        </DeskPanel>
      ) : (
        <>
          <DeskPanel
            title="Filter"
            actions={(
              <>
                <button className="btn" type="button" onClick={() => setQuery(filter)}>Load</button>
                <button className="btn ghost" type="button" onClick={() => navigate('/admin')}>Back</button>
              </>
            )}
          >
            <label className="sell-field">
              Name
              <input value={filter} onChange={(event) => setFilter(event.target.value)} />
            </label>
            <label className="page-lede">
              <input type="checkbox" checked={missing} onChange={(event) => setMissing(event.target.checked)} /> Missing logo only
            </label>
          </DeskPanel>
          <Alert>{error}</Alert>
          {loading ? <DeskPanel title="Expansions"><div className="skeleton-line" /></DeskPanel> : null}
          <div className="thread-list">
            {rows.map((row) => (
              <form
                className="desk-panel"
                key={row.name}
                onSubmit={(event) => {
                  event.preventDefault();
                  save(row);
                }}
              >
                <h2>{row.name}</h2>
                <div className="desk-body">
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
                </div>
                <div className="desk-actions">
                  <button className="btn" type="submit">Save</button>
                </div>
              </form>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
