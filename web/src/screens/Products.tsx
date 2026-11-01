import { useCallback, useEffect, useState } from 'react';
import type { ApiClient } from '../lib/api';
import { ApiError } from '../lib/api';
import { formatRupiah } from '../lib/format';
import type { PageData, Product } from '../types';
import { Dialog } from '../components/Dialog';
import { EmptyState, ErrorState, InlineNotice, LoadingState } from '../components/Feedback';
import { Icon } from '../components/Icon';
import { ProductForm, StockAdjustmentForm } from '../components/ProductForm';

export function Products({ api, businessId }: { api: ApiClient; businessId: string }) {
  const [result, setResult] = useState<PageData<Product> | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [addOpen, setAddOpen] = useState(false);
  const [stockProduct, setStockProduct] = useState<Product | null>(null);
  const [archiveProduct, setArchiveProduct] = useState<Product | null>(null);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      setResult(await api.getProducts(businessId, search, page, 20));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Produk belum dapat dimuat.');
    } finally {
      setBusy(false);
    }
  }, [api, businessId, search, page]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, search ? 220 : 0);
    return () => window.clearTimeout(timer);
  }, [load, search]);

  async function archive() {
    if (!archiveProduct) return;
    setArchiveBusy(true);
    setError('');
    try {
      await api.archiveProduct(businessId, archiveProduct.id);
      setNotice(`${archiveProduct.name} diarsipkan.`);
      setArchiveProduct(null);
      await load();
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : 'Produk belum berhasil diarsipkan.');
    } finally {
      setArchiveBusy(false);
    }
  }

  function refreshAfterSave(message: string) {
    setAddOpen(false);
    setStockProduct(null);
    setNotice(message);
    void load();
  }

  return (
    <div className="screen">
      <div className="screen-heading screen-heading--split">
        <div><p className="overline">Katalog usaha</p><h1>Produk & stok</h1><p className="lede">Pantau jumlah stok, batas minimum, dan harga jual.</p></div>
        <button className="button button--primary" type="button" onClick={() => setAddOpen(true)}><Icon name="plus" /> Tambah produk</button>
      </div>
      <div className="toolbar">
        <label className="search-field">
          <Icon name="search" />
          <span className="sr-only">Cari produk</span>
          <input type="search" value={search} onChange={(event) => { setPage(1); setSearch(event.target.value); }} placeholder="Cari nama produk" />
        </label>
        {result && <span className="result-count">{result.pagination.totalItems} produk aktif</span>}
      </div>
      {notice && <InlineNotice>{notice}</InlineNotice>}
      {error ? <ErrorState message={error} onRetry={() => void load()} /> : busy ? <LoadingState message="Memuat produk..." /> : !result || result.data.length === 0 ? (
        search.trim()
          ? <EmptyState title="Produk tidak ditemukan" message="Coba kata pencarian lain atau hapus kata kunci." />
          : <EmptyState title="Belum ada produk" message="Tambahkan produk dan stok awal untuk mulai mencatat penjualan." action={<button className="button button--primary" type="button" onClick={() => setAddOpen(true)}>Tambah produk</button>} />
      ) : (
        <section className="content-panel table-panel" aria-label="Daftar produk aktif">
          <div className="table-scroll">
            <table>
              <thead><tr><th>Produk</th><th>Harga jual</th><th>Stok</th><th>Batas minimum</th><th>Status</th><th><span className="sr-only">Tindakan</span></th></tr></thead>
              <tbody>
                {result.data.map((product) => {
                  const low = product.stockQuantity <= product.minStock;
                  return (
                    <tr key={product.id}>
                      <td data-label="Produk"><strong>{product.name}</strong>{product.sku && <small className="table-subline">SKU {product.sku}</small>}</td>
                      <td data-label="Harga jual">{formatRupiah(product.sellingPrice)}</td>
                      <td data-label="Stok"><strong>{product.stockQuantity}</strong> unit</td>
                      <td data-label="Batas minimum">{product.minStock} unit</td>
                      <td data-label="Status"><span className={`status-label ${low ? 'status-label--warning' : 'status-label--good'}`}>{low ? product.stockQuantity === 0 ? 'Stok habis' : 'Stok menipis' : 'Aktif'}</span></td>
                      <td data-label="Tindakan" className="table-actions">
                        <button className="button button--small button--secondary" type="button" onClick={() => setStockProduct(product)}>Atur stok</button>
                        <button className="button button--small button--quiet" type="button" onClick={() => setArchiveProduct(product)}>Arsipkan</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="pagination">
            <span>Halaman {result.pagination.page} dari {Math.max(1, result.pagination.totalPages)}</span>
            <div className="pagination__actions">
              <button className="button button--secondary" type="button" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>Sebelumnya</button>
              <button className="button button--secondary" type="button" disabled={page >= result.pagination.totalPages} onClick={() => setPage((value) => value + 1)}>Berikutnya</button>
            </div>
          </div>
        </section>
      )}

      <Dialog title="Tambah produk" open={addOpen} onClose={() => setAddOpen(false)}>
        <ProductForm api={api} businessId={businessId} onSaved={() => refreshAfterSave('Produk berhasil ditambahkan.')} />
      </Dialog>
      <Dialog title="Penyesuaian stok" open={Boolean(stockProduct)} onClose={() => setStockProduct(null)}>
        {stockProduct && <StockAdjustmentForm api={api} businessId={businessId} productId={stockProduct.id} currentQuantity={stockProduct.stockQuantity} onSaved={() => refreshAfterSave(`Stok ${stockProduct.name} berhasil disesuaikan.`)} />}
      </Dialog>
      <Dialog title="Arsipkan produk" open={Boolean(archiveProduct)} onClose={() => setArchiveProduct(null)}>
        <div className="confirm-panel">
          <p>Produk <strong>{archiveProduct?.name}</strong> tidak akan bisa dipilih untuk transaksi baru. Riwayat penjualan lama tetap tersimpan.</p>
          <p>Produk arsip tidak muncul di daftar aktif.</p>
          {error && <InlineNotice tone="error">{error}</InlineNotice>}
          <button className="button button--danger button--wide" type="button" disabled={archiveBusy} onClick={() => void archive()}>
            {archiveBusy ? 'Mengarsipkan...' : 'Ya, arsipkan produk'}
          </button>
        </div>
      </Dialog>
    </div>
  );
}
