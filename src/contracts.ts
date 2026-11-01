export type TransactionStatus = 'COMPLETED' | 'VOIDED';
export type Currency = 'IDR';

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface AuthResponse {
  data: {
    user: {
      id: string;
      email: string;
    };
  };
}

export interface CsrfTokenResponse {
  data: {
    csrfToken: string;
  };
}

export interface TransactionItemSnapshot {
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

export interface TransactionCreated {
  id: string;
  status: 'COMPLETED';
  createdAt: string;
  currency: Currency;
  items: TransactionItemSnapshot[];
  totalAmount: number;
}

export interface TransactionDetail extends Omit<TransactionCreated, 'status'> {
  status: TransactionStatus;
  voidedAt: string | null;
  voidReason: string | null;
}

export type VoidResult = TransactionDetail;

export interface ProductResponse {
  id: string;
  name: string;
  sku: string | null;
  sellingPrice: number;
  currency: Currency;
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

export interface StockAdjustmentResult {
  id: string;
  productId: string;
  stockQuantity: number;
  movement: {
    id: string;
    type: 'ADJUSTMENT';
    previousQuantity: number;
    quantityDelta: number;
    newQuantity: number;
    reason: string;
    createdAt: string;
  };
}

export interface LowStockAlert {
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
  averageUnitsPerDay: number | null;
  estimatedDaysRemaining: number | null;
  insufficientData: boolean;
  historyDays: number;
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
