import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../lib/api';
import { ApiError as ApiErrorClass } from '../lib/api';
import { formatRupiah } from '../lib/format';
import type { CreatedTransaction, PageData, Product } from '../types';
import { Dialog } from '../components/Dialog';
import { EmptyState, ErrorState, InlineNotice, LoadingState } from '../components/Feedback';
import { Icon } from '../components/Icon';
import { TransactionHistory } from './TransactionHistory';

interface CartItem {
  product: Product;
  quantity: number;
}

interface StockIssue {
  productId: string;
  available: number;
  requested: number;
}

export function Sales({ api, businessId }: { api: ApiClient; businessId: string }) {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [products, setProducts] = useState<PageData<Product> | null>(null);
  const [productsBusy, setProductsBusy] = useState(true);
  const [productsError, setProductsError] = useState('');
  const [cart, setCart] = useState<CartItem[]>([]);
  const [stockIssues, setStockIssues] = useState<StockIssue[]>([]);
  const [saleError, setSaleError] = useState('');
  const [saleBusy, setSaleBusy] = useState(false);
  const [receipt, setReceipt] = useState<CreatedTransaction | null>(null);
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const idempotencyKey = useRef('');

  const loadProducts = useCallback(async () => {
    setProductsBusy(true);
    setProductsError('');
    try {
      setProducts(await api.getProducts(businessId, search, page, 12));
    } catch (reason) {
      setProductsError(reason instanceof Error ? reason.message : 'Daftar produk belum dapat dimuat.');
    } finally {
      setProductsBusy(false);
    }
  }, [api, businessId, search, page]);

  useEffect(() => { void loadProducts(); }, [loadProducts]);

  function changeCart(update: (current: CartItem[]) => CartItem[]) {
    setCart((current) => update(current));
    idempotencyKey.current = '';
    setStockIssues([]);
    setSaleError('');
  }

  function addProduct(product: Product) {
    changeCart((current) => {
      const existing = current.find((item) => item.product.id === product.id);
      if (existing) return current.map((item) => item.product.id === product.id ? { ...item, quantity: item.quantity + 1 } : item);
      return [...current, { product, quantity: 1 }];
    });
  }

  function setQuantity(productId: string, quantity: number) {
    changeCart((current) => quantity < 1
      ? current.filter((item) => item.product.id !== productId)
      : current.map((item) => item.product.id === productId ? { ...item, quantity } : item));
  }

  async function submitSale() {
    if (!cart.length || saleBusy) return;
    setSaleBusy(true);
    setSaleError('');
    if (!idempotencyKey.current) idempotencyKey.current = crypto.randomUUID();
    try {
      const created = await api.createTransaction(
        businessId,
        cart.map((item) => ({ productId: item.product.id, quantity: item.quantity })),
        idempotencyKey.current,
      );
      setReceipt(created);
      setCart([]);
      setStockIssues([]);
      idempotencyKey.current = '';
      setHistoryRefresh((value) => value + 1);
      await loadProducts();
    } catch (reason) {
      if (reason instanceof ApiErrorClass && reason.code === 'INSUFFICIENT_STOCK') {
        const details = reason.details as { items?: StockIssue[] } | undefined;
        setStockIssues(details?.items ?? []);
        setSaleError('Stok berubah sejak daftar dimuat. Sesuaikan jumlah di keranjang, lalu coba lagi.');
      } else {
        setSaleError(reason instanceof ApiErrorClass ? reason.message : 'Transaksi belum berhasil. Keranjang tetap tersimpan.');
      }
    } finally {
      setSaleBusy(false);
    }
  }

  const estimatedTotal = cart.reduce((sum, item) => sum + item.product.sellingPrice * item.quantity, 0);
  const issueFor = (productId: string) => stockIssues.find((item) => item.productId === productId);

  return (
    <div className="screen">
      <div className="screen-heading"><p className="overline">Kasir</p><h1>Catat penjualan</h1><p className="lede">Pilih produk, atur jumlah, lalu simpan transaksi.</p></div>
      <div className="sale-layout">
        <section className="content-panel product-picker">
          <div className="section-heading"><div><h2>Pilih produk</h2><p>Produk aktif yang bisa dijual.</p></div>{products && <span className="result-count">{products.pagination.totalItems} produk</span>}</div>
          <label className="search-field"><Icon name="search" /><span className="sr-only">Cari produk untuk dijual</span><input type="search" value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="Cari produk" /></label>
          {productsError ? <ErrorState message={productsError} onRetry={() => void loadProducts()} /> : productsBusy ? <LoadingState message="Memuat produk aktif..." /> : !products || products.data.length === 0 ? (
            <EmptyState title={search ? 'Produk tidak ditemukan' : 'Belum ada produk aktif'} message={search ? 'Coba kata pencarian lain.' : 'Tambahkan produk sebelum mencatat penjualan.'} />
          ) : (
            <>
              <ul className="picker-list">
                {products.data.map((product) => {
                  const low = product.stockQuantity <= product.minStock;
                  return (
                    <li key={product.id}>
                      <div className="picker-product"><strong>{product.name}</strong><span>{formatRupiah(product.sellingPrice)}</span><small className={low ? 'text-warning' : ''}>{product.stockQuantity} unit tersedia{low ? ', stok menipis' : ''}</small></div>
                      <button className="button button--small button--secondary" type="button" disabled={product.stockQuantity === 0} onClick={() => addProduct(product)} aria-label={`Tambah ${product.name} ke keranjang`}>
                        <Icon name="plus" /> Tambah
                      </button>
                    </li>
                  );
                })}
              </ul>
              {products.pagination.totalPages > 1 && <div className="pagination"><span>Halaman {products.pagination.page} dari {products.pagination.totalPages}</span><div className="pagination__actions"><button className="button button--secondary" type="button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Sebelumnya</button><button className="button button--secondary" type="button" disabled={page >= products.pagination.totalPages} onClick={() => setPage((value) => value + 1)}>Berikutnya</button></div></div>}
            </>
          )}
        </section>

        <section className="content-panel cart-panel" aria-labelledby="cart-title">
          <div className="section-heading"><div><h2 id="cart-title">Keranjang</h2><p>{cart.length} jenis produk</p></div></div>
          {cart.length === 0 ? <div className="quiet-empty">Pilih produk untuk mulai mencatat penjualan.</div> : (
            <>
              <ul className="cart-list">
                {cart.map((item) => {
                  const issue = issueFor(item.product.id);
                  return (
                    <li className={issue ? 'cart-line cart-line--error' : 'cart-line'} key={item.product.id}>
                      <div className="cart-line__info"><strong>{item.product.name}</strong><small>{formatRupiah(item.product.sellingPrice)} per unit</small>{issue && <span className="field-error">Stok tersedia {issue.available}, diminta {issue.requested}.</span>}</div>
                      <div className="quantity-control" aria-label={`Jumlah ${item.product.name}`}>
                        <button type="button" className="quantity-control__button" aria-label={`Kurangi ${item.product.name}`} onClick={() => setQuantity(item.product.id, item.quantity - 1)}>−</button>
                        <span>{item.quantity}</span>
                        <button type="button" className="quantity-control__button" aria-label={`Tambah ${item.product.name}`} onClick={() => setQuantity(item.product.id, item.quantity + 1)}>+</button>
                      </div>
                    </li>
                  );
                })}
              </ul>
              {saleError && <InlineNotice tone="error">{saleError}</InlineNotice>}
              <div className="cart-total"><span>Perkiraan total</span><strong>{formatRupiah(estimatedTotal)}</strong></div>
              <p className="field-hint">Harga akhir dan pengurangan stok dihitung oleh server saat transaksi disimpan.</p>
              <button className="button button--primary button--wide" type="button" disabled={saleBusy} onClick={() => void submitSale()}>{saleBusy ? 'Menyimpan transaksi...' : 'Simpan transaksi'}</button>
            </>
          )}
        </section>
      </div>
      <TransactionHistory api={api} businessId={businessId} refreshKey={historyRefresh} />
      <Dialog title="Transaksi tersimpan" open={Boolean(receipt)} onClose={() => setReceipt(null)}>
        {receipt && <div className="transaction-detail">
          <InlineNotice>Transaksi berhasil dicatat.</InlineNotice>
          <div className="detail-total"><span>Total dari server</span><strong>{formatRupiah(receipt.totalAmount)}</strong></div>
          <p className="detail-meta">{receipt.items.length} jenis produk, transaksi {receipt.id.slice(0, 8)}</p>
          <div className="receipt-lines">{receipt.items.map((item) => <div className="receipt-line" key={item.productId}><span>{item.productName}<small>{item.quantity} × {formatRupiah(item.unitPrice)}</small></span><strong>{formatRupiah(item.lineTotal)}</strong></div>)}</div>
          <button className="button button--primary button--wide" type="button" onClick={() => setReceipt(null)}>Selesai</button>
        </div>}
      </Dialog>
    </div>
  );
}
