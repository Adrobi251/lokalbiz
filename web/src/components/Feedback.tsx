import type { ReactNode } from 'react';
import { Icon } from './Icon';

export function LoadingState({ message = 'Memuat data...' }: { message?: string }) {
  return (
    <div className="state-message" role="status" aria-busy="true">
      <span className="loading-mark" aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="state-box state-box--error" role="alert">
      <strong>Data belum dapat dimuat</strong>
      <p>{message}</p>
      <button className="button button--secondary" type="button" onClick={onRetry}>
        <Icon name="refresh" /> Coba lagi
      </button>
    </div>
  );
}

export function EmptyState({ title, message, action }: { title: string; message: string; action?: ReactNode }) {
  return (
    <div className="state-box state-box--empty" role="status">
      <strong>{title}</strong>
      <p>{message}</p>
      {action}
    </div>
  );
}

export function InlineNotice({ children, tone = 'success' }: { children: ReactNode; tone?: 'success' | 'error' | 'warning' }) {
  return <div className={`notice notice--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>{children}</div>;
}
