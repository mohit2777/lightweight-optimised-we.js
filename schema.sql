-- ============================================================================
-- WHATSAPP MULTI-AUTOMATION - DATABASE SCHEMA
-- ============================================================================
-- Run this in Supabase SQL Editor to set up the database
-- Compatible with: index.optimized.js, index.lite.js, index.js
-- ============================================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- CORE TABLE: WhatsApp Accounts
-- ============================================================================

CREATE TABLE IF NOT EXISTS whatsapp_accounts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    status VARCHAR(50) DEFAULT 'initializing' CHECK (status IN ('initializing', 'qr_ready', 'ready', 'disconnected', 'auth_failed', 'error')),
    phone_number VARCHAR(50),
    session_data TEXT, -- Base64 encoded WhatsApp Web session data for persistence
    last_session_saved TIMESTAMP WITH TIME ZONE,
    qr_code TEXT,
    error_message TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_active_at TIMESTAMP WITH TIME ZONE
);

COMMENT ON TABLE whatsapp_accounts IS 'WhatsApp account information and session data';
COMMENT ON COLUMN whatsapp_accounts.session_data IS 'Base64 encoded session for persistent authentication across restarts';

-- ============================================================================
-- CORE TABLE: Webhooks
-- ============================================================================

CREATE TABLE IF NOT EXISTS webhooks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    account_id UUID NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
    url VARCHAR(500) NOT NULL,
    secret VARCHAR(255),
    is_active BOOLEAN DEFAULT true,
    retry_count INTEGER DEFAULT 0,
    last_success_at TIMESTAMP WITH TIME ZONE,
    last_failure_at TIMESTAMP WITH TIME ZONE,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE webhooks IS 'Webhook configurations for message forwarding to external services';

-- ============================================================================
-- CORE TABLE: Message Logs
-- ============================================================================

CREATE TABLE IF NOT EXISTS message_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    account_id UUID NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
    direction VARCHAR(50) NOT NULL CHECK (direction IN ('incoming', 'outgoing', 'webhook', 'webhook_incoming')),
    message_id VARCHAR(255),
    sender VARCHAR(255),
    recipient VARCHAR(255),
    message TEXT,
    timestamp BIGINT,
    type VARCHAR(50),
    chat_id VARCHAR(255),
    is_group BOOLEAN DEFAULT false,
    group_name VARCHAR(255),
    media JSONB,
    status VARCHAR(50) DEFAULT 'success' CHECK (status IN ('success', 'failed', 'pending', 'delivered', 'read')),
    error_message TEXT,
    webhook_id UUID REFERENCES webhooks(id) ON DELETE SET NULL,
    webhook_url VARCHAR(500),
    response_status INTEGER,
    processing_time_ms INTEGER,
    retry_count INTEGER DEFAULT 0,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE message_logs IS 'Message activity logs (disable with DISABLE_MESSAGE_LOGGING=true to save egress)';

-- ============================================================================
-- CORE TABLE: Webhook Delivery Queue
-- ============================================================================

CREATE TABLE IF NOT EXISTS webhook_delivery_queue (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    account_id UUID NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
    webhook_id UUID NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    webhook_url VARCHAR(500) NOT NULL,
    webhook_secret VARCHAR(255),
    payload JSONB NOT NULL,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'success', 'failed', 'dead_letter')),
    attempt_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 5,
    last_error TEXT,
    response_status INTEGER,
    next_attempt_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE webhook_delivery_queue IS 'Durable webhook delivery queue with retry support';

-- ============================================================================
-- OPTIONAL TABLE: AI Auto Reply (Chatbot)
-- ============================================================================

CREATE TABLE IF NOT EXISTS ai_auto_replies (
    account_id UUID PRIMARY KEY REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    api_key TEXT,
    model TEXT,
    system_prompt TEXT,
    history_limit INTEGER DEFAULT 10,
    temperature NUMERIC DEFAULT 0.7,
    is_active BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE ai_auto_replies IS 'Per-account AI chatbot configuration (providers: gemini, groq, openrouter, etc.)';

-- ============================================================================
-- INDEXES FOR PERFORMANCE
-- ============================================================================

-- WhatsApp Accounts
CREATE INDEX IF NOT EXISTS idx_whatsapp_accounts_status ON whatsapp_accounts(status);
CREATE INDEX IF NOT EXISTS idx_whatsapp_accounts_phone ON whatsapp_accounts(phone_number) WHERE phone_number IS NOT NULL;

-- Webhooks
CREATE INDEX IF NOT EXISTS idx_webhooks_account_id ON webhooks(account_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_active ON webhooks(account_id) WHERE is_active = true;

-- Message Logs
CREATE INDEX IF NOT EXISTS idx_message_logs_account_id ON message_logs(account_id);
CREATE INDEX IF NOT EXISTS idx_message_logs_created_at ON message_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_message_logs_direction ON message_logs(account_id, direction);

-- Webhook Queue
CREATE INDEX IF NOT EXISTS idx_webhook_queue_pending ON webhook_delivery_queue(status, next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_webhook_queue_account ON webhook_delivery_queue(account_id);

-- AI Auto Replies
CREATE INDEX IF NOT EXISTS idx_ai_auto_replies_active ON ai_auto_replies(is_active) WHERE is_active = true;

-- ============================================================================
-- AUTO-UPDATE TIMESTAMPS
-- ============================================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply triggers
DROP TRIGGER IF EXISTS update_whatsapp_accounts_updated_at ON whatsapp_accounts;
CREATE TRIGGER update_whatsapp_accounts_updated_at
    BEFORE UPDATE ON whatsapp_accounts
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

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================

-- Enable RLS on all tables
ALTER TABLE whatsapp_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_delivery_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_auto_replies ENABLE ROW LEVEL SECURITY;

-- Allow service role full access (for server-side operations)
DROP POLICY IF EXISTS "Service role access on whatsapp_accounts" ON whatsapp_accounts;
CREATE POLICY "Service role access on whatsapp_accounts" ON whatsapp_accounts
    FOR ALL USING (auth.role() = 'service_role');

DROP POLICY IF EXISTS "Service role access on webhooks" ON webhooks;
CREATE POLICY "Service role access on webhooks" ON webhooks
    FOR ALL USING (auth.role() = 'service_role');

DROP POLICY IF EXISTS "Service role access on message_logs" ON message_logs;
CREATE POLICY "Service role access on message_logs" ON message_logs
    FOR ALL USING (auth.role() = 'service_role');

DROP POLICY IF EXISTS "Service role access on webhook_delivery_queue" ON webhook_delivery_queue;
CREATE POLICY "Service role access on webhook_delivery_queue" ON webhook_delivery_queue
    FOR ALL USING (auth.role() = 'service_role');

DROP POLICY IF EXISTS "Service role access on ai_auto_replies" ON ai_auto_replies;
CREATE POLICY "Service role access on ai_auto_replies" ON ai_auto_replies
    FOR ALL USING (auth.role() = 'service_role');

-- ============================================================================
-- OPTIONAL: Express Session Table (for PostgreSQL session storage)
-- ============================================================================
-- Uncomment if you want persistent dashboard sessions across restarts
-- Requires DATABASE_URL environment variable

-- CREATE TABLE IF NOT EXISTS "session" (
--     "sid" VARCHAR NOT NULL COLLATE "default" PRIMARY KEY,
--     "sess" JSON NOT NULL,
--     "expire" TIMESTAMP(6) NOT NULL
-- );
-- CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");

-- ============================================================================
-- DONE! Your database is ready.
-- ============================================================================
-- Set these environment variables in your deployment:
--   SUPABASE_URL=https://your-project.supabase.co
--   SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
-- ============================================================================
