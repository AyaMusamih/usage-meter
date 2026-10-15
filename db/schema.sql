-- Accounts represent the applications using our service.
CREATE TABLE IF NOT EXISTS accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    api_key_hash TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Plans define usage limits for accounts or individual users.
CREATE TABLE IF NOT EXISTS plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
    scope TEXT NOT NULL CHECK (scope IN ('account', 'user')),
    name TEXT NOT NULL,
    monthly_limit BIGINT NOT NULL CHECK (monthly_limit >= 0),
    max_request_units BIGINT NOT NULL CHECK (max_request_units > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Each account has an assigned account-level plan.
CREATE TABLE IF NOT EXISTS account_plan_assignments (
    account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    plan_id UUID NOT NULL REFERENCES plans(id)
);

-- External users belong to an account and have individual plans.
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    external_user_id TEXT NOT NULL,
    plan_id UUID NOT NULL REFERENCES plans(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (account_id, external_user_id),
    UNIQUE (account_id, id)
);

-- Every accepted consumption request is recorded for usage tracking.
CREATE TABLE IF NOT EXISTS usage_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    user_id UUID NOT NULL,
    request_id TEXT NOT NULL,
    units BIGINT NOT NULL CHECK (units > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (account_id, user_id)
        REFERENCES users(account_id, id),
    UNIQUE (account_id, request_id)
);

-- Indexes help retrieve monthly usage and usage history efficiently.
CREATE INDEX IF NOT EXISTS idx_usage_account_created
    ON usage_events (account_id, created_at);

CREATE INDEX IF NOT EXISTS idx_usage_user_created
    ON usage_events (account_id, user_id, created_at);
