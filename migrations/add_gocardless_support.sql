-- ============================================
-- Migration: Add GoCardless Support
-- Description: Adds provider field and GoCardless-specific tables
-- ============================================

-- IMPORTANT: plaid_accounts and plaid_transactions are VIEWS, not tables
-- We need to add provider column to the BASE TABLES

-- 1. Add provider column to BASE TABLES (not views)
-- These are the actual storage tables behind the views

-- For plaid_items (this is usually a real table)
ALTER TABLE plaid_items 
ADD COLUMN IF NOT EXISTS provider TEXT DEFAULT 'plaid' CHECK (provider IN ('plaid', 'gocardless'));

-- For accounts - add to the base table (usually named: accounts or nordigen_accounts or similar)
-- Check your actual table name in Supabase and uncomment the correct one:
-- ALTER TABLE accounts ADD COLUMN IF NOT EXISTS provider TEXT DEFAULT 'plaid' CHECK (provider IN ('plaid', 'gocardless'));
-- OR
-- ALTER TABLE nordigen_accounts ADD COLUMN IF NOT EXISTS provider TEXT DEFAULT 'plaid' CHECK (provider IN ('plaid', 'gocardless'));

-- For transactions - add to the base table (usually named: transactions)
-- ALTER TABLE transactions ADD COLUMN IF NOT EXISTS provider TEXT DEFAULT 'plaid' CHECK (provider IN ('plaid', 'gocardless'));

-- 2. Create index for faster provider queries (only on real tables, not views)
CREATE INDEX IF NOT EXISTS idx_plaid_items_provider ON plaid_items(provider, user_id);

-- 3. GoCardless-specific table for requisitions (similar to Plaid items)
CREATE TABLE IF NOT EXISTS gocardless_requisitions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    requisition_id TEXT NOT NULL UNIQUE,
    institution_id TEXT NOT NULL,
    institution_name TEXT,
    status TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES auth.users(id)
);

-- 4. Enable Row Level Security
ALTER TABLE gocardless_requisitions ENABLE ROW LEVEL SECURITY;

-- 5. RLS Policies for GoCardless
CREATE POLICY "Users can view own requisitions"
    ON gocardless_requisitions
    FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own requisitions"
    ON gocardless_requisitions
    FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own requisitions"
    ON gocardless_requisitions
    FOR UPDATE
    USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own requisitions"
    ON gocardless_requisitions
    FOR DELETE
    USING (auth.uid() = user_id);

-- 6. Add comments for documentation
COMMENT ON TABLE gocardless_requisitions IS 'Stores GoCardless requisition data for European/Turkish bank connections';
COMMENT ON COLUMN plaid_items.provider IS 'Bank data provider: plaid (US/CA) or gocardless (EU/TR)';
COMMENT ON COLUMN plaid_accounts.provider IS 'Bank data provider: plaid (US/CA) or gocardless (EU/TR)';
COMMENT ON COLUMN plaid_transactions.provider IS 'Bank data provider: plaid (US/CA) or gocardless (EU/TR)';
