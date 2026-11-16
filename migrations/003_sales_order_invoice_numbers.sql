CREATE TABLE sales_orders (
  invoice_number bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  seller_id uuid NOT NULL REFERENCES users(id),
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (seller_id, request_id)
);

INSERT INTO sales_orders (seller_id, request_id, created_at)
SELECT seller_id, request_id, MIN(created_at)
FROM sales
GROUP BY seller_id, request_id
ORDER BY MIN(created_at), seller_id, request_id;
