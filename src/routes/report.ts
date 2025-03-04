import { Router } from 'express';
import { authenticateToken } from '../middleware/auth';
import { generateReport } from '../controllers/reportController';

const router = Router();

router.post('/generate-report', authenticateToken, generateReport);

export default router; 