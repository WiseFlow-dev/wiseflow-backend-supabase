-- ============================================
-- Helper Query: Find Base Tables
-- Run this first to discover your actual table names
-- ============================================

-- 1. List all tables (not views) in your database
SELECT 
    schemaname,
    tablename,
    tableowner
FROM pg_catalog.pg_tables
WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
ORDER BY tablename;

-- 2. Find tables related to Plaid/accounts
SELECT 
    table_name,
    table_type
FROM information_schema.tables
WHERE table_schema = 'public'
  AND (
    table_name LIKE '%account%' 
    OR table_name LIKE '%transaction%'
    OR table_name LIKE '%plaid%'
    OR table_name LIKE '%item%'
  )
ORDER BY table_type, table_name;

-- 3. Check columns in user_accounts view (to understand its structure)
SELECT 
    column_name,
    data_type,
    is_nullable
FROM information_schema.columns
WHERE table_name = 'user_accounts'
ORDER BY ordinal_position;

-- 4. Find the view definition (shows which base tables it uses)
SELECT 
    table_name,
    view_definition
FROM information_schema.views
WHERE table_schema = 'public'
  AND table_name IN ('user_accounts', 'plaid_accounts', 'user_transactions', 'plaid_transactions');
