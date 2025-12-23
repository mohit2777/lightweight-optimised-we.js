const { db, supabase } = require('../config/database');
const logger = require('../utils/logger');

/**
 * Service to manage chatbot conversation state
 */
const flowState = {
    /**
     * Get current session for a user
     * @param {string} accountId - WhatsApp account ID
     * @param {string} contactId - User's phone number
     * @returns {Promise<Object|null>} Session object or null
     */
    async getSession(accountId, contactId) {
        try {
            const { data, error } = await supabase
                .from('chatbot_conversations')
                .select('*')
                .eq('account_id', accountId)
                .eq('contact_number', contactId)
                .eq('status', 'active')
                .single();

            if (error && error.code !== 'PGRST116') { // PGRST116 is "no rows returned"
                logger.error(`Error fetching session for ${contactId}:`, error);
                return null;
            }

            return data;
        } catch (err) {
            logger.error(`Unexpected error fetching session for ${contactId}:`, err);
            return null;
        }
    },

    /**
     * Create or update a session
     * @param {string} accountId 
     * @param {string} contactId 
     * @param {string} flowId 
     * @param {string} nodeId - Current node ID
     * @param {Object} context - Session variables
     */
    async updateSession(accountId, contactId, flowId, nodeId, context = {}) {
        try {
            // First check if an active session exists
            const { data: existing } = await supabase
                .from('chatbot_conversations')
                .select('id')
                .eq('account_id', accountId)
                .eq('contact_number', contactId)
                .eq('status', 'active')
                .single();

            if (existing) {
                // Update existing session
                const { data, error } = await supabase
                    .from('chatbot_conversations')
                    .update({
                        flow_id: flowId,
                        current_node_id: nodeId,
                        context: context,
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', existing.id)
                    .select()
                    .single();

                if (error) throw error;
                return data;
            } else {
                // Create new session
                const { data, error } = await supabase
                    .from('chatbot_conversations')
                    .insert({
                        account_id: accountId,
                        contact_number: contactId,
                        flow_id: flowId,
                        current_node_id: nodeId,
                        context: context,
                        status: 'active',
                        updated_at: new Date().toISOString()
                    })
                    .select()
                    .single();

                if (error) throw error;
                return data;
            }
        } catch (err) {
            logger.error(`Error updating session for ${contactId}:`, err);
            throw err;
        }
    },

    /**
     * End a session (mark as completed or ended)
     * @param {string} accountId 
     * @param {string} contactId 
     * @param {string} status - 'completed' or 'ended'
     */
    async endSession(accountId, contactId, status = 'completed') {
        try {
            const { error } = await supabase
                .from('chatbot_conversations')
                .update({ status: status, updated_at: new Date().toISOString() })
                .eq('account_id', accountId)
                .eq('contact_number', contactId)
                .eq('status', 'active');

            if (error) throw error;
            return true;
        } catch (err) {
            logger.error(`Error ending session for ${contactId}:`, err);
            return false;
        }
    }
};

module.exports = flowState;

