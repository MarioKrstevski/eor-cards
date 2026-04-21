import axios from 'axios';
import type {
  CurriculumNode,
  RuleSet,
  Document,
  UploadDocumentResponse,
  Card,
  CardStatus,
  Model,
  CostEstimate,
  StartGenerationResponse,
  GenerationJob,
} from './types';

const http = axios.create({ baseURL: '/api' });

// ─── Curriculum ───────────────────────────────────────────────────────────────

export async function getCurriculum(): Promise<CurriculumNode[]> {
  const res = await http.get<CurriculumNode[]>('/curriculum');
  return res.data;
}

export async function createCurriculumNode(params: {
  name: string;
  parent_id?: number | null;
}): Promise<CurriculumNode> {
  const res = await http.post<CurriculumNode>('/curriculum/', params);
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

// ─── Rule Sets ────────────────────────────────────────────────────────────────

export async function getRuleSets(): Promise<RuleSet[]> {
  const res = await http.get<RuleSet[]>('/rules');
  return res.data;
}

export async function createRuleSet(params: {
  name: string;
  content: string;
  is_default?: boolean;
}): Promise<RuleSet> {
  const res = await http.post<RuleSet>('/rules/', params);
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

export async function getDocuments(): Promise<Document[]> {
  const res = await http.get<Document[]>('/documents');
  return res.data;
}

export async function getDocument(id: number): Promise<Document> {
  const res = await http.get<Document>(`/documents/${id}`);
  return res.data;
}

export async function uploadDocument(
  file: File
): Promise<UploadDocumentResponse> {
  const form = new FormData();
  form.append('file', file);
  const res = await http.post<UploadDocumentResponse>('/documents/upload', form);
  return res.data;
}

export async function updateDocument(
  id: number,
  params: { curriculum_id?: number | null }
): Promise<Document> {
  const res = await http.patch<Document>(`/documents/${id}`, params);
  return res.data;
}

export async function deleteDocument(id: number): Promise<void> {
  await http.delete(`/documents/${id}`);
}

// ─── Cards ────────────────────────────────────────────────────────────────────

export async function getCards(params?: {
  document_id?: number;
  chunk_id?: number;
  status?: CardStatus;
  needs_review?: boolean;
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
    status?: CardStatus;
  }
): Promise<Card> {
  const res = await http.patch<Card>(`/cards/${id}`, params);
  return res.data;
}

export async function rejectCard(id: number): Promise<Card> {
  const res = await http.post<Card>(`/cards/${id}/reject`);
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
}): Promise<StartGenerationResponse> {
  const res = await http.post<StartGenerationResponse>('/generate/start', params);
  return res.data;
}

export async function getGenerationJob(jobId: number): Promise<GenerationJob> {
  const res = await http.get<GenerationJob>(`/generate/jobs/${jobId}`);
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
