import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import {
  deleteDocument,
  renameDocument,
  getDocuments,
  getCurriculum,
  getCurriculumCoverage,
  uploadDocument,
  pasteDocument,
  getDocument,
  getRuleSets,
  startGeneration,
  getGenerationJob,
  estimateCost,
  confirmDocumentTopics,
  createCurriculumNode,
  updateCurriculumNode,
  deleteCurriculumNode,
  previewReassignTopics,
  confirmReassignTopics,
} from '../api';
import type {
  CurriculumNode,
  TopicCoverageStats,
  Document,
  ChunkWithTopic,
  CostEstimate,
  UploadResult,
  ReassignPreviewResult,
} from '../types';
import CardsPanel from './CardsPanel';
import ConfirmModal from '../components/ConfirmModal';
import CurriculumPicker from '../components/CurriculumPicker';
import { flattenTree, buildAggregatedCounts } from '../utils';
import { useSettings } from '../context/SettingsContext';

// ── TopicNode: read-only collapsible curriculum node for sidebar tree ─────────

interface TopicNodeProps {
  node: CurriculumNode;
  depth: number;
  onSelect: (id: number) => void;
  selectedId: number | null;
  cardCounts: Record<string, TopicCoverageStats>;
  editMode?: boolean;
  onAddChild?: (parentId: number, name: string) => Promise<void>;
  onRename?: (nodeId: number, name: string) => Promise<void>;
  onDelete?: (nodeId: number) => void;
}

function topicReviewStyle(active: number, unreviewed: number, isSelected: boolean) {
  if (isSelected) return { text: 'text-blue-700', badge: 'bg-blue-100 text-blue-700' };
  if (active === 0) return { text: 'text-gray-400', badge: '' };
  if (unreviewed === 0) return { text: 'text-green-700', badge: 'bg-green-100 text-green-700' };
  return { text: 'text-blue-600', badge: 'bg-blue-50 text-blue-700' };
}

function TopicNode({ node, depth, onSelect, selectedId, cardCounts, editMode, onAddChild, onRename, onDelete }: TopicNodeProps) {
  const [expanded, setExpanded] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameVal, setRenameVal] = useState(node.name);
  const [isAddingChild, setIsAddingChild] = useState(false);
  const [addChildVal, setAddChildVal] = useState('');
  const stats = cardCounts[String(node.id)];
  const active = stats?.active ?? 0;
  const unreviewed = stats?.unreviewed ?? 0;
  const reviewed = active - unreviewed;
  const isSelected = node.id === selectedId;
  const style = topicReviewStyle(active, unreviewed, isSelected);

  return (
    <div>
      <div
        onClick={() => !isRenaming && onSelect(node.id)}
        className={[
          'flex items-center gap-1.5 py-1.5 rounded-lg mx-1 transition-colors duration-150',
          isRenaming ? 'cursor-default' : 'cursor-pointer',
          isSelected ? 'bg-blue-50 text-blue-700' : 'hover:bg-gray-50',
        ].join(' ')}
        style={{ paddingLeft: `${10 + depth * 14}px`, paddingRight: '8px' }}
      >
        {node.children.length > 0 ? (
          <button
            onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
            className="shrink-0 text-gray-400 hover:text-gray-600 transition-colors duration-150"
          >
            <svg className={`h-3 w-3 transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        ) : (
          <span className="w-3 shrink-0" />
        )}

        {isRenaming ? (
          <input
            autoFocus
            value={renameVal}
            onChange={(e) => setRenameVal(e.target.value)}
            onBlur={() => { setIsRenaming(false); if (renameVal.trim() && renameVal !== node.name) onRename?.(node.id, renameVal.trim()); else setRenameVal(node.name); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); setIsRenaming(false); if (renameVal.trim() && renameVal !== node.name) onRename?.(node.id, renameVal.trim()); else setRenameVal(node.name); }
              if (e.key === 'Escape') { setIsRenaming(false); setRenameVal(node.name); }
            }}
            onClick={(e) => e.stopPropagation()}
            className="flex-1 text-xs border border-blue-400 rounded px-1.5 py-0.5 outline-none focus:ring-1 focus:ring-blue-400 bg-white text-gray-800"
          />
        ) : (
          <span className={`flex-1 text-xs truncate ${isSelected ? 'font-semibold' : 'font-medium'} ${style.text}`}>{node.name}</span>
        )}

        {!isRenaming && active > 0 && (
          <span className={`text-[10px] px-1.5 py-0.5 rounded-full shrink-0 font-semibold tabular-nums ${style.badge}`}>
            {reviewed}/{active}
          </span>
        )}

        {editMode && !isRenaming && (
          <div className="flex items-center gap-0.5 shrink-0 ml-0.5" onClick={(e) => e.stopPropagation()}>
            <button
              onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); setIsAddingChild(v => !v); setAddChildVal(''); }}
              title="Add child topic"
              className="p-0.5 text-gray-300 hover:text-blue-500 transition-colors duration-150 rounded"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
            </button>
            <button
              onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); setIsRenaming(true); setRenameVal(node.name); }}
              title="Rename topic"
              className="p-0.5 text-gray-300 hover:text-amber-500 transition-colors duration-150 rounded"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536M9 13l6.586-6.586a2 2 0 112.828 2.828L11.828 15.828a2 2 0 01-1.414.586H8v-2.414a2 2 0 01.586-1.414z" />
              </svg>
            </button>
            <button
              onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onDelete?.(node.id); }}
              title={node.children.length > 0 ? 'Remove children first' : 'Delete topic'}
              disabled={node.children.length > 0}
              className={`p-0.5 transition-colors duration-150 rounded ${node.children.length > 0 ? 'text-gray-200 cursor-not-allowed' : 'text-gray-300 hover:text-red-500'}`}
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M9 7h6m-7 0a1 1 0 01-1-1V5a1 1 0 011-1h6a1 1 0 011 1v1a1 1 0 01-1 1H9z" />
              </svg>
            </button>
          </div>
        )}
      </div>
      {editMode && isAddingChild && (
        <div
          className="mx-1 mb-1"
          style={{ paddingLeft: `${10 + (depth + 1) * 14}px`, paddingRight: '8px' }}
          onClick={(e) => e.stopPropagation()}
        >
          <input
            autoFocus
            value={addChildVal}
            onChange={(e) => setAddChildVal(e.target.value)}
            onBlur={() => { setIsAddingChild(false); setAddChildVal(''); }}
            onKeyDown={async (e) => {
              if (e.key === 'Enter' && addChildVal.trim()) {
                e.preventDefault();
                await onAddChild?.(node.id, addChildVal.trim());
                setIsAddingChild(false);
                setAddChildVal('');
              }
              if (e.key === 'Escape') { setIsAddingChild(false); setAddChildVal(''); }
            }}
            placeholder="New topic name..."
            className="w-full text-xs border border-blue-300 rounded px-2 py-1 outline-none focus:ring-1 focus:ring-blue-400 bg-blue-50/50"
          />
        </div>
      )}
      {expanded &&
        node.children.map((child) => (
          <TopicNode
            key={child.id}
            node={child}
            depth={depth + 1}
            onSelect={onSelect}
            selectedId={selectedId}
            cardCounts={cardCounts}
            editMode={editMode}
            onAddChild={onAddChild}
            onRename={onRename}
            onDelete={onDelete}
          />
        ))}
    </div>
  );
}

// ── TopicConfirmScreen ────────────────────────────────────────────────────────

interface TopicConfirmScreenProps {
  uploadResult: UploadResult;
  flatCurriculum: CurriculumNode[];
  onConfirmed: () => void;
  onDismiss: () => void;
  refreshUsage: () => void;
  refreshCards: () => void;
}

function TopicConfirmScreen({
  uploadResult,
  flatCurriculum,
  onConfirmed,
  onDismiss,
  refreshUsage,
  refreshCards,
}: TopicConfirmScreenProps) {
  const { selectedModel, selectedRuleSetId } = useSettings();

  // topic_id per chunk — initialized from AI suggestions
  const [topicMap, setTopicMap] = useState<Record<number, number | null>>(() => {
    const init: Record<number, number | null> = {};
    for (const chunk of uploadResult.chunks) {
      init[chunk.id] = chunk.topic_id;
    }
    return init;
  });

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Generation state after confirm
  const [genRunning, setGenRunning] = useState(false);
  const [genProgress, setGenProgress] = useState<string | null>(null);
  const [genDone, setGenDone] = useState(false);
  const genIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (genIntervalRef.current) clearInterval(genIntervalRef.current);
    };
  }, []);

  async function handleConfirm() {
    setSaving(true);
    setSaveError(null);
    try {
      const topics = Object.entries(topicMap).map(([chunkId, topicId]) => ({
        chunk_id: Number(chunkId),
        topic_id: topicId,
      }));
      await confirmDocumentTopics(uploadResult.id, topics);
      setSaved(true);
      refreshUsage();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save topics');
    } finally {
      setSaving(false);
    }
  }

  async function handleGenerateNow() {
    if (!selectedRuleSetId || !selectedModel) return;
    setGenRunning(true);
    setGenProgress('Starting...');
    try {
      const resp = await startGeneration({
        document_id: uploadResult.id,
        rule_set_id: selectedRuleSetId,
        model: selectedModel,
        replace_existing: false,
      });
      const jobId = resp.job_id;
      if (genIntervalRef.current) clearInterval(genIntervalRef.current);
      genIntervalRef.current = setInterval(async () => {
        try {
          const job = await getGenerationJob(jobId);
          setGenProgress(`${job.processed_chunks}/${job.total_chunks} chunks`);
          if (job.status === 'done' || job.status === 'failed') {
            clearInterval(genIntervalRef.current!);
            genIntervalRef.current = null;
            setGenRunning(false);
            if (job.status === 'done') {
              setGenDone(true);
              refreshUsage();
              refreshCards();
              setGenProgress('Done!');
            } else {
              setGenProgress('Failed');
            }
            setTimeout(() => setGenProgress(null), 3000);
          }
        } catch {
          // keep polling
        }
      }, 1500);
    } catch {
      setGenRunning(false);
      setGenProgress('Failed to start');
    }
  }

  function stripHtml(html: string): string {
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  const { ai_costs } = uploadResult;

  return (
    <div className="fixed inset-x-0 bottom-0 top-11 z-40 bg-white flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-5 shadow-[0_1px_3px_0_rgba(0,0,0,0.05)] shrink-0">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Review detected topics</h2>
          <p className="text-sm text-gray-500 mt-0.5 truncate max-w-xl">
            {uploadResult.original_name}
          </p>
        </div>
        {/* AI cost badge */}
        <div className="flex items-center gap-3">
          <span className="text-xs text-gray-500 bg-gray-50 rounded-full px-3 py-1.5 font-medium">
            AI: chunking{' '}
            <span className="font-semibold text-gray-700">
              ${ai_costs.chunking_usd.toFixed(4)}
            </span>{' '}
            + topics{' '}
            <span className="font-semibold text-gray-700">
              ${ai_costs.topic_detection_usd.toFixed(4)}
            </span>{' '}
            ={' '}
            <span className="font-semibold text-blue-700">
              ${ai_costs.total_usd.toFixed(4)}
            </span>
          </span>
          <button
            onClick={onDismiss}
            className="p-1.5 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-50 transition-colors duration-150"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Chunk list */}
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="max-w-3xl mx-auto flex flex-col gap-3">
          {uploadResult.chunks.map((chunk, idx) => {
            const preview = stripHtml(chunk.source_html).slice(0, 80);
            return (
              <div key={chunk.id} className="bg-white rounded-xl shadow-md border border-gray-200 p-5">
                <div className="flex items-start gap-3">
                  <span className="text-[10px] text-gray-400 mt-0.5 shrink-0 font-medium">#{idx + 1}</span>
                  <div className="flex-1 min-w-0">
                    {chunk.heading && (
                      <p className="text-xs font-semibold text-gray-800 mb-1.5">{chunk.heading}</p>
                    )}
                    <p className="text-xs text-gray-500 mb-3 line-clamp-2 leading-relaxed">
                      {preview}
                      {stripHtml(chunk.source_html).length > 80 ? '...' : ''}
                    </p>
                    <CurriculumPicker
                      flatNodes={flatCurriculum}
                      value={topicMap[chunk.id] ?? null}
                      onChange={(id) =>
                        setTopicMap((prev) => ({ ...prev, [chunk.id]: id }))
                      }
                      placeholder="-- unassigned --"
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Footer */}
      <div className="shrink-0 shadow-[0_-1px_3px_0_rgba(0,0,0,0.05)] px-6 py-4">
        <div className="max-w-3xl mx-auto">
          {saveError && (
            <p className="text-xs text-red-600 mb-3">{saveError}</p>
          )}

          {!saved ? (
            <div className="flex items-center gap-3">
              <button
                onClick={handleConfirm}
                disabled={saving}
                className="px-5 py-2.5 text-sm font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 disabled:opacity-50 transition-colors duration-150"
              >
                {saving ? 'Saving...' : 'Confirm topics'}
              </button>
              <button
                onClick={onDismiss}
                className="px-4 py-2.5 text-sm font-medium text-gray-500 hover:text-gray-700 transition-colors duration-150"
              >
                Skip
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-sm text-green-700 font-medium flex items-center gap-1.5">
                <svg
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2.5}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M5 13l4 4L19 7"
                  />
                </svg>
                Topics saved!
              </span>

              {genDone ? (
                <span className="text-sm text-green-700">
                  Cards generated.{' '}
                  <button onClick={onConfirmed} className="underline hover:no-underline">
                    View them
                  </button>
                </span>
              ) : genRunning ? (
                <span className="flex items-center gap-2 text-sm text-gray-500">
                  <svg
                    className="animate-spin h-4 w-4 text-blue-700"
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8v8H4z"
                    />
                  </svg>
                  Generating... {genProgress}
                </span>
              ) : (
                <>
                  <button
                    onClick={handleGenerateNow}
                    className="px-4 py-2.5 text-sm font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 transition-colors duration-150"
                  >
                    Generate now
                  </button>
                  <button
                    onClick={onConfirmed}
                    className="px-4 py-2.5 text-sm font-medium text-gray-500 hover:text-gray-700 transition-colors duration-150"
                  >
                    Later
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── ReassignReviewScreen ──────────────────────────────────────────────────────

interface ReassignReviewScreenProps {
  nodeId: number;
  nodeName: string;
  previewResult: ReassignPreviewResult;
  flatCurriculum: CurriculumNode[];
  onConfirmed: () => void;
  onDismiss: () => void;
  refreshUsage: () => void;
}

function ReassignReviewScreen({
  nodeId,
  nodeName,
  previewResult,
  flatCurriculum,
  onConfirmed,
  onDismiss,
  refreshUsage,
}: ReassignReviewScreenProps) {
  const [topicMap, setTopicMap] = useState<Record<number, number | null>>(() => {
    const init: Record<number, number | null> = {};
    for (const chunk of previewResult.chunks) {
      init[chunk.id] = chunk.topic_id;
    }
    return init;
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  function stripHtml(html: string): string {
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  async function handleConfirm() {
    setSaving(true);
    setSaveError(null);
    try {
      const topics = Object.entries(topicMap).map(([chunkId, topicId]) => ({
        chunk_id: Number(chunkId),
        topic_id: topicId,
      }));
      await confirmReassignTopics(nodeId, topics);
      setSaved(true);
      refreshUsage();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save topics');
    } finally {
      setSaving(false);
    }
  }

  const { ai_costs } = previewResult;

  return (
    <div className="fixed inset-x-0 bottom-0 top-11 z-40 bg-white flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-5 shadow-[0_1px_3px_0_rgba(0,0,0,0.05)] shrink-0">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Review reassigned topics</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            Under <span className="font-medium text-gray-700">{nodeName}</span>
            {' '}— {previewResult.chunks.length} chunk{previewResult.chunks.length !== 1 ? 's' : ''}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-gray-500 bg-gray-50 rounded-full px-3 py-1.5 font-medium">
            AI:{' '}
            <span className="font-semibold text-blue-700">
              ${ai_costs.topic_detection_usd.toFixed(4)}
            </span>
          </span>
          <button
            onClick={onDismiss}
            className="p-1.5 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-50 transition-colors duration-150"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Chunk list */}
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="max-w-3xl mx-auto flex flex-col gap-3">
          {previewResult.chunks.length === 0 ? (
            <p className="text-sm text-gray-500 text-center py-10">No chunks found under this topic.</p>
          ) : (
            previewResult.chunks.map((chunk, idx) => {
              const preview = stripHtml(chunk.source_html).slice(0, 80);
              return (
                <div key={chunk.id} className="bg-white rounded-xl shadow-md border border-gray-200 p-5">
                  <div className="flex items-start gap-3">
                    <span className="text-[10px] text-gray-400 mt-0.5 shrink-0 font-medium">#{idx + 1}</span>
                    <div className="flex-1 min-w-0">
                      {chunk.document_name && (
                        <p className="text-[10px] font-medium text-blue-500 mb-1 truncate">{chunk.document_name}</p>
                      )}
                      {chunk.heading && (
                        <p className="text-xs font-semibold text-gray-800 mb-1.5">{chunk.heading}</p>
                      )}
                      <p className="text-xs text-gray-500 mb-3 line-clamp-2 leading-relaxed">
                        {preview}{stripHtml(chunk.source_html).length > 80 ? '...' : ''}
                      </p>
                      <CurriculumPicker
                        flatNodes={flatCurriculum}
                        value={topicMap[chunk.id] ?? null}
                        onChange={(id) => setTopicMap((prev) => ({ ...prev, [chunk.id]: id }))}
                        placeholder="-- unassigned --"
                      />
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="shrink-0 shadow-[0_-1px_3px_0_rgba(0,0,0,0.05)] px-6 py-4">
        <div className="max-w-3xl mx-auto">
          {saveError && <p className="text-xs text-red-600 mb-3">{saveError}</p>}
          {!saved ? (
            <div className="flex items-center gap-3">
              <button
                onClick={handleConfirm}
                disabled={saving}
                className="px-5 py-2.5 text-sm font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 disabled:opacity-50 transition-colors duration-150"
              >
                {saving ? 'Saving...' : 'Confirm topics'}
              </button>
              <button
                onClick={onDismiss}
                className="px-4 py-2.5 text-sm font-medium text-gray-500 hover:text-gray-700 transition-colors duration-150"
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <span className="text-sm text-green-700 font-medium flex items-center gap-1.5">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                Topics saved!
              </span>
              <button
                onClick={onConfirmed}
                className="px-4 py-2.5 text-sm font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 transition-colors duration-150"
              >
                Done
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── WorkspacePage ─────────────────────────────────────────────────────────────

interface WorkspacePageProps {
  refreshUsage: () => void;
}

export default function WorkspacePage({ refreshUsage }: WorkspacePageProps) {
  const { selectedModel, chunkingModel, selectedRuleSetId } = useSettings();
  const location = useLocation();

  // Documents
  const [documents, setDocuments] = useState<Document[]>([]);
  const [loadingDocs, setLoadingDocs] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [confirmDeleteDocId, setConfirmDeleteDocId] = useState<number | null>(null);
  const [renamingDocId, setRenamingDocId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState('');

  // Sidebar
  const [sidebarTab, setSidebarTab] = useState<'topics' | 'documents'>('topics');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // Topic tree
  const [curriculum, setCurriculum] = useState<CurriculumNode[]>([]);
  const [directCounts, setDirectCounts] = useState<Record<string, TopicCoverageStats>>({});
  const [selectedTopicId, setSelectedTopicId] = useState<number | null>(null);
  const [topicSearch, setTopicSearch] = useState('');
  const [topicEditMode, setTopicEditMode] = useState(false);
  const [confirmDeleteTopicId, setConfirmDeleteTopicId] = useState<number | null>(null);
  const [reassignLoading, setReassignLoading] = useState(false);
  const [reassignPreviewResult, setReassignPreviewResult] = useState<ReassignPreviewResult | null>(null);
  const [reassignPreviewNodeId, setReassignPreviewNodeId] = useState<number | null>(null);
  const [addingRootTopic, setAddingRootTopic] = useState(false);
  const [rootTopicName, setRootTopicName] = useState('');

  // Document selection
  const [selectedDocumentId, setSelectedDocumentId] = useState<number | null>(null);

  // Chunk view
  const [chunkViewDocId, setChunkViewDocId] = useState<number | null>(null);
  const [chunkViewChunks, setChunkViewChunks] = useState<ChunkWithTopic[]>([]);
  const [chunkViewLoading, setChunkViewLoading] = useState(false);
  const [selectedChunkId, setSelectedChunkId] = useState<number | null>(null);
  const chunkRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const pendingChunkId = useRef<number | null>(null);

  // Card refresh
  const [cardsRefreshKey, setCardsRefreshKey] = useState(0);

  // Chunk regen
  const [chunkRegenRunning, setChunkRegenRunning] = useState(false);
  const [chunkRegenProgress, setChunkRegenProgress] = useState<string | null>(null);
  const chunkRegenIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [chunkRegenConfirm, setChunkRegenConfirm] = useState(false);
  const [chunkRegenCost, setChunkRegenCost] = useState<CostEstimate | null>(null);
  const [chunkRegenCostLoading, setChunkRegenCostLoading] = useState(false);

  // Upload → topic confirm flow
  const [pendingUpload, setPendingUpload] = useState<UploadResult | null>(null);

  // Paste modal
  const [showPasteModal, setShowPasteModal] = useState(false);
  const [pastedHtml, setPastedHtml] = useState<string | null>(null);
  const [pasteName, setPasteName] = useState('');
  const [pasting, setPasting] = useState(false);
  const [pasteError, setPasteError] = useState<string | null>(null);
  const pasteAreaRef = useRef<HTMLDivElement>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchDocuments = useCallback(async () => {
    try {
      setDocuments(await getDocuments());
    } catch {
      /* stay stale */
    }
  }, []);

  // Handle navigation from Library: auto-select a document
  useEffect(() => {
    const state = location.state as { goToDocId?: number } | null;
    if (state?.goToDocId) {
      setSidebarTab('documents');
      setSidebarCollapsed(false);
      setSelectedDocumentId(state.goToDocId);
      setSelectedTopicId(null);
      window.history.replaceState({}, '');
    }
  }, [location.state]);

  function refreshCoverage() {
    getCurriculumCoverage().then(setDirectCounts).catch(() => {});
  }

  async function handleAddTopicChild(parentId: number, name: string) {
    await createCurriculumNode({ name, parent_id: parentId });
    const updated = await getCurriculum();
    setCurriculum(updated);
  }

  async function handleRenameTopic(nodeId: number, name: string) {
    await updateCurriculumNode(nodeId, { name });
    const updated = await getCurriculum();
    setCurriculum(updated);
    refreshCoverage();
  }

  function handleDeleteTopicRequest(nodeId: number) {
    setConfirmDeleteTopicId(nodeId);
  }

  async function handleDeleteTopicConfirm() {
    if (confirmDeleteTopicId == null) return;
    const id = confirmDeleteTopicId;
    setConfirmDeleteTopicId(null);
    await deleteCurriculumNode(id);
    if (selectedTopicId === id) setSelectedTopicId(null);
    const updated = await getCurriculum();
    setCurriculum(updated);
    refreshCoverage();
  }

  async function handleReassignTopicsClick() {
    if (selectedTopicId == null) return;
    setReassignLoading(true);
    try {
      const result = await previewReassignTopics(selectedTopicId, chunkingModel);
      setReassignPreviewNodeId(selectedTopicId);
      setReassignPreviewResult(result);
      refreshUsage();
    } finally {
      setReassignLoading(false);
    }
  }

  function handleReassignConfirmed() {
    setReassignPreviewResult(null);
    setReassignPreviewNodeId(null);
    setCardsRefreshKey((k) => k + 1);
    refreshCoverage();
  }

  async function handleAddRootTopic(name: string) {
    await createCurriculumNode({ name, parent_id: null });
    const updated = await getCurriculum();
    setCurriculum(updated);
  }

  useEffect(() => {
    setLoadingDocs(true);
    fetchDocuments().finally(() => setLoadingDocs(false));
    getCurriculum().then(setCurriculum).catch(() => {});
    refreshCoverage();
  }, [fetchDocuments]);

  // Fetch chunks when entering chunk view
  useEffect(() => {
    if (chunkViewDocId == null) {
      setChunkViewChunks([]);
      setSelectedChunkId(null);
      return;
    }
    setChunkViewLoading(true);
    getDocument(chunkViewDocId)
      .then((d) => {
        const chunks = (d.chunks as ChunkWithTopic[]) ?? [];
        setChunkViewChunks(chunks);
        // If a navigation is pending, select + scroll to that chunk
        if (pendingChunkId.current != null) {
          const target = pendingChunkId.current;
          pendingChunkId.current = null;
          setSelectedChunkId(target);
          // Scroll after DOM updates
          setTimeout(() => {
            const el = chunkRefs.current.get(target);
            el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }, 100);
        }
      })
      .catch(console.error)
      .finally(() => setChunkViewLoading(false));
  }, [chunkViewDocId]);

  function openChunkView(docId: number) {
    setSelectedDocumentId(docId);
    setChunkViewDocId(docId);
    setSelectedChunkId(null);
    setSidebarCollapsed(false);
  }

  function closeChunkView() {
    setChunkViewDocId(null);
    setSelectedChunkId(null);
  }

  function handleGoToChunk(docId: number, chunkId: number) {
    setSidebarTab('documents');
    setSidebarCollapsed(false);
    setSelectedTopicId(null);
    if (chunkViewDocId === docId) {
      // Doc already open — select + scroll immediately
      setSelectedChunkId(chunkId);
      setTimeout(() => {
        const el = chunkRefs.current.get(chunkId);
        el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 50);
    } else {
      // Need to load the doc first — store pending and open
      pendingChunkId.current = chunkId;
      openChunkView(docId);
    }
  }

  function handleUploadClick() {
    setUploadError(null);
    fileInputRef.current?.click();
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setUploadError(null);
    setUploading(true);
    try {
      const result = await uploadDocument(file, chunkingModel);
      await fetchDocuments();
      setPendingUpload(result);
      refreshUsage();
    } catch (err: unknown) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed. Please try again.');
    } finally {
      setUploading(false);
    }
  }

  function openPasteModal() {
    setPastedHtml(null);
    setPasteName('');
    setPasteError(null);
    setShowPasteModal(true);
    setTimeout(() => pasteAreaRef.current?.focus(), 50);
  }

  function applyHtml(rawHtml: string, extraImages: { type: string; dataUri: string }[] = []) {
    let finalHtml = rawHtml;
    if (extraImages.length > 0) {
      const parser2 = new DOMParser();
      const doc2 = parser2.parseFromString(rawHtml, 'text/html');
      let imgIdx = 0;
      doc2.querySelectorAll('img').forEach((img) => {
        const src = img.getAttribute('src') || '';
        if (!src.startsWith('data:') && imgIdx < extraImages.length) {
          img.setAttribute('src', extraImages[imgIdx++].dataUri);
        }
      });
      if (imgIdx < extraImages.length) {
        doc2.querySelectorAll('li').forEach((li) => {
          if (imgIdx >= extraImages.length) return;
          const txt = li.textContent?.replace(/[\s\u00a0\u200b]/g, '') ?? '';
          if (txt === '') {
            const imgEl = doc2.createElement('img');
            imgEl.setAttribute('src', extraImages[imgIdx++].dataUri);
            li.appendChild(imgEl);
          }
        });
      }
      finalHtml = doc2.body.innerHTML;
    }
    const parser = new DOMParser();
    const parsed = parser.parseFromString(finalHtml, 'text/html');
    const heading = parsed.querySelector('h1, h2, h3, h4, h5, h6, b, strong');
    const detected = heading?.textContent?.trim() ?? '';
    if (detected && detected.length < 100) {
      setPasteName((prev) => prev || detected);
    }
    setPastedHtml(finalHtml);
  }

  function handlePaste(e: React.ClipboardEvent) {
    e.preventDefault();
    const html = e.clipboardData.getData('text/html');
    const text = e.clipboardData.getData('text/plain');

    // Collect any image/* items from the clipboard
    // Word doesn't embed images in HTML — they're separate clipboard items
    const imageItems: DataTransferItem[] = [];
    for (let i = 0; i < e.clipboardData.items.length; i++) {
      const item = e.clipboardData.items[i];
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        imageItems.push(item);
      }
    }

    if (html && html.trim()) {
      if (imageItems.length > 0) {
        Promise.all(
          imageItems.map(
            (item) =>
              new Promise<{ type: string; dataUri: string }>((resolve) => {
                const file = item.getAsFile();
                if (!file) { resolve({ type: item.type, dataUri: '' }); return; }
                const reader = new FileReader();
                reader.onload = (ev) =>
                  resolve({ type: item.type, dataUri: (ev.target?.result as string) ?? '' });
                reader.readAsDataURL(file);
              })
          )
        ).then((images) => applyHtml(html, images.filter((i) => i.dataUri)));
      } else {
        applyHtml(html);
      }
    } else if (text && text.trim()) {
      const escaped = text
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const wrapped = escaped.split('\n').map((l) => `<p>${l || '&nbsp;'}</p>`).join('\n');
      setPastedHtml(wrapped);
    }
  }

  async function handlePasteButton() {
    try {
      const items = await navigator.clipboard.read();
      let html = '';
      let text = '';
      for (const item of items) {
        if (item.types.includes('text/html')) {
          html = await (await item.getType('text/html')).text();
        }
        if (item.types.includes('text/plain')) {
          text = await (await item.getType('text/plain')).text();
        }
      }
      if (html && html.trim()) {
        applyHtml(html);
      } else if (text && text.trim()) {
        const escaped = text
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const wrapped = escaped.split('\n').map((l) => `<p>${l || '&nbsp;'}</p>`).join('\n');
        setPastedHtml(wrapped);
      }
    } catch {
      // Permission denied or API not supported — user can still use Ctrl+V
    }
  }

  async function handlePasteSubmit() {
    if (!pastedHtml || !pasteName.trim()) return;
    setPasteError(null);
    setPasting(true);
    try {
      const result = await pasteDocument(pastedHtml, pasteName.trim(), chunkingModel);
      await fetchDocuments();
      setShowPasteModal(false);
      setPendingUpload(result);
      refreshUsage();
    } catch (err: unknown) {
      setPasteError(err instanceof Error ? err.message : 'Failed to process pasted content.');
    } finally {
      setPasting(false);
    }
  }

  function startRename(doc: { id: number; original_name: string }) {
    setRenamingDocId(doc.id);
    setRenameValue(doc.original_name);
  }

  async function commitRename() {
    if (renamingDocId == null) return;
    const trimmed = renameValue.trim();
    if (trimmed) {
      await renameDocument(renamingDocId, trimmed);
      await fetchDocuments();
    }
    setRenamingDocId(null);
  }

  async function handleDeleteConfirm() {
    if (confirmDeleteDocId == null) return;
    setDeleteError(null);
    const idToDelete = confirmDeleteDocId;
    setConfirmDeleteDocId(null);
    try {
      await deleteDocument(idToDelete);
      if (selectedDocumentId === idToDelete) setSelectedDocumentId(null);
      if (chunkViewDocId === idToDelete) closeChunkView();
      await fetchDocuments();
    } catch (err: unknown) {
      setDeleteError(err instanceof Error ? err.message : 'Delete failed. Please try again.');
    }
  }

  async function openRegenConfirm() {
    if (!chunkViewDocId || !selectedChunkId) return;
    setChunkRegenCost(null);
    setChunkRegenConfirm(true);
    setChunkRegenCostLoading(true);
    try {
      const rules = await getRuleSets();
      const ruleId =
        rules.find((r) => r.id === selectedRuleSetId)?.id ??
        rules.find((r) => r.is_default)?.id ??
        rules[0]?.id;
      if (!ruleId) return;
      const cost = await estimateCost({
        document_id: chunkViewDocId,
        chunk_ids: [selectedChunkId],
        rule_set_id: ruleId,
        model: selectedModel,
      });
      setChunkRegenCost(cost);
    } catch {
      // cost estimate is informational — still show the modal
    } finally {
      setChunkRegenCostLoading(false);
    }
  }

  async function handleRegenChunk(replaceExisting: boolean) {
    if (!chunkViewDocId || !selectedChunkId) return;
    setChunkRegenConfirm(false);
    setChunkRegenRunning(true);
    setChunkRegenProgress('Starting...');
    try {
      const rules = await getRuleSets();
      const ruleId =
        rules.find((r) => r.id === selectedRuleSetId)?.id ??
        rules.find((r) => r.is_default)?.id ??
        rules[0]?.id;
      if (!ruleId) return;
      const resp = await startGeneration({
        document_id: chunkViewDocId,
        chunk_ids: [selectedChunkId],
        rule_set_id: ruleId,
        model: selectedModel,
        replace_existing: replaceExisting,
      });
      const jobId = resp.job_id;
      if (chunkRegenIntervalRef.current) clearInterval(chunkRegenIntervalRef.current);
      chunkRegenIntervalRef.current = setInterval(async () => {
        const job = await getGenerationJob(jobId);
        setChunkRegenProgress(`${job.processed_chunks}/${job.total_chunks} chunks`);
        if (job.status === 'done' || job.status === 'failed') {
          clearInterval(chunkRegenIntervalRef.current!);
          chunkRegenIntervalRef.current = null;
          setChunkRegenRunning(false);
          setChunkRegenProgress(job.status === 'done' ? 'Done' : 'Failed');
          getDocument(chunkViewDocId).then((d) =>
            setChunkViewChunks((d.chunks as ChunkWithTopic[]) ?? [])
          );
          if (job.status === 'done') {
            setCardsRefreshKey((k) => k + 1);
            refreshUsage();
          }
          setTimeout(() => setChunkRegenProgress(null), 2000);
        }
      }, 1500);
    } catch {
      setChunkRegenRunning(false);
      setChunkRegenProgress('Failed');
      setTimeout(() => setChunkRegenProgress(null), 2000);
    }
  }

  // Flat curriculum for pickers and topic lookup
  const flatCurriculum = useMemo(() => flattenTree(curriculum), [curriculum]);

  // Aggregated card counts for topic tree
  const aggregatedCounts = useMemo(
    () => buildAggregatedCounts(curriculum, directCounts),
    [curriculum, directCounts]
  );

  // Topic path for CardsPanel
  const selectedTopicPath = useMemo(() => {
    if (selectedTopicId == null) return null;
    return flatCurriculum.find((n) => n.id === selectedTopicId)?.path ?? null;
  }, [selectedTopicId, flatCurriculum]);

  // Active document for chunk view display
  const chunkViewDoc = useMemo(
    () => documents.find((d) => d.id === chunkViewDocId) ?? null,
    [documents, chunkViewDocId]
  );

  const isChunkView = chunkViewDocId != null;

  // Cards panel props
  const cardsPanelDocId = sidebarTab === 'documents' ? selectedDocumentId : null;
  const cardsPanelChunkId = sidebarTab === 'documents' ? selectedChunkId : null;
  const cardsPanelTopicPath = sidebarTab === 'topics' ? selectedTopicPath : null;

  const sidebarWidth = sidebarCollapsed ? 'w-10' : isChunkView ? 'w-[440px]' : 'w-64';

  return (
    <>
      <div className="flex h-[calc(100vh-44px)] overflow-hidden">
        {/* ── Sidebar ── */}
        <aside
          className={`bg-white shrink-0 flex flex-col transition-all duration-200 shadow-[1px_0_3px_0_rgba(0,0,0,0.04)] ${sidebarWidth}`}
        >
          {sidebarCollapsed ? (
            /* Collapsed strip */
            <div className="flex flex-col items-center pt-3 gap-3">
              <button
                onClick={() => setSidebarCollapsed(false)}
                title="Expand sidebar"
                className="p-1.5 rounded-lg text-gray-400 hover:text-blue-700 hover:bg-blue-50 transition-colors duration-150"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
              </button>
            </div>
          ) : isChunkView ? (
            /* ── Chunk view mode ── */
            <>
              {/* Chunk view header */}
              <div className="flex items-center gap-2 px-3 py-3 border-b border-gray-200 shrink-0">
                <button
                  onClick={closeChunkView}
                  title="Back to documents"
                  className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-50 transition-colors duration-150 shrink-0"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="h-4 w-4"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                  </svg>
                </button>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-gray-800 truncate leading-tight">
                    {chunkViewDoc?.original_name}
                  </p>
                  <p className="text-[10px] text-gray-400 mt-0.5">
                    {chunkViewDoc?.chunk_count ?? 0} chunks
                  </p>
                </div>
                <button
                  onClick={() => setSidebarCollapsed(true)}
                  title="Collapse sidebar"
                  className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-50 transition-colors duration-150 shrink-0"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="h-4 w-4"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                  </svg>
                </button>
              </div>

              {/* "All" / regen bar */}
              <div className="px-3 py-2.5 border-b border-gray-200 shrink-0 flex items-center gap-2">
                <button
                  onClick={() => setSelectedChunkId(null)}
                  className={[
                    'flex-1 text-left px-3 py-2 rounded-lg text-xs font-medium transition-colors duration-150',
                    selectedChunkId === null
                      ? 'bg-blue-50 text-blue-700'
                      : 'text-gray-600 hover:bg-gray-50',
                  ].join(' ')}
                >
                  All chunks ({chunkViewChunks.length})
                </button>
                {selectedChunkId != null && (
                  <button
                    onClick={openRegenConfirm}
                    disabled={chunkRegenRunning}
                    title="Regenerate cards for this chunk"
                    className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-amber-700 bg-amber-50 rounded-lg hover:bg-amber-100 disabled:opacity-50 transition-colors duration-150 shrink-0"
                  >
                    {chunkRegenRunning ? (
                      <svg
                        className="animate-spin h-3 w-3"
                        xmlns="http://www.w3.org/2000/svg"
                        fill="none"
                        viewBox="0 0 24 24"
                      >
                        <circle
                          className="opacity-25"
                          cx="12"
                          cy="12"
                          r="10"
                          stroke="currentColor"
                          strokeWidth="4"
                        />
                        <path
                          className="opacity-75"
                          fill="currentColor"
                          d="M4 12a8 8 0 018-8v8H4z"
                        />
                      </svg>
                    ) : (
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        className="h-3 w-3"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                        />
                      </svg>
                    )}
                    {chunkRegenProgress ?? 'Regen chunk'}
                  </button>
                )}
              </div>

              {/* Chunks list */}
              <div className="flex-1 overflow-y-auto">
                {chunkViewLoading ? (
                  <div className="flex items-center justify-center h-20 text-sm text-gray-400">
                    Loading...
                  </div>
                ) : (
                  <div className="p-3 space-y-2">
                    {chunkViewChunks.map((chunk, idx) => {
                      const isSelected = chunk.id === selectedChunkId;
                      const hasCards = chunk.card_count > 0;
                      return (
                        <div
                          key={chunk.id}
                          ref={(el) => {
                            if (el) chunkRefs.current.set(chunk.id, el);
                            else chunkRefs.current.delete(chunk.id);
                          }}
                          onClick={() => {
                            setSelectedChunkId(chunk.id);
                            const el = chunkRefs.current.get(chunk.id);
                            el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                          }}
                          className={[
                            'relative rounded-lg border-l-[3px] p-3 cursor-pointer transition-all duration-150',
                            isSelected
                              ? 'bg-amber-50/80 border-l-amber-400 shadow-sm'
                              : hasCards
                                ? 'bg-white border-l-green-400 hover:bg-gray-50/80'
                                : 'bg-red-50/30 border-l-red-300 hover:bg-red-50/50',
                          ].join(' ')}
                        >
                          {/* Topic path badge */}
                          {chunk.topic_path && (
                            <p
                              title={chunk.topic_path}
                              className="text-[9px] font-medium text-blue-600 mb-1 truncate bg-blue-50 rounded-full px-2 py-0.5 inline-block max-w-full"
                            >
                              {chunk.topic_path.split(' > ').slice(-2).join(' › ')}
                            </p>
                          )}

                          {/* Card count badge */}
                          <span
                            className={[
                              'absolute top-2.5 right-2.5 text-[9px] font-semibold px-1.5 py-0.5 rounded-full shrink-0',
                              hasCards
                                ? 'bg-green-50 text-green-700'
                                : 'bg-red-50 text-red-500',
                            ].join(' ')}
                          >
                            {hasCards ? `${chunk.card_count}c` : '0'}
                          </span>

                          <p className="text-[10px] text-gray-400 mb-1 font-medium">#{idx + 1}</p>

                          <div
                            className="chunk-content pr-8 overflow-hidden"
                            style={{ maxHeight: isSelected ? 'none' : '120px' }}
                            dangerouslySetInnerHTML={{ __html: chunk.source_html }}
                          />

                          {!isSelected && (
                            <div className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-white/90 to-transparent rounded-b-lg pointer-events-none" />
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          ) : (
            /* ── Normal sidebar (tabs) ── */
            <>
              {/* Tab header — pill toggle style */}
              <div className="flex items-center gap-1 px-3 py-3 border-b border-gray-200 shrink-0">
                <div className="flex items-center gap-0.5 rounded-lg bg-gray-100/80 p-0.5 flex-1">
                  <button
                    onClick={() => setSidebarTab('topics')}
                    className={[
                      'flex-1 py-1.5 text-xs font-medium rounded-md transition-colors duration-150 text-center',
                      sidebarTab === 'topics'
                        ? 'bg-white text-blue-700 shadow-sm'
                        : 'text-gray-600 hover:text-gray-700',
                    ].join(' ')}
                  >
                    Topics
                  </button>
                  <button
                    onClick={() => setSidebarTab('documents')}
                    className={[
                      'flex-1 py-1.5 text-xs font-medium rounded-md transition-colors duration-150 text-center',
                      sidebarTab === 'documents'
                        ? 'bg-white text-blue-700 shadow-sm'
                        : 'text-gray-600 hover:text-gray-700',
                    ].join(' ')}
                  >
                    Documents
                  </button>
                </div>
                <button
                  onClick={() => setSidebarCollapsed(true)}
                  title="Collapse sidebar"
                  className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-50 transition-colors duration-150 shrink-0"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="h-3.5 w-3.5"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                  </svg>
                </button>
              </div>

              {sidebarTab === 'topics' ? (
                /* Topics tab */
                <div className="flex flex-col flex-1 overflow-hidden">
                  {/* Search input + edit toolbar */}
                  <div className="px-3 pt-2.5 pb-1.5 shrink-0 flex flex-col gap-1.5">
                    <div className="relative">
                      <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-gray-400 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                      </svg>
                      <input
                        className="w-full pl-7 pr-6 py-1.5 text-xs border border-gray-200 rounded-lg bg-gray-50 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent focus:bg-white transition-colors duration-150"
                        placeholder="Search topics..."
                        value={topicSearch}
                        onChange={(e) => setTopicSearch(e.target.value)}
                      />
                      {topicSearch && (
                        <button onClick={() => setTopicSearch('')} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => setTopicEditMode(v => !v)}
                        title={topicEditMode ? 'Exit edit mode' : 'Edit topics'}
                        className={`flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded-lg border transition-colors duration-150 ${topicEditMode ? 'bg-amber-50 text-amber-700 border-amber-300 hover:bg-amber-100' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536M9 13l6.586-6.586a2 2 0 112.828 2.828L11.828 15.828a2 2 0 01-1.414.586H8v-2.414a2 2 0 01.586-1.414z" />
                        </svg>
                        {topicEditMode ? 'Done' : 'Edit'}
                      </button>
                      {selectedTopicId != null && (
                        <button
                          onClick={handleReassignTopicsClick}
                          disabled={reassignLoading}
                          title="Re-run AI topic detection for cards under this topic"
                          className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded-lg border bg-white text-gray-600 border-gray-200 hover:bg-blue-50 hover:text-blue-700 hover:border-blue-300 disabled:opacity-50 transition-colors duration-150"
                        >
                          {reassignLoading ? (
                            <svg className="animate-spin h-3 w-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                            </svg>
                          ) : (
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
                            </svg>
                          )}
                          Reassign
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="flex-1 overflow-y-auto py-1">
                    {curriculum.length === 0 ? (
                      <div className="flex flex-col items-center justify-center h-24 gap-2 px-4 text-center">
                        <p className="text-xs text-gray-400">No curriculum topics loaded.</p>
                      </div>
                    ) : topicSearch.trim() ? (
                      /* Flat search results */
                      (() => {
                        const results = flatCurriculum.filter((n) =>
                          n.name.toLowerCase().includes(topicSearch.toLowerCase())
                        );
                        return results.length === 0 ? (
                          <p className="text-xs text-gray-400 italic px-3 py-2">No matches</p>
                        ) : (
                          results.map((node) => {
                            const stats = aggregatedCounts[String(node.id)];
                            const active = stats?.active ?? 0;
                            const unreviewed = stats?.unreviewed ?? 0;
                            const reviewed = active - unreviewed;
                            const isSelected = node.id === selectedTopicId;
                            const style = topicReviewStyle(active, unreviewed, isSelected);
                            return (
                              <div
                                key={node.id}
                                onClick={() => {
                                  setSelectedTopicId(node.id);
                                  setSelectedDocumentId(null);
                                  setChunkViewDocId(null);
                                }}
                                className={`flex items-center justify-between px-3 py-1.5 mx-1 rounded-lg cursor-pointer text-xs font-medium transition-colors duration-150 ${isSelected ? 'bg-blue-50' : 'hover:bg-gray-50'} ${style.text}`}
                                title={node.path}
                              >
                                <span className="truncate">{node.name}</span>
                                {active > 0 && (
                                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full shrink-0 ml-1.5 font-semibold tabular-nums ${style.badge}`}>
                                    {reviewed}/{active}
                                  </span>
                                )}
                              </div>
                            );
                          })
                        );
                      })()
                    ) : (
                      /* Normal tree */
                      curriculum.map((node) => (
                        <TopicNode
                          key={node.id}
                          node={node}
                          depth={0}
                          onSelect={(id) => {
                            setSelectedTopicId(id);
                            setSelectedDocumentId(null);
                            setChunkViewDocId(null);
                            setSidebarTab('topics');
                          }}
                          selectedId={selectedTopicId}
                          cardCounts={aggregatedCounts}
                          editMode={topicEditMode}
                          onAddChild={handleAddTopicChild}
                          onRename={handleRenameTopic}
                          onDelete={handleDeleteTopicRequest}
                        />
                      ))
                    )}
                    {/* Add root-level topic */}
                    {topicEditMode && (
                      <div className="px-2 py-1.5 mt-1">
                        {addingRootTopic ? (
                          <input
                            autoFocus
                            value={rootTopicName}
                            onChange={(e) => setRootTopicName(e.target.value)}
                            onBlur={() => { setAddingRootTopic(false); setRootTopicName(''); }}
                            onKeyDown={async (e) => {
                              if (e.key === 'Enter' && rootTopicName.trim()) {
                                e.preventDefault();
                                await handleAddRootTopic(rootTopicName.trim());
                                setAddingRootTopic(false);
                                setRootTopicName('');
                              }
                              if (e.key === 'Escape') { setAddingRootTopic(false); setRootTopicName(''); }
                            }}
                            placeholder="New topic name..."
                            className="w-full text-xs border border-blue-300 rounded px-2 py-1 outline-none focus:ring-1 focus:ring-blue-400 bg-blue-50/50"
                          />
                        ) : (
                          <button
                            onMouseDown={(e) => { e.preventDefault(); setAddingRootTopic(true); setRootTopicName(''); }}
                            className="flex items-center gap-1 w-full px-2 py-1 text-xs text-gray-400 hover:text-blue-600 rounded-lg hover:bg-blue-50 transition-colors duration-150"
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                            </svg>
                            Add topic
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                /* Documents tab */
                <>
                  {/* Upload header */}
                  <div className="px-3 pt-3 pb-2 border-b border-gray-200 shrink-0">
                    <h2 className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2 px-1">
                      Documents
                    </h2>
                    <div className="flex gap-1.5">
                      <button
                        onClick={openPasteModal}
                        disabled={uploading}
                        className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 text-xs font-medium text-gray-700 rounded-lg border border-gray-300 hover:bg-gray-50 disabled:opacity-60 disabled:cursor-not-allowed transition-colors duration-150"
                      >
                        Paste
                      </button>
                      <button
                        onClick={handleUploadClick}
                        disabled={uploading}
                        className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs font-medium text-white rounded-lg bg-blue-700 hover:bg-blue-800 disabled:opacity-60 disabled:cursor-not-allowed transition-colors duration-150"
                      >
                        {uploading ? (
                          <>
                            <svg
                              className="animate-spin h-3 w-3"
                              xmlns="http://www.w3.org/2000/svg"
                              fill="none"
                              viewBox="0 0 24 24"
                            >
                              <circle
                                className="opacity-25"
                                cx="12"
                                cy="12"
                                r="10"
                                stroke="currentColor"
                                strokeWidth="4"
                              />
                              <path
                                className="opacity-75"
                                fill="currentColor"
                                d="M4 12a8 8 0 018-8v8H4z"
                              />
                            </svg>
                            Uploading...
                          </>
                        ) : (
                          'Upload .docx'
                        )}
                      </button>
                    </div>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".docx"
                      className="hidden"
                      onChange={handleFileChange}
                    />
                  </div>

                  {/* Errors */}
                  {uploadError && (
                    <div className="mx-3 mt-2.5 px-3 py-2 text-xs text-red-700 bg-red-50 rounded-lg">
                      {uploadError}
                    </div>
                  )}
                  {deleteError && (
                    <div className="mx-3 mt-2.5 px-3 py-2 text-xs text-red-700 bg-red-50 rounded-lg">
                      {deleteError}
                    </div>
                  )}

                  {/* Document list */}
                  <div className="flex-1 overflow-y-auto py-1">
                    {loadingDocs ? (
                      <div className="flex items-center justify-center h-20 text-sm text-gray-400">
                        Loading...
                      </div>
                    ) : documents.length === 0 ? (
                      <div className="flex flex-col items-center justify-center h-32 gap-3 px-6 text-center">
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          className="h-10 w-10 text-gray-200"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          strokeWidth={1.2}
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                          />
                        </svg>
                        <p className="text-xs text-gray-400 leading-relaxed">
                          No documents yet. Upload a .docx to get started.
                        </p>
                      </div>
                    ) : (
                      documents.map((doc) => {
                        const isSelected = doc.id === selectedDocumentId;
                        return (
                          <div
                            key={doc.id}
                            onClick={() => {
                              setSelectedDocumentId(doc.id);
                              setSelectedTopicId(null);
                            }}
                            className={[
                              'group relative px-3 pt-2 pb-3 cursor-pointer transition-colors duration-150 border-b border-gray-100',
                              isSelected
                                ? 'bg-blue-50 border-l-2 border-l-blue-600'
                                : 'border-l-2 border-l-transparent hover:bg-gray-50',
                            ].join(' ')}
                          >
                            {/* Top-right: rename + delete */}
                            <div className="absolute top-1.5 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
                              <button
                                onClick={(e) => { e.stopPropagation(); startRename(doc); }}
                                title="Rename document"
                                className="p-0.5 text-gray-300 hover:text-blue-500 transition-colors duration-150"
                              >
                                <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536M9 13l6.586-6.586a2 2 0 112.828 2.828L11.828 15.828A2 2 0 0110 16.414H8v-2a2 2 0 01.586-1.414z" />
                                </svg>
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); setConfirmDeleteDocId(doc.id); }}
                                title="Delete document"
                                className="p-0.5 text-gray-300 hover:text-red-500 transition-colors duration-150"
                              >
                                <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M9 7h6m-7 0a1 1 0 01-1-1V5a1 1 0 011-1h6a1 1 0 011 1v1a1 1 0 01-1 1H9z" />
                                </svg>
                              </button>
                            </div>

                            {/* Main content */}
                            <div className="pr-12 min-w-0">
                              {renamingDocId === doc.id ? (
                                <input
                                  autoFocus
                                  value={renameValue}
                                  onChange={(e) => setRenameValue(e.target.value)}
                                  onBlur={commitRename}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') commitRename();
                                    if (e.key === 'Escape') setRenamingDocId(null);
                                  }}
                                  onClick={(e) => e.stopPropagation()}
                                  className="w-full text-xs text-gray-800 font-medium leading-tight border border-blue-400 rounded px-1 py-0.5 outline-none focus:ring-1 focus:ring-blue-400"
                                />
                              ) : (
                                <p className="text-xs text-gray-800 font-medium truncate leading-tight">
                                  {doc.original_name}
                                </p>
                              )}
                              <p className="text-[10px] text-gray-400 mt-0.5 flex items-center gap-1.5">
                                <span>{doc.chunk_count} chunk{doc.chunk_count !== 1 ? 's' : ''} · {doc.total_cards ?? 0} card{(doc.total_cards ?? 0) !== 1 ? 's' : ''}</span>
                                {(doc.total_cards ?? 0) > 0 && (
                                  doc.unreviewed_cards === 0
                                    ? <span className="text-green-500 font-semibold" title="All reviewed">✓</span>
                                    : <span className="text-gray-400 tabular-nums" title={`${doc.unreviewed_cards} unreviewed`}>{doc.unreviewed_cards} left</span>
                                )}
                              </p>
                              <p className="text-[10px] text-gray-400 mt-0.5">
                                {doc.filename.startsWith('paste_') ? 'Paste' : 'Doc'} · {new Date(doc.uploaded_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                              </p>
                            </div>

                            {/* Bottom-right: open chunks */}
                            <button
                              onClick={(e) => { e.stopPropagation(); openChunkView(doc.id); }}
                              title="Browse chunks"
                              className="absolute bottom-7 right-2 flex items-center gap-1 text-xs font-medium text-gray-400 hover:text-blue-600 transition-colors duration-150"
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h7" />
                              </svg>
                              <span>chunks</span>
                            </button>
                          </div>
                        );
                      })
                    )}
                  </div>
                </>
              )}
            </>
          )}
        </aside>

        {/* ── Right panel — Cards ── */}
        <CardsPanel
          documentId={cardsPanelDocId}
          chunkId={cardsPanelChunkId}
          topicPath={cardsPanelTopicPath}
          refreshKey={cardsRefreshKey}
          refreshUsage={refreshUsage}
          onReviewChange={() => { refreshCoverage(); fetchDocuments(); }}
          onGoToChunk={handleGoToChunk}
        />
      </div>

      {/* Delete document confirm */}
      {confirmDeleteDocId != null && (
        <ConfirmModal
          title="Delete document?"
          message="This will permanently delete the document and all its cards. This cannot be undone."
          confirmLabel="Delete"
          onConfirm={handleDeleteConfirm}
          onCancel={() => setConfirmDeleteDocId(null)}
        />
      )}

      {/* Delete topic confirm */}
      {reassignPreviewResult != null && reassignPreviewNodeId != null && (
        <ReassignReviewScreen
          nodeId={reassignPreviewNodeId}
          nodeName={flatCurriculum.find(n => n.id === reassignPreviewNodeId)?.name ?? ''}
          previewResult={reassignPreviewResult}
          flatCurriculum={flatCurriculum}
          onConfirmed={handleReassignConfirmed}
          onDismiss={() => { setReassignPreviewResult(null); setReassignPreviewNodeId(null); }}
          refreshUsage={refreshUsage}
        />
      )}

      {confirmDeleteTopicId != null && (() => {
        const node = flatCurriculum.find(n => n.id === confirmDeleteTopicId);
        const stats = aggregatedCounts[String(confirmDeleteTopicId)];
        const cardCount = stats?.active ?? 0;
        return (
          <ConfirmModal
            title="Delete topic?"
            message={cardCount > 0
              ? `"${node?.name}" has ${cardCount} active card(s). Deleting it will reassign those cards to the parent topic.`
              : `Delete "${node?.name}"? This cannot be undone.`}
            confirmLabel="Delete"
            onConfirm={handleDeleteTopicConfirm}
            onCancel={() => setConfirmDeleteTopicId(null)}
          />
        );
      })()}

      {/* Chunk regen choice modal */}
      {chunkRegenConfirm && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-lg w-full max-w-sm mx-4 p-6">
            <h3 className="text-base font-semibold text-gray-900 mb-2">Regenerate chunk</h3>
            <p className="text-sm text-gray-500 mb-4 leading-relaxed">
              What should happen to the existing cards for this chunk?
            </p>

            <div className="mb-5 px-4 py-3 rounded-xl bg-gray-50 text-xs">
              {chunkRegenCostLoading ? (
                <span className="text-gray-400">Calculating cost...</span>
              ) : chunkRegenCost ? (
                <div className="flex flex-col items-center gap-0.5">
                  <span className="font-semibold text-gray-800 text-sm">
                    ~${chunkRegenCost.estimated_cost_usd.toFixed(4)}
                  </span>
                  <span className="text-gray-500">
                    {chunkRegenCost.estimated_input_tokens.toLocaleString()} in /{' '}
                    {chunkRegenCost.estimated_output_tokens.toLocaleString()} out
                  </span>
                </div>
              ) : (
                <span className="text-gray-400">Cost estimate unavailable</span>
              )}
            </div>

            <div className="flex flex-col gap-2">
              <button
                onClick={() => handleRegenChunk(true)}
                className="w-full px-4 py-2.5 text-sm font-medium text-white bg-amber-500 rounded-lg hover:bg-amber-600 transition-colors duration-150"
              >
                Replace -- delete old cards, generate fresh
              </button>
              <button
                onClick={() => handleRegenChunk(false)}
                className="w-full px-4 py-2.5 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors duration-150"
              >
                Add -- keep old cards, append new ones
              </button>
              <button
                onClick={() => {
                  setChunkRegenConfirm(false);
                  setChunkRegenCost(null);
                }}
                className="w-full px-4 py-1.5 text-sm text-gray-400 hover:text-gray-600 transition-colors duration-150"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Paste modal */}
      {showPasteModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-2xl w-[900px] max-h-[90vh] flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 shrink-0">
              <div>
                <h2 className="text-sm font-semibold text-gray-900">Paste content</h2>
                <p className="text-xs text-gray-500 mt-0.5">Preserves bold, bullets, tables, and images from Word or Google Docs</p>
              </div>
              <button
                onClick={() => setShowPasteModal(false)}
                className="text-gray-400 hover:text-gray-600 transition-colors"
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Body */}
            <div className="flex flex-col gap-4 px-5 py-4 overflow-y-auto flex-1">
              {/* Name */}
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Document name</label>
                <input
                  type="text"
                  value={pasteName}
                  onChange={(e) => setPasteName(e.target.value)}
                  placeholder="Auto-detected from content, or type a name..."
                  className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              {/* Paste area or preview */}
              {!pastedHtml ? (
                <div
                  ref={pasteAreaRef}
                  tabIndex={0}
                  onPaste={handlePaste}
                  className="border-2 border-dashed border-gray-300 rounded-lg p-10 text-center cursor-text focus:outline-none focus:border-blue-400 transition-colors flex-1"
                  style={{ minHeight: '320px' }}
                >
                  <svg className="mx-auto h-8 w-8 text-gray-300 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  <p className="text-sm font-medium text-gray-500">Click here, then paste</p>
                  <p className="text-xs text-gray-400 mt-1">Cmd+V / Ctrl+V — copies from Word, Google Docs, web pages</p>
                  <button
                    onClick={(e) => { e.stopPropagation(); handlePasteButton(); }}
                    className="mt-3 px-4 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors"
                  >
                    Paste
                  </button>
                </div>
              ) : (
                <div className="border border-gray-200 rounded-lg overflow-hidden flex-1 flex flex-col">
                  <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-b border-gray-200 shrink-0">
                    <span className="text-xs font-medium text-gray-600">Preview</span>
                    <button
                      onClick={() => setPastedHtml(null)}
                      className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
                    >
                      Clear &amp; paste again
                    </button>
                  </div>
                  <div
                    className="p-4 overflow-y-auto text-sm chunk-content flex-1"
                    style={{ minHeight: '320px' }}
                    dangerouslySetInnerHTML={{ __html: pastedHtml }}
                  />
                </div>
              )}

              {pasteError && (
                <div className="px-3 py-2 text-xs text-red-700 bg-red-50 rounded-lg">{pasteError}</div>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between gap-2 px-5 py-4 border-t border-gray-200 shrink-0">
              {/* Left: context-sensitive Paste / Clear button */}
              <div>
                {!pastedHtml ? (
                  <button
                    onClick={handlePasteButton}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                    </svg>
                    Paste
                  </button>
                ) : (
                  <button
                    onClick={() => setPastedHtml(null)}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                    Clear
                  </button>
                )}
              </div>
              {/* Right: Cancel + Process */}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowPasteModal(false)}
                  className="px-3 py-1.5 text-xs font-medium text-gray-600 hover:text-gray-800 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handlePasteSubmit}
                  disabled={!pastedHtml || !pasteName.trim() || pasting}
                  className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium text-white rounded-lg bg-blue-700 hover:bg-blue-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {pasting ? (
                    <>
                      <svg className="animate-spin h-3 w-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                      </svg>
                      Processing...
                    </>
                  ) : (
                    'Process & chunk'
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Topic confirm screen (post-upload) */}
      {pendingUpload != null && (
        <TopicConfirmScreen
          uploadResult={pendingUpload}
          flatCurriculum={flatCurriculum}
          onConfirmed={() => {
            setPendingUpload(null);
            // Switch to documents tab and select the uploaded doc
            setSidebarTab('documents');
            setSelectedDocumentId(pendingUpload.id);
            setCardsRefreshKey((k) => k + 1);
          }}
          onDismiss={() => setPendingUpload(null)}
          refreshUsage={refreshUsage}
          refreshCards={() => setCardsRefreshKey((k) => k + 1)}
        />
      )}
    </>
  );
}
