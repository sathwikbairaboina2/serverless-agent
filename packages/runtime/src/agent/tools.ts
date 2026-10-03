import { tool } from '@langchain/core/tools';
import { z } from 'zod';

export const getCurrentTime = tool(async () => new Date().toISOString(), {
  name: 'get_current_time',
  description: 'Returns the current UTC time in ISO-8601 format.',
  schema: z.object({}),
});

export const sendEmail = tool(
  async ({ to, subject }) => `Demo stub: email to ${to} with subject "${subject}" was recorded but not sent.`,
  {
    name: 'send_email',
    description: 'Sends an email on the user\'s behalf. Requires human approval before it runs.',
    schema: z.object({ to: z.string().email(), subject: z.string().max(200), body: z.string().max(5000) }),
  },
);

export const demoTools = [getCurrentTime, sendEmail];
