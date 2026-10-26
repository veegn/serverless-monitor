import { logError, markResponseLogged } from './observability.js';

export class AppError extends Error {
  constructor(message, code = 500, details = null) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
}

export function createErrorResponse(error, shouldLog = true) {
  if (shouldLog) {
    const status = error instanceof AppError ? error.code : 500;
    emitResponseError(error, status);
  }

  const code = error instanceof AppError ? error.code : 500;
  const message = error instanceof AppError 
    ? error.message 
    : 'Internal Server Error';

  return new Response(JSON.stringify({ 
    error: message, 
    code: code 
  }), {
    status: code,
    headers: { 'Content-Type': 'application/json' }
  });
}

function emitResponseError(error, status) {
  markResponseLogged();
  logError('http', status < 500 ? 'http.request.rejected' : 'http.request.failed',
    status < 500 ? error.message : 'Request failed', error,
    { status, ...(error instanceof AppError && error.details ? { details: error.details } : {}) }, status < 500 ? 'warn' : 'error');
}

export function createSuccessResponse(data, headers = {}) {
  const defaultHeaders = { 'Content-Type': 'application/json' };
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { ...defaultHeaders, ...headers }
  });
}

export function createUnauthorizedResponse(message = 'Unauthorized') {
  return new Response(JSON.stringify({ 
    error: message, 
    code: 401 
  }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' }
  });
}

export function createBadRequestResponse(message = 'Bad Request') {
  return new Response(JSON.stringify({ 
    error: message, 
    code: 400 
  }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' }
  });
}

export function createNotFoundResponse(message = 'Not Found') {
  return new Response(JSON.stringify({ 
    error: message, 
    code: 404 
  }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' }
  });
}
