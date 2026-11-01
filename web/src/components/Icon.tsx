import type { ReactNode, SVGProps } from 'react';

export type IconName = 'overview' | 'products' | 'sale' | 'reports' | 'assistant' | 'plus' | 'search' | 'stock' | 'close' | 'calendar' | 'refresh' | 'moon' | 'sun' | 'chevron';

const paths: Record<IconName, ReactNode> = {
  overview: <><path d="M4 13h7V4H4z" /><path d="M15 20h5V11h-5z" /><path d="M15 8h5V4h-5z" /><path d="M4 20h7v-3H4z" /></>,
  products: <><path d="m4 8 8-4 8 4-8 4z" /><path d="M4 8v9l8 4 8-4V8" /><path d="M12 12v9" /></>,
  sale: <><path d="M6 3h12v18l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5L6 21z" /><path d="M9 8h6M9 12h6M9 16h3" /></>,
  reports: <><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></>,
  assistant: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H11l-5 4v-4.2A2.5 2.5 0 0 1 4 13.5z" /><path d="M8 8h8M8 12h5" /></>,
  plus: <><path d="M12 5v14M5 12h14" /></>,
  search: <><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 4 4" /></>,
  stock: <><path d="M4 7h16M6 7l1 13h10l1-13" /><path d="M9 7V5a3 3 0 0 1 6 0v2" /><path d="M10 11v5M14 11v5" /></>,
  close: <><path d="m6 6 12 12M18 6 6 18" /></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 10h18" /></>,
  refresh: <><path d="M20 7v5h-5" /><path d="M4 17v-5h5" /><path d="M5.6 9a7 7 0 0 1 11.6-2L20 12M4 12l2.8 5a7 7 0 0 0 11.6-2" /></>,
  moon: <><path d="M20.5 14.2A8 8 0 0 1 9.8 3.5 8.5 8.5 0 1 0 20.5 14.2z" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  chevron: <path d="m9 18 6-6-6-6" />,
};

export function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: IconName }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      {paths[name]}
    </svg>
  );
}
