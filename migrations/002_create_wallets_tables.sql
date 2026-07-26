-- ============================================
-- Migration: Create Wallets & Transactions Tables
-- For Wisey AI to access user financial data
-- ============================================

-- Create wallets table (synced from Android DataStore)
CREATE TABLE IF NOT EXISTS wallets (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'spending' CHECK (type IN ('spending', 'savings', 'cash', 'bank')),
  balance DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  currency_symbol TEXT DEFAULT '₺',
  icon_key TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create wallet_transactions table (synced from Android DataStore)
-- Note: Using different name to avoid conflict with existing Plaid/TrueLayer transactions table
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  wallet_id UUID REFERENCES wallets(id) ON DELETE CASCADE,
  amount DECIMAL(12,2) NOT NULL, -- Positive for income, negative for expenses
  category TEXT NOT NULL DEFAULT 'Other',
  title TEXT,
  note TEXT,
  date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable Row Level Security
ALTER TABLE wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_transactions ENABLE ROW LEVEL SECURITY;

-- ============================================
-- RLS Policies for wallets
-- ============================================
CREATE POLICY "Users can view own wallets"
  ON wallets
  FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own wallets"
  ON wallets
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own wallets"
  ON wallets
  FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own wallets"
  ON wallets
  FOR DELETE
  USING (auth.uid() = user_id);

-- ============================================
-- RLS Policies for wallet_transactions
-- ============================================
CREATE POLICY "Users can view own wallet transactions"
  ON wallet_transactions
  FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own wallet transactions"
  ON wallet_transactions
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own wallet transactions"
  ON wallet_transactions
  FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own wallet transactions"
  ON wallet_transactions
  FOR DELETE
  USING (auth.uid() = user_id);

-- ============================================
-- Indexes for performance
-- ============================================
CREATE INDEX IF NOT EXISTS wallets_user_id_idx ON wallets(user_id);
CREATE INDEX IF NOT EXISTS wallets_type_idx ON wallets(type);

CREATE INDEX IF NOT EXISTS wallet_transactions_user_id_idx ON wallet_transactions(user_id);
CREATE INDEX IF NOT EXISTS wallet_transactions_wallet_id_idx ON wallet_transactions(wallet_id);
CREATE INDEX IF NOT EXISTS wallet_transactions_date_idx ON wallet_transactions(date DESC);
CREATE INDEX IF NOT EXISTS wallet_transactions_category_idx ON wallet_transactions(category);

-- ============================================
-- Triggers for updated_at timestamps
-- ============================================
CREATE TRIGGER update_wallets_updated_at
  BEFORE UPDATE ON wallets
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- Comments for documentation
-- ============================================
COMMENT ON TABLE wallets IS 'User wallets synced from Android app for Wisey AI access';
COMMENT ON TABLE wallet_transactions IS 'User wallet transactions synced from Android app for Wisey AI access';
COMMENT ON COLUMN wallets.balance IS 'Current wallet balance in decimal format (e.g., 150.75)';
COMMENT ON COLUMN wallet_transactions.amount IS 'Transaction amount - positive for income, negative for expenses';
