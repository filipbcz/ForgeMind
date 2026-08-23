import type { FastifyReply } from 'fastify';
import { redactError, redactSecrets } from '@forgemind/core';
import { ZodError } from 'zod';

export function sendNotFound(reply: FastifyReply, message = 'Not found') {
  return reply.code(404).send({ error: message });
}

export function sendBadRequest(reply: FastifyReply, error: unknown) {
  if (error instanceof ZodError) {
    return reply.code(400).send({
      error: 'Validation failed',
      issues: redactSecrets(error.issues)
    });
  }

  return reply.code(400).send({
    error: redactError(error)
  });
}
