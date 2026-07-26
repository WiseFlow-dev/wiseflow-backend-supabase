-- New tables for receivables and planned payments/bills/incomes
-- This makes all cashflow planning entities visible to Wisey AI

-- Receivables table (money others owe the user)
CREATE TABLE IF NOT EXISTS receivables (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    person_name TEXT NOT NULL,
    original_amount_cents BIGINT NOT NULL,
    amount_received_cents BIGINT NOT NULL DEFAULT 0,
    interest_rate DECIMAL(5,2),
    due_date DATE,
    note TEXT,
    created_at_millis BIGINT DEFAULT extract(epoch from now()) * 1000,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Planned payments (generic upcoming payments, separate from subscriptions)
CREATE TABLE IF NOT EXISTS planned_payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    name TEXT NOT NULL,
    amount_cents BIGINT NOT NULL,
    due_date DATE NOT NULL,
    is_recurring BOOLEAN DEFAULT false,
    recurring_frequency TEXT CHECK (recurring_frequency IN ('WEEKLY','MONTHLY','QUARTERLY','YEARLY')),
    is_fixed_amount BOOLEAN DEFAULT true,
    actual_amount_paid_cents BIGINT,
    category TEXT,
    wallet_id UUID,
    notes TEXT,
    is_paid BOOLEAN DEFAULT false,
    icon_key TEXT,
    created_at_millis BIGINT DEFAULT extract(epoch from now()) * 1000,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Bills (structured, recurring or one-off obligations)
CREATE TABLE IF NOT EXISTS bills (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    name TEXT NOT NULL,
    amount_cents BIGINT NOT NULL,
    due_date DATE NOT NULL,
    is_recurring BOOLEAN DEFAULT false,
    recurring_frequency TEXT CHECK (recurring_frequency IN ('WEEKLY','MONTHLY','QUARTERLY','YEARLY')),
    is_fixed_amount BOOLEAN DEFAULT true,
    actual_amount_paid_cents BIGINT,
    category TEXT,
    wallet_id UUID,
    notes TEXT,
    is_paid BOOLEAN DEFAULT false,
    icon_key TEXT,
    created_at_millis BIGINT DEFAULT extract(epoch from now()) * 1000,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Expected incomes (future inflows)
CREATE TABLE IF NOT EXISTS incomes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    name TEXT NOT NULL,
    amount_cents BIGINT NOT NULL,
    expected_date DATE NOT NULL,
    is_recurring BOOLEAN DEFAULT false,
    recurring_frequency TEXT CHECK (recurring_frequency IN ('WEEKLY','MONTHLY','QUARTERLY','YEARLY')),
    is_fixed_amount BOOLEAN DEFAULT true,
    actual_amount_received_cents BIGINT,
    source TEXT,
    wallet_id UUID,
    notes TEXT,
    is_received BOOLEAN DEFAULT false,
    icon_key TEXT,
    created_at_millis BIGINT DEFAULT extract(epoch from now()) * 1000,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS receivables_user_id_idx ON receivables(user_id);
CREATE INDEX IF NOT EXISTS receivables_due_date_idx ON receivables(due_date);

CREATE INDEX IF NOT EXISTS planned_payments_user_id_idx ON planned_payments(user_id);
CREATE INDEX IF NOT EXISTS planned_payments_due_date_idx ON planned_payments(due_date);

CREATE INDEX IF NOT EXISTS bills_user_id_idx ON bills(user_id);
CREATE INDEX IF NOT EXISTS bills_due_date_idx ON bills(due_date);

CREATE INDEX IF NOT EXISTS incomes_user_id_idx ON incomes(user_id);
CREATE INDEX IF NOT EXISTS incomes_expected_date_idx ON incomes(expected_date);

-- Enable Row Level Security
ALTER TABLE receivables ENABLE ROW LEVEL SECURITY;
ALTER TABLE planned_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE incomes ENABLE ROW LEVEL SECURITY;

-- RLS policies (guarded with IF NOT EXISTS equivalents)
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'receivables' AND policyname = 'Users can manage their own receivables') THEN
        CREATE POLICY "Users can manage their own receivables" ON receivables FOR ALL USING (auth.uid() = user_id);
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'planned_payments' AND policyname = 'Users can manage their own planned payments') THEN
        CREATE POLICY "Users can manage their own planned payments" ON planned_payments FOR ALL USING (auth.uid() = user_id);
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'bills' AND policyname = 'Users can manage their own bills') THEN
        CREATE POLICY "Users can manage their own bills" ON bills FOR ALL USING (auth.uid() = user_id);
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'incomes' AND policyname = 'Users can manage their own incomes') THEN
        CREATE POLICY "Users can manage their own incomes" ON incomes FOR ALL USING (auth.uid() = user_id);
    END IF;
END $$;

-- Documentation comments
COMMENT ON TABLE receivables IS 'Money others owe the user (local Receivable model)';
COMMENT ON TABLE planned_payments IS 'User planned payments from Payments screen';
COMMENT ON TABLE bills IS 'User bills (recurring or one-off) from Payments/Subscriptions';
COMMENT ON TABLE incomes IS 'Expected incomes from Payments screen';
