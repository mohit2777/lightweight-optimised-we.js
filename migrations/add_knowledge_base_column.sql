-- Add knowledge_base column to chatbot_flows table
-- This stores company information that the AI uses to answer questions and handle objections

ALTER TABLE chatbot_flows 
ADD COLUMN IF NOT EXISTS knowledge_base TEXT;

-- Add comment for documentation
COMMENT ON COLUMN chatbot_flows.knowledge_base IS 'Company knowledge base content for AI to use when answering questions and handling objections';
