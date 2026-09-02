import { z } from "zod";
import { toCliJsonSchema } from "../domain/json-schemas.js";

export const maxInquiriesPerRun = 20;
export const maxInquiryQuestionChars = 2_000;
export const maxInquiryAnswerChars = 800;
export const inquiryTimeoutMs = 180_000;

export type InquiryStatus = "running" | "completed" | "failed" | "cancelled";

export interface InquiryRecord {
  id: string;
  version: 1;
  runId: string;
  stage: string;
  runStatusAtAsk: string;
  question: string;
  answer?: string;
  keyPoints?: string[];
  status: InquiryStatus;
  error?: string;
  usage?: {
    durationMs: number;
    profileName?: string;
  };
  createdAt: string;
  updatedAt: string;
}

export const inquiryAnswerSchema = z.object({
  answer: z.string().trim().min(1).max(maxInquiryAnswerChars),
  keyPoints: z.array(z.string().trim().min(1).max(80)).max(6).default([]),
});

export type InquiryAnswer = z.infer<typeof inquiryAnswerSchema>;

export const inquiryAnswerJsonSchema: Record<string, unknown> =
  toCliJsonSchema(inquiryAnswerSchema);
