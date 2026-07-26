-- ============================================
-- Migration: Add TrueLayer Support
-- Description: Adds provider field and TrueLayer-specific tables
-- ============================================

-- 1. Add provider column to existing tables
ALTER TABLE plaid_items 
ADD COLUMN IF NOT EXISTS provider TEXT DEFAULT 'plaid' 
CHECK (provider IN ('plaid', 'truelayer'));

ALTER TABLE accounts 
ADD COLUMN IF NOT EXISTS provider TEXT DEFAULT 'plaid' 
CHECK (provider IN ('plaid', 'truelayer'));

ALTER TABLE transactions 
ADD COLUMN IF NOT EXISTS provider TEXT DEFAULT 'plaid' 
CHECK (provider IN ('plaid', 'truelayer'));

-- 2. Create TrueLayer-specific table for auth tokens
CREATE TABLE IF NOT EXISTS truelayer_connections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    auth_code TEXT NOT NULL,
    access_token TEXT,
    refresh_token TEXT,
    token_expires_at TIMESTAMPTZ,
    provider_id TEXT NOT NULL,
    provider_name TEXT,
    status TEXT DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Enable Row Level Security
ALTER TABLE truelayer_connections ENABLE ROW LEVEL SECURITY;

-- 4. RLS Policies for TrueLayer
CREATE POLICY "Users can view own connections"
    ON truelayer_connections
    FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own connections"
    ON truelayer_connections
    FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own connections"
    ON truelayer_connections
    FOR UPDATE
    USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own connections"
    ON truelayer_connections
    FOR DELETE
    USING (auth.uid() = user_id);

-- 5. Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_plaid_items_provider 
    ON plaid_items(provider, user_id);

CREATE INDEX IF NOT EXISTS idx_accounts_provider 
    ON accounts(provider, user_id);

CREATE INDEX IF NOT EXISTS idx_transactions_provider 
    ON transactions(provider, user_id);

CREATE INDEX IF NOT EXISTS idx_truelayer_connections_user 
    ON truelayer_connections(user_id);

CREATE INDEX IF NOT EXISTS idx_truelayer_connections_status 
    ON truelayer_connections(status);

-- 6. Comments for documentation
COMMENT ON TABLE truelayer_connections IS 'Stores TrueLayer OAuth tokens and connection data for European bank accounts';
COMMENT ON COLUMN plaid_items.provider IS 'Bank data provider: plaid (US/CA) or truelayer (EU/UK)';
COMMENT ON COLUMN accounts.provider IS 'Bank data provider: plaid (US/CA) or truelayer (EU/UK)';
COMMENT ON COLUMN transactions.provider IS 'Bank data provider: plaid (US/CA) or truelayer (EU/UK)';
