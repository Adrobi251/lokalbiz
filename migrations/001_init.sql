CREATE TABLE business (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  currency TEXT NOT NULL DEFAULT 'IDR' CHECK (currency = 'IDR'),
  time_zone TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE business_membership (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES business(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role = 'OWNER'),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE (business_id, id)
) STRICT;

CREATE TABLE product (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES business(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 160),
  sku TEXT,
  unit_price INTEGER NOT NULL CHECK (unit_price BETWEEN 0 AND 9000000000000),
  stock_quantity INTEGER NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
  low_stock_threshold INTEGER NOT NULL DEFAULT 5 CHECK (low_stock_threshold >= 0),
  is_archived INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (business_id, id),
  UNIQUE (business_id, sku)
) STRICT;
CREATE INDEX product_business_active_name_idx ON product (business_id, is_archived, name);

CREATE TABLE sales_transaction (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES business(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('COMPLETED', 'VOIDED')),
  currency TEXT NOT NULL DEFAULT 'IDR' CHECK (currency = 'IDR'),
  total_amount INTEGER NOT NULL CHECK (total_amount BETWEEN 0 AND 9007199254740991),
  created_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  voided_at TEXT,
  void_reason TEXT,
  UNIQUE (business_id, id),
  CHECK ((status = 'COMPLETED' AND voided_at IS NULL AND void_reason IS NULL)
      OR (status = 'VOIDED' AND voided_at IS NOT NULL AND length(trim(void_reason)) > 0))
) STRICT;
CREATE INDEX sales_transaction_business_created_idx ON sales_transaction (business_id, created_at DESC);
CREATE INDEX sales_transaction_business_status_created_idx ON sales_transaction (business_id, status, created_at DESC);

CREATE TABLE transaction_item (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  item_order INTEGER NOT NULL CHECK (item_order >= 0),
  product_name TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price INTEGER NOT NULL CHECK (unit_price BETWEEN 0 AND 9000000000000),
  line_total INTEGER NOT NULL CHECK (line_total BETWEEN 0 AND 9007199254740991),
  CHECK (line_total = unit_price * quantity),
  FOREIGN KEY (business_id, transaction_id) REFERENCES sales_transaction (business_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (business_id, product_id) REFERENCES product (business_id, id) ON DELETE RESTRICT,
  UNIQUE (transaction_id, product_id),
  UNIQUE (transaction_id, item_order)
) STRICT;
CREATE INDEX transaction_item_business_product_idx ON transaction_item (business_id, product_id);

CREATE TABLE stock_movement (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  movement_type TEXT NOT NULL CHECK (movement_type IN ('INITIAL', 'ADJUSTMENT', 'SALE', 'VOID')),
  quantity_delta INTEGER NOT NULL CHECK (quantity_delta <> 0 OR movement_type = 'INITIAL'),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
  transaction_id TEXT,
  created_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (business_id, product_id) REFERENCES product (business_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (business_id, transaction_id) REFERENCES sales_transaction (business_id, id) ON DELETE RESTRICT,
  CHECK ((movement_type IN ('INITIAL', 'ADJUSTMENT') AND transaction_id IS NULL)
      OR (movement_type = 'SALE' AND quantity_delta < 0 AND transaction_id IS NOT NULL)
      OR (movement_type = 'VOID' AND quantity_delta > 0 AND transaction_id IS NOT NULL))
) STRICT;
CREATE INDEX stock_movement_business_product_created_idx ON stock_movement (business_id, product_id, created_at DESC);
CREATE INDEX stock_movement_transaction_idx ON stock_movement (business_id, transaction_id);

CREATE TABLE idempotency_record (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  transaction_id TEXT NOT NULL,
  response_body TEXT NOT NULL CHECK (json_valid(response_body)),
  created_at TEXT NOT NULL,
  FOREIGN KEY (business_id, transaction_id) REFERENCES sales_transaction (business_id, id) ON DELETE RESTRICT,
  UNIQUE (business_id, idempotency_key)
) STRICT;
