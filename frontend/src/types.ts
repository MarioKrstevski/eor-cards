// ─── Curriculum ───────────────────────────────────────────────────────────────

export interface CurriculumNode {
  id: number;
  name: string;
  parent_id: number | null;
  path: string;
  level: number;
  children: CurriculumNode[];
}

// ─── Coverage ─────────────────────────────────────────────────────────────────

export interface TopicCoverageStats {
  total: number;
  active: number;
  rejected: number;
  unreviewed: number;
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

export interface ChunkWithTopic {
  id: number;
  chunk_index: number;
  heading: string | null;
  content_type: string;
  source_html: string;
  card_count: number;
  topic_id: number | null;
  topic_path: string | null;
  topic_confirmed: boolean;
}

export interface Document {
  id: number;
  original_name: string;
  filename: string;
  uploaded_at: string;
  chunk_count: number;
  total_cards: number;
  unreviewed_cards: number;
  chunks?: ChunkWithTopic[];
}

export interface UploadResult {
  id: number;
  original_name: string;
  filename: string;
  uploaded_at: string;
  chunk_count: number;
  chunks: ChunkWithTopic[];
  ai_costs: {
    chunking_usd: number;
    topic_detection_usd: number;
    total_usd: number;
  };
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
  vignette: string | null;
  teaching_case: string | null;
  status: CardStatus;
  is_reviewed: boolean;
  created_at: string;
  updated_at: string;
  topic_path: string | null;
  chunk_heading: string | null;
  chunk_source_html: string | null;
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
  job_id: number;
  total_chunks: number;
  estimated_cost_usd: number;
}

export type JobStatus = 'pending' | 'running' | 'done' | 'failed';

export interface GenerationJob {
  id: number;
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

export interface AIUsageSummary {
  total_cost_usd: number;
  by_operation: Record<string, {
    cost_usd: number;
    input_tokens: number;
    output_tokens: number;
    count: number;
  }>;
}
