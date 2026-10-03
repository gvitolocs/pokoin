import { Component } from 'react';
import { renderCrashRecord } from './render-crash.js';

/** A render or lazy-chunk failure must not leave a blank page. */
export class AppCrash extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false, name: '', message: '', release: '' };
  }

  static getDerivedStateFromError(error) {
    return {
      failed: true,
      name: String(error?.name || 'Error'),
      message: String(error?.message || '').slice(0, 180),
    };
  }

  componentDidCatch(error, info) {
    const record = renderCrashRecord(error, info);
    this.setState({ release: record.release });
  }

  render() {
    if (!this.state.failed) return this.props.children;
    const dev = Boolean(import.meta.env?.DEV);
    return (
      <main className="page desk" role="alert" style={{ minHeight: '100vh', padding: '2.5rem 1.25rem' }}>
        <h1 style={{ fontSize: '1.5rem', marginBottom: '0.75rem' }}>Something went wrong</h1>
        <p style={{ marginBottom: '1rem' }}>This page could not be drawn. Your cards and account were not changed.</p>
        {dev ? (
          <p style={{ marginBottom: '1rem', fontFamily: 'ui-monospace, monospace', fontSize: '0.85rem' }}>
            {this.state.name}: {this.state.message}
            {this.state.release ? ` · ${this.state.release}` : ''}
          </p>
        ) : null}
        <button type="button" onClick={() => window.location.reload()}>Reload</button>
      </main>
    );
  }
}
