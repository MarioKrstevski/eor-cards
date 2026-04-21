// ─── Curriculum ───────────────────────────────────────────────────────────────

export interface CurriculumNode {
  id: number;
  name: string;
  parent_id: number | null;
  path: string;
  children: CurriculumNode[];
}

// ─── Rule Sets ────────────────────────────────────────────────────────────────

export interface RuleSet {
  id: number;
  name: string;
  content: string;
  is_default: boolean;
  created_at: string;
}

// ─── Documents ────────────────────────────────────────────────────────────────

export interface Chunk {
  id: number;
  chunk_index: number;
  heading: string | null;
  content_type: string;
  source_html: string;
  card_count: number;
}

export interface Document {
  id: number;
  original_name: string;
  filename: string;
  curriculum_id: number | null;
  topic_path: string | null;
  uploaded_at: string;
  chunk_count: number;
  chunks?: Chunk[];
}

export interface UploadDocumentResponse extends Document {
  suggested_curriculum_id?: number | null;
}

// ─── Cards ────────────────────────────────────────────────────────────────────

export type CardStatus = 'active' | 'rejected';

export interface Card {
  id: number;
  chunk_id: number;
  document_id: number;
  card_number: number;
  front_html: string;
  front_text: string;
  tags: string[];
  extra: string | null;
  status: CardStatus;
  needs_review: boolean;
  created_at: string;
  updated_at: string;
  topic_path: string | null;
  chunk_heading: string | null;
}

// ─── Generation ───────────────────────────────────────────────────────────────

export interface Model {
  id: string;
  display: string;
  input_per_1m: number;
  output_per_1m: number;
}

export interface CostEstimate {
  chunk_count: number;
  estimated_input_tokens: number;
  estimated_output_tokens: number;
  estimated_cost_usd: number;
  model: string;
}

export interface StartGenerationResponse {
  job_id: string;
  total_chunks: number;
  estimated_cost_usd: number;
}

export type JobStatus = 'pending' | 'running' | 'done' | 'failed';

export interface GenerationJob {
  id: string;
  document_id: number;
  status: JobStatus;
  total_chunks: number;
  processed_chunks: number;
  total_cards: number;
  estimated_cost_usd: number | null;
  actual_input_tokens: number | null;
  actual_output_tokens: number | null;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
}
