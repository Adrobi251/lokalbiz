CREATE TABLE IF NOT EXISTS business (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  name VARCHAR(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  currency CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'IDR',
  time_zone VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  CONSTRAINT business_name_length CHECK (CHAR_LENGTH(TRIM(name)) BETWEEN 1 AND 120),
  CONSTRAINT business_currency_idr CHECK (currency = 'IDR')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS business_membership (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  business_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id VARCHAR(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL UNIQUE,
  `role` VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  is_active TINYINT NOT NULL DEFAULT 1,
  created_at CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  UNIQUE KEY business_membership_business_id_id_uq (business_id, id),
  CONSTRAINT business_membership_business_fk FOREIGN KEY (business_id) REFERENCES business (id) ON DELETE RESTRICT,
  CONSTRAINT business_membership_role_owner CHECK (`role` = 'OWNER'),
  CONSTRAINT business_membership_active_bool CHECK (is_active IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS product (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  business_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(160) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  sku VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
  unit_price BIGINT NOT NULL,
  stock_quantity BIGINT NOT NULL DEFAULT 0,
  low_stock_threshold BIGINT NOT NULL DEFAULT 5,
  is_archived TINYINT NOT NULL DEFAULT 0,
  created_at CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  updated_at CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  UNIQUE KEY product_business_id_id_uq (business_id, id),
  UNIQUE KEY product_business_sku_uq (business_id, sku),
  KEY product_business_active_name_idx (business_id, is_archived, name),
  CONSTRAINT product_business_fk FOREIGN KEY (business_id) REFERENCES business (id) ON DELETE RESTRICT,
  CONSTRAINT product_name_length CHECK (CHAR_LENGTH(TRIM(name)) BETWEEN 1 AND 160),
  CONSTRAINT product_price_range CHECK (unit_price BETWEEN 0 AND 9000000000000),
  CONSTRAINT product_stock_nonnegative CHECK (stock_quantity >= 0),
  CONSTRAINT product_low_stock_nonnegative CHECK (low_stock_threshold >= 0),
  CONSTRAINT product_archived_bool CHECK (is_archived IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS sales_transaction (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  business_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  currency CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'IDR',
  total_amount BIGINT NOT NULL,
  created_by_user_id VARCHAR(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  created_at CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  voided_at CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NULL,
  void_reason VARCHAR(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
  UNIQUE KEY sales_transaction_business_id_id_uq (business_id, id),
  KEY sales_transaction_business_created_idx (business_id, created_at DESC),
  KEY sales_transaction_business_status_created_idx (business_id, status, created_at DESC),
  CONSTRAINT sales_transaction_business_fk FOREIGN KEY (business_id) REFERENCES business (id) ON DELETE RESTRICT,
  CONSTRAINT sales_transaction_status_valid CHECK (status IN ('COMPLETED', 'VOIDED')),
  CONSTRAINT sales_transaction_currency_idr CHECK (currency = 'IDR'),
  CONSTRAINT sales_transaction_amount_range CHECK (total_amount BETWEEN 0 AND 9007199254740991),
  CONSTRAINT sales_transaction_void_state CHECK (
    (status = 'COMPLETED' AND voided_at IS NULL AND void_reason IS NULL)
    OR (status = 'VOIDED' AND voided_at IS NOT NULL AND void_reason IS NOT NULL AND CHAR_LENGTH(TRIM(void_reason)) > 0)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS transaction_item (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  business_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  transaction_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  product_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  item_order INT NOT NULL,
  product_name VARCHAR(160) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  quantity BIGINT NOT NULL,
  unit_price BIGINT NOT NULL,
  line_total BIGINT NOT NULL,
  UNIQUE KEY transaction_item_transaction_product_uq (transaction_id, product_id),
  UNIQUE KEY transaction_item_transaction_order_uq (transaction_id, item_order),
  KEY transaction_item_business_product_idx (business_id, product_id),
  CONSTRAINT transaction_item_transaction_fk FOREIGN KEY (business_id, transaction_id)
    REFERENCES sales_transaction (business_id, id) ON DELETE RESTRICT,
  CONSTRAINT transaction_item_product_fk FOREIGN KEY (business_id, product_id)
    REFERENCES product (business_id, id) ON DELETE RESTRICT,
  CONSTRAINT transaction_item_order_nonnegative CHECK (item_order >= 0),
  CONSTRAINT transaction_item_quantity_positive CHECK (quantity > 0),
  CONSTRAINT transaction_item_price_range CHECK (unit_price BETWEEN 0 AND 9000000000000),
  CONSTRAINT transaction_item_line_total_range CHECK (line_total BETWEEN 0 AND 9007199254740991),
  CONSTRAINT transaction_item_line_total_valid CHECK (line_total = unit_price * quantity)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS stock_movement (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  business_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  product_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  movement_type VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  quantity_delta BIGINT NOT NULL,
  reason VARCHAR(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  transaction_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_by_user_id VARCHAR(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  created_at CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  KEY stock_movement_business_product_created_idx (business_id, product_id, created_at DESC),
  KEY stock_movement_transaction_idx (business_id, transaction_id),
  CONSTRAINT stock_movement_product_fk FOREIGN KEY (business_id, product_id)
    REFERENCES product (business_id, id) ON DELETE RESTRICT,
  CONSTRAINT stock_movement_transaction_fk FOREIGN KEY (business_id, transaction_id)
    REFERENCES sales_transaction (business_id, id) ON DELETE RESTRICT,
  CONSTRAINT stock_movement_type_valid CHECK (movement_type IN ('INITIAL', 'ADJUSTMENT', 'SALE', 'VOID')),
  CONSTRAINT stock_movement_quantity_valid CHECK (quantity_delta <> 0 OR movement_type = 'INITIAL'),
  CONSTRAINT stock_movement_reason_length CHECK (CHAR_LENGTH(TRIM(reason)) BETWEEN 1 AND 500),
  CONSTRAINT stock_movement_transaction_valid CHECK (
    (movement_type IN ('INITIAL', 'ADJUSTMENT') AND transaction_id IS NULL)
    OR (movement_type = 'SALE' AND quantity_delta < 0 AND transaction_id IS NOT NULL)
    OR (movement_type = 'VOID' AND quantity_delta > 0 AND transaction_id IS NOT NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS idempotency_record (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  business_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  idempotency_key VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  transaction_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  response_body LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  created_at CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  UNIQUE KEY idempotency_business_key_uq (business_id, idempotency_key),
  CONSTRAINT idempotency_record_transaction_fk FOREIGN KEY (business_id, transaction_id)
    REFERENCES sales_transaction (business_id, id) ON DELETE RESTRICT,
  CONSTRAINT idempotency_key_length CHECK (CHAR_LENGTH(idempotency_key) BETWEEN 1 AND 128),
  CONSTRAINT idempotency_request_hash_length CHECK (CHAR_LENGTH(request_hash) = 64),
  CONSTRAINT idempotency_response_json_valid CHECK (JSON_VALID(response_body))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
