import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { ApiClient } from '../lib/api';
import { addDays, formatDate, formatRupiah, monthStart, todayLocal } from '../lib/format';
import type { SalesReport } from '../types';
import { EmptyState, ErrorState, LoadingState } from '../components/Feedback';
import { RevenueChart } from '../components/RevenueChart';

export function Reports({ api, businessId }: { api: ApiClient; businessId: string }) {
  const today = todayLocal();
  const [fromInput, setFromInput] = useState(monthStart(today));
  const [toInput, setToInput] = useState(today);
  const [period, setPeriod] = useState({ from: monthStart(today), to: today });
  const [report, setReport] = useState<SalesReport | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (period.from > period.to) {
      setError('Tanggal mulai harus sebelum atau sama dengan tanggal akhir.');
      setBusy(false);
      return;
    }
    setBusy(true);
    setError('');
    try {
      setReport(await api.getReport(businessId, period.from, addDays(period.to, 1)));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Laporan belum dapat dimuat.');
    } finally {
      setBusy(false);
    }
  }, [api, businessId, period]);

  useEffect(() => { void load(); }, [load]);

  function applyPeriod(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPeriod({ from: fromInput, to: toInput });
  }

  return (
    <div className="screen">
      <div className="screen-heading"><p className="overline">Kinerja usaha</p><h1>Laporan penjualan</h1><p className="lede">Pendapatan kotor dari transaksi yang tidak dibatalkan.</p></div>
      <form className="period-form content-panel" onSubmit={applyPeriod}>
        <label className="field field--compact"><span>Dari tanggal</span><input type="date" value={fromInput} onChange={(event) => setFromInput(event.target.value)} required /></label>
        <label className="field field--compact"><span>Sampai tanggal</span><input type="date" value={toInput} onChange={(event) => setToInput(event.target.value)} required /></label>
        <button className="button button--primary" type="submit">Tampilkan laporan</button>
      </form>
      {busy ? <LoadingState message="Menghitung laporan penjualan..." /> : error ? <ErrorState message={error} onRetry={() => void load()} /> : report && (
        <>
          <p className="period-caption">Periode {formatDate(period.from)} sampai {formatDate(period.to)}. Tanggal akhir termasuk.</p>
          <section className="metric-row metric-row--reports" aria-label="Metrik laporan">
            <article className="metric metric--lead"><span className="metric__label">Pendapatan kotor</span><strong className="metric__value">{formatRupiah(report.totalRevenue)}</strong><span className="metric__caption">Periode yang dipilih</span></article>
            <article className="metric"><span className="metric__label">Transaksi selesai</span><strong className="metric__value">{report.transactionCount}</strong><span className="metric__caption">Transaksi dibatalkan tidak dihitung</span></article>
            {report.unitsSold !== undefined && <article className="metric"><span className="metric__label">Unit terjual</span><strong className="metric__value">{report.unitsSold}</strong><span className="metric__caption">Jumlah produk pada transaksi selesai</span></article>}
          </section>
          <section className="content-panel content-panel--chart">
            <div className="section-heading"><div><h2>Pendapatan harian</h2><p>{formatDate(period.from)} sampai {formatDate(period.to)}</p></div></div>
            {report.transactionCount === 0 ? <EmptyState title="Belum ada penjualan pada periode ini" message="Pilih rentang tanggal lain untuk melihat transaksi yang sudah tercatat." /> : <RevenueChart data={report.dailyRevenue} />}
          </section>
          <section className="content-panel top-products-panel">
            <div className="section-heading"><div><h2>Produk teratas</h2><p>Diurutkan berdasarkan jumlah terjual.</p></div></div>
            {report.topProducts.length === 0 ? <EmptyState title="Belum ada produk terjual" message="Produk yang terjual pada periode ini akan muncul di sini." /> : (
              <div className="table-scroll"><table><thead><tr><th>Produk</th><th>Jumlah terjual</th><th>Pendapatan</th></tr></thead><tbody>
                {report.topProducts.map((product, index) => <tr key={product.productId}><td data-label="Produk"><span className="rank-number">{index + 1}</span><strong>{product.productName}</strong></td><td data-label="Jumlah terjual">{product.quantitySold} unit</td><td data-label="Pendapatan">{formatRupiah(product.revenue)}</td></tr>)}
              </tbody></table></div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
