import { useState, type FormEvent } from 'react';
import { ApiError, type AuthMode } from '../lib/api';
import { InlineNotice } from './Feedback';

export function AuthForm({
  onAuthenticate,
  initialError = '',
}: {
  onAuthenticate: (email: string, password: string, mode: AuthMode) => Promise<void>;
  initialError?: string;
}) {
  const [mode, setMode] = useState<AuthMode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onAuthenticate(email.trim(), password, mode);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : 'Permintaan belum berhasil. Periksa koneksi lalu coba lagi.');
    } finally {
      setBusy(false);
    }
  }

  function changeMode(nextMode: AuthMode) {
    setMode(nextMode);
    setPassword('');
    setError('');
  }

  const isRegistering = mode === 'register';
  const message = error || initialError;

  return (
    <section className="auth-card">
      <div className="auth-card__intro">
        <p className="auth-brand">LokalBiz AI</p>
        <p className="overline">Akun usaha</p>
        <h1>{isRegistering ? 'Buat akun' : 'Masuk ke LokalBiz'}</h1>
        <p className="lede">
          {isRegistering
            ? 'Daftar dengan email dan kata sandi untuk mulai menyiapkan ruang usaha.'
            : 'Masuk dengan email dan kata sandi untuk melanjutkan ke ruang usaha Anda.'}
        </p>
      </div>
      <form className="form-stack" onSubmit={submit}>
        <label className="field" htmlFor="auth-email">
          <span>Email</span>
          <input
            id="auth-email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
          />
        </label>
        <label className="field" htmlFor="auth-password">
          <span>Kata sandi</span>
          <input
            id="auth-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete={isRegistering ? 'new-password' : 'current-password'}
            minLength={8}
            required
            aria-describedby={isRegistering ? 'auth-password-hint' : undefined}
          />
          {isRegistering && <small id="auth-password-hint">Gunakan minimal 8 karakter.</small>}
        </label>
        {message && <InlineNotice tone="error">{message}</InlineNotice>}
        <button className="button button--primary button--wide" type="submit" disabled={busy}>
          {busy ? 'Memproses...' : isRegistering ? 'Daftar' : 'Masuk'}
        </button>
        <p className="auth-switch">
          {isRegistering ? 'Sudah punya akun?' : 'Belum punya akun?'}
          <button
            className="text-button"
            type="button"
            onClick={() => changeMode(isRegistering ? 'login' : 'register')}
            disabled={busy}
          >
            {isRegistering ? 'Masuk' : 'Buat akun'}
          </button>
        </p>
        <p className="privacy-note">Sesi dikelola browser; aplikasi tidak membaca token sesi.</p>
      </form>
    </section>
  );
}

export function CreateBusinessForm({
  onCreate,
}: {
  onCreate: (name: string, timeZone: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [timeZone, setTimeZone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Jakarta');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onCreate(name.trim(), timeZone.trim());
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : 'Usaha belum berhasil dibuat.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="auth-card">
      <div className="auth-card__intro">
        <p className="auth-brand">LokalBiz AI</p>
        <p className="overline">Langkah pertama</p>
        <h1>Siapkan ruang usaha</h1>
        <p className="lede">Tambahkan nama usaha dan zona waktu. Setelah itu, produk dan transaksi akan tersimpan pada ruang ini.</p>
      </div>
      <form className="form-stack" onSubmit={submit}>
        <label className="field" htmlFor="business-name">
          <span>Nama usaha</span>
          <input id="business-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required autoFocus />
        </label>
        <label className="field" htmlFor="business-time-zone">
          <span>Zona waktu usaha</span>
          <input id="business-time-zone" value={timeZone} onChange={(event) => setTimeZone(event.target.value)} maxLength={80} required />
          <small>Gunakan nama zona waktu IANA, misalnya Asia/Jakarta.</small>
        </label>
        {error && <InlineNotice tone="error">{error}</InlineNotice>}
        <button className="button button--primary button--wide" type="submit" disabled={busy || !name.trim()}>
          {busy ? 'Menyimpan...' : 'Buat ruang usaha'}
        </button>
      </form>
    </section>
  );
}
