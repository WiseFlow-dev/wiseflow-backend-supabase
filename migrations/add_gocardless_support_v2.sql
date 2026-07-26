-- ============================================
-- Migration: Add GoCardless Support (v2)
-- Works with standard Plaid schema (base tables)
-- ============================================

-- Step 1: Run this query FIRST to see your table names:
-- SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE '%account%' OR tablename LIKE '%transaction%';

-- Then uncomment the correct ALTER statements below based on what you find

-- ============================================
-- Option A: Standard names (most common)
-- ============================================

-- Add provider to items table
ALTER TABLE IF EXISTS plaid_items 
ADD COLUMN IF NOT EXISTS provider TEXT DEFAULT 'plaid' CHECK (provider IN ('plaid', 'gocardless'));

-- Add provider to accounts table (base table, not view)
ALTER TABLE IF EXISTS accounts 
ADD COLUMN IF NOT EXISTS provider TEXT DEFAULT 'plaid' CHECK (provider IN ('plaid', 'gocardless'));

-- Add provider to transactions table (base table, not view)
ALTER TABLE IF EXISTS transactions 
ADD COLUMN IF NOT EXISTS provider TEXT DEFAULT 'plaid' CHECK (provider IN ('plaid', 'gocardless'));

-- ============================================
-- Option B: If tables have nordigen_ prefix
-- ============================================
-- ALTER TABLE IF EXISTS nordigen_accounts 
-- ADD COLUMN IF NOT EXISTS provider TEXT DEFAULT 'plaid' CHECK (provider IN ('plaid', 'gocardless'));

-- ALTER TABLE IF EXISTS nordigen_transactions 
-- ADD COLUMN IF NOT EXISTS provider TEXT DEFAULT 'plaid' CHECK (provider IN ('plaid', 'gocardless'));

-- ============================================
-- Create GoCardless requisitions table
-- ============================================
CREATE TABLE IF NOT EXISTS gocardless_requisitions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    requisition_id TEXT NOT NULL UNIQUE,
    institution_id TEXT NOT NULL,
    institution_name TEXT,
    status TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- Enable Row Level Security
-- ============================================
ALTER TABLE gocardless_requisitions ENABLE ROW LEVEL SECURITY;

-- ============================================
-- RLS Policies
-- ============================================
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

-- ============================================
-- Create indexes for better performance
-- ============================================
CREATE INDEX IF NOT EXISTS idx_plaid_items_provider 
    ON plaid_items(provider, user_id) 
    WHERE provider IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_accounts_provider 
    ON accounts(provider, user_id) 
    WHERE provider IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_transactions_provider 
    ON transactions(provider, user_id) 
    WHERE provider IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_gocardless_requisitions_user 
    ON gocardless_requisitions(user_id);

CREATE INDEX IF NOT EXISTS idx_gocardless_requisitions_status 
    ON gocardless_requisitions(status);

-- ============================================
-- Comments for documentation
-- ============================================
COMMENT ON TABLE gocardless_requisitions IS 'Stores GoCardless requisition data for European/Turkish bank connections';
COMMENT ON COLUMN gocardless_requisitions.requisition_id IS 'GoCardless requisition ID (similar to Plaid item_id)';
COMMENT ON COLUMN gocardless_requisitions.institution_id IS 'Bank institution ID from GoCardless';
COMMENT ON COLUMN gocardless_requisitions.status IS 'Requisition status: LN (linked), CR (created), etc.';
