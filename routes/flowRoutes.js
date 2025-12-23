const express = require('express');
const router = express.Router();
const flowController = require('../controllers/flowController');
const { requireAuth } = require('../middleware/auth'); // Ensure auth middleware exists

// Apply auth middleware to all flow routes
router.use(requireAuth);

router.get('/flows', flowController.getFlows);
router.get('/flows/:id', flowController.getFlow);
router.post('/flows', flowController.createFlow);
router.put('/flows/:id', flowController.updateFlow);
router.put('/flows/:id/design', flowController.updateFlowDesign);
router.delete('/flows/:id', flowController.deleteFlow);
router.post('/flows/:id/simulate', flowController.simulateFlow);
router.post('/flows/:id/simulate/reset', flowController.resetSimulation);

router.get('/llm-providers', flowController.getLLMProviders);
router.post('/llm-test', flowController.testLLMConnection);

module.exports = router;
