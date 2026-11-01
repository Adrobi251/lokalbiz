import { useState, type FormEvent } from 'react';
import type { ApiClient } from '../lib/api';
import { ApiError } from '../lib/api';
import { addDays, defaultWeekStart, formatDate, todayLocal } from '../lib/format';
import type { AssistantSummary } from '../types';
import { EmptyState, ErrorState, InlineNotice, LoadingState } from '../components/Feedback';

export function Assistant({ api, businessId }: { api: ApiClient; businessId: string }) {
  const [from, setFrom] = useState(defaultWeekStart());
  const [to, setTo] = useState(todayLocal());
  const [summary, setSummary] = useState<AssistantSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function requestSummary(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setSummary(null);
    if (from > to) {
      setError('Tanggal mulai harus sebelum atau sama dengan tanggal akhir.');
      return;
    }
    setBusy(true);
    try {
      setSummary(await api.getAssistantSummary(businessId, from, addDays(to, 1)));
    } catch (reason) {
      if (reason instanceof ApiError && reason.code === 'AI_SUMMARY_NOT_CONFIGURED') {
        setError('Asisten belum dihubungkan ke penyedia ringkasan di server. Data penjualan tetap tersimpan dan tidak dikirim otomatis ke layanan eksternal.');
      } else {
        setError(reason instanceof Error ? reason.message : 'Ringkasan belum dapat dibuat.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="screen">
      <div className="screen-heading"><p className="overline">Baca kondisi usaha</p><h1>Asisten bisnis</h1><p className="lede">Ringkasan hanya menggunakan agregat penjualan yang tersedia di server.</p></div>
      <form id="assistant-form" className="period-form content-panel" onSubmit={(event) => void requestSummary(event)}>
        <label className="field field--compact"><span>Dari tanggal</span><input type="date" value={from} onChange={(event) => setFrom(event.target.value)} required /></label>
        <label className="field field--compact"><span>Sampai tanggal</span><input type="date" value={to} onChange={(event) => setTo(event.target.value)} required /></label>
        <button className="button button--primary" type="submit" disabled={busy}>{busy ? 'Menyusun ringkasan...' : 'Buat ringkasan'}</button>
      </form>
      {busy ? <LoadingState message="Membaca agregat usaha untuk periode ini..." /> : error ? <ErrorState message={error} onRetry={() => { const form = document.getElementById('assistant-form') as HTMLFormElement | null; form?.requestSubmit(); }} /> : summary ? (
        <article className="assistant-result content-panel">
          <div className="section-heading"><div><p className="overline">Periode {formatDate(summary.period.from)} sampai {formatDate(addDays(summary.period.to, -1))}</p><h2>Ringkasan usaha</h2></div></div>
          {summary.dataStatus === 'INSUFFICIENT_DATA' && <InlineNotice tone="warning">Data belum cukup untuk menyimpulkan pola penjualan pada periode ini.</InlineNotice>}
          <p className="assistant-summary">{summary.summary}</p>
          {summary.highlights.length > 0 && <div className="assistant-highlights"><h3>Hal yang perlu diperhatikan</h3><ul>{summary.highlights.map((highlight, index) => <li key={`${index}-${highlight}`}>{highlight}</li>)}</ul></div>}
          <p className="field-hint">Ringkasan mengikuti data periode yang dipilih. Periksa laporan untuk melihat angka sumbernya.</p>
        </article>
      ) : (
        <EmptyState title="Pilih periode untuk mulai" message="Asisten akan membuat ringkasan setelah Anda memilih rentang tanggal dan meminta analisis." />
      )}
    </div>
  );
}
