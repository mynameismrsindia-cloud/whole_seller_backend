ALTER TABLE sales
  DROP CONSTRAINT IF EXISTS sales_seller_id_request_id_key;

ALTER TABLE sales
  ADD CONSTRAINT sales_seller_request_product_key
  UNIQUE (seller_id, request_id, product_id);
