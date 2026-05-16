-- ============================================================
-- Razoryn Warehouse — Postgres schema
-- Designed to support all 16 features:
--   live sync, stock checks, locations, role-based access,
--   returns, schedule, sales, low-stock, phone pricing,
--   videos, KB, login (PIN/email), barcode scanning, audit log
-- ============================================================

-- Migrations table — used by scripts/migrate.js to skip already-applied versions
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Staff & access (features 4, 13) ----------
CREATE TABLE IF NOT EXISTS users (
  id              SERIAL PRIMARY KEY,
  email           CITEXT UNIQUE,
  -- bcrypt hash of the email password (admin only required to have one)
  password_hash   TEXT,
  -- bcrypt hash of the 4-digit PIN (warehouse staff)
  pin_hash        TEXT,
  name            TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('admin','warehouse')),
  -- JSON map of granular permissions for warehouse role.
  -- Keys: inventory, scan, locations, returns, sales, pricing, kb, kbSensitive, schedule, videos
  permissions     JSONB NOT NULL DEFAULT '{}'::jsonb,
  active          BOOLEAN NOT NULL DEFAULT true,
  last_login_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS users_role_idx ON users (role) WHERE active = true;

-- ---------- Storage locations (feature 3) ----------
CREATE TABLE IF NOT EXISTS locations (
  id          SERIAL PRIMARY KEY,
  code        TEXT UNIQUE NOT NULL,        -- e.g. "A1-03"
  name        TEXT NOT NULL,                -- e.g. "Aisle A, Bay 1, Shelf 3"
  description TEXT,
  photo_path  TEXT,                         -- relative path under UPLOAD_DIR
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Products (feature 1, 8, 15) ----------
CREATE TABLE IF NOT EXISTS products (
  id                 SERIAL PRIMARY KEY,
  sku                TEXT UNIQUE NOT NULL,
  title              TEXT NOT NULL,
  brand              TEXT,
  model              TEXT,
  part_number        TEXT,
  position           TEXT,
  barcode            TEXT,
  -- Stock numbers are the single source of truth.
  -- Sync logic pushes these to Shopify and eBay.
  qty_on_hand        INTEGER NOT NULL DEFAULT 0,
  qty_reserved       INTEGER NOT NULL DEFAULT 0,
  low_stock_threshold INTEGER NOT NULL DEFAULT 2,
  price_shopify      NUMERIC(10,2),
  price_ebay         NUMERIC(10,2),
  cost_price         NUMERIC(10,2),
  image_url          TEXT,
  location_id        INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  -- External IDs for sync
  shopify_product_id    TEXT,
  shopify_variant_id    TEXT,
  shopify_inventory_id  TEXT,
  ebay_listing_id_em    TEXT,    -- Electric Motor Parts account
  ebay_listing_id_cl    TEXT,    -- Cappanel & Lamps account
  ebay_offer_id_em      TEXT,
  ebay_offer_id_cl      TEXT,
  active             BOOLEAN NOT NULL DEFAULT true,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS products_barcode_idx ON products (barcode) WHERE barcode IS NOT NULL;
CREATE INDEX IF NOT EXISTS products_sku_idx ON products (sku);
CREATE INDEX IF NOT EXISTS products_low_stock_idx ON products (qty_on_hand) WHERE active = true;

-- ---------- Stock movements (audit trail of every change) ----------
-- Replaces ad-hoc stock adjustments. Every change goes through here.
CREATE TABLE IF NOT EXISTS stock_movements (
  id           SERIAL PRIMARY KEY,
  product_id   INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  delta        INTEGER NOT NULL,           -- positive = stock in, negative = stock out
  reason       TEXT NOT NULL,               -- 'sale_shopify' | 'sale_ebay' | 'sale_direct' | 'sale_bank' | 'return' | 'damage' | 'stock_check' | 'manual' | 'sync_correction'
  reference_id INTEGER,                     -- e.g. sales.id, returns.id, stock_checks.id
  notes        TEXT,
  performed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stock_movements_product_idx ON stock_movements (product_id, created_at DESC);

-- ---------- Stock checks (feature 2) ----------
CREATE TABLE IF NOT EXISTS stock_checks (
  id            SERIAL PRIMARY KEY,
  product_id    INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  expected_qty  INTEGER NOT NULL,
  actual_qty    INTEGER NOT NULL,
  variance      INTEGER GENERATED ALWAYS AS (actual_qty - expected_qty) STORED,
  reason        TEXT,                       -- 'damaged','sold','replacement','miscount','other'
  notes         TEXT,
  photo_path    TEXT,
  performed_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stock_checks_product_idx ON stock_checks (product_id, created_at DESC);

-- ---------- Sales (feature 1, 7) ----------
CREATE TABLE IF NOT EXISTS sales (
  id              SERIAL PRIMARY KEY,
  channel         TEXT NOT NULL CHECK (channel IN ('shopify','ebay_em','ebay_cl','direct_cash','direct_bank')),
  external_order_id TEXT,                    -- Shopify order ID or eBay order ID
  customer_name   TEXT,
  customer_phone  TEXT,
  customer_email  TEXT,
  subtotal        NUMERIC(10,2) NOT NULL,
  vat             NUMERIC(10,2) NOT NULL DEFAULT 0,
  shipping        NUMERIC(10,2) NOT NULL DEFAULT 0,
  total           NUMERIC(10,2) NOT NULL,
  status          TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('pending','paid','dispatched','refunded','cancelled')),
  notes           TEXT,
  invoice_number  TEXT UNIQUE,               -- generated for direct sales
  recorded_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sales_channel_idx ON sales (channel, occurred_at DESC);
CREATE INDEX IF NOT EXISTS sales_external_idx ON sales (external_order_id) WHERE external_order_id IS NOT NULL;

-- Invoice-related columns added later. Migrated in place to preserve existing rows.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sales' AND column_name = 'payment_method') THEN
    ALTER TABLE sales ADD COLUMN payment_method TEXT;  -- 'cash' | 'card' | 'bank' | 'shopify' | 'ebay'
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sales' AND column_name = 'payment_reference') THEN
    ALTER TABLE sales ADD COLUMN payment_reference TEXT;  -- REP-{nanoid}-{C/B/S}
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sales' AND column_name = 'is_estimate') THEN
    ALTER TABLE sales ADD COLUMN is_estimate BOOLEAN NOT NULL DEFAULT false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sales' AND column_name = 'order_number') THEN
    ALTER TABLE sales ADD COLUMN order_number TEXT;  -- customer-facing order reference
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sales' AND column_name = 'vehicle_reg') THEN
    ALTER TABLE sales ADD COLUMN vehicle_reg TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sales' AND column_name = 'vin_number') THEN
    ALTER TABLE sales ADD COLUMN vin_number TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sales' AND column_name = 'shipping_address') THEN
    ALTER TABLE sales ADD COLUMN shipping_address TEXT;
  END IF;
END $$;

-- Settings: VAT registration toggle + company details — see migration block below
-- (after CREATE TABLE app_settings).

CREATE TABLE IF NOT EXISTS sale_items (
  id          SERIAL PRIMARY KEY,
  sale_id     INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id  INTEGER REFERENCES products(id) ON DELETE SET NULL,
  sku         TEXT NOT NULL,                  -- snapshot in case product is deleted
  title       TEXT NOT NULL,
  qty         INTEGER NOT NULL,
  unit_price  NUMERIC(10,2) NOT NULL,
  line_total  NUMERIC(10,2) NOT NULL
);
CREATE INDEX IF NOT EXISTS sale_items_sale_idx ON sale_items (sale_id);
CREATE INDEX IF NOT EXISTS sale_items_product_idx ON sale_items (product_id);

-- ---------- Returns (feature 5) ----------
CREATE TABLE IF NOT EXISTS returns (
  id           SERIAL PRIMARY KEY,
  sale_id      INTEGER REFERENCES sales(id) ON DELETE SET NULL,
  product_id   INTEGER REFERENCES products(id) ON DELETE SET NULL,
  channel      TEXT NOT NULL,
  qty          INTEGER NOT NULL,
  reason       TEXT,                       -- 'damaged','wrong_item','not_as_described','customer_change_of_mind'
  resolution   TEXT,                       -- 'refund','replacement','restock','dispose'
  refund_amount NUMERIC(10,2),
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','received','processed','closed')),
  notes        TEXT,
  handled_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS returns_status_idx ON returns (status, created_at DESC);

-- Extended return tracking — eBay return-case integration
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'returns' AND column_name = 'external_return_id') THEN
    ALTER TABLE returns ADD COLUMN external_return_id TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'returns' AND column_name = 'external_state') THEN
    ALTER TABLE returns ADD COLUMN external_state TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'returns' AND column_name = 'respond_by') THEN
    ALTER TABLE returns ADD COLUMN respond_by TIMESTAMPTZ;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'returns' AND column_name = 'buyer_username') THEN
    ALTER TABLE returns ADD COLUMN buyer_username TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'returns' AND column_name = 'last_synced_at') THEN
    ALTER TABLE returns ADD COLUMN last_synced_at TIMESTAMPTZ;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'returns' AND column_name = 'item_title') THEN
    ALTER TABLE returns ADD COLUMN item_title TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'returns' AND column_name = 'item_sku') THEN
    ALTER TABLE returns ADD COLUMN item_sku TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'returns' AND column_name = 'external_order_id') THEN
    ALTER TABLE returns ADD COLUMN external_order_id TEXT;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS returns_external_idx ON returns (external_return_id) WHERE external_return_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS return_photos (
  id         SERIAL PRIMARY KEY,
  return_id  INTEGER NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
  photo_path TEXT NOT NULL,
  caption    TEXT,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Schedule / tasks (feature 6) ----------
CREATE TABLE IF NOT EXISTS schedule_tasks (
  id           SERIAL PRIMARY KEY,
  title        TEXT NOT NULL,
  description  TEXT,
  task_type    TEXT,                       -- 'stock_check','returns','packing','admin','custom'
  scheduled_for DATE NOT NULL,
  due_time     TIME,
  assigned_to  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','done','skipped')),
  recurrence   TEXT,                       -- 'none','daily','weekly','monthly'
  completed_at TIMESTAMPTZ,
  completed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS schedule_date_idx ON schedule_tasks (scheduled_for, status);
CREATE INDEX IF NOT EXISTS schedule_assignee_idx ON schedule_tasks (assigned_to);

-- ---------- Notifications (feature 8) ----------
CREATE TABLE IF NOT EXISTS notifications (
  id          SERIAL PRIMARY KEY,
  type        TEXT NOT NULL,               -- 'low_stock','sync_error','return_opened','task_overdue'
  title       TEXT NOT NULL,
  body        TEXT,
  severity    TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warn','error','success')),
  -- Optional targeting; null = all admins
  target_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  read_at     TIMESTAMPTZ,
  related_type TEXT,                        -- 'product','return','sale','task'
  related_id   INTEGER,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notif_unread_idx ON notifications (target_user_id, created_at DESC) WHERE read_at IS NULL;

-- ---------- Staff notes (phone-team follow-ups) ----------
-- Notes auto-expire on read (filtered to last 31 days) so the page stays uncluttered.
-- An optional cron job permanently deletes anything older than 31 days.
CREATE TABLE IF NOT EXISTS staff_notes (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body          TEXT NOT NULL,
  customer_name  TEXT,
  customer_phone TEXT,
  customer_email TEXT,
  follow_up_date DATE,                    -- optional reminder date
  category       TEXT,                    -- 'call_back','quote','fitment_query','complaint','other'
  done_at        TIMESTAMPTZ,             -- set when the user ticks the note as done
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS staff_notes_user_idx ON staff_notes (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS staff_notes_followup_idx ON staff_notes (follow_up_date) WHERE done_at IS NULL;

-- ---------- How-to videos (feature 10) ----------
CREATE TABLE IF NOT EXISTS videos (
  id          SERIAL PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT,
  category    TEXT,                         -- 'returns','packing','stock_check','onboarding'
  video_url   TEXT NOT NULL,                -- YouTube/Vimeo/Mux URL or signed S3 URL
  thumbnail_url TEXT,
  duration_seconds INTEGER,
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Knowledge base (feature 11) ----------
CREATE TABLE IF NOT EXISTS kb_entries (
  id          SERIAL PRIMARY KEY,
  title       TEXT NOT NULL,
  category    TEXT,                         -- 'contact','login','process','supplier'
  body        TEXT,
  -- If sensitive, only admins or warehouse users with 'kbSensitive' permission can read.
  sensitive   BOOLEAN NOT NULL DEFAULT false,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kb_category_idx ON kb_entries (category);

-- ---------- Settings (single-row config) ----------
CREATE TABLE IF NOT EXISTS app_settings (
  id           INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  cash_discount_pct NUMERIC(5,2) NOT NULL DEFAULT 10.00,
  vat_rate     NUMERIC(5,2) NOT NULL DEFAULT 20.00,
  free_delivery_threshold NUMERIC(10,2) NOT NULL DEFAULT 50.00,
  same_day_cutoff_hour INTEGER NOT NULL DEFAULT 12,
  data         JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Schema migrations for app_settings — run AFTER the CREATE TABLE above so
-- fresh databases (e.g. new tenant deployments) don't try to ALTER a table
-- that doesn't exist yet. Each IF NOT EXISTS guard makes this idempotent.
DO $$ BEGIN
  -- Pricing config
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'app_settings' AND column_name = 'bank_transfer_pct'
  ) THEN
    ALTER TABLE app_settings ADD COLUMN bank_transfer_pct NUMERIC(5,2) NOT NULL DEFAULT 10.00;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'app_settings' AND column_name = 'ebay_buyer_protection_markup'
  ) THEN
    ALTER TABLE app_settings ADD COLUMN ebay_buyer_protection_markup NUMERIC(5,2) NOT NULL DEFAULT 0.00;
  END IF;
  -- VAT registration toggle + number
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'app_settings' AND column_name = 'vat_registered') THEN
    ALTER TABLE app_settings ADD COLUMN vat_registered BOOLEAN NOT NULL DEFAULT false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'app_settings' AND column_name = 'vat_number') THEN
    ALTER TABLE app_settings ADD COLUMN vat_number TEXT;
  END IF;
  -- Company details — these get sensible defaults for Razoryn; Calibre will
  -- overwrite via Settings → Company & invoice details.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'app_settings' AND column_name = 'company_name') THEN
    ALTER TABLE app_settings ADD COLUMN company_name TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'app_settings' AND column_name = 'company_address') THEN
    ALTER TABLE app_settings ADD COLUMN company_address TEXT DEFAULT 'Unit 4 Shakespeare Industrial Estate, Watford';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'app_settings' AND column_name = 'company_phone') THEN
    ALTER TABLE app_settings ADD COLUMN company_phone TEXT DEFAULT '+44 7494589542';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'app_settings' AND column_name = 'company_email') THEN
    ALTER TABLE app_settings ADD COLUMN company_email TEXT DEFAULT 'eparts@razoryn.co.uk';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'app_settings' AND column_name = 'company_website') THEN
    ALTER TABLE app_settings ADD COLUMN company_website TEXT DEFAULT 'www.razoryn.co.uk';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'app_settings' AND column_name = 'company_reg_no') THEN
    ALTER TABLE app_settings ADD COLUMN company_reg_no TEXT DEFAULT '16466013';
  END IF;
  -- Bank account details for bank-transfer invoices
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'app_settings' AND column_name = 'bank_account_name') THEN
    ALTER TABLE app_settings ADD COLUMN bank_account_name TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'app_settings' AND column_name = 'bank_sort_code') THEN
    ALTER TABLE app_settings ADD COLUMN bank_sort_code TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'app_settings' AND column_name = 'bank_account_number') THEN
    ALTER TABLE app_settings ADD COLUMN bank_account_number TEXT;
  END IF;
END $$;

-- ---------- Sync state (per-channel cursor) ----------
CREATE TABLE IF NOT EXISTS sync_state (
  channel       TEXT PRIMARY KEY,           -- 'shopify' | 'ebay_em' | 'ebay_cl'
  last_synced_at TIMESTAMPTZ,
  last_cursor    TEXT,
  last_status    TEXT,                      -- 'ok' | 'error'
  last_error     TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Audit log (feature 4 — track admin actions) ----------
CREATE TABLE IF NOT EXISTS audit_log (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,                -- 'login','update_user','create_product','sync','etc'
  target_type TEXT,
  target_id   INTEGER,
  metadata    JSONB,
  ip_address  INET,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_user_idx ON audit_log (user_id, created_at DESC);

-- Migrations to support adding columns on existing deployments
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'products' AND column_name = 'image_url'
  ) THEN
    ALTER TABLE products ADD COLUMN image_url TEXT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'avatar_url'
  ) THEN
    ALTER TABLE users ADD COLUMN avatar_url TEXT;
  END IF;
END $$;

-- Per-eBay-listing overrides (so SKU/title edits persist across mirror sessions)
CREATE TABLE IF NOT EXISTS ebay_listing_overrides (
  ebay_item_id  TEXT PRIMARY KEY,
  override_sku  TEXT,
  override_title TEXT,
  custom_price  NUMERIC(10,2),
  metafields    JSONB,
  shipping_profile_id TEXT,
  updated_at    TIMESTAMPTZ DEFAULT now()
);

-- Stable link between an eBay listing and a Shopify product, regardless of SKU/title changes.
-- Used to determine "already mirrored" status — survives renames and SKU edits.
CREATE TABLE IF NOT EXISTS mirror_links (
  ebay_item_id        TEXT PRIMARY KEY,
  shopify_product_id  BIGINT NOT NULL,
  last_mirrored_at    TIMESTAMPTZ DEFAULT now(),
  last_synced_sku     TEXT,
  last_synced_title   TEXT
);
CREATE INDEX IF NOT EXISTS idx_mirror_links_shopify_id ON mirror_links(shopify_product_id);

-- Triggers — auto-update updated_at
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'users_set_updated') THEN
    CREATE TRIGGER users_set_updated BEFORE UPDATE ON users
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'products_set_updated') THEN
    CREATE TRIGGER products_set_updated BEFORE UPDATE ON products
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'locations_set_updated') THEN
    CREATE TRIGGER locations_set_updated BEFORE UPDATE ON locations
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'kb_set_updated') THEN
    CREATE TRIGGER kb_set_updated BEFORE UPDATE ON kb_entries
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- citext extension for case-insensitive emails
CREATE EXTENSION IF NOT EXISTS citext;
