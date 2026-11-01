import { z } from 'zod';

const idSchema = z.string().uuid();
const positiveInt = z.number().int().positive();
const money = z.number().int().min(0).max(9_000_000_000_000);
const nonEmptyReason = z.string().trim().min(1).max(500);

export const authCredentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(8),
}).strict();

export const createBusinessSchema = z.object({
  name: z.string().trim().min(1).max(120),
  timeZone: z.string().trim().min(1).max(80),
}).strict();

export const createProductSchema = z.object({
  name: z.string().trim().min(1).max(160),
  sku: z.string().trim().max(80).nullable().optional(),
  sellingPrice: money,
  initialStock: z.number().int().min(0).max(1_000_000).default(0),
  minStock: z.number().int().min(0).max(1_000_000).default(5),
}).strict();

export const updateProductSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  sku: z.string().trim().max(80).nullable().optional(),
  sellingPrice: money.optional(),
  minStock: z.number().int().min(0).max(1_000_000).optional(),
  isArchived: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, 'Setidaknya satu field perubahan wajib diisi.');

export const stockAdjustmentSchema = z.object({
  newQuantity: z.number().int().min(0).max(1_000_000),
  reason: nonEmptyReason,
}).strict();

export const createTransactionSchema = z.object({
  items: z.array(z.object({ productId: idSchema, quantity: positiveInt.max(1_000_000) }).strict()).min(1).max(100),
}).strict().superRefine(({ items }, context) => {
  const ids = items.map((item) => item.productId.toLowerCase());
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: 'custom', path: ['items'], message: 'Setiap produk hanya boleh muncul satu kali dalam transaksi.' });
  }
});

export const voidTransactionSchema = z.object({ reason: nonEmptyReason }).strict();

export const paginationSchema = z.object({
  page: z.coerce.number().int().positive().max(1_000_000).default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});

export const transactionFilterSchema = paginationSchema.extend({
  status: z.enum(['COMPLETED', 'VOIDED']).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

export const productFilterSchema = paginationSchema.extend({
  search: z.string().trim().max(160).optional(),
});

export const reportFilterSchema = z.object({
  from: z.string(),
  to: z.string(),
});

export const forecastFilterSchema = z.object({
  windowDays: z.coerce.number().int().positive().default(30),
}).strict();

export const idParamSchema = z.object({ id: idSchema });
export const productIdParamSchema = z.object({ productId: idSchema });
