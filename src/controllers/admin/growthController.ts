import { Request, Response } from 'express';

export const getPlaceholder = async (req: Request, res: Response) => {
  res.json({ message: 'Stub for growthController.ts' });
};
