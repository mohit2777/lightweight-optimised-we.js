/**
 * AI Input Analyzer - Pure AI-Based Approach
 * 
 * Two modes:
 * 1. GENERATE QUESTION - AI creates the question to ask for a field
 * 2. ANALYZE INPUT - AI validates and extracts data from user response
 * 
 * The AI uses:
 * - Persona (if configured)
 * - Knowledge base (for context)
 * - Instructions/guidelines
 * - Conversation history (shared memory with chatbot)
 */

const logger = require('./logger');
const axios = require('axios');

// ============================================================================
// AI PROVIDER IMPLEMENTATIONS
// ============================================================================

async function callGroq(config, messages, systemPrompt) {
    const response = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        {
            model: config.model || 'llama-3.3-70b-versatile',
            messages: [
                { role: 'system', content: systemPrompt },
                ...messages
            ],
            temperature: config.temperature || 0.5,
            max_tokens: 400
        },
        {
            headers: {
                'Authorization': `Bearer ${config.apiKey}`,
                'Content-Type': 'application/json'
            },
            timeout: 15000
        }
    );
    return response.data.choices[0].message.content;
}

async function callOpenAI(config, messages, systemPrompt) {
    const response = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
            model: config.model || 'gpt-4o-mini',
            messages: [
                { role: 'system', content: systemPrompt },
                ...messages
            ],
            temperature: config.temperature || 0.5,
            max_tokens: 400
        },
        {
            headers: {
                'Authorization': `Bearer ${config.apiKey}`,
                'Content-Type': 'application/json'
            },
            timeout: 15000
        }
    );
    return response.data.choices[0].message.content;
}

async function callGemini(config, messages, systemPrompt) {
    const model = config.model || 'gemini-1.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.apiKey}`;
    
    const contents = messages.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
    }));
    
    const response = await axios.post(url, {
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig: {
            temperature: config.temperature || 0.5,
            maxOutputTokens: 400
        }
    }, { timeout: 15000 });
    
    return response.data.candidates[0].content.parts[0].text;
}

async function callOpenRouter(config, messages, systemPrompt) {
    const response = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
            model: config.model || 'meta-llama/llama-3.1-8b-instruct:free',
            messages: [
                { role: 'system', content: systemPrompt },
                ...messages
            ],
            temperature: config.temperature || 0.5,
            max_tokens: 400
        },
        {
            headers: {
                'Authorization': `Bearer ${config.apiKey}`,
                'Content-Type': 'application/json'
            },
            timeout: 15000
        }
    );
    return response.data.choices[0].message.content;
}

async function callAnthropic(config, messages, systemPrompt) {
    const response = await axios.post(
        'https://api.anthropic.com/v1/messages',
        {
            model: config.model || 'claude-3-haiku-20240307',
            system: systemPrompt,
            messages: messages.map(m => ({
                role: m.role,
                content: m.content
            })),
            max_tokens: 400
        },
        {
            headers: {
                'x-api-key': config.apiKey,
                'anthropic-version': '2023-06-01',
                'Content-Type': 'application/json'
            },
            timeout: 15000
        }
    );
    return response.data.content[0].text;
}

async function callAI(provider, config, messages, systemPrompt) {
    const providerLower = (provider || '').toLowerCase();
    
    switch (providerLower) {
        case 'groq':
            return await callGroq(config, messages, systemPrompt);
        case 'openai':
            return await callOpenAI(config, messages, systemPrompt);
        case 'gemini':
            return await callGemini(config, messages, systemPrompt);
        case 'openrouter':
        case 'openrouter-free':
            return await callOpenRouter(config, messages, systemPrompt);
        case 'anthropic':
            return await callAnthropic(config, messages, systemPrompt);
        default:
            throw new Error(`Unknown AI provider: ${provider}`);
    }
}

// ============================================================================
// GENERATE QUESTION - AI creates question for a field
// ============================================================================

/**
 * Generate a question to ask the user for a specific field
 * Called when flow reaches a collect node for the first time
 */
async function generateQuestion(flow, node, context = {}, conversationHistory = []) {
    // Safety check - if flow is null/undefined, return default
    if (!flow) {
        logger.warn('[AIAnalyzer] generateQuestion called with null flow');
        const fieldType = node?.config?.fieldType || 'text';
        const fieldName = node?.config?.field || 'information';
        return getDefaultQuestion(fieldName, fieldType, fieldName);
    }

    const fieldName = node?.config?.field || 'info';
    const fieldType = node?.config?.fieldType || 'text';
    const label = node?.config?.label || fieldName;
    
    // If user provided a custom question, use it
    if (node?.config?.question && node.config.question.trim()) {
        return node.config.question;
    }

    const llmConfig = {
        provider: flow.llm_provider,
        apiKey: flow.llm_api_key,
        model: flow.llm_model,
        temperature: flow.llm_temperature || 0.7
    };

    // No AI configured? Use default questions
    if (!llmConfig.provider || !llmConfig.apiKey) {
        logger.info(`[AIAnalyzer] No AI configured, using default question for ${fieldType}`);
        return getDefaultQuestion(fieldName, fieldType, label);
    }

    // Get collected fields
    const collectedFields = {};
    for (const [key, value] of Object.entries(context || {})) {
        if (!key.startsWith('_') && key !== 'user_input' && key !== 'selected_option' && value) {
            collectedFields[key] = value;
        }
    }

    const systemPrompt = `You are a conversational assistant collecting information.
${flow.llm_persona ? `YOUR PERSONA: ${flow.llm_persona}` : ''}
${flow.knowledge_base ? `CONTEXT: ${flow.knowledge_base}` : ''}
${flow.llm_instructions ? `GUIDELINES: ${flow.llm_instructions}` : ''}

Generate a friendly, natural question to ask the user for their ${label} (${fieldType}).
${Object.keys(collectedFields).length > 0 ? `Already collected: ${JSON.stringify(collectedFields)}` : 'This is the first piece of info being collected.'}

Rules:
- Be conversational and friendly
- Keep it short (1-2 sentences max)
- Don't be robotic or formal
- Match your persona if one is defined
- Just output the question text, nothing else`;

    try {
        const messages = [];
        
        // Add conversation context
        if (conversationHistory && conversationHistory.length > 0) {
            const recent = conversationHistory.slice(-5);
            for (const msg of recent) {
                messages.push({
                    role: msg.role === 'user' ? 'user' : 'assistant',
                    content: msg.content
                });
            }
        }

        messages.push({ role: 'user', content: `Generate a question to ask for: ${label} (${fieldType})` });

        logger.info(`[AIAnalyzer] Generating question for field "${fieldName}" (${fieldType}) using ${llmConfig.provider}`);
        
        const question = await callAI(llmConfig.provider, llmConfig, messages, systemPrompt);
        const cleanQuestion = question.trim().replace(/^["']|["']$/g, ''); // Remove quotes if AI added them
        
        logger.info(`[AIAnalyzer] Generated question: "${cleanQuestion}"`);
        return cleanQuestion;
    } catch (error) {
        logger.error(`[AIAnalyzer] Question generation error: ${error.message}`);
        return getDefaultQuestion(fieldName, fieldType, label);
    }
}

function getDefaultQuestion(fieldName, fieldType, label) {
    const questions = {
        name: `What's your name?`,
        phone: `Could you share your phone number?`,
        email: `What's your email address?`,
        address: `What's your address?`,
        date: `What date works for you?`,
        number: `Please provide the number.`,
        text: `Could you tell me your ${label || fieldName}?`
    };
    return questions[fieldType] || questions.text;
}

// ============================================================================
// ANALYZE INPUT - AI validates and extracts data
// ============================================================================

function buildAnalysisPrompt(options) {
    const {
        fieldName,
        fieldType,
        label,
        collectedFields,
        persona,
        knowledgeBase,
        instructions,
        flowName
    } = options;

    let collectedSummary = 'None yet';
    if (collectedFields && Object.keys(collectedFields).length > 0) {
        collectedSummary = Object.entries(collectedFields)
            .map(([key, val]) => `  • ${key}: "${val}"`)
            .join('\n');
    }

    return `=== AI DATA COLLECTION ASSISTANT ===

${persona ? `YOUR PERSONA:\n${persona}\n` : ''}
${knowledgeBase ? `KNOWLEDGE BASE:\n${knowledgeBase}\n` : ''}
${instructions ? `GUIDELINES:\n${instructions}\n` : ''}

CURRENT TASK:
You are collecting "${label || fieldName}" (type: ${fieldType}) from the user.

ALREADY COLLECTED:
${collectedSummary}

RESPONSE FORMAT (JSON only):
{"isValid": boolean, "extractedValue": "value or null", "response": "your message"}

RULES:

✅ isValid = TRUE when user provides valid ${fieldType} data:
${fieldType === 'name' ? '- Real names: "John", "Sarah Smith", "राहुल" - Extract just the name from "My name is X" → "X"' : ''}
${fieldType === 'email' ? '- Valid email format: user@domain.com' : ''}
${fieldType === 'phone' ? '- Phone numbers with 7+ digits' : ''}
${fieldType === 'number' ? '- Numeric values' : ''}
${fieldType === 'address' ? '- Any address-like text' : ''}
${fieldType === 'date' ? '- Any date reference: "tomorrow", "Jan 5", "2024-01-05"' : ''}
${fieldType === 'text' ? '- Any meaningful answer to the question' : ''}

❌ isValid = FALSE when:
- User asks questions: "why?", "what for?", "who are you?"
- User deflects: "answer me first", "tell me more", "later"
- User refuses: "no", "I don't want to", "skip"
- Invalid/fake data: "asdf", "xxx", "123" (for name)

RESPONSE GUIDELINES:

When isValid = TRUE:
- Short acknowledgment, then you can move on
- extractedValue = clean data only (e.g., "John" not "My name is John")

When isValid = FALSE:
- Address their question/concern using your knowledge base
- Be helpful and conversational
- Naturally circle back to asking for the info
- Never be pushy or robotic

OUTPUT ONLY THE JSON, nothing else.`;
}

/**
 * Analyze user input - validate and extract data
 */
async function analyzeUserInput(flow, node, userMessage, context = {}, conversationHistory = []) {
    const fieldName = node.config?.field || node.config?.variable || 'user_input';
    const fieldType = node.config?.fieldType || node.config?.type || 'text';
    const label = node.config?.label || fieldName;

    const llmConfig = {
        provider: flow.llm_provider,
        apiKey: flow.llm_api_key,
        model: flow.llm_model,
        temperature: flow.llm_temperature || 0.3
    };

    const collectedFields = {};
    for (const [key, value] of Object.entries(context || {})) {
        if (!key.startsWith('_') && key !== 'user_input' && key !== 'selected_option' && value) {
            collectedFields[key] = value;
        }
    }

    logger.info(`[AIAnalyzer] Analyzing: "${userMessage}" for field "${fieldName}" (${fieldType})`);

    if (!llmConfig.provider || !llmConfig.apiKey) {
        logger.warn('[AIAnalyzer] No AI configured, using fallback');
        return basicFallback(userMessage, fieldName, fieldType);
    }

    try {
        const systemPrompt = buildAnalysisPrompt({
            fieldName,
            fieldType,
            label,
            collectedFields,
            persona: flow.llm_persona || '',
            knowledgeBase: flow.knowledge_base || '',
            instructions: flow.llm_instructions || '',
            flowName: flow.name || 'Flow'
        });

        const messages = [];
        
        if (conversationHistory && conversationHistory.length > 0) {
            const recent = conversationHistory.slice(-10);
            for (const msg of recent) {
                messages.push({
                    role: msg.role === 'user' ? 'user' : 'assistant',
                    content: msg.content
                });
            }
        }

        messages.push({ role: 'user', content: userMessage });

        logger.info(`[AIAnalyzer] Calling ${llmConfig.provider}...`);
        
        const aiResponse = await callAI(llmConfig.provider, llmConfig, messages, systemPrompt);
        
        logger.info(`[AIAnalyzer] AI Response: ${aiResponse}`);

        return parseAIResponse(aiResponse, userMessage, fieldName);

    } catch (error) {
        logger.error(`[AIAnalyzer] Error: ${error.message}`);
        return basicFallback(userMessage, fieldName, fieldType);
    }
}

function parseAIResponse(aiResponse, userMessage, fieldName) {
    try {
        const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
        
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            
            return {
                isQuery: !parsed.isValid,
                response: parsed.response || null,
                extractedData: parsed.isValid ? (parsed.extractedValue || userMessage) : null
            };
        }

        logger.warn('[AIAnalyzer] No JSON in response');
        return {
            isQuery: true,
            response: aiResponse.trim(),
            extractedData: null
        };

    } catch (error) {
        logger.error(`[AIAnalyzer] Parse error: ${error.message}`);
        return {
            isQuery: true,
            response: aiResponse.trim() || `Could you please share your ${fieldName}?`,
            extractedData: null
        };
    }
}

function basicFallback(userMessage, fieldName, fieldType) {
    const msg = userMessage.trim().toLowerCase();
    
    const questionIndicators = ['?', 'why', 'what', 'how', 'who', 'tell me'];
    const refusalIndicators = ['no', 'don\'t', 'won\'t', 'not', 'later', 'skip', 'first'];
    
    const isQuestion = questionIndicators.some(q => msg.includes(q));
    const isRefusal = refusalIndicators.some(r => msg.split(/\s+/).includes(r));
    
    if (isQuestion || isRefusal) {
        return {
            isQuery: true,
            response: `I understand! To help you better, could you please share your ${fieldName}?`,
            extractedData: null
        };
    }

    let isValid = false;
    let value = userMessage.trim();

    switch (fieldType) {
        case 'email':
            const emailMatch = userMessage.match(/[^\s@]+@[^\s@]+\.[^\s@]+/);
            isValid = !!emailMatch;
            value = emailMatch ? emailMatch[0] : null;
            break;
        case 'phone':
            const phoneMatch = userMessage.match(/[\d\s\-\+\(\)]{7,}/);
            isValid = !!phoneMatch;
            value = phoneMatch ? phoneMatch[0].replace(/[\s\-\(\)]/g, '') : null;
            break;
        case 'number':
            const numMatch = userMessage.match(/\d+/);
            isValid = !!numMatch;
            value = numMatch ? numMatch[0] : null;
            break;
        case 'name':
            isValid = userMessage.length >= 2 && !/^\d+$/.test(userMessage) && !/^[a-z]{1,3}$/i.test(userMessage);
            break;
        default:
            isValid = userMessage.length >= 1;
    }

    return {
        isQuery: !isValid,
        response: isValid ? null : `Please share your ${fieldName}.`,
        extractedData: isValid ? value : null
    };
}

module.exports = {
    analyzeUserInput,
    generateQuestion
};
