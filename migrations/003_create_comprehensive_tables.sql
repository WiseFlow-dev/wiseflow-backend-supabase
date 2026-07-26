-- Create comprehensive tables for all WiseFlow app data
-- This will make Wisey AI see EVERYTHING in your app

-- Goals and Challenges table
CREATE TABLE IF NOT EXISTS goals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    name TEXT NOT NULL,
    target_amount_cents BIGINT NOT NULL,
    current_amount_cents BIGINT DEFAULT 0,
    target_date_millis BIGINT NOT NULL,
    linked_wallet_id UUID,
    last_deduction_date_millis BIGINT,
    deduction_frequency TEXT DEFAULT 'DAILY' CHECK (deduction_frequency IN ('DAILY', 'WEEKLY', 'MONTHLY', 'CUSTOM')),
    custom_deduction_days INTEGER DEFAULT 1,
    is_deduction_paused BOOLEAN DEFAULT false,
    minimum_wallet_balance_cents BIGINT DEFAULT 0,
    note TEXT,
    icon_key TEXT,
    is_challenge BOOLEAN DEFAULT false,
    challenge_type TEXT CHECK (challenge_type IN ('NO_SPEND', 'SAVINGS', 'BUDGET_DISCIPLINE', 'STREAK', 'CUSTOM')),
    challenge_duration TEXT CHECK (challenge_duration IN ('DAYS', 'WEEKS', 'MONTHS', 'CUSTOM')),
    challenge_duration_value INTEGER,
    challenge_data JSONB, -- Store ChallengeData as JSON
    created_at_millis BIGINT DEFAULT extract(epoch from now()) * 1000,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Categories table
CREATE TABLE IF NOT EXISTS categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    name TEXT NOT NULL,
    icon_key TEXT,
    color TEXT,
    is_income BOOLEAN DEFAULT false,
    is_system BOOLEAN DEFAULT false, -- System categories vs user-created
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Budgets table
CREATE TABLE IF NOT EXISTS budgets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    name TEXT NOT NULL,
    amount_cents BIGINT NOT NULL,
    category_id UUID REFERENCES categories(id) ON DELETE CASCADE,
    wallet_id UUID, -- Optional: budget for specific wallet
    period TEXT DEFAULT 'MONTHLY' CHECK (period IN ('DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY')),
    start_date DATE NOT NULL,
    end_date DATE,
    spent_cents BIGINT DEFAULT 0,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Debts table
CREATE TABLE IF NOT EXISTS debts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    name TEXT NOT NULL,
    total_amount_cents BIGINT NOT NULL,
    remaining_amount_cents BIGINT NOT NULL,
    interest_rate DECIMAL(5,2), -- e.g., 15.50 for 15.5%
    minimum_payment_cents BIGINT,
    due_date DATE,
    creditor TEXT,
    note TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Subscriptions table
CREATE TABLE IF NOT EXISTS subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    name TEXT NOT NULL,
    amount_cents BIGINT NOT NULL,
    billing_cycle TEXT DEFAULT 'MONTHLY' CHECK (billing_cycle IN ('DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY')),
    next_billing_date DATE NOT NULL,
    category_id UUID REFERENCES categories(id),
    wallet_id UUID, -- Which wallet it comes from
    is_active BOOLEAN DEFAULT true,
    auto_pay BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- User preferences table
CREATE TABLE IF NOT EXISTS user_preferences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL UNIQUE,
    currency TEXT DEFAULT 'USD',
    date_format TEXT DEFAULT 'MM/dd/yyyy',
    first_day_of_week INTEGER DEFAULT 1, -- 1 = Monday, 0 = Sunday
    notification_settings JSONB DEFAULT '{}',
    theme TEXT DEFAULT 'system' CHECK (theme IN ('light', 'dark', 'system')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS goals_user_id_idx ON goals(user_id);
CREATE INDEX IF NOT EXISTS goals_is_challenge_idx ON goals(is_challenge);
CREATE INDEX IF NOT EXISTS goals_target_date_idx ON goals(target_date_millis);

CREATE INDEX IF NOT EXISTS categories_user_id_idx ON categories(user_id);
CREATE INDEX IF NOT EXISTS categories_is_income_idx ON categories(is_income);

CREATE INDEX IF NOT EXISTS budgets_user_id_idx ON budgets(user_id);
CREATE INDEX IF NOT EXISTS budgets_category_id_idx ON budgets(category_id);
CREATE INDEX IF NOT EXISTS budgets_is_active_idx ON budgets(is_active);

CREATE INDEX IF NOT EXISTS debts_user_id_idx ON debts(user_id);
CREATE INDEX IF NOT EXISTS subscriptions_user_id_idx ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS subscriptions_is_active_idx ON subscriptions(is_active);

-- Enable Row Level Security
ALTER TABLE goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE debts ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;

-- Create RLS policies (with IF NOT EXISTS equivalent)
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'goals' AND policyname = 'Users can manage their own goals') THEN
        CREATE POLICY "Users can manage their own goals" ON goals FOR ALL USING (auth.uid() = user_id);
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'categories' AND policyname = 'Users can manage their own categories') THEN
        CREATE POLICY "Users can manage their own categories" ON categories FOR ALL USING (auth.uid() = user_id);
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'budgets' AND policyname = 'Users can manage their own budgets') THEN
        CREATE POLICY "Users can manage their own budgets" ON budgets FOR ALL USING (auth.uid() = user_id);
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'debts' AND policyname = 'Users can manage their own debts') THEN
        CREATE POLICY "Users can manage their own debts" ON debts FOR ALL USING (auth.uid() = user_id);
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'subscriptions' AND policyname = 'Users can manage their own subscriptions') THEN
        CREATE POLICY "Users can manage their own subscriptions" ON subscriptions FOR ALL USING (auth.uid() = user_id);
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'user_preferences' AND policyname = 'Users can manage their own preferences') THEN
        CREATE POLICY "Users can manage their own preferences" ON user_preferences FOR ALL USING (auth.uid() = user_id);
    END IF;
END $$;

-- Add comments for documentation
COMMENT ON TABLE goals IS 'User financial goals and challenges synced from Android app';
COMMENT ON TABLE categories IS 'Transaction categories for expense/income classification';
COMMENT ON TABLE budgets IS 'User budgets for spending limits and tracking';
COMMENT ON TABLE debts IS 'User debt tracking and management';
COMMENT ON TABLE subscriptions IS 'Recurring subscription payments';
COMMENT ON TABLE user_preferences IS 'User app preferences and settings';
