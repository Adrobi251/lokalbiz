import type { ErrorRequestHandler, Response } from 'express';
import type { ApiErrorBody } from './contracts.js';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function sendApiError(
  response: Response,
  status: number,
  code: string,
  message: string,
  details?: unknown,
): void {
  const error: ApiErrorBody['error'] = { code, message };
  if (details !== undefined) error.details = details;
  response.status(status).json({ error });
}

export const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  if (error instanceof ApiError) {
    sendApiError(response, error.status, error.code, error.message, error.details);
    return;
  }

  if (error instanceof SyntaxError && 'body' in error) {
    sendApiError(response, 400, 'INVALID_JSON', 'Format JSON tidak valid.');
    return;
  }

  if (isPayloadTooLarge(error)) {
    sendApiError(response, 413, 'PAYLOAD_TOO_LARGE', 'Ukuran permintaan melebihi batas.');
    return;
  }

  sendApiError(response, 500, 'INTERNAL_SERVER_ERROR', 'Terjadi kesalahan pada server.');
};

function isPayloadTooLarge(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'status' in error && error.status === 413;
}
