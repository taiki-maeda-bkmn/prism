import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

class ErrorBoundary extends React.Component<React.PropsWithChildren, { error: boolean }> {
  state = { error: false };
  static getDerivedStateFromError() { return { error: true }; }
  render() {
    if (this.state.error) return <div className="fatal-error"><h1>Prism needs to reopen.</h1><p>Your saved Markdown files are still in your notebook folder. Unsaved changes may be lost.</p><button className="primary-button" onClick={() => { window.prism?.setDirty(false); window.prism?.windowControl('close'); }}>Close without saving</button></div>;
    return this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(<ErrorBoundary><App /></ErrorBoundary>);
