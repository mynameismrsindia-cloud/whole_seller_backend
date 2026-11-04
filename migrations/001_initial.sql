CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  password_hash text NOT NULL,
  name varchar(120) NOT NULL,
  role varchar(16) NOT NULL CHECK (role IN ('owner', 'seller')),
  store_name varchar(160) NOT NULL DEFAULT '',
  contact varchar(80) NOT NULL DEFAULT '',
  location varchar(160) NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_email_lower_uq ON users (lower(email));
CREATE INDEX users_role_idx ON users (role);

CREATE TABLE refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id uuid NOT NULL,
  token_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);

CREATE TABLE products (
  id varchar(100) PRIMARY KEY,
  name varchar(160) NOT NULL,
  quantity integer NOT NULL CHECK (quantity >= 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX products_catalog_idx ON products (created_at DESC, id DESC);
CREATE INDEX products_active_catalog_idx
  ON products (created_at DESC, id DESC) WHERE active = true;
CREATE INDEX products_name_prefix_idx ON products (lower(name) text_pattern_ops);

CREATE TABLE sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL,
  seller_id uuid NOT NULL REFERENCES users(id),
  salesman varchar(120) NOT NULL,
  store varchar(160) NOT NULL,
  contact varchar(80) NOT NULL,
  location varchar(160) NOT NULL,
  product_id varchar(100) NOT NULL REFERENCES products(id),
  product_name varchar(160) NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  rate integer NOT NULL CHECK (rate >= 0),
  total_amount bigint NOT NULL CHECK (total_amount >= 0),
  order_status varchar(16) NOT NULL DEFAULT 'pending'
    CHECK (order_status IN ('pending', 'approved')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (seller_id, request_id)
);

CREATE INDEX sales_owner_date_idx ON sales (created_at DESC, id DESC);
CREATE INDEX sales_seller_date_idx
  ON sales (seller_id, created_at DESC, id DESC);
