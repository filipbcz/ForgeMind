import type { FastifyReply } from 'fastify';
import { ZodError } from 'zod';

export function sendNotFound(reply: FastifyReply, message = 'Not found') {
  return reply.code(404).send({ error: message });
}

export function sendBadRequest(reply: FastifyReply, error: unknown) {
  if (error instanceof ZodError) {
    return reply.code(400).send({
      error: 'Validation failed',
      issues: error.issues
    });
  }

  return reply.code(400).send({
    error: error instanceof Error ? error.message : String(error)
  });
}

