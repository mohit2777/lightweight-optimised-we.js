const { db, supabase } = require('../config/database');
const logger = require('../utils/logger');
const flowState = require('./flowState');
const { List } = require('whatsapp-web.js');
const { analyzeUserInput, generateQuestion } = require('../utils/aiInputAnalyzer');
const axios = require('axios');

// Default questions when AI not available
function getDefaultQuestion(fieldType, fieldName) {
    const questions = {
        name: `What's your name?`,
        phone: `Could you share your phone number?`,
        email: `What's your email address?`,
        address: `What's your address?`,
        date: `What date works for you?`,
        number: `Please provide the number.`,
        text: `Could you tell me your ${fieldName}?`
    };
    return questions[fieldType] || questions.text;
}

class FlowEngine {
    constructor(whatsappManager) {
        this.whatsappManager = whatsappManager; // dependency injection to avoid circular require if possible, or pass later
    }

    /**
     * Process a message for a given session or start new flow
     * @param {string} accountId 
     * @param {string} contactId 
     * @param {string} messageBody 
     * @param {Object} existingSession - Optional existing session
     */
    async processMessage(accountId, contactId, messageBody, existingSession = null) {
        logger.info(`[FlowEngine] processMessage called - accountId: ${accountId}, contact: ${contactId}, message: "${messageBody}", hasSession: ${!!existingSession}`);
        
        let session = existingSession;
        let flowId = session ? session.flow_id : null;
        let currentNodeId = session ? session.current_node_id : null;
        let context = session ? session.context : {};

        // If no session, check if message triggers a new flow
        if (!session) {
            logger.info(`[FlowEngine] No existing session, checking for trigger flow...`);
            const flow = await this.findTriggerFlow(accountId, messageBody);
            if (flow) {
                logger.info(`[FlowEngine] Starting flow '${flow.name}' (id: ${flow.id}) for ${contactId}`);
                flowId = flow.id;
                // Start at 'start' node
                const startNode = await this.findStartNode(flowId);
                if (!startNode) {
                    logger.error(`[FlowEngine] Flow ${flowId} has no start node`);
                    return false;
                }
                logger.info(`[FlowEngine] Found start node: ${startNode.id}`);
                currentNodeId = startNode.id;
                context = {};

                // Create session
                session = await flowState.updateSession(accountId, contactId, flowId, currentNodeId, context);
                logger.info(`[FlowEngine] Session created/updated for ${contactId}`);

                // Execute the start node immediately
                await this.executeNode(accountId, contactId, flowId, currentNodeId, context, messageBody);
                return true;
            }
            logger.info(`[FlowEngine] No matching trigger flow found for message: "${messageBody}"`);
            return false; // No flow triggered
        }

        // Existing session: handle input for current node
        logger.info(`[FlowEngine] Existing session found, handling input for node: ${currentNodeId}`);
        await this.handleInput(accountId, contactId, flowId, currentNodeId, context, messageBody);
        return true;
    }

    async findTriggerFlow(accountId, messageBody) {
        // Get all active flows for this account (regardless of trigger_type)
        const { data: flows, error } = await supabase
            .from('chatbot_flows')
            .select('*')
            .eq('account_id', accountId)
            .eq('is_active', true);

        if (error) {
            logger.error(`Error fetching flows for account ${accountId}:`, error);
            return null;
        }

        if (!flows || flows.length === 0) {
            logger.info(`No active flows found for account ${accountId}`);
            return null;
        }

        const lowerMsg = messageBody.toLowerCase().trim();
        logger.info(`[FlowEngine] Checking ${flows.length} active flows for trigger. Message: "${messageBody}"`);

        // Find the first matching flow based on trigger type
        return flows.find(flow => {
            const triggerType = flow.trigger_type || 'keyword';
            
            // trigger_type 'all' - matches any message
            if (triggerType === 'all') {
                logger.info(`[FlowEngine] Flow "${flow.name}" has trigger_type='all' - triggering`);
                return true;
            }

            // trigger_type 'exact' - exact match required
            if (triggerType === 'exact') {
                if (!flow.trigger_keywords || flow.trigger_keywords.length === 0) return false;
                const matched = flow.trigger_keywords.some(k => lowerMsg === k.toLowerCase().trim());
                if (matched) {
                    logger.info(`[FlowEngine] Flow "${flow.name}" exact match triggered`);
                }
                return matched;
            }

            // trigger_type 'regex' - regex pattern matching
            if (triggerType === 'regex') {
                if (!flow.trigger_keywords || flow.trigger_keywords.length === 0) return false;
                const matched = flow.trigger_keywords.some(pattern => {
                    try {
                        const regex = new RegExp(pattern, 'i');
                        return regex.test(messageBody);
                    } catch (e) {
                        logger.warn(`Invalid regex pattern in flow "${flow.name}": ${pattern}`);
                        return false;
                    }
                });
                if (matched) {
                    logger.info(`[FlowEngine] Flow "${flow.name}" regex match triggered`);
                }
                return matched;
            }

            // trigger_type 'keyword' (default) - keyword contains match
            if (triggerType === 'keyword') {
                if (!flow.trigger_keywords || flow.trigger_keywords.length === 0) return false;
                const matched = flow.trigger_keywords.some(k => lowerMsg.includes(k.toLowerCase().trim()));
                if (matched) {
                    logger.info(`[FlowEngine] Flow "${flow.name}" keyword match triggered`);
                }
                return matched;
            }

            logger.info(`[FlowEngine] Flow "${flow.name}" - unknown trigger_type: ${triggerType}`);
            return false;
        });
    }

    async findStartNode(flowId) {
        const { data } = await supabase
            .from('flow_nodes')
            .select('*')
            .eq('flow_id', flowId)
            .eq('node_type', 'start')
            .single();
        return data;
    }

    async executeNode(accountId, contactId, flowId, nodeId, context, input = null) {
        // 1. Get Node Data
        const { data: node } = await supabase
            .from('flow_nodes')
            .select('*')
            .eq('id', nodeId)
            .single();

        if (!node) {
            logger.error(`Node ${nodeId} not found`);
            return;
        }

        logger.info(`Executing node ${node.node_type} (${node.name}) for ${contactId}`);

        // 2. Execute Node Logic
        let nextNodeId = null;
        let shouldWait = false;

        switch (node.node_type) {
            case 'start':
                // Just move to next
                nextNodeId = await this.getNextNode(flowId, node.id);
                break;

            case 'message':
                const messageText = this.interpolateVariables(node.config.message, context);
                await this.whatsappManager.sendMessage(accountId, contactId, messageText);
                nextNodeId = await this.getNextNode(flowId, node.id);
                break;

            case 'buttons': // Renamed to "Options Menu" in UI
                const options = node.config.options || [];

                // Use WhatsApp List Message
                try {
                    const rows = options.map((opt, index) => ({
                        id: `option-${index + 1}`,
                        // Support both 'label' and 'text' property names for backwards compatibility
                        title: (opt.label || opt.text || '').substring(0, 24), // Max 24 chars for title
                        description: (opt.label || opt.text || '').length > 24 ? (opt.label || opt.text).substring(0, 72) : '' // Max 72 chars description
                    }));

                    const list = new List(
                        node.config.message,
                        'View Options',
                        [{ title: 'Please select an option', rows: rows }],
                        'Options Menu',
                        ''
                    );

                    await this.whatsappManager.sendMessage(accountId, contactId, list);
                } catch (err) {
                    logger.warn(`Failed to send List message, falling back to text: ${err.message}`);
                    // Fallback to text list
                    let menuText = node.config.message + '\n\n';
                    options.forEach((opt, index) => {
                        // Support both 'label' and 'text' property names
                        menuText += `${index + 1}. ${opt.label || opt.text || ''}\n`;
                    });
                    menuText += '\nPlease reply with the number of your choice.';
                    await this.whatsappManager.sendMessage(accountId, contactId, menuText);
                }

                shouldWait = true; // Wait for user input
                break;

            case 'input':
                const promptMsg = this.interpolateVariables(node.config.prompt, context);
                await this.whatsappManager.sendMessage(accountId, contactId, promptMsg);
                shouldWait = true; // Wait for any text input
                break;

            case 'condition':
                // Check condition
                const variable = node.config.variable; // e.g., 'user_input'
                const value = context[variable];
                const targetValue = node.config.value;
                const operator = node.config.operator || 'equals';

                let matched = false;
                switch (operator) {
                    case 'equals':
                        matched = (String(value).toLowerCase() === String(targetValue).toLowerCase());
                        break;
                    case 'contains':
                        matched = String(value).toLowerCase().includes(String(targetValue).toLowerCase());
                        break;
                    case 'starts_with':
                        matched = String(value).toLowerCase().startsWith(String(targetValue).toLowerCase());
                        break;
                    case 'ends_with':
                        matched = String(value).toLowerCase().endsWith(String(targetValue).toLowerCase());
                        break;
                    case 'greater_than':
                        matched = parseFloat(value) > parseFloat(targetValue);
                        break;
                    case 'less_than':
                        matched = parseFloat(value) < parseFloat(targetValue);
                        break;
                    default:
                        matched = (value == targetValue);
                }

                // Find connection based on result (true/false or handle)
                nextNodeId = await this.getNextNode(flowId, node.id, matched ? 'true' : 'false');
                // Fallback to default if no specific handle found
                if (!nextNodeId) {
                    nextNodeId = await this.getNextNode(flowId, node.id);
                }
                break;

            case 'delay':
                // Wait for specified seconds before continuing
                const delaySeconds = node.config.seconds || 2;
                await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
                nextNodeId = await this.getNextNode(flowId, node.id);
                break;

            case 'api':
                // Make HTTP API call
                try {
                    const axios = require('axios');
                    const method = (node.config.method || 'GET').toLowerCase();
                    const url = this.interpolateVariables(node.config.url, context);
                    const headers = node.config.headers || {};
                    let body = node.config.body || '';
                    
                    if (body && typeof body === 'string') {
                        body = this.interpolateVariables(body, context);
                        try {
                            body = JSON.parse(body);
                        } catch (e) {
                            // Keep as string if not valid JSON
                        }
                    }

                    const response = await axios({
                        method,
                        url,
                        headers,
                        data: method !== 'get' ? body : undefined,
                        timeout: 30000
                    });

                    // Save response to variable
                    const responseVar = node.config.responseVariable || 'api_response';
                    context[responseVar] = response.data;
                    logger.info(`API call successful: ${method.toUpperCase()} ${url}`);
                } catch (apiError) {
                    logger.error(`API call failed: ${apiError.message}`);
                    context.api_error = apiError.message;
                }
                nextNodeId = await this.getNextNode(flowId, node.id);
                break;

            case 'ai_question':
                // AI-powered question node - asks a question and uses AI to extract/validate the answer
                const aiQuestion = this.interpolateVariables(node.config.question || '', context);
                if (aiQuestion) {
                    await this.whatsappManager.sendMessage(accountId, contactId, aiQuestion);
                } else {
                    // Generate question using AI
                    const { data: flowForQ } = await supabase.from('chatbot_flows').select('*').eq('id', flowId).single();
                    const generatedQ = await generateQuestion(flowForQ, node, context);
                    await this.whatsappManager.sendMessage(accountId, contactId, generatedQ);
                }
                shouldWait = true; // Wait for user input
                break;

            case 'collect':
                // AI-powered data collection - AI generates the question automatically
                try {
                    // Get flow for AI config
                    const { data: flowData, error: flowError } = await supabase.from('chatbot_flows').select('*').eq('id', flowId).single();
                    
                    if (flowError) {
                        logger.error(`[FlowEngine] Failed to get flow data: ${flowError.message}`);
                    }
                    
                    // Generate or use custom question
                    let collectQuestion = '';
                    if (node.config?.question && node.config.question.trim()) {
                        // User provided a custom question
                        collectQuestion = this.interpolateVariables(node.config.question, context);
                    } else if (flowData) {
                        // AI generates the question based on field type and context
                        collectQuestion = await generateQuestion(flowData, node, context);
                    } else {
                        // Fallback if no flow data
                        const fieldName = node.config?.field || 'information';
                        const fieldType = node.config?.fieldType || 'text';
                        collectQuestion = getDefaultQuestion(fieldType, fieldName);
                    }
                    
                    if (collectQuestion) {
                        await this.whatsappManager.sendMessage(accountId, contactId, collectQuestion);
                    }
                } catch (collectError) {
                    logger.error(`[FlowEngine] Error in collect node: ${collectError.message}`);
                    // Don't try to send fallback message here - it will likely fail too
                    // The session is already updated to wait on this node
                    // User can retry by sending another message
                }
                shouldWait = true; // Wait for user input
                break;

            case 'end':
                if (node.config.message) {
                    const endMsg = this.interpolateVariables(node.config.message, context);
                    await this.whatsappManager.sendMessage(accountId, contactId, endMsg);
                }
                await this.sendFlowWebhook(flowId, accountId, contactId, context);
                await flowState.endSession(accountId, contactId);
                return; // Stop execution

            default:
                logger.warn(`Unknown node type: ${node.node_type}`);
                nextNodeId = await this.getNextNode(flowId, node.id);
        }

        // 3. Update State
        if (shouldWait) {
            // Stay on this node, waiting for input
            await flowState.updateSession(accountId, contactId, flowId, node.id, context);
        } else if (nextNodeId) {
            // Update session to next node
            await flowState.updateSession(accountId, contactId, flowId, nextNodeId, context);
            // Execute next node synchronously to ensure TEST MODE wrapper is still active
            // This prevents race condition where wrapper is restored before async nodes complete
            await this.executeNode(accountId, contactId, flowId, nextNodeId, context);
        } else {
            // No next node, implicit end
            await flowState.endSession(accountId, contactId);
        }
    }

    async handleInput(accountId, contactId, flowId, currentNodeId, context, input) {
        const { data: node } = await supabase
            .from('flow_nodes')
            .select('*')
            .eq('id', currentNodeId)
            .single();

        if (!node) return;

        let nextNodeId = null;

        if (node.node_type === 'buttons') {
            const inputTrimmed = input.trim();
            const choiceNum = parseInt(inputTrimmed);
            const options = node.config.options || [];

            let selectedIndex = -1;

            // Match by number
            if (!isNaN(choiceNum) && choiceNum >= 1 && choiceNum <= options.length) {
                selectedIndex = choiceNum - 1;
            }
            // Match by exact text (case insensitive) for List clicks - support both 'label' and 'text'
            else {
                selectedIndex = options.findIndex(opt => {
                    const optText = (opt.label || opt.text || '').toLowerCase();
                    return optText === inputTrimmed.toLowerCase();
                });
            }

            if (selectedIndex !== -1) {
                const selectedOption = options[selectedIndex];
                const optionText = selectedOption.label || selectedOption.text || '';
                context.selected_option = selectedOption.value || optionText;
                context.user_input = optionText;

                // Find connection from the specific option handle
                nextNodeId = await this.getNextNode(flowId, node.id, `option-${selectedIndex}`);

                // Use default output if specific option not connected
                if (!nextNodeId) nextNodeId = await this.getNextNode(flowId, node.id, 'default');
                if (!nextNodeId) nextNodeId = await this.getNextNode(flowId, node.id);

            } else {
                // Invalid input, re-ask
                await this.whatsappManager.sendMessage(accountId, contactId, 'Invalid option. Please try again.');
                return; // Stay on current node
            }
        } else if (['input', 'ai_question', 'collect'].includes(node.node_type)) {
            // AI-assisted data collection: classify query vs data and extract value
            const { data: flow } = await supabase
                .from('chatbot_flows')
                .select('*')
                .eq('id', flowId)
                .single();

            // Get conversation history if shared memory is enabled
            let conversationHistory = [];
            if (flow?.use_shared_memory) {
                try {
                    const history = await db.getConversationHistory(accountId, contactId, 10);
                    conversationHistory = history.map(log => ({
                        role: log.direction === 'incoming' ? 'user' : 'assistant',
                        content: log.message
                    }));
                    logger.debug(`[FlowEngine] Loaded ${conversationHistory.length} messages for shared memory`);
                } catch (historyError) {
                    logger.warn(`[FlowEngine] Failed to load shared memory: ${historyError.message}`);
                }
            }

            const aiAnalysis = flow
                ? await analyzeUserInput(flow, node, input, context, conversationHistory)
                : { isQuery: false, response: null, extractedData: input };

            const promptText = node.config?.prompt || node.config?.question || 'Please provide the requested information';

            if (aiAnalysis.isQuery) {
                // User asked a question or raised an objection - AI response already generated
                if (aiAnalysis.response) {
                    // Send only the AI's natural response (no internal markers)
                    await this.whatsappManager.sendMessage(accountId, contactId, aiAnalysis.response);
                }
                // Don't re-ask immediately - the AI response should include the re-ask naturally
                // Stay on this node waiting for data
                await flowState.updateSession(accountId, contactId, flowId, node.id, context);
                return;
            }

            const extracted = aiAnalysis.extractedData ?? input;

            // Store the extracted data in the context
            if (node.node_type === 'input') {
                const varName = node.config.variable || 'user_input';
                context[varName] = extracted;
            } else if (node.node_type === 'collect' || node.node_type === 'ai_question') {
                const fieldName = node.config.field || 'user_input';
                context[fieldName] = extracted;
                
                // Also store with label for display purposes
                if (node.config.label) {
                    context[`_label_${fieldName}`] = node.config.label;
                }
            } else {
                const fieldName = node.config.field || 'user_input';
                context[fieldName] = extracted;
            }
            context.user_input = extracted;
            nextNodeId = await this.getNextNode(flowId, node.id);
        }

        if (nextNodeId) {
            await flowState.updateSession(accountId, contactId, flowId, nextNodeId, context);
            await this.executeNode(accountId, contactId, flowId, nextNodeId, context);
        } else {
            await flowState.endSession(accountId, contactId);
        }
    }

    /**
     * Interpolate {{variable}} placeholders in a string
     * @param {string} text - Text with placeholders
     * @param {Object} context - Variables to interpolate
     * @returns {string} - Interpolated text
     */
    interpolateVariables(text, context) {
        if (!text) return '';
        return text.replace(/\{\{(\w+)\}\}/g, (match, varName) => {
            return context[varName] !== undefined ? String(context[varName]) : match;
        });
    }

    async getNextNode(flowId, nodeId, sourceHandle = null) {
        let query = supabase
            .from('flow_connections')
            .select('target_node_id')
            .eq('flow_id', flowId)
            .eq('source_node_id', nodeId);

        // If sourceHandle is specified (e.g. for branches), filter by it
        if (sourceHandle) {
            query = query.eq('source_handle', sourceHandle);
        }

        const { data } = await query.maybeSingle(); // Use maybeSingle to avoid error if no result
        if (data) return data.target_node_id;

        // Fallback: try without handle filter if specific handle not found
        if (sourceHandle) {
            const fallback = await supabase
                .from('flow_connections')
                .select('target_node_id')
                .eq('flow_id', flowId)
                .eq('source_node_id', nodeId)
                .maybeSingle();
            if (fallback.data) return fallback.data.target_node_id;
        }

        return null;
    }

    async sendFlowWebhook(flowId, accountId, contactId, context) {
        try {
            const { data: flow } = await supabase
                .from('chatbot_flows')
                .select('webhook_url, name')
                .eq('id', flowId)
                .single();

            if (!flow || !flow.webhook_url) return;

            const payload = {
                flow_id: flowId,
                flow_name: flow.name,
                account_id: accountId,
                contact_number: contactId,
                context,
                timestamp: new Date().toISOString(),
            };

            await axios.post(flow.webhook_url, payload, { timeout: 10000 });
            logger.info(`Flow webhook delivered for ${contactId} -> ${flow.webhook_url}`);
        } catch (err) {
            logger.warn(`Failed to deliver flow webhook for flow ${flowId}: ${err.message}`);
        }
    }
}

module.exports = FlowEngine;

