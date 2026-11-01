import { useCallback, useEffect, useState } from 'react';
import type { ApiClient } from '../lib/api';
import { addDays, defaultWeekStart, formatDate, formatRupiah, todayLocal } from '../lib/format';
import type { ForecastItem, PageData, Product, SalesReport, StockAlert } from '../types';
import { EmptyState, ErrorState, LoadingState } from '../components/Feedback';
import { RevenueChart } from '../components/RevenueChart';
import type { PageId } from '../components/AppShell';

export function Overview({ api, businessId, onNavigate }: { api: ApiClient; businessId: string; onNavigate: (page: PageId) => void }) {
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [products, setProducts] = useState<PageData<Product> | null>(null);
  const [alerts, setAlerts] = useState<StockAlert[]>([]);
  const [forecasts, setForecasts] = useState<ForecastItem[]>([]);
  const [report, setReport] = useState<SalesReport | null>(null);
  const from = defaultWeekStart();
  const to = addDays(todayLocal(), 1);

  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const [productPage, alertItems, forecastItems, salesReport] = await Promise.all([
        api.getProducts(businessId, '', 1, 100),
        api.getAlerts(businessId),
        api.getForecasts(businessId),
        api.getReport(businessId, from, to),
      ]);
      setProducts(productPage);
      setAlerts(alertItems);
      setForecasts(forecastItems);
      setReport(salesReport);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Ringkasan belum dapat dimuat.');
    } finally {
      setBusy(false);
    }
  }, [api, businessId, from, to]);

  useEffect(() => { void load(); }, [load]);

  if (busy) return <LoadingState message="Memuat ringkasan usaha..." />;
  if (error) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!report || !products) return <ErrorState message="Respons ringkasan tidak lengkap." onRetry={() => void load()} />;

  const isFirstRun = products.pagination.totalItems === 0 && report.transactionCount === 0;
  const forecastsToShow = forecasts.filter((item) => item.status !== 'NO_RECENT_SALES').slice(0, 4);

  return (
    <div className="screen screen--overview">
      <div className="screen-heading screen-heading--split">
        <div>
          <p className="overline">Ringkasan usaha</p>
          <h1>Kabar usaha hari ini</h1>
          <p className="lede">Angka penjualan untuk {formatDate(from)} sampai {formatDate(addDays(to, -1))}.</p>
        </div>
        <div className="heading-actions">
          <button className="button button--secondary" type="button" onClick={() => onNavigate('products')}>Tambah produk</button>
          <button className="button button--primary" type="button" onClick={() => onNavigate('sale')}>Catat penjualan</button>
        </div>
      </div>

      {isFirstRun ? (
        <EmptyState
          title="Mulai dengan produk pertama"
          message="Tambahkan produk dan stok awal agar penjualan serta laporan mulai tercatat di sini."
          action={<button className="button button--primary" type="button" onClick={() => onNavigate('products')}>Tambahkan produk</button>}
        />
      ) : (
        <>
          <section className="metric-row" aria-label="Metrik ringkasan">
            <article className="metric metric--lead">
              <span className="metric__label">Pendapatan kotor</span>
              <strong className="metric__value">{formatRupiah(report.totalRevenue)}</strong>
              <span className="metric__caption">{report.transactionCount} transaksi selesai dalam 7 hari</span>
            </article>
            <article className="metric">
              <span className="metric__label">Produk aktif</span>
              <strong className="metric__value">{products.pagination.totalItems}</strong>
              <button className="text-button" type="button" onClick={() => onNavigate('products')}>Buka produk</button>
            </article>
            <article className={`metric${alerts.length ? ' metric--warning' : ''}`}>
              <span className="metric__label">Perlu restok</span>
              <strong className="metric__value">{alerts.length}</strong>
              <span className="metric__caption">Stok di batas minimum atau lebih rendah</span>
            </article>
          </section>

          <section className="content-panel content-panel--chart">
            <div className="section-heading">
              <div>
                <h2>Pendapatan per hari</h2>
                <p>Transaksi yang dibatalkan tidak dihitung.</p>
              </div>
              <button className="text-button" type="button" onClick={() => onNavigate('reports')}>Buka laporan</button>
            </div>
            {report.dailyRevenue.length ? <RevenueChart data={report.dailyRevenue} /> : <EmptyState title="Belum ada catatan penjualan" message="Pendapatan harian akan terlihat setelah transaksi pertama selesai." />}
          </section>

          <div className="overview-columns">
            <section className="content-panel">
              <div className="section-heading">
                <div><h2>Stok perlu perhatian</h2><p>{alerts.length ? `${alerts.length} produk menyentuh batas minimum.` : 'Tidak ada peringatan stok saat ini.'}</p></div>
                <button className="text-button" type="button" onClick={() => onNavigate('products')}>Kelola stok</button>
              </div>
              {alerts.length === 0 ? (
                <div className="quiet-empty">Semua stok berada di atas batas minimum.</div>
              ) : (
                <ul className="compact-list">
                  {alerts.slice(0, 5).map((item) => (
                    <li key={item.productId}>
                      <span><strong>{item.productName}</strong><small>{item.type === 'OUT_OF_STOCK' ? 'Stok habis' : 'Stok menipis'}</small></span>
                      <b>{item.stockQuantity} <small>unit</small></b>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="content-panel">
              <div className="section-heading">
                <div><h2>Perkiraan stok</h2><p>Perkiraan memakai riwayat penjualan 30 hari.</p></div>
              </div>
              {forecasts.length === 0 ? (
                <div className="quiet-empty">Belum ada produk aktif untuk diperkirakan.</div>
              ) : forecastsToShow.length === 0 ? (
                <div className="quiet-empty">Belum ada penjualan terbaru. Data akan muncul setelah produk terjual.</div>
              ) : (
                <ul className="compact-list">
                  {forecastsToShow.map((item) => (
                    <li key={item.productId}>
                      <span><strong>{item.productName}</strong><small>{item.insufficientData ? 'Data belum cukup' : `${item.averageUnitsPerDay} unit terjual per hari`}</small></span>
                      <b>{item.insufficientData || item.estimatedDaysRemaining === null ? 'Belum tersedia' : `${item.estimatedDaysRemaining} hari`}</b>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
