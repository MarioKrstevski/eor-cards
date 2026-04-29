import axios from 'axios';
import type {
  CurriculumNode,
  TopicCoverageStats,
  RuleSet,
  Document,
  UploadResult,
  ReassignPreviewResult,
  Card,
  CardStatus,
  Model,
  CostEstimate,
  StartGenerationResponse,
  GenerationJob,
  AIUsageSummary,
  SupplementalEstimate,
  SupplementalStartResponse,
} from './types';

const http = axios.create({ baseURL: '/api' });

// ─── Curriculum ───────────────────────────────────────────────────────────────

export async function getCurriculum(): Promise<CurriculumNode[]> {
  const res = await http.get<CurriculumNode[]>('/curriculum');
  return res.data;
}

export async function getCurriculumCoverage(): Promise<Record<string, TopicCoverageStats>> {
  const res = await http.get<Record<string, TopicCoverageStats>>('/curriculum/coverage');
  return res.data;
}

export async function createCurriculumNode(params: {
  name: string;
  parent_id?: number | null;
}): Promise<CurriculumNode> {
  const res = await http.post<CurriculumNode>('/curriculum', params);
  return res.data;
}

export async function updateCurriculumNode(
  id: number,
  params: { name: string }
): Promise<CurriculumNode> {
  const res = await http.patch<CurriculumNode>(`/curriculum/${id}`, params);
  return res.data;
}

export async function deleteCurriculumNode(id: number): Promise<void> {
  await http.delete(`/curriculum/${id}`);
}

export async function previewReassignTopics(id: number): Promise<ReassignPreviewResult> {
  const res = await http.post<ReassignPreviewResult>(`/curriculum/${id}/reassign-topics`);
  return res.data;
}

export async function confirmReassignTopics(
  id: number,
  topics: { chunk_id: number; topic_id: number | null }[]
): Promise<{ confirmed: number }> {
  const res = await http.post<{ confirmed: number }>(`/curriculum/${id}/reassign-topics/confirm`, { topics });
  return res.data;
}

// ─── Rule Sets ────────────────────────────────────────────────────────────────

export async function getRuleSets(ruleType?: string): Promise<RuleSet[]> {
  const params = ruleType ? { rule_type: ruleType } : undefined;
  const res = await http.get<RuleSet[]>('/rules', { params });
  return res.data;
}

export async function createRuleSet(params: {
  name: string;
  content: string;
  is_default?: boolean;
  rule_type?: string;
}): Promise<RuleSet> {
  const res = await http.post<RuleSet>('/rules', params);
  return res.data;
}

export async function updateRuleSet(
  id: number,
  params: { name?: string; content?: string; is_default?: boolean }
): Promise<RuleSet> {
  const res = await http.patch<RuleSet>(`/rules/${id}`, params);
  return res.data;
}

export async function deleteRuleSet(id: number): Promise<void> {
  await http.delete(`/rules/${id}`);
}

export async function setDefaultRuleSet(id: number): Promise<RuleSet> {
  const res = await http.post<RuleSet>(`/rules/${id}/set-default`);
  return res.data;
}

// ─── Documents ────────────────────────────────────────────────────────────────

export async function getDocuments(params?: { topic_id?: number }): Promise<Document[]> {
  const res = await http.get<Document[]>('/documents', { params });
  return res.data;
}

export async function getDocument(id: number): Promise<Document> {
  const res = await http.get<Document>(`/documents/${id}`);
  return res.data;
}

export async function uploadDocument(file: File): Promise<UploadResult> {
  const form = new FormData();
  form.append('file', file);
  const res = await http.post<UploadResult>('/documents/upload', form);
  return res.data;
}

export async function pasteDocument(html: string, name: string): Promise<UploadResult> {
  const res = await http.post<UploadResult>('/documents/paste', { html, name });
  return res.data;
}

export async function confirmDocumentTopics(
  docId: number,
  topics: { chunk_id: number; topic_id: number | null }[]
): Promise<Document> {
  const res = await http.post<Document>(`/documents/${docId}/confirm-topics`, { topics });
  return res.data;
}

export async function deleteDocument(id: number): Promise<void> {
  await http.delete(`/documents/${id}`);
}

export async function renameDocument(id: number, name: string): Promise<void> {
  await http.patch(`/documents/${id}/rename`, { name });
}

// ─── Cards ────────────────────────────────────────────────────────────────────

export async function getCards(params?: {
  document_id?: number;
  chunk_id?: number;
  status?: CardStatus;
  is_reviewed?: boolean;
  tag?: string;
  search_q?: string;
}): Promise<Card[]> {
  const res = await http.get<Card[]>('/cards', { params });
  return res.data;
}

export async function updateCard(
  id: number,
  params: {
    front_html?: string;
    tags?: string[];
    extra?: string | null;
    vignette?: string | null;
    teaching_case?: string | null;
    status?: CardStatus;
    is_reviewed?: boolean;
    ref_img_position?: 'front' | 'back';
  }
): Promise<Card> {
  const res = await http.patch<Card>(`/cards/${id}`, params);
  return res.data;
}

export async function rejectCard(id: number): Promise<Card> {
  const res = await http.post<Card>(`/cards/${id}/reject`);
  return res.data;
}

export async function bulkMarkReviewed(cardIds: number[]): Promise<{ updated: number }> {
  const res = await http.post<{ updated: number }>('/cards/bulk-review', { card_ids: cardIds });
  return res.data;
}

export async function deleteCard(id: number): Promise<void> {
  await http.delete(`/cards/${id}`);
}

export async function regenerateCard(
  id: number,
  params: { model?: string; prompt?: string }
): Promise<Card> {
  const res = await http.post<Card>(`/cards/${id}/regenerate`, params);
  return res.data;
}

// ─── Generation ───────────────────────────────────────────────────────────────

export async function getModels(): Promise<Model[]> {
  const res = await http.get<Model[]>('/generate/models');
  return res.data;
}

export async function estimateCost(params: {
  document_id: number;
  chunk_ids?: number[];
  rule_set_id: number;
  model: string;
}): Promise<CostEstimate> {
  const res = await http.post<CostEstimate>('/generate/estimate', params);
  return res.data;
}

export async function startGeneration(params: {
  document_id: number;
  chunk_ids?: number[];
  rule_set_id: number;
  model: string;
  replace_existing?: boolean;
}): Promise<StartGenerationResponse> {
  const res = await http.post<StartGenerationResponse>('/generate/start', params);
  return res.data;
}

export async function getGenerationJob(jobId: number): Promise<GenerationJob> {
  const res = await http.get<GenerationJob>(`/generate/jobs/${jobId}`);
  return res.data;
}

// ─── Supplemental Generation (Vignettes + Teaching Cases combined) ────────────

export async function estimateSupplemental(params: { card_ids: number[]; model: string }): Promise<SupplementalEstimate> {
  const res = await http.post<SupplementalEstimate>('/generate/supplemental/estimate', params);
  return res.data;
}

export async function startSupplemental(params: {
  card_ids: number[];
  rule_set_id: number;
  model: string;
  replace_existing?: boolean;
}): Promise<SupplementalStartResponse> {
  const res = await http.post<SupplementalStartResponse>('/generate/supplemental/start', params);
  return res.data;
}

// ─── Export ───────────────────────────────────────────────────────────────────

export function exportCardsUrl(params?: {
  document_id?: number;
  curriculum_id?: number;
}): string {
  const url = new URL('/api/export/cards', window.location.origin);
  if (params?.document_id != null) {
    url.searchParams.set('document_id', String(params.document_id));
  }
  if (params?.curriculum_id != null) {
    url.searchParams.set('curriculum_id', String(params.curriculum_id));
  }
  return url.toString();
}

// ─── Usage ────────────────────────────────────────────────────────────────────

export async function getUsageSummary(): Promise<AIUsageSummary> {
  const res = await http.get<AIUsageSummary>('/usage/summary');
  return res.data;
}

// ─── Chat ────────────────────────────────────────────────────────────────────

export interface ChatSessionSummary {
  id: number;
  name: string;
  app_version: number;
  message_count: number;
  created_at: string;
  updated_at: string;
}

export interface ChatSessionDetail {
  id: number;
  name: string;
  messages: { role: string; content: string }[];
  app_version: number;
  created_at: string;
  updated_at: string;
}

export async function getChatSessions(): Promise<ChatSessionSummary[]> {
  const res = await http.get<ChatSessionSummary[]>('/chat/sessions');
  return res.data;
}

export async function getChatSession(id: number): Promise<ChatSessionDetail> {
  const res = await http.get<ChatSessionDetail>(`/chat/sessions/${id}`);
  return res.data;
}

export async function deleteChatSession(id: number): Promise<void> {
  await http.delete(`/chat/sessions/${id}`);
}

export async function sendChatMessage(message: string, sessionId?: number | null): Promise<{
  content: string;
  session_id: number;
  session_name: string;
}> {
  const res = await http.post<{ content: string; session_id: number; session_name: string }>(
    '/chat/send',
    { message, session_id: sessionId ?? null }
  );
  return res.data;
}
