import { Request, Response } from 'express';
import { interpretOperatorNotes } from './llm-interpreter';
import { runOptimization } from './optimizer';
import { SAMPLE_CASES } from './sampleCases';
import { validateRequest } from './types';

/**
 * Health check handler: GET /health
 */
export function handleHealth(_req: Request, res: Response): void {
  res.status(200).json({ status: 'ok' });
}

/**
 * Primary optimization endpoint: POST /optimize-energy
 */
export async function handleOptimizeEnergy(req: Request, res: Response): Promise<void> {
  try {
    // 1. Validate request structure
    const validation = validateRequest(req.body);
    if (!validation.valid || !validation.data) {
      res.status(400).json({
        error: validation.error || 'Invalid request body format',
      });
      return;
    }

    const payload = validation.data;

    // 2. LLM interpretation with deterministic guardrails
    const directives = await interpretOperatorNotes(
      payload.operator_notes,
      payload.battery
    );

    // 3. Mathematical energy optimization
    const response = runOptimization(payload, directives);

    // 4. Return successful 200 response
    res.status(200).json(response);
  } catch (err: any) {
    console.error('[POST /optimize-energy Error]:', err?.message || err);
    res.status(500).json({
      error: 'An unexpected error occurred during energy optimization.',
      message: err?.message || 'Internal processing error',
    });
  }
}

/**
 * Helper endpoint for the web dashboard: GET /api/sample-cases
 */
export function handleGetSampleCases(_req: Request, res: Response): void {
  res.status(200).json(SAMPLE_CASES);
}
