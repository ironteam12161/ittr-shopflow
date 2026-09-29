-- Additive, idempotent delivery audit for Resend invoice emails.
-- No existing invoice or customer data is modified.
CREATE TABLE IF NOT EXISTS invoice_email_deliveries(
  id BIGSERIAL PRIMARY KEY,
  invoice_id BIGINT,
  invoice_number TEXT NOT NULL,
  to_addresses JSONB NOT NULL DEFAULT '[]'::jsonb,
  cc_addresses JSONB NOT NULL DEFAULT '[]'::jsonb,
  subject TEXT NOT NULL,
  attach_pdf BOOLEAN NOT NULL DEFAULT TRUE,
  provider TEXT NOT NULL DEFAULT 'resend',
  provider_message_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','failed')),
  idempotency_key TEXT UNIQUE NOT NULL,
  error_message TEXT,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  sent_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_invoice_email_deliveries_invoice
  ON invoice_email_deliveries(invoice_id,created_at DESC);
