import { z } from 'zod';

export const ListByIndustryQuerySchema = z
  .object({
    sw_l2: z.string().min(1, 'sw_l2 is required'),
  })
  .strict();

export type ListByIndustryQuery = z.infer<typeof ListByIndustryQuerySchema>;
