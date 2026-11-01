import { useCallback, useEffect, useRef, useState } from 'react';
import { AppShell, type PageId } from './components/AppShell';
import { AuthForm, CreateBusinessForm } from './components/ConnectionForm';
import { ErrorState, LoadingState } from './components/Feedback';
import { ApiClient, ApiError, authenticateUser, fetchCsrfToken, type AuthMode } from './lib/api';
import type { Business } from './types';
import { Assistant } from './screens/Assistant';
import { Overview } from './screens/Overview';
import { Products } from './screens/Products';
import { Reports } from './screens/Reports';
import { Sales } from './screens/Sales';

const apiBaseKey = 'lokalbiz-api-base';
const defaultApiBase = import.meta.env.VITE_API_BASE_URL || '/api';

type Gate = 'checking' | 'auth' | 'business' | 'ready';
type Theme = 'light' | 'dark';

export function App() {
  const [gate, setGate] = useState<Gate>('checking');
  const [api, setApi] = useState<ApiClient | null>(null);
  const [business, setBusiness] = useState<Business | null>(null);
  const [authError, setAuthError] = useState('');
  const [signOutError, setSignOutError] = useState('');
  const [page, setPage] = useState<PageId>('overview');
  const [theme, setTheme] = useState<Theme>(() => localStorage.getItem('lokalbiz-theme') === 'dark' ? 'dark' : 'light');
  const initialSessionCheckStarted = useRef(false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('lokalbiz-theme', theme);
  }, [theme]);

  const acceptConnection = useCallback(async (baseUrl: string, sessionCsrfToken: string) => {
    const nextApi = new ApiClient(baseUrl, sessionCsrfToken);
    setAuthError('');
    try {
      const nextBusiness = await nextApi.getBusiness();
      sessionStorage.setItem(apiBaseKey, baseUrl);
      setApi(nextApi);
      setBusiness(nextBusiness);
      setGate('ready');
      setPage('overview');
    } catch (reason) {
      if (reason instanceof ApiError && reason.code === 'BUSINESS_NOT_FOUND') {
        sessionStorage.setItem(apiBaseKey, baseUrl);
        setApi(nextApi);
        setBusiness(null);
        setGate('business');
        return;
      }
      throw reason;
    }
  }, []);

  async function authenticate(email: string, password: string, mode: AuthMode) {
    setAuthError('');
    const baseUrl = sessionStorage.getItem(apiBaseKey) || defaultApiBase;
    await authenticateUser(mode, email, password, baseUrl);
    const sessionCsrfToken = await fetchCsrfToken(baseUrl);
    await acceptConnection(baseUrl, sessionCsrfToken);
  }

  useEffect(() => {
    if (initialSessionCheckStarted.current) return;
    initialSessionCheckStarted.current = true;
    const baseUrl = sessionStorage.getItem(apiBaseKey) || defaultApiBase;
    const currentApi = new ApiClient(baseUrl);
    setApi(currentApi);

    async function restoreSession() {
      try {
        let currentBusiness: Business;
        try {
          currentBusiness = await currentApi.getBusiness();
        } catch (reason) {
          if (!(reason instanceof ApiError && reason.code === 'BUSINESS_NOT_FOUND')) throw reason;
          const token = await fetchCsrfToken(baseUrl);
          currentApi.setCsrfToken(token);
          setBusiness(null);
          setGate('business');
          return;
        }

        const token = await fetchCsrfToken(baseUrl);
        currentApi.setCsrfToken(token);
        setBusiness(currentBusiness);
        setGate('ready');
      } catch (reason) {
        setApi(null);
        setAuthError(reason instanceof ApiError && reason.status === 401
          ? ''
          : reason instanceof Error ? reason.message : 'Sesi usaha belum dapat dipulihkan. Coba masuk kembali.');
        setGate('auth');
      }
    }

    void restoreSession();
  }, []);

  async function createBusiness(name: string, timeZone: string) {
    if (!api) throw new Error('Masuk kembali sebelum menyiapkan usaha.');
    const created = await api.createBusiness({ name, timeZone });
    setBusiness(created);
    setGate('ready');
    setPage('overview');
  }

  async function signOut() {
    if (!api) return;
    setSignOutError('');
    try {
      await api.logout();
      setApi(null);
      setBusiness(null);
      setAuthError('');
      setGate('auth');
    } catch (reason) {
      setSignOutError(reason instanceof ApiError ? reason.message : 'Belum berhasil keluar. Coba lagi.');
    }
  }

  function retrySessionCheck() {
    window.location.reload();
  }

  if (gate === 'checking') return <div className="gate-screen"><LoadingState message="Memeriksa ruang usaha..." /></div>;
  if (gate === 'auth') return (
    <div className="gate-screen">
      <main className="gate-main">
        <AuthForm onAuthenticate={authenticate} initialError={authError} />
      </main>
    </div>
  );
  if (gate === 'business') return <div className="gate-screen"><main className="gate-main"><CreateBusinessForm onCreate={createBusiness} /></main></div>;
  if (!api || !business) return <div className="gate-screen"><ErrorState message="Sesi usaha tidak lengkap. Muat ulang pemeriksaan sesi untuk melanjutkan." onRetry={retrySessionCheck} /></div>;

  return (
    <>
      <a className="skip-link" href="#main-content">Lewati ke konten utama</a>
      <AppShell
        page={page}
        businessName={business.name}
        theme={theme}
        onNavigate={setPage}
        onToggleTheme={() => setTheme((current) => current === 'light' ? 'dark' : 'light')}
        onSignOut={signOut}
        signOutError={signOutError}
      >
        {page === 'overview' && <Overview api={api} businessId={business.id} onNavigate={setPage} />}
        {page === 'products' && <Products api={api} businessId={business.id} />}
        {page === 'sale' && <Sales api={api} businessId={business.id} />}
        {page === 'reports' && <Reports api={api} businessId={business.id} />}
        {page === 'assistant' && <Assistant api={api} businessId={business.id} />}
      </AppShell>
    </>
  );
}
