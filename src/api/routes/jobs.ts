import { Router, Request, Response } from 'express';
import Joi from 'joi';
import { v4 as uuidv4 } from 'uuid';
import QueueManager from '../../queue/manager';
import WorkerManager from '../../workers/manager';
import { logger } from '../../utils/logger';
import { JobData } from '../../utils/types';
import config from '../../config';

const router = Router();
const queueManager = QueueManager.getInstance();
const workerManager = WorkerManager.getInstance();

// Validation schemas
const submitJobSchema = Joi.object({
  script: Joi.string().max(config.security.maxScriptLength).optional(),
  command: Joi.string().optional(),
  args: Joi.array().items(Joi.string()).optional(),
  env: Joi.object().pattern(Joi.string(), Joi.string()).optional(),
  timeout: Joi.number().max(config.security.maxExecutionTime).optional(),
  retries: Joi.number().min(0).max(10).optional(),
  metadata: Joi.object().optional()
});

const listJobsSchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  status: Joi.string().valid('waiting', 'active', 'completed', 'failed', 'delayed', 'paused').optional()
});

/**
 * POST /submit-test
 * Submit a new test execution job
 */
router.post('/submit-test', async (req: Request, res: Response) => {
  try {
    // Validate request body
    const { error, value } = submitJobSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: error.details.map(detail => detail.message)
      });
    }

    // Generate job ID
    const jobId = uuidv4();

    // Create job data
    const jobData: JobData = {
      id: jobId,
      script: value.script,
      command: value.command,
      args: value.args,
      env: value.env,
      timeout: value.timeout,
      retries: value.retries,
      metadata: value.metadata,
      createdAt: new Date()
    };

    // Add job to queue
    const job = await queueManager.addJob(jobData);

    logger.info('Job submitted successfully', { jobId });

    return res.status(201).json({
      success: true,
      data: {
        jobId: job.id,
        status: 'pending',
        submittedAt: jobData.createdAt,
        queuePosition: await queueManager.getQueueStats().then(stats => stats.waiting)
      }
    });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error('Failed to submit job', { error: err.message });
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to submit job'
    });
  }
});

/**
 * GET /status/:jobId
 * Get the status of a specific job
 */
router.get('/status/:jobId', async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;

    // Get job status from queue
    const status = await queueManager.getJobStatus(jobId);
    
    if (status === 'not_found') {
      return res.status(404).json({
        success: false,
        error: 'Job not found'
      });
    }

    // Get job details
    const job = await queueManager.getJob(jobId);
    
    // Get job result if completed
    let result: any = null;
    if (status === 'completed' || status === 'failed') {
      result = await workerManager.getJobResult(jobId);
    }

    return res.json({
      success: true,
      data: {
        jobId,
        status,
        submittedAt: job?.timestamp,
        processedAt: job?.processedOn,
        completedAt: job?.finishedOn,
        attemptsMade: job?.attemptsMade,
        result: result ? {
          exitCode: result.exitCode,
          duration: result.duration,
          stdout: result.stdout.substring(0, 1000), // Truncate for response
          stderr: result.stderr.substring(0, 1000), // Truncate for response
          error: result.error
        } : null
      }
    });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error('Failed to get job status', { jobId: req.params.jobId, error: err.message });
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to get job status'
    });
  }
});

/**
 * GET /logs/:jobId
 * Get logs for a specific job
 */
router.get('/logs/:jobId', async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;

    // Get job result which contains logs
    const result = await workerManager.getJobResult(jobId);
    
    if (!result) {
      return res.status(404).json({
        success: false,
        error: 'Job logs not found'
      });
    }

    return res.json({
      success: true,
      data: {
        jobId,
        logs: {
          stdout: result.stdout,
          stderr: result.stderr,
          combined: result.stdout + result.stderr
        },
        metadata: {
          duration: result.duration,
          exitCode: result.exitCode,
          startTime: result.startTime,
          endTime: result.endTime
        }
      }
    });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error('Failed to get job logs', { jobId: req.params.jobId, error: err.message });
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to get job logs'
    });
  }
});

/**
 * GET /result/:jobId
 * Get the complete result of a specific job
 */
router.get('/result/:jobId', async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;

    // Get job result
    const result = await workerManager.getJobResult(jobId);
    
    if (!result) {
      return res.status(404).json({
        success: false,
        error: 'Job result not found'
      });
    }

    return res.json({
      success: true,
      data: result
    });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error('Failed to get job result', { jobId: req.params.jobId, error: err.message });
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to get job result'
    });
  }
});

/**
 * DELETE /jobs/:jobId
 * Cancel a running job
 */
router.delete('/jobs/:jobId', async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;

    // Check job status first
    const status = await queueManager.getJobStatus(jobId);
    
    if (status === 'not_found') {
      return res.status(404).json({
        success: false,
        error: 'Job not found'
      });
    }

    if (status === 'completed' || status === 'failed') {
      return res.status(400).json({
        success: false,
        error: 'Cannot cancel completed job'
      });
    }

    // Cancel the job
    const cancelled = await workerManager.cancelJob(jobId);
    
    if (!cancelled) {
      return res.status(500).json({
        success: false,
        error: 'Failed to cancel job'
      });
    }

    logger.info('Job cancelled successfully', { jobId });

    return res.json({
      success: true,
      message: 'Job cancelled successfully'
    });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error('Failed to cancel job', { jobId: req.params.jobId, error: err.message });
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to cancel job'
    });
  }
});

/**
 * POST /jobs/:jobId/retry
 * Retry a failed job
 */
router.post('/jobs/:jobId/retry', async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;

    // Check job status first
    const status = await queueManager.getJobStatus(jobId);
    
    if (status === 'not_found') {
      return res.status(404).json({
        success: false,
        error: 'Job not found'
      });
    }

    if (status !== 'failed') {
      return res.status(400).json({
        success: false,
        error: 'Can only retry failed jobs'
      });
    }

    // Retry the job
    await queueManager.retryJob(jobId);

    logger.info('Job retried successfully', { jobId });

    return res.json({
      success: true,
      message: 'Job retried successfully'
    });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error('Failed to retry job', { jobId: req.params.jobId, error: err.message });
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to retry job'
    });
  }
});

/**
 * GET /jobs
 * List jobs with optional status filter and pagination
 */
router.get('/jobs', async (req: Request, res: Response) => {
  try {
    const { error, value } = listJobsSchema.validate(req.query);
    if (error) {
      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: error.details.map(d => d.message)
      });
    }

    const { page, limit, status } = value;
    const start = (page - 1) * limit;
    const end = start + limit - 1;

    // Determine which statuses to query
    const statuses: Array<'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'paused'> =
      status ? [status] : ['waiting', 'active', 'completed', 'failed', 'delayed'];

    const queueInstance = queueManager.getQueueInstance();
    const allJobs = await queueInstance.getJobs(statuses, start, end);

    // Build response with pagination
    const totalCounts = await queueManager.getQueueStats();
    const totalForStatus = status
      ? ((totalCounts as unknown) as Record<string, number>)[status] ?? 0
      : Object.values(totalCounts).reduce((a, b) => a + b, 0);

    const jobs = allJobs.map(job => ({
      jobId: job.id,
      name: job.name,
      submittedAt: job.timestamp,
      processedAt: job.processedOn,
      completedAt: job.finishedOn,
      attemptsMade: job.attemptsMade,
      data: {
        command: job.data.command,
        timeout: job.data.timeout,
        metadata: job.data.metadata
      }
    }));

    return res.json({
      success: true,
      data: {
        jobs,
        pagination: {
          page,
          limit,
          total: totalForStatus,
          pages: Math.ceil(totalForStatus / limit),
          hasNext: end < totalForStatus - 1,
          hasPrev: page > 1
        }
      }
    });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error('Failed to list jobs', { error: err.message });
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to list jobs'
    });
  }
});

export default router;
