import { useCallback, useEffect, useState } from 'react';
import type { ApiClient } from '../lib/api';
import { ApiError } from '../lib/api';
import { addDays, defaultWeekStart, formatDateTime, formatRupiah, todayLocal } from '../lib/format';
import type { PageData, TransactionDetail, TransactionStatus, TransactionSummary } from '../types';
import { Dialog } from '../components/Dialog';
import { EmptyState, ErrorState, InlineNotice, LoadingState } from '../components/Feedback';

export function TransactionHistory({ api, businessId, refreshKey = 0 }: { api: ApiClient; businessId: string; refreshKey?: number }) {
  const [from, setFrom] = useState(defaultWeekStart());
  const [to, setTo] = useState(todayLocal());
  const [statusFilter, setStatusFilter] = useState<'' | TransactionStatus>('');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<PageData<TransactionSummary> | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState<TransactionDetail | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const [voidBusy, setVoidBusy] = useState(false);
  const [voidError, setVoidError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    if (from > to) {
      setError('Tanggal mulai harus sebelum atau sama dengan tanggal akhir.');
      setBusy(false);
      return;
    }
    setBusy(true);
    setError('');
    try {
      setResult(await api.getTransactions(businessId, from, addDays(to, 1), page, statusFilter || undefined));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Riwayat transaksi belum dapat dimuat.');
    } finally {
      setBusy(false);
    }
  }, [api, businessId, from, to, page, statusFilter, refreshKey]);

  useEffect(() => { void load(); }, [load]);

  async function openDetail(transactionId: string) {
    setDetail(null);
    setDetailError('');
    setDetailBusy(true);
    try {
      setDetail(await api.getTransaction(businessId, transactionId));
    } catch (reason) {
      setDetailError(reason instanceof Error ? reason.message : 'Detail transaksi belum dapat dimuat.');
    } finally {
      setDetailBusy(false);
    }
  }

  async function submitVoid(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!detail || !voidReason.trim()) return;
    setVoidBusy(true);
    setVoidError('');
    try {
      await api.voidTransaction(businessId, detail.id, voidReason.trim());
      setVoidOpen(false);
      setVoidReason('');
      setNotice('Transaksi dibatalkan dan stok dipulihkan.');
      setDetail(null);
      await load();
    } catch (reason) {
      setVoidError(reason instanceof ApiError ? reason.message : 'Transaksi belum berhasil dibatalkan.');
    } finally {
      setVoidBusy(false);
    }
  }

  return (
    <section className="content-panel history-panel">
      <div className="section-heading section-heading--wrap">
        <div><h2>Riwayat transaksi</h2><p>Buka transaksi untuk melihat rincian atau membatalkan transaksi selesai.</p></div>
        {result && <span className="result-count">{result.pagination.totalItems} transaksi</span>}
      </div>
      <div className="filter-row">
        <label className="field field--compact"><span>Dari tanggal</span><input type="date" value={from} onChange={(event) => { setPage(1); setFrom(event.target.value); }} /></label>
        <label className="field field--compact"><span>Sampai tanggal</span><input type="date" value={to} onChange={(event) => { setPage(1); setTo(event.target.value); }} /></label>
        <label className="field field--compact"><span>Status</span><select value={statusFilter} onChange={(event) => { setPage(1); setStatusFilter(event.target.value as '' | TransactionStatus); }}><option value="">Semua status</option><option value="COMPLETED">Selesai</option><option value="VOIDED">Dibatalkan</option></select></label>
      </div>
      {notice && <InlineNotice>{notice}</InlineNotice>}
      {error ? <ErrorState message={error} onRetry={() => void load()} /> : busy ? <LoadingState message="Memuat riwayat transaksi..." /> : !result || result.data.length === 0 ? (
        <EmptyState title="Belum ada transaksi pada periode ini" message="Pilih rentang tanggal lain atau catat penjualan pertama." />
      ) : (
        <>
          <ul className="transaction-list">
            {result.data.map((transaction) => (
              <li key={transaction.id}>
                <div className="transaction-list__main">
                  <strong>{formatRupiah(transaction.totalAmount)}</strong>
                  <span>{formatDateTime(transaction.createdAt)}</span>
                  <small className="transaction-id">{transaction.id}</small>
                </div>
                <div className="transaction-list__side">
                  <span className={`status-label ${transaction.status === 'VOIDED' ? 'status-label--muted' : 'status-label--good'}`}>{transaction.status === 'VOIDED' ? 'Dibatalkan' : 'Selesai'}</span>
                  <button className="button button--small button--secondary" type="button" onClick={() => void openDetail(transaction.id)}>Lihat detail</button>
                </div>
              </li>
            ))}
          </ul>
          <div className="pagination">
            <span>Halaman {result.pagination.page} dari {Math.max(1, result.pagination.totalPages)}</span>
            <div className="pagination__actions">
              <button className="button button--secondary" type="button" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>Sebelumnya</button>
              <button className="button button--secondary" type="button" disabled={page >= result.pagination.totalPages} onClick={() => setPage((value) => value + 1)}>Berikutnya</button>
            </div>
          </div>
        </>
      )}

      <Dialog title="Detail transaksi" open={detailBusy || Boolean(detail) || Boolean(detailError)} onClose={() => { setDetail(null); setDetailError(''); }}>
        {detailBusy ? <LoadingState message="Memuat detail transaksi..." /> : detailError ? <div className="confirm-panel"><InlineNotice tone="error">{detailError}</InlineNotice></div> : detail && (
          <div className="transaction-detail">
            <div className="detail-total"><span>Total transaksi</span><strong>{formatRupiah(detail.totalAmount)}</strong></div>
            <p className="detail-meta">{formatDateTime(detail.createdAt)} <span className={`status-label ${detail.status === 'VOIDED' ? 'status-label--muted' : 'status-label--good'}`}>{detail.status === 'VOIDED' ? 'Dibatalkan' : 'Selesai'}</span></p>
            <div className="receipt-lines">
              {detail.items.map((item) => <div className="receipt-line" key={item.productId}><span>{item.productName}<small>{item.quantity} × {formatRupiah(item.unitPrice)}</small></span><strong>{formatRupiah(item.lineTotal)}</strong></div>)}
            </div>
            {detail.status === 'VOIDED' && <InlineNotice tone="warning">Alasan pembatalan: {detail.voidReason || 'Tidak tersedia'}</InlineNotice>}
            {detail.status === 'COMPLETED' && <button className="button button--danger button--wide" type="button" onClick={() => setVoidOpen(true)}>Batalkan transaksi</button>}
          </div>
        )}
      </Dialog>
      <Dialog title="Konfirmasi pembatalan" open={voidOpen} onClose={() => { setVoidOpen(false); setVoidError(''); }}>
        <form className="form-stack" onSubmit={(event) => void submitVoid(event)}>
          <p className="confirm-copy">Transaksi ini akan ditandai dibatalkan dan stoknya dipulihkan. Tindakan ini tidak dapat diulang.</p>
          <label className="field"><span>Alasan pembatalan</span><textarea value={voidReason} onChange={(event) => setVoidReason(event.target.value)} maxLength={500} rows={3} required autoFocus placeholder="Tuliskan alasan singkat" /></label>
          {voidError && <InlineNotice tone="error">{voidError}</InlineNotice>}
          <button className="button button--danger button--wide" type="submit" disabled={voidBusy || !voidReason.trim()}>{voidBusy ? 'Membatalkan...' : 'Ya, batalkan transaksi'}</button>
        </form>
      </Dialog>
    </section>
  );
}
