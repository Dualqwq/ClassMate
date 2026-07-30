import { z } from 'zod';

export const problemIdentificationWireSchema = z.object({
	id: z.string().trim().regex(/^[a-z0-9][a-z0-9.-]*$/).max(160).nullable(),
	v: z.string().trim().regex(/^[a-z0-9][a-z0-9.-]*$/).max(160).nullable(),
	c: z.number().min(0).max(1),
	e: z.array(z.string().trim().min(1).max(160)).max(4),
	r: z.string().trim().min(1).max(300),
}).strict();
