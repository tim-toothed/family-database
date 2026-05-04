'use strict';

const {
  emptyResponse,
  getHttpMethod,
  jsonResponse,
  normalizePath,
  parseBody,
  requireApiToken,
} = require('./http');
const {
  addAgentEvent,
  createAgentJob,
  getAgentJob,
  listAgentJobs,
  updateAgentJobStatus,
} = require('./family-db');
const { prepareAgentRequest, runAgentChat } = require('./runner');

async function route(event, context) {
  const method = getHttpMethod(event);
  if (method === 'OPTIONS') return emptyResponse(204);

  requireApiToken(event);

  const path = normalizePath(event);
  if (method === 'GET' && path === '/health') {
    return jsonResponse(200, { ok: true });
  }

  if (method === 'POST' && path === '/chat') {
    return jsonResponse(200, await runAgentChat(parseBody(event), {
      remainingTimeMs: typeof context?.getRemainingTimeInMillis === 'function'
        ? context.getRemainingTimeInMillis()
        : null,
    }));
  }

  const segments = path.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment));
  if (segments[0] === 'chat' && segments[1] === 'jobs') {
    if (method === 'GET' && segments.length === 2) {
      const limit = Number(event?.queryStringParameters?.limit ?? 20);
      return jsonResponse(200, await listAgentJobs(Number.isFinite(limit) ? limit : 20));
    }

    if (method === 'POST' && segments.length === 2) {
      const requestPayload = parseBody(event);
      prepareAgentRequest(requestPayload);
      return jsonResponse(201, await createAgentJob(requestPayload));
    }

    if (segments.length >= 3) {
      const jobId = segments[2];
      const sinceEventIndex = Number(event?.queryStringParameters?.sinceEventIndex ?? -1);

      if (method === 'GET' && segments.length === 3) {
        return jsonResponse(200, await getAgentJob(jobId, Number.isFinite(sinceEventIndex) ? sinceEventIndex : -1));
      }

      if (method === 'POST' && segments[3] === 'run') {
        const snapshot = await getAgentJob(jobId);
        if (snapshot.job.status === 'completed') return jsonResponse(200, snapshot);
        if (snapshot.job.status === 'cancelled') return jsonResponse(200, snapshot);
        await addAgentEvent(jobId, 'run_requested', {});
        await updateAgentJobStatus(jobId, { status: 'running' });
        await addAgentEvent(jobId, 'run_started', {});
        try {
          const result = await runAgentChat(snapshot.job.request_payload, {
            jobId,
            remainingTimeMs: typeof context?.getRemainingTimeInMillis === 'function'
              ? context.getRemainingTimeInMillis()
              : null,
          });
          const latest = await getAgentJob(jobId);
          if (latest.job.status === 'cancelled' || result.cancelled) {
            if (latest.job.status !== 'cancelled') {
              await updateAgentJobStatus(jobId, {
                status: 'cancelled',
                final_message: result.message || 'Запрос остановлен пользователем.',
              });
            }
          } else {
            await updateAgentJobStatus(jobId, {
              status: result.incomplete ? 'timeout' : 'completed',
              final_message: result.message,
            });
          }
          return jsonResponse(200, {
            ...(await getAgentJob(jobId)),
            result,
          });
        } catch (error) {
          const latest = await getAgentJob(jobId).catch(() => null);
          if (latest?.job?.status === 'cancelled') {
            await addAgentEvent(jobId, 'cancelled', { message: latest.job.final_message || 'Запрос остановлен пользователем.' }).catch((eventError) => console.error(eventError));
            return jsonResponse(200, latest);
          }
          await updateAgentJobStatus(jobId, {
            status: 'failed',
            error: error.message,
          }).catch((statusError) => console.error(statusError));
          throw error;
        }
      }

      if (method === 'POST' && segments[3] === 'cancel') {
        await addAgentEvent(jobId, 'cancel_requested', {});
        const snapshot = await getAgentJob(jobId);
        if (['completed', 'failed', 'timeout', 'cancelled'].includes(snapshot.job.status)) {
          return jsonResponse(200, snapshot);
        }
        await updateAgentJobStatus(jobId, {
          status: 'cancelled',
          final_message: 'Запрос остановлен пользователем.',
        });
        return jsonResponse(200, await getAgentJob(jobId));
      }
    }
  }

  return jsonResponse(404, { error: 'Not found' });
}

module.exports.handler = async function handler(event, context) {
  try {
    return await route(event, context);
  } catch (error) {
    const statusCode = Number(error?.statusCode) || 500;
    const message = statusCode >= 500 ? 'Internal server error' : error.message;
    console.error(error);
    return jsonResponse(statusCode, { error: message });
  }
};
