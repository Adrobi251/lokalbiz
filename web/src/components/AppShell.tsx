import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

export type PageId = 'overview' | 'products' | 'sale' | 'reports' | 'assistant';

const navigation: Array<{ id: PageId; label: string; icon: IconName }> = [
  { id: 'overview', label: 'Ringkasan', icon: 'overview' },
  { id: 'products', label: 'Produk & stok', icon: 'products' },
  { id: 'sale', label: 'Jual', icon: 'sale' },
  { id: 'reports', label: 'Laporan', icon: 'reports' },
  { id: 'assistant', label: 'Asisten', icon: 'assistant' },
];

export function AppShell({
  page,
  businessName,
  theme,
  onNavigate,
  onToggleTheme,
  onSignOut,
  signOutError,
  children,
}: {
  page: PageId;
  businessName: string;
  theme: 'light' | 'dark';
  onNavigate: (page: PageId) => void;
  onToggleTheme: () => void;
  onSignOut: () => void;
  signOutError: string;
  children: ReactNode;
}) {
  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Navigasi utama">
        <button className="wordmark" type="button" onClick={() => onNavigate('overview')}>
          <span>LokalBiz <small>AI</small></span>
        </button>
        <div className="sidebar__business">
          <span className="overline">Ruang usaha</span>
          <strong title={businessName}>{businessName}</strong>
        </div>
        <nav className="nav-list" aria-label="Halaman">
          {navigation.map((item) => (
            <button
              className={`nav-item${page === item.id ? ' nav-item--active' : ''}`}
              type="button"
              key={item.id}
              aria-current={page === item.id ? 'page' : undefined}
              onClick={() => onNavigate(item.id)}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar__foot">
          <p>Catat usaha, satu langkah sekali.</p>
          <button className="text-button" type="button" onClick={onSignOut}>Keluar dari akun</button>
        </div>
      </aside>

      <div className="app-main">
        <header className="topbar">
          <div className="topbar__context">
            <span className="overline">{businessName}</span>
            <span className="topbar__mobile-brand">LokalBiz AI</span>
          </div>
          <div className="topbar__actions">
            <button className="icon-button" type="button" onClick={onToggleTheme} aria-label={theme === 'light' ? 'Gunakan tema gelap' : 'Gunakan tema terang'} title={theme === 'light' ? 'Tema gelap' : 'Tema terang'}>
              <Icon name={theme === 'light' ? 'moon' : 'sun'} />
            </button>
            <button className="button button--quiet settings-button" type="button" onClick={onSignOut}>Keluar</button>
          </div>
        </header>
        <main id="main-content" className="page-content" key={page}>
          {signOutError && <div className="notice notice--error session-error" role="alert">{signOutError}</div>}
          {children}
        </main>
      </div>

      <nav className="mobile-nav" aria-label="Navigasi utama">
        {navigation.map((item) => (
          <button
            className={`mobile-nav__item${page === item.id ? ' mobile-nav__item--active' : ''}`}
            type="button"
            key={item.id}
            aria-current={page === item.id ? 'page' : undefined}
            onClick={() => onNavigate(item.id)}
          >
            <Icon name={item.icon} />
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
