export interface Business {
  id: string;
  name: string;
  currency: 'IDR';
  timeZone: string;
  createdAt: string;
}

export interface Product {
  id: string;
  name: string;
  sku: string | null;
  sellingPrice: number;
  currency: 'IDR';
  stockQuantity: number;
  minStock: number;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Pagination {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

export interface PageData<T> {
  data: T[];
  pagination: Pagination;
}

export interface StockAlert {
  type: 'OUT_OF_STOCK' | 'LOW_STOCK';
  productId: string;
  productName: string;
  stockQuantity: number;
  minStock: number;
}

export interface ForecastItem {
  productId: string;
  productName: string;
  stockQuantity: number;
  historyDays: number;
  averageUnitsPerDay: number | null;
  estimatedDaysRemaining: number | null;
  insufficientData: boolean;
  from: string;
  to: string;
  status: 'READY' | 'INSUFFICIENT_DATA' | 'NO_RECENT_SALES';
}

export interface DailyRevenue {
  date: string;
  totalRevenue: number;
  transactionCount: number;
}

export interface TopProduct {
  productId: string;
  productName: string;
  quantitySold: number;
  revenue: number;
}

export interface SalesReport {
  totalRevenue: number;
  transactionCount: number;
  unitsSold?: number;
  dailyRevenue: DailyRevenue[];
  topProducts: TopProduct[];
}

export type TransactionStatus = 'COMPLETED' | 'VOIDED';

export interface TransactionItem {
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

export interface TransactionSummary {
  id: string;
  status: TransactionStatus;
  currency: 'IDR';
  totalAmount: number;
  createdAt: string;
}

export interface TransactionDetail extends TransactionSummary {
  items: TransactionItem[];
  voidedAt: string | null;
  voidReason: string | null;
}

export interface CreatedTransaction extends TransactionSummary {
  status: 'COMPLETED';
  items: TransactionItem[];
}

export interface AssistantSummary {
  period: { from: string; to: string; timeZone: string };
  summary: string;
  dataStatus: 'READY' | 'INSUFFICIENT_DATA';
  highlights: string[];
}
