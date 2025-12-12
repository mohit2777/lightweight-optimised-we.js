-- Supabase Database Schema for WhatsApp Multi-Automation V2
-- Enhanced with better indexing, partitioning considerations, and data integrity

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Enable pg_stat_statements for query performance monitoring (optional)
-- CREATE EXTENSION IF NOT EXISTS "pg_stat_statements";

-- ============================================================================
-- TABLES
-- ============================================================================

-- WhatsApp Accounts Table
CREATE TABLE IF NOT EXISTS whatsapp_accounts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    status VARCHAR(50) DEFAULT 'initializing' CHECK (status IN ('initializing', 'qr_ready', 'ready', 'disconnected', 'auth_failed', 'error')),
    phone_number VARCHAR(50),
    session_dir VARCHAR(500), -- Legacy column, can be removed later
    session_data TEXT, -- Base64 encoded WhatsApp Web session data
    last_session_saved TIMESTAMP WITH TIME ZONE,
    qr_code TEXT,
    error_message TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_active_at TIMESTAMP WITH TIME ZONE
);

COMMENT ON COLUMN whatsapp_accounts.session_data IS 'Base64 encoded WhatsApp Web session data for persistent authentication';
COMMENT ON COLUMN whatsapp_accounts.last_session_saved IS 'Timestamp of last session data save';

-- Webhooks Table
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

-- Message Logs Table
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

-- Webhook Delivery Queue (durable delivery + retries)
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

-- AI Auto Reply Configuration Table (per WhatsApp account)
CREATE TABLE IF NOT EXISTS ai_auto_replies (
    account_id UUID PRIMARY KEY REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider IN ('openai', 'gemini', 'anthropic', 'openrouter')),
    api_key TEXT,
    model TEXT,
    system_prompt TEXT,
    temperature NUMERIC DEFAULT 0.7,
    is_active BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================================
-- SAFE MIGRATIONS (Ensure columns exist if tables were already created)
-- ============================================================================

-- Ensure whatsapp_accounts has all required columns
ALTER TABLE whatsapp_accounts ADD COLUMN IF NOT EXISTS session_data TEXT;
ALTER TABLE whatsapp_accounts ADD COLUMN IF NOT EXISTS last_session_saved TIMESTAMP WITH TIME ZONE;
ALTER TABLE whatsapp_accounts ADD COLUMN IF NOT EXISTS qr_code TEXT;
ALTER TABLE whatsapp_accounts ADD COLUMN IF NOT EXISTS error_message TEXT;

-- Ensure message_logs has all required columns
ALTER TABLE message_logs ADD COLUMN IF NOT EXISTS webhook_id UUID REFERENCES webhooks(id) ON DELETE SET NULL;
ALTER TABLE message_logs ADD COLUMN IF NOT EXISTS webhook_url VARCHAR(500);
ALTER TABLE message_logs ADD COLUMN IF NOT EXISTS response_status INTEGER;
ALTER TABLE message_logs ADD COLUMN IF NOT EXISTS processing_time_ms INTEGER;
ALTER TABLE message_logs ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0;

-- Ensure webhooks has all required columns
ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0;
ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS last_success_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS last_failure_at TIMESTAMP WITH TIME ZONE;

-- Ensure ai_auto_replies provider check constraint includes all supported providers
DO $$ 
BEGIN 
    ALTER TABLE ai_auto_replies DROP CONSTRAINT IF EXISTS ai_auto_replies_provider_check;
    ALTER TABLE ai_auto_replies ADD CONSTRAINT ai_auto_replies_provider_check CHECK (provider IN ('openai', 'gemini', 'anthropic', 'openrouter'));
EXCEPTION
    WHEN undefined_table THEN 
        NULL; -- Table might not exist yet, which is fine
END $$;

-- ============================================================================
-- INDEXES for Performance Optimization
-- ============================================================================

-- WhatsApp Accounts Indexes
CREATE INDEX IF NOT EXISTS idx_whatsapp_accounts_status ON whatsapp_accounts(status);
CREATE INDEX IF NOT EXISTS idx_whatsapp_accounts_created_at ON whatsapp_accounts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_whatsapp_accounts_phone_number ON whatsapp_accounts(phone_number) WHERE phone_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_whatsapp_accounts_last_active ON whatsapp_accounts(last_active_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_whatsapp_accounts_session_data ON whatsapp_accounts(id) WHERE session_data IS NOT NULL;

-- Webhooks Indexes
CREATE INDEX IF NOT EXISTS idx_webhooks_account_id ON webhooks(account_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_is_active ON webhooks(is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_webhooks_account_active ON webhooks(account_id, is_active) WHERE is_active = true;

-- Message Logs Indexes
CREATE INDEX IF NOT EXISTS idx_message_logs_account_id ON message_logs(account_id);
CREATE INDEX IF NOT EXISTS idx_message_logs_direction ON message_logs(direction);
CREATE INDEX IF NOT EXISTS idx_message_logs_status ON message_logs(status);
CREATE INDEX IF NOT EXISTS idx_message_logs_created_at ON message_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_message_logs_account_created ON message_logs(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_message_logs_webhook_id ON message_logs(webhook_id) WHERE webhook_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_message_logs_chat_id ON message_logs(chat_id) WHERE chat_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_message_logs_message_id ON message_logs(message_id) WHERE message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_webhook_delivery_status ON webhook_delivery_queue(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_webhook_delivery_account ON webhook_delivery_queue(account_id);
CREATE INDEX IF NOT EXISTS idx_webhook_delivery_webhook ON webhook_delivery_queue(webhook_id);

-- Chatbots Indexes
CREATE INDEX IF NOT EXISTS idx_ai_auto_replies_account_id ON ai_auto_replies(account_id);
CREATE INDEX IF NOT EXISTS idx_ai_auto_replies_is_active ON ai_auto_replies(is_active) WHERE is_active = true;

-- ============================================================================
-- ROW LEVEL SECURITY (RLS) Policies
-- ============================================================================

ALTER TABLE whatsapp_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_auto_replies ENABLE ROW LEVEL SECURITY;

-- Allow all operations (customize based on your security needs)
DROP POLICY IF EXISTS "Allow all operations on whatsapp_accounts" ON whatsapp_accounts;
CREATE POLICY "Allow all operations on whatsapp_accounts" ON whatsapp_accounts
    FOR ALL USING (true);

DROP POLICY IF EXISTS "Allow all operations on webhooks" ON webhooks;
CREATE POLICY "Allow all operations on webhooks" ON webhooks
    FOR ALL USING (true);

DROP POLICY IF EXISTS "Allow all operations on message_logs" ON message_logs;
CREATE POLICY "Allow all operations on message_logs" ON message_logs
    FOR ALL USING (true);

DROP POLICY IF EXISTS "Allow all operations on chatbots" ON chatbots;
CREATE POLICY "Allow all operations on chatbots" ON chatbots
    FOR ALL USING (true);

-- ============================================================================
-- FUNCTIONS
-- ============================================================================

-- Function for automatic timestamp updates
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Function to get comprehensive message statistics
CREATE OR REPLACE FUNCTION get_message_stats(account_uuid UUID)
RETURNS TABLE(
    total BIGINT,
    incoming BIGINT,
    outgoing BIGINT,
    success BIGINT,
    failed BIGINT,
    pending BIGINT,
    last_24h BIGINT,
    avg_processing_time_ms NUMERIC
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE direction = 'incoming') as incoming,
        COUNT(*) FILTER (WHERE direction = 'outgoing') as outgoing,
        COUNT(*) FILTER (WHERE status = 'success') as success,
        COUNT(*) FILTER (WHERE status = 'failed') as failed,
        COUNT(*) FILTER (WHERE status = 'pending') as pending,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') as last_24h,
        AVG(processing_time_ms) FILTER (WHERE processing_time_ms IS NOT NULL) as avg_processing_time_ms
    FROM message_logs
    WHERE account_id = account_uuid;
END;
$$ LANGUAGE plpgsql;

-- Function to get recent messages with pagination
CREATE OR REPLACE FUNCTION get_recent_messages(
    account_uuid UUID, 
    limit_count INTEGER DEFAULT 100,
    offset_count INTEGER DEFAULT 0
)
RETURNS TABLE(
    id UUID,
    direction VARCHAR(50),
    message TEXT,
    sender VARCHAR(255),
    recipient VARCHAR(255),
    status VARCHAR(50),
    type VARCHAR(50),
    created_at TIMESTAMP WITH TIME ZONE
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        ml.id,
        ml.direction,
        ml.message,
        ml.sender,
        ml.recipient,
        ml.status,
        ml.type,
        ml.created_at
    FROM message_logs ml
    WHERE ml.account_id = account_uuid
    ORDER BY ml.created_at DESC
    LIMIT limit_count
    OFFSET offset_count;
END;
$$ LANGUAGE plpgsql;

-- Function to clean old message logs (for data retention)
CREATE OR REPLACE FUNCTION cleanup_old_messages(days_to_keep INTEGER DEFAULT 90)
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM message_logs
    WHERE created_at < NOW() - (days_to_keep || ' days')::INTERVAL;
    
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- Function to get webhook statistics
CREATE OR REPLACE FUNCTION get_webhook_stats(webhook_uuid UUID)
RETURNS TABLE(
    total_deliveries BIGINT,
    successful_deliveries BIGINT,
    failed_deliveries BIGINT,
    avg_response_time_ms NUMERIC,
    last_success TIMESTAMP WITH TIME ZONE,
    last_failure TIMESTAMP WITH TIME ZONE
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        COUNT(*) as total_deliveries,
        COUNT(*) FILTER (WHERE status = 'success') as successful_deliveries,
        COUNT(*) FILTER (WHERE status = 'failed') as failed_deliveries,
        AVG(processing_time_ms) FILTER (WHERE processing_time_ms IS NOT NULL) as avg_response_time_ms,
        MAX(created_at) FILTER (WHERE status = 'success') as last_success,
        MAX(created_at) FILTER (WHERE status = 'failed') as last_failure
    FROM message_logs
    WHERE webhook_id = webhook_uuid;
END;
$$ LANGUAGE plpgsql;

-- Session Data Functions

-- Function to save session data
CREATE OR REPLACE FUNCTION save_session_data(
  p_account_id UUID,
  p_session_data TEXT
)
RETURNS BOOLEAN AS $$
BEGIN
  UPDATE whatsapp_accounts
  SET 
    session_data = p_session_data,
    last_session_saved = NOW(),
    updated_at = NOW()
  WHERE id = p_account_id;
  
  RETURN FOUND;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to get session data
CREATE OR REPLACE FUNCTION get_session_data(p_account_id UUID)
RETURNS TEXT AS $$
DECLARE
  v_session_data TEXT;
BEGIN
  SELECT session_data INTO v_session_data
  FROM whatsapp_accounts
  WHERE id = p_account_id;
  
  RETURN v_session_data;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to clear session data (for logout/disconnect)
CREATE OR REPLACE FUNCTION clear_session_data(p_account_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  UPDATE whatsapp_accounts
  SET 
    session_data = NULL,
    last_session_saved = NULL,
    status = 'disconnected',
    updated_at = NOW()
  WHERE id = p_account_id;
  
  RETURN FOUND;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- TRIGGERS
-- ============================================================================

-- Triggers for automatic timestamp updates
DROP TRIGGER IF EXISTS update_whatsapp_accounts_updated_at ON whatsapp_accounts;
CREATE TRIGGER update_whatsapp_accounts_updated_at 
    BEFORE UPDATE ON whatsapp_accounts 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_webhooks_updated_at ON webhooks;
CREATE TRIGGER update_webhooks_updated_at 
    BEFORE UPDATE ON webhooks 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_webhook_queue_updated_at ON webhook_delivery_queue;
CREATE TRIGGER update_webhook_queue_updated_at
    BEFORE UPDATE ON webhook_delivery_queue
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_ai_auto_replies_updated_at ON ai_auto_replies;
CREATE TRIGGER update_ai_auto_replies_updated_at 
    BEFORE UPDATE ON ai_auto_replies 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- VIEWS for Common Queries
-- ============================================================================

-- View for active accounts with recent activity
CREATE OR REPLACE VIEW active_accounts_summary AS
SELECT 
    wa.id,
    wa.name,
    wa.status,
    wa.phone_number,
    wa.last_active_at,
    COUNT(DISTINCT w.id) as webhook_count,
    COUNT(DISTINCT w.id) FILTER (WHERE w.is_active = true) as active_webhook_count,
    COUNT(ml.id) FILTER (WHERE ml.created_at > NOW() - INTERVAL '24 hours') as messages_last_24h
FROM whatsapp_accounts wa
LEFT JOIN webhooks w ON wa.id = w.account_id
LEFT JOIN message_logs ml ON wa.id = ml.account_id
GROUP BY wa.id, wa.name, wa.status, wa.phone_number, wa.last_active_at;

-- View for webhook delivery statistics
CREATE OR REPLACE VIEW webhook_delivery_stats AS
SELECT 
    w.id,
    w.account_id,
    w.url,
    w.is_active,
    COUNT(ml.id) as total_deliveries,
    COUNT(ml.id) FILTER (WHERE ml.status = 'success') as successful_deliveries,
    COUNT(ml.id) FILTER (WHERE ml.status = 'failed') as failed_deliveries,
    MAX(ml.created_at) FILTER (WHERE ml.status = 'success') as last_success_at,
    MAX(ml.created_at) FILTER (WHERE ml.status = 'failed') as last_failure_at
FROM webhooks w
LEFT JOIN message_logs ml ON w.id = ml.webhook_id
GROUP BY w.id, w.account_id, w.url, w.is_active;

-- ============================================================================
-- COMMENTS for Documentation
-- ============================================================================

COMMENT ON TABLE whatsapp_accounts IS 'Stores WhatsApp account information and connection status';
COMMENT ON TABLE webhooks IS 'Stores webhook configurations for receiving message notifications';
COMMENT ON TABLE message_logs IS 'Stores all message activity, webhook deliveries, and processing logs';
COMMENT ON TABLE ai_auto_replies IS 'Stores per-account AI auto reply configuration';
COMMENT ON FUNCTION get_message_stats(UUID) IS 'Returns comprehensive message statistics for a specific account';
COMMENT ON FUNCTION get_recent_messages(UUID, INTEGER, INTEGER) IS 'Returns recent messages for a specific account with pagination support';
COMMENT ON FUNCTION cleanup_old_messages(INTEGER) IS 'Removes message logs older than specified days for data retention';
COMMENT ON FUNCTION get_webhook_stats(UUID) IS 'Returns delivery statistics for a specific webhook';
