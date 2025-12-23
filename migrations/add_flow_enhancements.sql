-- Migration: Add knowledge_base and shared_memory columns to chatbot_flows
-- Run this in your Supabase SQL editor

-- Add knowledge_base column for storing custom knowledge/context for the LLM
ALTER TABLE chatbot_flows 
ADD COLUMN IF NOT EXISTS knowledge_base TEXT;

-- Add use_shared_memory column to enable chatbot and flow to share conversation history
ALTER TABLE chatbot_flows 
ADD COLUMN IF NOT EXISTS use_shared_memory BOOLEAN DEFAULT false;

-- Add llm_temperature column for controlling AI creativity
ALTER TABLE chatbot_flows 
ADD COLUMN IF NOT EXISTS llm_temperature DECIMAL(3,2) DEFAULT 0.7;

-- Add llm_persona column for setting AI personality
ALTER TABLE chatbot_flows 
ADD COLUMN IF NOT EXISTS llm_persona TEXT;

-- Add comments
COMMENT ON COLUMN chatbot_flows.knowledge_base IS 'Custom knowledge base content to provide context to the LLM';
COMMENT ON COLUMN chatbot_flows.use_shared_memory IS 'When enabled, flow shares conversation history with the chatbot';
COMMENT ON COLUMN chatbot_flows.llm_temperature IS 'Temperature setting for LLM responses (0.0 = precise, 2.0 = creative)';
COMMENT ON COLUMN chatbot_flows.llm_persona IS 'Persona/character description for the AI assistant';

-- Refresh the schema cache (Supabase specific)
NOTIFY pgrst, 'reload schema';
