import { useState, type FormEvent } from 'react';
import type { ApiClient } from '../lib/api';
import { ApiError } from '../lib/api';
import { InlineNotice } from './Feedback';

export function ProductForm({ api, businessId, onSaved }: { api: ApiClient; businessId: string; onSaved: () => void }) {
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [initialStock, setInitialStock] = useState('0');
  const [minStock, setMinStock] = useState('5');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.createProduct(businessId, {
        name: name.trim(),
        sellingPrice: Number(price),
        initialStock: Number(initialStock),
        minStock: Number(minStock),
      });
      onSaved();
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : 'Produk belum berhasil disimpan.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form-stack" onSubmit={submit}>
      <label className="field">
        <span>Nama produk</span>
        <input value={name} onChange={(event) => setName(event.target.value)} maxLength={160} required autoFocus />
      </label>
      <label className="field">
        <span>Harga jual</span>
        <div className="input-with-prefix"><span>Rp</span><input type="number" min="0" step="1" inputMode="numeric" value={price} onChange={(event) => setPrice(event.target.value)} required /></div>
      </label>
      <div className="form-row">
        <label className="field">
          <span>Stok awal</span>
          <input type="number" min="0" max="1000000" step="1" inputMode="numeric" value={initialStock} onChange={(event) => setInitialStock(event.target.value)} required />
        </label>
        <label className="field">
          <span>Batas minimum</span>
          <input type="number" min="0" max="1000000" step="1" inputMode="numeric" value={minStock} onChange={(event) => setMinStock(event.target.value)} required />
        </label>
      </div>
      <p className="field-hint">Stok awal dicatat otomatis. Alasan hanya diminta untuk penyesuaian berikutnya.</p>
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      <button className="button button--primary button--wide" type="submit" disabled={busy || !name.trim() || price === ''}>
        {busy ? 'Menyimpan produk...' : 'Simpan produk'}
      </button>
    </form>
  );
}

export function StockAdjustmentForm({
  api,
  businessId,
  productId,
  currentQuantity,
  onSaved,
}: {
  api: ApiClient;
  businessId: string;
  productId: string;
  currentQuantity: number;
  onSaved: () => void;
}) {
  const [newQuantity, setNewQuantity] = useState(String(currentQuantity));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.adjustStock(businessId, productId, { newQuantity: Number(newQuantity), reason: reason.trim() });
      onSaved();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Stok belum berhasil disesuaikan.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form-stack" onSubmit={submit}>
      <p className="form-context">Stok saat ini <strong>{currentQuantity} unit</strong>. Masukkan jumlah akhir yang benar.</p>
      <label className="field">
        <span>Jumlah stok baru</span>
        <input type="number" min="0" max="1000000" step="1" inputMode="numeric" value={newQuantity} onChange={(event) => setNewQuantity(event.target.value)} required autoFocus />
      </label>
      <label className="field">
        <span>Alasan penyesuaian</span>
        <textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} rows={3} required placeholder="Contoh: hasil hitung stok fisik" />
      </label>
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      <button className="button button--primary button--wide" type="submit" disabled={busy || !reason.trim() || Number(newQuantity) === currentQuantity}>
        {busy ? 'Menyimpan perubahan...' : 'Simpan penyesuaian'}
      </button>
    </form>
  );
}
