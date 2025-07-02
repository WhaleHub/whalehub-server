-- Database Performance Optimization Indexes
-- Run these commands to improve query performance and prevent 502 errors

-- Index for users table (account lookups)
CREATE INDEX IF NOT EXISTS idx_users_account ON users(account);

-- Indexes for claimable_records table
CREATE INDEX IF NOT EXISTS idx_claimable_records_account_claimed 
ON claimable_records(account, claimed);

CREATE INDEX IF NOT EXISTS idx_claimable_records_created_at 
ON claimable_records(created_at DESC);

-- Indexes for pools table  
CREATE INDEX IF NOT EXISTS idx_pools_account_claimed_type 
ON pools(account, claimed, deposit_type);

CREATE INDEX IF NOT EXISTS idx_pools_sender_claimed 
ON pools(sender_public_key, claimed);

CREATE INDEX IF NOT EXISTS idx_pools_created_at 
ON pools(created_at DESC);

-- Indexes for stakes table
CREATE INDEX IF NOT EXISTS idx_stakes_account_created 
ON stakes(account, created_at DESC);

-- Indexes for lp_balances table
CREATE INDEX IF NOT EXISTS idx_lp_balances_account 
ON lp_balances(account);

-- Composite indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_claimable_records_account_claimed_created 
ON claimable_records(account, claimed, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pools_account_claimed_type_created 
ON pools(account, claimed, deposit_type, created_at DESC);

-- Analyze tables to update statistics after adding indexes
ANALYZE users;
ANALYZE claimable_records;
ANALYZE pools;
ANALYZE stakes;
ANALYZE lp_balances;

-- Optional: Add partial indexes for better performance on filtered queries
CREATE INDEX IF NOT EXISTS idx_claimable_records_unclaimed 
ON claimable_records(account, created_at DESC) 
WHERE claimed = 'UNCLAIMED';

CREATE INDEX IF NOT EXISTS idx_pools_unclaimed_locker 
ON pools(account, created_at DESC) 
WHERE claimed = 'UNCLAIMED' AND deposit_type = 'LOCKER';

-- Check index usage (run after some time to verify effectiveness)
-- SELECT schemaname, tablename, indexname, idx_scan, idx_tup_read, idx_tup_fetch 
-- FROM pg_stat_user_indexes 
-- WHERE schemaname = 'public' 
-- ORDER BY idx_scan DESC; 