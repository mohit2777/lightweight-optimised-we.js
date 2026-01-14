-- =============================================================================
-- WhatsApp Multi-Automation - Complete Supabase Schema
-- Run this in Supabase SQL Editor
-- =============================================================================

-- ============================================================================
-- CORE TABLES
-- ============================================================================

-- Accounts table
CREATE TABLE IF NOT EXISTS accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    phone_number VARCHAR(50),
    status VARCHAR(50) DEFAULT 'disconnected',
    session_data TEXT,  -- Baileys session data (base64 encoded)
    last_session_saved TIMESTAMPTZ,
    qr_code TEXT,
    error_message TEXT,
    metadata JSONB DEFAULT '{}',
    last_active_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Sessions table (alternative session storage - optional)
CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    session_data TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(account_id)
);

-- ============================================================================
-- WEBHOOKS
-- ============================================================================

-- Webhooks table
-- Supported events: 'message', 'message_ack', '*' (all events)
-- message_ack statuses: sent (2), delivered (3), read (4)
CREATE TABLE IF NOT EXISTS webhooks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    events TEXT[] DEFAULT ARRAY['message'],
    secret TEXT,
    headers JSONB DEFAULT '{}',
    max_retries INTEGER DEFAULT 5,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Webhook delivery queue (for pending/retry deliveries)
CREATE TABLE IF NOT EXISTS webhook_delivery_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    webhook_id UUID REFERENCES webhooks(id) ON DELETE CASCADE,
    account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
    webhook_url TEXT NOT NULL,
    webhook_secret TEXT,
    payload JSONB NOT NULL,
    max_retries INTEGER DEFAULT 5,
    attempt_count INTEGER DEFAULT 0,
    status VARCHAR(50) DEFAULT 'pending',  -- pending, processing, success, failed, dead_letter
    response_status INTEGER,
    last_error TEXT,
    next_attempt_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Webhook deliveries log (optional - for completed deliveries history)
CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    webhook_id UUID REFERENCES webhooks(id) ON DELETE CASCADE,
    account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
    payload JSONB,
    response_status INTEGER,
    response_body TEXT,
    attempts INTEGER DEFAULT 1,
    status VARCHAR(50) DEFAULT 'success',
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    delivered_at TIMESTAMPTZ
);

-- ============================================================================
-- AI CHATBOT
-- ============================================================================

-- AI Auto Reply configurations (per account)
CREATE TABLE IF NOT EXISTS ai_auto_replies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    is_active BOOLEAN DEFAULT false,
    provider VARCHAR(50) DEFAULT 'gemini',  -- gemini, groq, openai, anthropic, openrouter
    model VARCHAR(100),
    api_key TEXT,  -- Store encrypted in production
    system_prompt TEXT DEFAULT 'You are a helpful assistant.',
    temperature DECIMAL(3,2) DEFAULT 0.7,
    max_tokens INTEGER DEFAULT 500,
    history_limit INTEGER DEFAULT 10,  -- Number of messages to remember
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(account_id)
);

-- Chatbot conversation history (for AI memory)
CREATE TABLE IF NOT EXISTS chatbot_conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    contact_number VARCHAR(50) NOT NULL,
    context JSONB DEFAULT '{}',  -- Collected data, variables
    status VARCHAR(50) DEFAULT 'active',  -- active, completed, expired
    started_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Message logs (for conversation history retrieval by AI)
-- Set DISABLE_MESSAGE_LOGGING=true to skip logging
CREATE TABLE IF NOT EXISTS message_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
    webhook_id UUID REFERENCES webhooks(id) ON DELETE SET NULL,
    direction VARCHAR(20) NOT NULL,  -- incoming, outgoing
    message_id VARCHAR(255),
    sender VARCHAR(255),
    recipient VARCHAR(255),
    message TEXT,
    media JSONB,
    timestamp BIGINT,
    type VARCHAR(50) DEFAULT 'text',
    chat_id VARCHAR(255),
    is_group BOOLEAN DEFAULT false,
    group_name VARCHAR(255),
    status VARCHAR(50) DEFAULT 'success',
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- PER-NUMBER SETTINGS (Whitelist/Blacklist)
-- ============================================================================

CREATE TABLE IF NOT EXISTS account_number_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    phone_number VARCHAR(50) NOT NULL,
    webhook_enabled BOOLEAN DEFAULT true,
    chatbot_enabled BOOLEAN DEFAULT true,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(account_id, phone_number)
);

-- ============================================================================
-- INDEXES
-- ============================================================================

-- Core indexes
CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status);
CREATE INDEX IF NOT EXISTS idx_sessions_account_id ON sessions(account_id);

-- Webhook indexes
CREATE INDEX IF NOT EXISTS idx_webhooks_account_id ON webhooks(account_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_active ON webhooks(is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_webhook_queue_status ON webhook_delivery_queue(status);
CREATE INDEX IF NOT EXISTS idx_webhook_queue_next_attempt ON webhook_delivery_queue(next_attempt_at) WHERE status IN ('pending', 'failed');
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook_id ON webhook_deliveries(webhook_id);

-- AI/Chatbot indexes
CREATE INDEX IF NOT EXISTS idx_ai_auto_replies_account ON ai_auto_replies(account_id);
CREATE INDEX IF NOT EXISTS idx_chatbot_conversations_account ON chatbot_conversations(account_id);
CREATE INDEX IF NOT EXISTS idx_chatbot_conversations_contact ON chatbot_conversations(account_id, contact_number);
CREATE INDEX IF NOT EXISTS idx_chatbot_conversations_active ON chatbot_conversations(status) WHERE status = 'active';

-- Message log indexes
CREATE INDEX IF NOT EXISTS idx_message_logs_account ON message_logs(account_id);
CREATE INDEX IF NOT EXISTS idx_message_logs_created ON message_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_message_logs_conversation ON message_logs(account_id, sender, created_at DESC);

-- Number settings indexes
CREATE INDEX IF NOT EXISTS idx_number_settings_account ON account_number_settings(account_id);
CREATE INDEX IF NOT EXISTS idx_number_settings_phone ON account_number_settings(account_id, phone_number);

-- ============================================================================
-- TRIGGERS
-- ============================================================================

-- Updated_at trigger function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply updated_at triggers
DROP TRIGGER IF EXISTS update_accounts_updated_at ON accounts;
CREATE TRIGGER update_accounts_updated_at
    BEFORE UPDATE ON accounts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_sessions_updated_at ON sessions;
CREATE TRIGGER update_sessions_updated_at
    BEFORE UPDATE ON sessions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_webhooks_updated_at ON webhooks;
CREATE TRIGGER update_webhooks_updated_at
    BEFORE UPDATE ON webhooks
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_webhook_queue_updated_at ON webhook_delivery_queue;
CREATE TRIGGER update_webhook_queue_updated_at
    BEFORE UPDATE ON webhook_delivery_queue
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_ai_auto_replies_updated_at ON ai_auto_replies;
CREATE TRIGGER update_ai_auto_replies_updated_at
    BEFORE UPDATE ON ai_auto_replies
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_chatbot_conversations_updated_at ON chatbot_conversations;
CREATE TRIGGER update_chatbot_conversations_updated_at
    BEFORE UPDATE ON chatbot_conversations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_number_settings_updated_at ON account_number_settings;
CREATE TRIGGER update_number_settings_updated_at
    BEFORE UPDATE ON account_number_settings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- HELPER FUNCTIONS (Optional - for dashboard stats)
-- ============================================================================

-- Get daily message stats
CREATE OR REPLACE FUNCTION get_daily_message_stats(days_count INTEGER DEFAULT 7)
RETURNS TABLE(date TEXT, incoming BIGINT, outgoing BIGINT, total BIGINT) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        TO_CHAR(m.created_at, 'YYYY-MM-DD') as date,
        COUNT(*) FILTER (WHERE m.direction = 'incoming') as incoming,
        COUNT(*) FILTER (WHERE m.direction = 'outgoing') as outgoing,
        COUNT(*) as total
    FROM message_logs m
    WHERE m.created_at >= NOW() - (days_count || ' days')::INTERVAL
      AND m.sender != 'status@broadcast'
    GROUP BY TO_CHAR(m.created_at, 'YYYY-MM-DD')
    ORDER BY date DESC;
END;
$$ LANGUAGE plpgsql;

-- Get all accounts stats
CREATE OR REPLACE FUNCTION get_all_accounts_stats()
RETURNS TABLE(
    account_id UUID,
    total BIGINT,
    incoming BIGINT,
    outgoing BIGINT,
    success BIGINT,
    failed BIGINT,
    outgoing_success BIGINT
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        m.account_id,
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE m.direction = 'incoming') as incoming,
        COUNT(*) FILTER (WHERE m.direction = 'outgoing') as outgoing,
        COUNT(*) FILTER (WHERE m.status = 'success') as success,
        COUNT(*) FILTER (WHERE m.status = 'failed') as failed,
        COUNT(*) FILTER (WHERE m.direction = 'outgoing' AND m.status = 'success') as outgoing_success
    FROM message_logs m
    WHERE m.sender != 'status@broadcast'
    GROUP BY m.account_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- ROW LEVEL SECURITY (Optional - uncomment to enable)
-- ============================================================================

-- ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE webhooks ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE webhook_delivery_queue ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE ai_auto_replies ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE chatbot_conversations ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE message_logs ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE account_number_settings ENABLE ROW LEVEL SECURITY;
