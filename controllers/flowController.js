const { db, supabase } = require('../config/database');
const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');
const FlowEngine = require('../services/flowEngine');
const flowState = require('../services/flowState');

// Import chatbot providers for AI-powered flow responses
const GroqProvider = require('../utils/chatbot/providers/GroqProvider');
const GeminiProvider = require('../utils/chatbot/providers/GeminiProvider');
const OpenRouterProvider = require('../utils/chatbot/providers/OpenRouterProvider');
const OpenAIProvider = require('../utils/chatbot/providers/OpenAIProvider');
const AnthropicProvider = require('../utils/chatbot/providers/AnthropicProvider');
const { analyzeUserInput } = require('../utils/aiInputAnalyzer');

// These will be initialized when whatsappManager is ready
let whatsappManager = null;
let engine = null;

// Initialize references (called from index.js after whatsappManager is created)
function initializeFlowController(manager) {
    whatsappManager = manager;
    engine = new FlowEngine(whatsappManager);
    logger.info('[FlowController] Initialized with WhatsApp Manager');
}

const flowController = {
    // Get all flows for an account (or all if admin)
    async getFlows(req, res) {
        try {
            // In a real app, strict multi-tenancy would filter by req.user.accountId
            // For this system, we might return all or filter by query param
            const { data, error } = await supabase
                .from('chatbot_flows')
                .select('*')
                .order('created_at', { ascending: false });

            if (error) throw error;
            res.json(data);
        } catch (err) {
            logger.error('Error fetching flows:', err);
            res.status(500).json({ error: 'Failed to fetch flows' });
        }
    },

    // Create a new flow
    async createFlow(req, res) {
        try {
            const { 
                name, description, account_id, trigger_type, trigger_keywords, flow_type,
                llm_provider, llm_api_key, llm_model, llm_instructions, llm_persona,
                llm_temperature, knowledge_base, use_shared_memory, webhook_url
            } = req.body;

            // Build the insert object, only including non-null values
            const insertData = {
                name,
                description,
                account_id,
                trigger_type,
                trigger_keywords,
                flow_type: flow_type || 'basic',
                is_active: req.body.is_active !== undefined ? req.body.is_active : true,
                webhook_url
            };

            // Add LLM fields only if provided (to avoid schema errors for missing columns)
            if (llm_provider) insertData.llm_provider = llm_provider;
            if (llm_api_key) insertData.llm_api_key = llm_api_key;
            if (llm_model) insertData.llm_model = llm_model;
            if (llm_instructions) insertData.llm_instructions = llm_instructions;
            if (llm_persona !== undefined) insertData.llm_persona = llm_persona;
            if (llm_temperature !== undefined) insertData.llm_temperature = llm_temperature;
            if (knowledge_base !== undefined) insertData.knowledge_base = knowledge_base;
            if (use_shared_memory !== undefined) insertData.use_shared_memory = use_shared_memory;

            const { data, error } = await supabase
                .from('chatbot_flows')
                .insert(insertData)
                .select()
                .single();

            if (error) throw error;

            // Create a default Start node
            const startNode = {
                flow_id: data.id,
                node_type: 'start',
                name: 'Start',
                position_x: 100,
                position_y: 100,
                config: { keywords: trigger_keywords }
            };

            await supabase.from('flow_nodes').insert(startNode);

            res.json(data);
        } catch (err) {
            logger.error('Error creating flow:', err);
            res.status(500).json({ error: 'Failed to create flow' });
        }
    },

    // Get a single flow with nodes and connections
    async getFlow(req, res) {
        try {
            const { id } = req.params;

            // Fetch flow details
            const { data: flow, error: flowError } = await supabase
                .from('chatbot_flows')
                .select('*')
                .eq('id', id)
                .single();

            if (flowError) throw flowError;
            if (!flow) return res.status(404).json({ error: 'Flow not found' });

            // Fetch nodes
            const { data: nodes, error: nodeError } = await supabase
                .from('flow_nodes')
                .select('*')
                .eq('flow_id', id);

            if (nodeError) throw nodeError;

            // Fetch connections
            const { data: connections, error: connError } = await supabase
                .from('flow_connections')
                .select('*')
                .eq('flow_id', id);

            if (connError) throw connError;

            res.json({
                ...flow,
                nodes,
                connections
            });
        } catch (err) {
            logger.error('Error fetching flow details:', err);
            res.status(500).json({ error: 'Failed to fetch flow details' });
        }
    },

    // Update a flow (including nodes and connections transaction-like)
    async updateFlow(req, res) {
        try {
            const { id } = req.params;
            const { 
                name, description, trigger_type, trigger_keywords, nodes, connections, webhook_url,
                llm_provider, llm_api_key, llm_model, llm_instructions, llm_persona,
                llm_temperature, knowledge_base, use_shared_memory
            } = req.body;

            // 1. Update flow metadata
            const updateData = {
                name,
                description,
                trigger_type,
                trigger_keywords,
                webhook_url,
                updated_at: new Date().toISOString()
            };
            
            // Only update LLM fields if provided
            if (llm_provider !== undefined) updateData.llm_provider = llm_provider;
            if (llm_api_key !== undefined) updateData.llm_api_key = llm_api_key;
            if (llm_model !== undefined) updateData.llm_model = llm_model;
            if (llm_instructions !== undefined) updateData.llm_instructions = llm_instructions;
            if (llm_persona !== undefined) updateData.llm_persona = llm_persona;
            if (llm_temperature !== undefined) updateData.llm_temperature = llm_temperature;
            if (knowledge_base !== undefined) updateData.knowledge_base = knowledge_base;
            if (use_shared_memory !== undefined) updateData.use_shared_memory = use_shared_memory;
            
            const { error: flowError } = await supabase
                .from('chatbot_flows')
                .update(updateData)
                .eq('id', id);

            if (flowError) throw flowError;

            // 2. Handle Nodes (Upsert/Delete)
            // For simplicity in this iteration, we might wipe and recreate or intelligent upsert.
            // Wiping is risky for valid IDs, but easiest for syncing graph state.
            // However, to preserve IDs for active sessions, we should use upsert.

            if (nodes && Array.isArray(nodes)) {
                // Delete nodes not in the new list (safest way to handle deletions)
                const nodeIds = nodes.map(n => n.id).filter(nid => nid);
                if (nodeIds.length > 0) {
                    await supabase
                        .from('flow_nodes')
                        .delete()
                        .eq('flow_id', id)
                        .not('id', 'in', `(${nodeIds.join(',')})`); // Syntax might need verify
                    // Better: fetch existing, compare
                }

                // Upsert nodes
                for (const node of nodes) {
                    const payload = {
                        id: node.id,
                        flow_id: id,
                        node_type: node.node_type,
                        name: node.name,
                        position_x: node.position_x,
                        position_y: node.position_y,
                        config: node.config
                    };
                    const { error } = await supabase.from('flow_nodes').upsert(payload);
                    if (error) throw error;
                }
            }

            // 3. Handle Connections
            // Easiest is delete all for this flow and recreate, as they are just links
            if (connections && Array.isArray(connections)) {
                await supabase.from('flow_connections').delete().eq('flow_id', id);

                if (connections.length > 0) {
                    const connPayloads = connections.map(c => ({
                        flow_id: id,
                        source_node_id: c.source_node_id,
                        target_node_id: c.target_node_id,
                        source_handle: c.source_handle
                    }));
                    const { error } = await supabase.from('flow_connections').insert(connPayloads);
                    if (error) throw error;
                }
            }

            res.json({ success: true });
        } catch (err) {
            logger.error('Error updating flow:', err);
            res.status(500).json({ error: 'Failed to update flow' });
        }
    },

    // Delete a flow
    async deleteFlow(req, res) {
        try {
            const { id } = req.params;
            const { error } = await supabase
                .from('chatbot_flows')
                .delete()
                .eq('id', id);

            if (error) throw error;
            res.json({ success: true });
        } catch (err) {
            logger.error('Error deleting flow:', err);
            res.status(500).json({ error: 'Failed to delete flow' });
        }
    },

    // Update only the flow design (nodes and connections)
    async updateFlowDesign(req, res) {
        try {
            const { id } = req.params;
            const { nodes, connections } = req.body;

            // Update last modified timestamp
            const { error: flowError } = await supabase
                .from('chatbot_flows')
                .update({ updated_at: new Date().toISOString() })
                .eq('id', id);

            if (flowError) throw flowError;

            // Handle Nodes (Upsert/Delete)
            if (nodes && Array.isArray(nodes)) {
                // Get existing node IDs
                const { data: existingNodes } = await supabase
                    .from('flow_nodes')
                    .select('id')
                    .eq('flow_id', id);
                
                const existingIds = existingNodes?.map(n => n.id) || [];
                const newIds = nodes.map(n => n.id).filter(Boolean);
                
                // Delete nodes that were removed
                const idsToDelete = existingIds.filter(eid => !newIds.includes(eid));
                if (idsToDelete.length > 0) {
                    await supabase
                        .from('flow_nodes')
                        .delete()
                        .in('id', idsToDelete);
                }

                // Upsert nodes
                for (const node of nodes) {
                    const payload = {
                        id: node.id,
                        flow_id: id,
                        node_type: node.node_type,
                        name: node.name,
                        position_x: node.position_x,
                        position_y: node.position_y,
                        config: node.config
                    };
                    const { error } = await supabase.from('flow_nodes').upsert(payload);
                    if (error) throw error;
                }
            }

            // Handle Connections - delete all and recreate
            if (connections && Array.isArray(connections)) {
                await supabase.from('flow_connections').delete().eq('flow_id', id);

                if (connections.length > 0) {
                    const connPayloads = connections.map(c => ({
                        flow_id: id,
                        source_node_id: c.source_node_id,
                        target_node_id: c.target_node_id,
                        source_handle: c.source_handle || 'default'
                    }));
                    const { error } = await supabase.from('flow_connections').insert(connPayloads);
                    if (error) throw error;
                }
            }

            res.json({ success: true });
        } catch (err) {
            logger.error('Error updating flow design:', err);
            res.status(500).json({ error: 'Failed to update flow design' });
        }
    },

    // Get LLM Providers (Mock or Config)
    async getLLMProviders(req, res) {
        const providers = [
            { id: 'groq', name: 'Groq (Free - Fast Inference)' },
            { id: 'gemini', name: 'Google Gemini (Free tier)' },
            { id: 'openrouter', name: 'OpenRouter (Free models available)' },
            { id: 'openai', name: 'OpenAI (Paid)' },
            { id: 'anthropic', name: 'Anthropic (Paid)' }
        ];
        res.json(providers);
    },

    // Test LLM Connection - Actually validates the API key
    async testLLMConnection(req, res) {
        try {
            const { provider, apiKey, model } = req.body;
            
            if (!provider) {
                return res.status(400).json({ success: false, error: 'Missing provider' });
            }
            if (!apiKey) {
                return res.status(400).json({ success: false, error: 'Missing API Key' });
            }
            if (!model) {
                return res.status(400).json({ success: false, error: 'Missing model' });
            }

            // Get the provider class
            const providerMap = {
                groq: GroqProvider,
                gemini: GeminiProvider,
                openrouter: OpenRouterProvider,
                openai: OpenAIProvider,
                anthropic: AnthropicProvider
            };

            const ProviderClass = providerMap[provider];
            if (!ProviderClass) {
                return res.status(400).json({ success: false, error: `Unknown provider: ${provider}` });
            }

            // Create provider instance and test with a simple message
            const providerInstance = new ProviderClass({
                api_key: apiKey,
                model: model
            });

            // Send a test message to validate the connection
            const testResponse = await providerInstance.generateResponse(
                [{ role: 'user', content: 'Say "OK" if you can read this.' }],
                'You are a test assistant. Respond with just "OK".'
            );

            if (testResponse && typeof testResponse === 'string') {
                logger.info(`[LLM Test] ${provider}/${model} - Connection successful`);
                res.json({ success: true, response: testResponse.substring(0, 100) });
            } else {
                throw new Error('No response received from LLM');
            }
        } catch (err) {
            const errorMessage = err.message || 'Unknown error';
            logger.error(`[LLM Test] Connection failed: ${errorMessage}`);
            
            // Provide helpful error messages
            let userFriendlyError = errorMessage;
            if (errorMessage.includes('401') || errorMessage.includes('Unauthorized')) {
                userFriendlyError = 'Invalid API key. Please check your API key and try again.';
            } else if (errorMessage.includes('404')) {
                userFriendlyError = 'Model not found. Please select a valid model.';
            } else if (errorMessage.includes('rate') || errorMessage.includes('limit')) {
                userFriendlyError = 'Rate limit exceeded. Please wait a moment and try again.';
            } else if (errorMessage.includes('timeout')) {
                userFriendlyError = 'Connection timeout. Please try again.';
            }
            
            res.status(400).json({ success: false, error: userFriendlyError });
        }
    },

    // TEST MODE - Simulates real WhatsApp conversation with flow + chatbot
    async simulateFlow(req, res) {
        const { id } = req.params;
        const { message, sessionId, action } = req.body;

        try {
            logger.info(`[TEST MODE] Message: "${message}", SessionId: ${sessionId || 'new'}, Action: ${action}`);

            // Use unique simulation contact ID
            const simContactId = sessionId || `test-${Date.now()}`;

            // Get flow details first to get the account_id
            const { data: flow } = await supabase
                .from('chatbot_flows')
                .select('*')
                .eq('id', id)
                .single();

            if (!flow) {
                return res.status(404).json({ error: 'Flow not found' });
            }

            // Use the flow's account_id (not req.user.accountId which may be undefined)
            const accountId = flow.account_id;

            // Capture all messages sent during simulation
            const capturedMessages = [];
            
            // Create message capture wrapper for WhatsApp Manager
            const originalSendMessage = whatsappManager.sendMessage;
            whatsappManager.sendMessage = async function(accId, contactId, messageText) {
                if (contactId === simContactId) {
                    // Capture the message for simulation response
                    const msg = typeof messageText === 'object' ? 
                        (messageText.body || JSON.stringify(messageText)) : 
                        messageText;
                    capturedMessages.push(msg);
                    logger.info(`[TEST MODE] Bot sent: ${msg}`);
                    return Promise.resolve();
                }
                // Real messages go through normally
                return originalSendMessage.call(this, accId, contactId, messageText);
            };

            try {
                // Handle direct "start" action
                if (action === 'start') {
                    await flowState.endSession(accountId, simContactId);
                    await engine.processMessage(accountId, simContactId, flow.trigger_keywords?.[0] || 'start', null);
                } else if (message) {
                    // Get existing session
                    const existingSession = await flowState.getSession(accountId, simContactId);
                    
                    let flowHandled = false;
                    let chatbotResponse = null;

                    // Process message exactly like real WhatsApp
                    if (existingSession || checkTrigger(flow, message)) {
                        // Flow should process this message
                        flowHandled = await engine.processMessage(accountId, simContactId, message, existingSession);
                        logger.info(`[TEST MODE] Flow processed: ${flowHandled}`);
                    }

                    // If flow didn't handle it, use chatbot (just like real WhatsApp)
                    if (!flowHandled) {
                        chatbotResponse = await getChatbotResponse(accountId, message);
                        if (chatbotResponse) {
                            capturedMessages.push(chatbotResponse);
                            logger.info(`[TEST MODE] Chatbot responded`);
                        }
                    }
                }

                // Get updated session status
                const updatedSession = await flowState.getSession(accountId, simContactId);
                const isFlowActive = !!updatedSession;

                // Get current node info if flow is active
                let currentNodeInfo = null;
                if (updatedSession) {
                    const { data: currentNode } = await supabase
                        .from('flow_nodes')
                        .select('*')
                        .eq('id', updatedSession.current_node_id)
                        .single();
                    
                    if (currentNode) {
                        currentNodeInfo = {
                            id: currentNode.id,
                            type: currentNode.node_type,
                            name: currentNode.name,
                            waitingForInput: ['buttons', 'input', 'ai_question', 'collect'].includes(currentNode.node_type)
                        };
                    }
                }

                res.json({
                    sessionId: simContactId,
                    messages: capturedMessages,
                    response: capturedMessages.join('\n\n'),
                    isFlowActive: isFlowActive,
                    isComplete: !isFlowActive && capturedMessages.length > 0,
                    collectedData: updatedSession ? updatedSession.context : {},
                    currentNode: currentNodeInfo,
                    status: isFlowActive ? 'active' : (capturedMessages.length > 0 ? 'completed' : 'idle')
                });

            } finally {
                // Restore original sendMessage function
                whatsappManager.sendMessage = originalSendMessage;
            }

        } catch (err) {
            logger.error('[TEST MODE] Error:', err);
            res.status(500).json({ error: err.message });
        }
    },

    async resetSimulation(req, res) {
        try {
            const { sessionId } = req.body;
            if (sessionId) {
                await supabase.from('chatbot_conversations').delete().eq('contact_number', sessionId);
            }
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: 'Failed to reset' });
        }
    }
};

// Provider map for AI responses
const providers = {
    'groq': GroqProvider,
    'gemini': GeminiProvider,
    'openrouter': OpenRouterProvider,
    'openai': OpenAIProvider,
    'anthropic': AnthropicProvider
};

// Get chatbot response when flow is not active
async function getChatbotResponse(accountId, message) {
    try {
        // Get chatbot config for the account
        const config = await db.getChatbotConfig(accountId);
        
        if (config && config.is_active && config.api_key) {
            const ProviderClass = providers[config.provider];
            if (ProviderClass) {
                const provider = new ProviderClass({
                    api_key: config.api_key,
                    model: config.model
                });

                const messages = [{ role: 'user', content: message }];
                const response = await provider.generateResponse(messages, config.system_prompt);
                return response;
            }
        }

        // Return null if no chatbot configured - don't use fallback
        logger.info(`[Chatbot] No chatbot configured for account ${accountId}`);
        return null;
    } catch (err) {
        logger.error('Error getting chatbot response:', err);
        return null;
    }
}

// Helper function to check if message triggers flow
function checkTrigger(flow, message) {
    if (!flow || !message) {
        logger.info(`[Trigger] Invalid flow or message`);
        return false;
    }
    
    const lowerMsg = message.toLowerCase().trim();
    
    // If trigger type is 'all', any message triggers the flow
    if (flow.trigger_type === 'all') {
        logger.info(`[Trigger] trigger_type='all' - triggering flow`);
        return true;
    }
    
    // If trigger type is 'keyword' or 'regex', check for keyword match
    if ((flow.trigger_type === 'keyword' || flow.trigger_type === 'regex') && flow.trigger_keywords && flow.trigger_keywords.length > 0) {
        const matched = flow.trigger_keywords.some(kw => {
            const lowerKw = kw.toLowerCase().trim();
            const isMatch = lowerMsg === lowerKw || lowerMsg.includes(lowerKw);
            logger.info(`[Trigger] Checking keyword "${kw}" against "${message}" = ${isMatch}`);
            return isMatch;
        });
        if (matched) {
            logger.info(`[Trigger] Keyword matched! Triggering flow.`);
        }
        return matched;
    }
    
    logger.info(`[Trigger] No trigger condition met - trigger_type: ${flow.trigger_type}, keywords: ${JSON.stringify(flow.trigger_keywords)}`);
    return false;
}

module.exports = flowController;
module.exports.initializeFlowController = initializeFlowController;

