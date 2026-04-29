import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import ConfirmModal from '../components/ConfirmModal';
import ProcessesFlow from '../components/ProcessesFlow';
import { flattenTree, buildAggregatedCounts } from '../utils';
import {
  getCurriculum,
  getCurriculumCoverage,
  createCurriculumNode,
  updateCurriculumNode,
  deleteCurriculumNode,
  getRuleSets,
  createRuleSet,
  updateRuleSet,
  deleteRuleSet,
  setDefaultRuleSet,
  exportCardsUrl,
  getDocuments,
} from '../api';
import type { CurriculumNode, RuleSet, TopicCoverageStats, Document } from '../types';

// ─── CurriculumTreeNode (editable, for Curriculum tab) ────────────────────────

interface TreeNodeProps {
  node: CurriculumNode;
  selectedId: number | null;
  onSelect: (node: CurriculumNode) => void;
  onRefresh: () => void;
  onDeselect: (id: number) => void;
  onDeleteRequest: (id: number, name: string) => void;
  defaultOpen?: boolean;
}

function CurriculumTreeNode({
  node,
  selectedId,
  onSelect,
  onRefresh,
  onDeselect,
  onDeleteRequest,
  defaultOpen = false,
}: TreeNodeProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(node.name);
  const [addingChild, setAddingChild] = useState(false);
  const [childName, setChildName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const isSelected = node.id === selectedId;
  const hasChildren = node.children.length > 0;

  async function handleRename() {
    if (!renameValue.trim()) return;
    try {
      await updateCurriculumNode(node.id, { name: renameValue.trim() });
      setRenaming(false);
      onRefresh();
    } catch {
      setError('Rename failed');
    }
  }

  function handleDelete() {
    onDeleteRequest(node.id, node.name);
  }

  async function handleAddChild() {
    if (!childName.trim()) return;
    try {
      await createCurriculumNode({ name: childName.trim(), parent_id: node.id });
      setChildName('');
      setAddingChild(false);
      onRefresh();
    } catch {
      setError('Add child failed');
    }
  }

  // Suppress unused warning
  void onDeselect;

  return (
    <div>
      <div
        className={[
          'group flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg cursor-pointer text-sm transition-colors duration-150',
          isSelected ? 'bg-blue-50 text-blue-800' : 'hover:bg-gray-50 text-gray-700',
        ].join(' ')}
        onClick={() => onSelect(node)}
      >
        <button
          className="shrink-0 w-4 h-4 flex items-center justify-center text-gray-400 hover:text-gray-600 rounded transition-colors duration-150"
          onClick={(e) => {
            e.stopPropagation();
            if (hasChildren) setOpen((v) => !v);
          }}
        >
          {hasChildren ? (
            <svg
              className={`w-3 h-3 transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2.5}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          ) : (
            <span className="w-3 h-3 block" />
          )}
        </button>

        {renaming ? (
          <input
            autoFocus
            className="flex-1 border border-gray-200 rounded-lg px-2 py-0.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-600 transition-colors duration-150"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRename();
              if (e.key === 'Escape') {
                setRenaming(false);
                setRenameValue(node.name);
              }
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="flex-1 truncate text-xs leading-tight font-medium">{node.name}</span>
        )}

        {renaming ? (
          <>
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleRename();
              }}
              className="text-xs text-green-600 hover:text-green-800 px-1 font-medium shrink-0"
            >
              OK
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                setRenaming(false);
                setRenameValue(node.name);
              }}
              className="text-xs text-gray-400 hover:text-gray-600 px-0.5 shrink-0"
            >
              x
            </button>
          </>
        ) : (
          <span className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 shrink-0 transition-opacity duration-150">
            <button
              title="Add child"
              onClick={(e) => {
                e.stopPropagation();
                setAddingChild((v) => !v);
              }}
              className="p-0.5 text-xs text-blue-600 hover:text-blue-800 rounded leading-none"
            >
              +
            </button>
            <button
              title="Rename"
              onClick={(e) => {
                e.stopPropagation();
                setRenaming(true);
              }}
              className="p-0.5 text-xs text-gray-400 hover:text-gray-600 rounded leading-none"
            >
              ✎
            </button>
            <button
              title="Delete"
              onClick={(e) => {
                e.stopPropagation();
                handleDelete();
              }}
              className="p-0.5 text-xs text-red-400 hover:text-red-600 rounded leading-none"
            >
              x
            </button>
          </span>
        )}
      </div>

      {error && <p className="text-red-500 text-xs pl-6 mt-0.5">{error}</p>}

      {addingChild && (
        <div className="pl-8 flex items-center gap-1 mt-1 mb-1">
          <input
            autoFocus
            className="border border-gray-200 rounded-lg px-2 py-0.5 text-xs flex-1 focus:outline-none focus:ring-2 focus:ring-blue-600 transition-colors duration-150"
            placeholder="Child name"
            value={childName}
            onChange={(e) => setChildName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAddChild();
              if (e.key === 'Escape') {
                setAddingChild(false);
                setChildName('');
              }
            }}
          />
          <button onClick={handleAddChild} className="text-xs text-green-600 hover:text-green-800 font-medium">
            OK
          </button>
          <button
            onClick={() => {
              setAddingChild(false);
              setChildName('');
            }}
            className="text-xs text-gray-400 hover:text-gray-600"
          >
            x
          </button>
        </div>
      )}

      {open && hasChildren && (
        <div className="pl-3 border-l border-gray-200 ml-3">
          {node.children.map((child) => (
            <CurriculumTreeNode
              key={child.id}
              node={child}
              selectedId={selectedId}
              onSelect={onSelect}
              onRefresh={onRefresh}
              onDeselect={onDeselect}
              onDeleteRequest={onDeleteRequest}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── CoverageNode (read-only, with card count badges) ─────────────────────────

interface CoverageNodeProps {
  node: CurriculumNode;
  depth: number;
  cardCounts: Record<string, TopicCoverageStats>;
}

function CoverageNode({ node, depth, cardCounts }: CoverageNodeProps) {
  const [expanded, setExpanded] = useState(false);
  const stats = cardCounts[String(node.id)] ?? { total: 0, active: 0, rejected: 0, unreviewed: 0 };
  const hasCards = stats.total > 0;

  return (
    <div>
      <div
        className="flex items-center gap-1.5 py-1.5 rounded-lg mx-1 transition-colors duration-150 hover:bg-gray-50"
        style={{ paddingLeft: `${10 + depth * 14}px`, paddingRight: '8px' }}
      >
        {node.children.length > 0 ? (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="shrink-0 text-gray-400 hover:text-gray-600 transition-colors duration-150"
          >
            <svg
              className={`h-3 w-3 transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2.5}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <span className={`flex-1 text-xs truncate font-medium ${hasCards ? 'text-gray-800' : 'text-gray-400'}`}>
          {node.name}
        </span>
        <div className="flex items-center gap-1 shrink-0">
          {/* Total / active */}
          <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold tabular-nums ${
            hasCards ? 'bg-green-50 text-green-700' : 'bg-gray-50 text-gray-400'
          }`}>
            {stats.total}
          </span>
          {/* Unreviewed — amber, only if > 0 */}
          {stats.unreviewed > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full font-semibold tabular-nums bg-amber-50 text-amber-700" title="Unreviewed">
              ●{stats.unreviewed}
            </span>
          )}
          {/* Rejected — red, only if > 0 */}
          {stats.rejected > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full font-semibold tabular-nums bg-red-50 text-red-600" title="Rejected">
              ✕{stats.rejected}
            </span>
          )}
        </div>
      </div>
      {expanded &&
        node.children.map((child) => (
          <CoverageNode key={child.id} node={child} depth={depth + 1} cardCounts={cardCounts} />
        ))}
    </div>
  );
}

// ─── SelectableCoverageNode (clickable, for Documents tab) ────────────────────

interface SelectableCoverageNodeProps {
  node: CurriculumNode;
  depth: number;
  cardCounts: Record<string, TopicCoverageStats>;
  selectedId: number | null;
  onSelect: (id: number) => void;
}

function SelectableCoverageNode({ node, depth, cardCounts, selectedId, onSelect }: SelectableCoverageNodeProps) {
  const [expanded, setExpanded] = useState(false);
  const stats = cardCounts[String(node.id)] ?? { total: 0, active: 0, rejected: 0, unreviewed: 0 };
  const hasCards = stats.total > 0;
  const isSelected = node.id === selectedId;

  return (
    <div>
      <div
        onClick={() => onSelect(node.id)}
        className={`flex items-center gap-1.5 py-1.5 rounded-lg mx-1 cursor-pointer transition-colors duration-150 ${isSelected ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
        style={{ paddingLeft: `${10 + depth * 14}px`, paddingRight: '8px' }}
      >
        {node.children.length > 0 ? (
          <button onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }} className="shrink-0 text-gray-400 hover:text-gray-600">
            <svg className={`h-3 w-3 transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <span className={`flex-1 text-xs truncate font-medium ${isSelected ? 'text-blue-700' : hasCards ? 'text-gray-800' : 'text-gray-400'}`}>
          {node.name}
        </span>
        {hasCards && (
          <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold tabular-nums shrink-0 ${isSelected ? 'bg-blue-100 text-blue-700' : 'bg-green-50 text-green-700'}`}>
            {stats.total}
          </span>
        )}
      </div>
      {expanded && node.children.map((child) => (
        <SelectableCoverageNode key={child.id} node={child} depth={depth + 1} cardCounts={cardCounts} selectedId={selectedId} onSelect={onSelect} />
      ))}
    </div>
  );
}

// ─── RuleSetModal ─────────────────────────────────────────────────────────────

interface RuleSetModalProps {
  initialName?: string;
  initialContent?: string;
  initialIsDefault?: boolean;
  title: string;
  onSave: (name: string, content: string, isDefault: boolean) => Promise<void>;
  onClose: () => void;
}

function RuleSetModal({
  initialName = '',
  initialContent = '',
  initialIsDefault = false,
  title,
  onSave,
  onClose,
}: RuleSetModalProps) {
  const [name, setName] = useState(initialName);
  const [content, setContent] = useState(initialContent);
  const [isDefault, setIsDefault] = useState(initialIsDefault);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  async function handleSave() {
    if (!name.trim()) { setError('Name is required'); return; }
    setSaving(true);
    try {
      await onSave(name.trim(), content, isDefault);
      onClose();
    } catch {
      setError('Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" aria-modal="true" role="dialog">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-3xl mx-4 flex flex-col" style={{ maxHeight: '90vh' }}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 shrink-0">
          <h2 className="text-base font-semibold text-gray-900">{title}</h2>
          <button
            onClick={onClose}
            className="p-1.5 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-50 transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        {/* Body */}
        <div className="flex flex-col gap-4 px-6 py-5 overflow-y-auto flex-1">
          {error && <p className="text-red-500 text-xs">{error}</p>}
          <input
            autoFocus
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent transition-colors"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Rule set name"
          />
          <textarea
            className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent transition-colors resize-none flex-1"
            style={{ minHeight: '400px' }}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Rule set content..."
          />
          <label className="flex items-center gap-2 text-xs cursor-pointer text-gray-600 font-medium">
            <input
              type="checkbox"
              checked={isDefault}
              onChange={(e) => setIsDefault(e.target.checked)}
              className="rounded border-gray-300 text-blue-700 focus:ring-blue-500"
            />
            Set as default rule set
          </label>
        </div>
        {/* Footer */}
        <div className="flex justify-end gap-2.5 px-6 py-4 border-t border-gray-200 shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors disabled:opacity-60"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── NewRuleSetForm ───────────────────────────────────────────────────────────


// ─── LibraryPage ──────────────────────────────────────────────────────────────

type LibraryTab = 'curriculum' | 'rules' | 'coverage' | 'documents' | 'processes';

export default function LibraryPage() {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<LibraryTab>('rules');

  const [curriculum, setCurriculum] = useState<CurriculumNode[]>([]);
  const [selectedNode, setSelectedNode] = useState<CurriculumNode | null>(null);
  const [addingRoot, setAddingRoot] = useState(false);
  const [rootName, setRootName] = useState('');
  const [curriculumError, setCurriculumError] = useState<string | null>(null);
  const [treeSearch, setTreeSearch] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<{
    type: 'curriculum' | 'ruleset';
    id: number;
    name: string;
  } | null>(null);

  const [ruleSets, setRuleSets] = useState<RuleSet[]>([]);
  const [creatingRuleSet, setCreatingRuleSet] = useState(false);
  const [ruleSetError, setRuleSetError] = useState<string | null>(null);
  const [ruleSubTab, setRuleSubTab] = useState<'generation' | 'vignette' | 'teaching_case'>('generation');
  const [selectedRuleId, setSelectedRuleId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [editContent, setEditContent] = useState('');
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // Coverage tab
  const [directCounts, setDirectCounts] = useState<Record<string, TopicCoverageStats>>({});
  const [coverageLoading, setCoverageLoading] = useState(false);

  // Documents tab
  const [docsTopicId, setDocsTopicId] = useState<number | null>(null);
  const [topicDocs, setTopicDocs] = useState<Document[]>([]);
  const [topicDocsLoading, setTopicDocsLoading] = useState(false);

  const fetchCurriculum = useCallback(async () => {
    try {
      setCurriculum(await getCurriculum());
    } catch {
      setCurriculumError('Failed to load curriculum');
    }
  }, []);

  const fetchRuleSets = useCallback(async () => {
    try {
      setRuleSets(await getRuleSets());
    } catch {
      setRuleSetError('Failed to load rule sets');
    }
  }, []);

  const fetchCoverage = useCallback(async () => {
    setCoverageLoading(true);
    try {
      setDirectCounts(await getCurriculumCoverage());
    } catch {
      // silently fail
    } finally {
      setCoverageLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCurriculum();
    fetchRuleSets();
    fetchCoverage();
  }, [fetchCurriculum, fetchRuleSets, fetchCoverage]);

  // Fetch documents for selected topic in the Documents tab
  useEffect(() => {
    if (docsTopicId == null) { setTopicDocs([]); return; }
    setTopicDocsLoading(true);
    getDocuments({ topic_id: docsTopicId })
      .then(setTopicDocs)
      .catch(() => setTopicDocs([]))
      .finally(() => setTopicDocsLoading(false));
  }, [docsTopicId]);

  const handleDeselectIfDeleted = useCallback((id: number) => {
    setSelectedNode((prev) => (prev?.id === id ? null : prev));
  }, []);

  async function handleAddRoot() {
    if (!rootName.trim()) return;
    try {
      await createCurriculumNode({ name: rootName.trim(), parent_id: null });
      setRootName('');
      setAddingRoot(false);
      fetchCurriculum();
    } catch {
      setCurriculumError('Add root failed');
    }
  }

  async function handleDeleteConfirm() {
    if (!confirmDelete) return;
    const { type, id } = confirmDelete;
    setConfirmDelete(null);
    try {
      if (type === 'curriculum') {
        await deleteCurriculumNode(id);
        handleDeselectIfDeleted(id);
        fetchCurriculum();
      } else {
        await deleteRuleSet(id);
        fetchRuleSets();
      }
    } catch {
      if (type === 'curriculum') setCurriculumError('Delete failed');
      else setRuleSetError('Delete failed');
    }
  }

  function handleExport() {
    window.open(exportCardsUrl(selectedNode ? { curriculum_id: selectedNode.id } : undefined));
  }

  const flatCurriculum = flattenTree(curriculum);

  const searchResults = treeSearch.trim()
    ? flatCurriculum.filter((n) => n.name.toLowerCase().includes(treeSearch.toLowerCase()))
    : null;

  // Aggregated counts for coverage tab
  const aggregatedCounts = buildAggregatedCounts(curriculum, directCounts);

  // True totals — sum directCounts only to avoid double-counting aggregated parents
  const coverageTotals = Object.values(directCounts).reduce(
    (acc, s) => ({
      total: acc.total + s.total,
      active: acc.active + s.active,
      rejected: acc.rejected + s.rejected,
      unreviewed: acc.unreviewed + s.unreviewed,
    }),
    { total: 0, active: 0, rejected: 0, unreviewed: 0 }
  );

  const tabClass = (tab: LibraryTab) =>
    [
      'px-4 py-2 text-sm font-medium rounded-lg transition-colors duration-150',
      activeTab === tab
        ? 'bg-blue-50 text-blue-700'
        : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50',
    ].join(' ');

  return (
    <div className="flex h-[calc(100vh-56px)] flex-col overflow-hidden">
      {/* Tab header — pill-style */}
      <div className="bg-white border-b border-gray-200 flex items-center px-5 py-2.5 gap-1.5 shrink-0">
        {/* <button className={tabClass('curriculum')} onClick={() => setActiveTab('curriculum')}>
          Curriculum
        </button> */}
        <button className={tabClass('rules')} onClick={() => setActiveTab('rules')}>
          Rules
        </button>
        {/* <button className={tabClass('coverage')} onClick={() => setActiveTab('coverage')}>
          Coverage
        </button> */}
        <button className={tabClass('documents')} onClick={() => setActiveTab('documents')}>
          Documents
        </button>
        <button className={tabClass('processes')} onClick={() => setActiveTab('processes')}>
          Processes
        </button>
        <div className="flex-1" />
        <button
          onClick={handleExport}
          className="flex items-center gap-1.5 text-sm font-medium bg-blue-700 text-white px-4 py-2 rounded-lg hover:bg-blue-800 transition-colors duration-150"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-3.5 w-3.5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
            />
          </svg>
          Export cards
        </button>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-hidden">
        {/* ── CURRICULUM TAB ── */}
        {activeTab === 'curriculum' && (
          <div className="flex h-full">
            {/* Left: curriculum tree */}
            <aside className="bg-white w-64 flex flex-col shrink-0 overflow-hidden shadow-[1px_0_3px_0_rgba(0,0,0,0.04)]">
              <div className="px-3 pt-4 pb-2.5 shrink-0">
                <div className="flex items-center justify-between mb-2.5">
                  <h2 className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">
                    Curriculum
                  </h2>
                  <button
                    onClick={() => setAddingRoot((v) => !v)}
                    className="text-xs text-blue-700 hover:text-blue-900 font-medium transition-colors duration-150"
                    title="Add root node"
                  >
                    + Add
                  </button>
                </div>

                {/* Search */}
                <div className="relative">
                  <svg
                    className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-gray-400"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                    />
                  </svg>
                  <input
                    className="w-full pl-7 pr-2 py-1.5 text-xs border border-gray-200 rounded-lg bg-gray-50 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent focus:bg-white transition-colors duration-150"
                    placeholder="Search topics..."
                    value={treeSearch}
                    onChange={(e) => setTreeSearch(e.target.value)}
                  />
                  {treeSearch && (
                    <button
                      onClick={() => setTreeSearch('')}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                    >
                      <svg
                        className="w-3 h-3"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M6 18L18 6M6 6l12 12"
                        />
                      </svg>
                    </button>
                  )}
                </div>

                {curriculumError && (
                  <p className="text-red-500 text-xs mt-1">{curriculumError}</p>
                )}

                {addingRoot && (
                  <div className="flex items-center gap-1 mt-2">
                    <input
                      autoFocus
                      className="border border-gray-200 rounded-lg px-2 py-0.5 text-xs flex-1 focus:outline-none focus:ring-2 focus:ring-blue-600 transition-colors duration-150"
                      placeholder="Node name"
                      value={rootName}
                      onChange={(e) => setRootName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleAddRoot();
                        if (e.key === 'Escape') {
                          setAddingRoot(false);
                          setRootName('');
                        }
                      }}
                    />
                    <button
                      onClick={handleAddRoot}
                      className="text-xs text-green-600 font-medium"
                    >
                      OK
                    </button>
                    <button
                      onClick={() => {
                        setAddingRoot(false);
                        setRootName('');
                      }}
                      className="text-xs text-gray-400"
                    >
                      x
                    </button>
                  </div>
                )}
              </div>

              <div className="overflow-y-auto flex-1 px-1 pb-2">
                {searchResults !== null ? (
                  searchResults.length === 0 ? (
                    <p className="text-xs text-gray-400 italic px-3 py-2">No matches</p>
                  ) : (
                    searchResults.map((node) => (
                      <div
                        key={node.id}
                        onClick={() => setSelectedNode(node)}
                        className={[
                          'px-3 py-2 text-xs rounded-lg cursor-pointer truncate transition-colors duration-150 font-medium',
                          selectedNode?.id === node.id
                            ? 'bg-blue-50 text-blue-800'
                            : 'text-gray-700 hover:bg-gray-50',
                        ].join(' ')}
                        style={{ paddingLeft: `${(node.level + 1) * 10}px` }}
                        title={node.path}
                      >
                        {node.name}
                      </div>
                    ))
                  )
                ) : curriculum.length === 0 && !addingRoot ? (
                  <p className="text-xs text-gray-400 italic px-3 py-2">No nodes yet</p>
                ) : (
                  curriculum.map((node) => (
                    <CurriculumTreeNode
                      key={node.id}
                      node={node}
                      selectedId={selectedNode?.id ?? null}
                      onSelect={setSelectedNode}
                      onRefresh={fetchCurriculum}
                      onDeselect={handleDeselectIfDeleted}
                      onDeleteRequest={(id, name) =>
                        setConfirmDelete({ type: 'curriculum', id, name })
                      }
                      defaultOpen={false}
                    />
                  ))
                )}
              </div>
            </aside>

            {/* Right: selected node details */}
            <main className="flex-1 overflow-y-auto bg-gray-50/50 p-8">
              {selectedNode ? (
                <div className="max-w-lg">
                  <h1 className="text-sm font-semibold text-gray-900 mb-1">
                    {selectedNode.path}
                  </h1>
                  <p className="text-xs text-gray-500 mb-5">Level {selectedNode.level}</p>
                  <div className="bg-white rounded-xl shadow-md border border-gray-200 p-5">
                    <p className="text-xs text-gray-500">
                      <span className="font-semibold text-gray-700">ID:</span> {selectedNode.id}
                    </p>
                    <p className="text-xs text-gray-500 mt-2">
                      <span className="font-semibold text-gray-700">Children:</span>{' '}
                      {selectedNode.children.length}
                    </p>
                    <p className="text-xs text-gray-500 mt-2">
                      <span className="font-semibold text-gray-700">Full path:</span>{' '}
                      {selectedNode.path}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center h-40 gap-3 text-center">
                  <div className="w-12 h-12 rounded-xl bg-gray-100 flex items-center justify-center">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h7" />
                    </svg>
                  </div>
                  <p className="text-sm text-gray-500 font-medium">
                    Select a node to view details, or use the tree to add/rename/delete nodes.
                  </p>
                </div>
              )}
            </main>
          </div>
        )}

        {/* ── RULES TAB ── */}
        {activeTab === 'rules' && (
          <div className="flex h-full">
            {/* Sidebar */}
            <aside className="bg-white w-72 flex flex-col overflow-hidden shrink-0 shadow-[1px_0_3px_0_rgba(0,0,0,0.04)]">
              {/* Header */}
              <div className="px-4 py-3.5 border-b border-gray-200 shrink-0">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">
                    Rule Sets
                  </h2>
                  <button
                    onClick={() => setCreatingRuleSet((v) => !v)}
                    className="text-xs text-blue-700 hover:text-blue-900 font-medium transition-colors duration-150"
                  >
                    + New
                  </button>
                </div>
                {/* Sub-tabs */}
                <div className="flex gap-1 bg-gray-100 rounded-lg p-0.5">
                  {(['generation', 'vignette', 'teaching_case'] as const).map((type) => {
                    const labels: Record<typeof type, string> = {
                      generation: 'Generation',
                      vignette: 'Vignette',
                      teaching_case: 'Teaching',
                    };
                    return (
                      <button
                        key={type}
                        onClick={() => {
                          setRuleSubTab(type);
                          setSelectedRuleId(null);
                          setEditName('');
                          setEditContent('');
                          setEditError(null);
                        }}
                        className={[
                          'flex-1 px-2 py-1 text-[11px] font-medium rounded-md transition-colors duration-150',
                          ruleSubTab === type
                            ? 'bg-white text-blue-700 shadow-sm'
                            : 'text-gray-500 hover:text-gray-700',
                        ].join(' ')}
                      >
                        {labels[type]}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Rule list */}
              <div className="overflow-y-auto flex-1 py-2">
                {ruleSetError && (
                  <p className="text-red-500 text-xs px-4 mb-1">{ruleSetError}</p>
                )}
                {(() => {
                  const filteredRules = ruleSets.filter((r) => r.rule_type === ruleSubTab);
                  if (filteredRules.length === 0) {
                    return (
                      <p className="text-xs text-gray-400 italic px-4 py-2">No rule sets yet</p>
                    );
                  }
                  return filteredRules.map((rs) => {
                    const isActive = rs.id === selectedRuleId;
                    return (
                      <div
                        key={rs.id}
                        onClick={() => {
                          setSelectedRuleId(rs.id);
                          setEditName(rs.name);
                          setEditContent(rs.content);
                          setEditError(null);
                        }}
                        className={[
                          'group flex items-center gap-2 px-4 py-2.5 cursor-pointer transition-colors duration-150',
                          isActive ? 'bg-blue-50' : 'hover:bg-gray-50',
                        ].join(' ')}
                      >
                        <div className="flex-1 min-w-0">
                          <p className={`text-xs font-medium truncate ${isActive ? 'text-blue-700' : 'text-gray-800'}`}>
                            {rs.name}
                          </p>
                          {rs.is_default && (
                            <span className="inline-flex items-center px-1.5 py-0 rounded-full text-[10px] font-semibold bg-green-50 text-green-700 mt-0.5">
                              default
                            </span>
                          )}
                        </div>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setConfirmDelete({ type: 'ruleset', id: rs.id, name: rs.name });
                          }}
                          className="opacity-0 group-hover:opacity-100 p-1 text-gray-400 hover:text-red-500 rounded transition-all duration-150 shrink-0"
                          title="Delete"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    );
                  });
                })()}
              </div>
            </aside>

            {/* Right panel — inline editor */}
            <main className="flex-1 bg-gray-50/50 flex flex-col overflow-hidden">
              {selectedRuleId == null ? (
                <div className="flex-1 flex items-center justify-center">
                  <div className="flex flex-col items-center gap-3 text-center">
                    <div className="w-12 h-12 rounded-xl bg-gray-100 flex items-center justify-center">
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                      </svg>
                    </div>
                    <p className="text-sm text-gray-500 font-medium">Select a rule set to edit it.</p>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col h-full p-6 gap-4">
                  {/* Name */}
                  <div>
                    <label className="block text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5">
                      Name
                    </label>
                    <input
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent transition-colors bg-white"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      placeholder="Rule set name"
                    />
                  </div>

                  {/* Content */}
                  <div className="flex flex-col flex-1 min-h-0">
                    <label className="block text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5">
                      Content
                    </label>
                    <textarea
                      className="flex-1 w-full border border-gray-200 rounded-lg px-3 py-2.5 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent transition-colors resize-none bg-white"
                      value={editContent}
                      onChange={(e) => setEditContent(e.target.value)}
                      placeholder="Rule set content..."
                    />
                  </div>

                  {/* Error */}
                  {editError && <p className="text-red-500 text-xs">{editError}</p>}

                  {/* Actions */}
                  <div className="flex items-center gap-2.5 shrink-0">
                    <button
                      onClick={async () => {
                        if (!editName.trim()) { setEditError('Name is required'); return; }
                        setEditSaving(true);
                        setEditError(null);
                        try {
                          await updateRuleSet(selectedRuleId, { name: editName.trim(), content: editContent });
                          await fetchRuleSets();
                        } catch {
                          setEditError('Save failed');
                        } finally {
                          setEditSaving(false);
                        }
                      }}
                      disabled={editSaving}
                      className="px-4 py-2 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors disabled:opacity-60"
                    >
                      {editSaving ? 'Saving...' : 'Save'}
                    </button>
                    <button
                      onClick={async () => {
                        try {
                          await setDefaultRuleSet(selectedRuleId);
                          await fetchRuleSets();
                        } catch {
                          setEditError('Set default failed');
                        }
                      }}
                      className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
                    >
                      Set as Default
                    </button>
                  </div>
                </div>
              )}
            </main>

            {/* Create modal (kept for new rule creation) */}
            {creatingRuleSet && (
              <RuleSetModal
                title="New Rule Set"
                onSave={async (name, content, isDefault) => {
                  await createRuleSet({ name, content, is_default: isDefault, rule_type: ruleSubTab });
                  await fetchRuleSets();
                }}
                onClose={() => setCreatingRuleSet(false)}
              />
            )}
          </div>
        )}

        {/* ── COVERAGE TAB ── */}
        {activeTab === 'coverage' && (
          <div className="flex h-full">
            <aside className="bg-white w-72 flex flex-col overflow-hidden shrink-0 shadow-[1px_0_3px_0_rgba(0,0,0,0.04)]">
              <div className="px-4 py-3.5 border-b border-gray-200 shrink-0">
                <h2 className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">
                  Topic Coverage
                </h2>
                <p className="text-[10px] text-gray-400 mt-1">
                  ●amber = unreviewed &nbsp;✕red = rejected
                </p>
              </div>
              <div className="flex-1 overflow-y-auto py-1.5">
                {coverageLoading ? (
                  <div className="flex items-center justify-center h-20 text-sm text-gray-400">
                    Loading...
                  </div>
                ) : curriculum.length === 0 ? (
                  <p className="text-xs text-gray-400 italic px-3 py-2">No curriculum loaded.</p>
                ) : (
                  curriculum.map((node) => (
                    <CoverageNode
                      key={node.id}
                      node={node}
                      depth={0}
                      cardCounts={aggregatedCounts}
                    />
                  ))
                )}
              </div>
            </aside>
            <main className="flex-1 overflow-y-auto bg-gray-50/50 p-8">
              <div className="max-w-sm flex flex-col gap-5">
                {/* Card totals */}
                <div>
                  <h2 className="text-sm font-semibold text-gray-900 mb-3">Card totals</h2>
                  <div className="bg-white rounded-xl shadow-md border border-gray-200 p-5 flex flex-col gap-3">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-gray-500 font-medium">Total cards</span>
                      <span className="font-semibold text-gray-800 tabular-nums">{coverageTotals.total}</span>
                    </div>
                    <div className="h-px bg-gray-100" />
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-gray-500 font-medium">Active</span>
                      <span className="font-semibold text-green-700 tabular-nums">{coverageTotals.active}</span>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="flex items-center gap-1.5 text-gray-500 font-medium">
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-400 inline-block" />
                        Pending review
                      </span>
                      <span className="font-semibold text-amber-700 tabular-nums">{coverageTotals.unreviewed}</span>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="flex items-center gap-1.5 text-gray-500 font-medium">
                        <span className="w-1.5 h-1.5 rounded-full bg-red-400 inline-block" />
                        Rejected
                      </span>
                      <span className="font-semibold text-red-600 tabular-nums">{coverageTotals.rejected}</span>
                    </div>
                  </div>
                </div>

                {/* Topic coverage */}
                <div>
                  <h2 className="text-sm font-semibold text-gray-900 mb-3">Topic coverage</h2>
                  <div className="bg-white rounded-xl shadow-md border border-gray-200 p-5 flex flex-col gap-3">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-gray-500 font-medium">Total topics</span>
                      <span className="font-semibold text-gray-800 tabular-nums">{flatCurriculum.length}</span>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-gray-500 font-medium">Topics with cards</span>
                      <span className="font-semibold text-green-700 tabular-nums">
                        {Object.values(aggregatedCounts).filter((s) => s.total > 0).length}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-gray-500 font-medium">Topics without cards</span>
                      <span className="font-semibold text-gray-400 tabular-nums">
                        {Object.values(aggregatedCounts).filter((s) => s.total === 0).length}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Legend */}
                <div className="text-[10px] text-gray-400 flex flex-col gap-1">
                  <p>Counts in the tree are aggregated from child nodes.</p>
                  <div className="flex items-center gap-3 mt-1">
                    <span className="flex items-center gap-1"><span className="px-1.5 py-0.5 rounded-full bg-green-50 text-green-700 font-semibold">12</span> total</span>
                    <span className="flex items-center gap-1"><span className="px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-700 font-semibold">●3</span> unreviewed</span>
                    <span className="flex items-center gap-1"><span className="px-1.5 py-0.5 rounded-full bg-red-50 text-red-600 font-semibold">✕1</span> rejected</span>
                  </div>
                </div>
              </div>
            </main>
          </div>
        )}
        {/* ── DOCUMENTS TAB ── */}
        {activeTab === 'documents' && (
          <div className="flex h-full">
            {/* Left: topic tree */}
            <aside className="bg-white w-72 flex flex-col overflow-hidden shrink-0 shadow-[1px_0_3px_0_rgba(0,0,0,0.04)]">
              <div className="px-4 py-3.5 border-b border-gray-200 shrink-0">
                <h2 className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Topics</h2>
                <p className="text-[10px] text-gray-400 mt-1">Select a topic to see its documents</p>
              </div>
              <div className="flex-1 overflow-y-auto py-1.5">
                {curriculum.length === 0 ? (
                  <p className="text-xs text-gray-400 italic px-3 py-2">No curriculum loaded.</p>
                ) : (
                  curriculum.map((node) => (
                    <SelectableCoverageNode
                      key={node.id}
                      node={node}
                      depth={0}
                      cardCounts={aggregatedCounts}
                      selectedId={docsTopicId}
                      onSelect={setDocsTopicId}
                    />
                  ))
                )}
              </div>
            </aside>

            {/* Right: documents list */}
            <main className="flex-1 overflow-y-auto bg-gray-50/50 p-6">
              {docsTopicId == null ? (
                <div className="flex flex-col items-center justify-center h-40 gap-3 text-center">
                  <div className="w-12 h-12 rounded-xl bg-gray-100 flex items-center justify-center">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                  </div>
                  <p className="text-sm text-gray-500 font-medium">Select a topic to see related documents</p>
                </div>
              ) : topicDocsLoading ? (
                <div className="flex items-center justify-center h-20 text-sm text-gray-400">Loading...</div>
              ) : topicDocs.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-32 gap-2 text-center">
                  <p className="text-sm text-gray-500 font-medium">No documents for this topic yet.</p>
                  <p className="text-xs text-gray-400">Documents appear here once their chunks are assigned to this topic.</p>
                </div>
              ) : (
                <div className="max-w-2xl">
                  <p className="text-sm text-gray-400 mb-4 font-medium">{topicDocs.length} document{topicDocs.length !== 1 ? 's' : ''} in this topic</p>
                  <div className="flex flex-col gap-2">
                    {topicDocs.map((doc) => (
                      <div key={doc.id} className="bg-white rounded-xl border border-gray-200 shadow-sm px-4 py-3 flex items-center justify-between gap-3 hover:border-blue-200 hover:shadow-md transition-all duration-150">
                        <div className="min-w-0">
                          <p className="text-base font-semibold text-gray-800 truncate">{doc.original_name}</p>
                          <p className="text-xs text-gray-400 mt-0.5 flex items-center gap-2">
                            <span>{doc.chunk_count} chunk{doc.chunk_count !== 1 ? 's' : ''}</span>
                            <span>·</span>
                            <span>{doc.total_cards ?? 0} card{(doc.total_cards ?? 0) !== 1 ? 's' : ''}</span>
                            {(doc.total_cards ?? 0) > 0 && doc.unreviewed_cards === 0 && (
                              <span className="text-green-500 font-semibold">✓ reviewed</span>
                            )}
                            {(doc.unreviewed_cards ?? 0) > 0 && (
                              <span className="text-amber-600 font-medium">{doc.unreviewed_cards} unreviewed</span>
                            )}
                          </p>
                        </div>
                        <button
                          onClick={() => navigate('/', { state: { goToDocId: doc.id } })}
                          className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 transition-colors duration-150"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
                          </svg>
                          Open
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </main>
          </div>
        )}
        {activeTab === 'processes' && (
          <div className="flex-1 overflow-hidden">
            <ProcessesFlow />
          </div>
        )}
      </div>

      {confirmDelete && (
        <ConfirmModal
          title={
            confirmDelete.type === 'curriculum'
              ? 'Delete curriculum node?'
              : 'Delete rule set?'
          }
          message={
            confirmDelete.type === 'curriculum'
              ? `"${confirmDelete.name}" and all its children will be permanently deleted.`
              : `"${confirmDelete.name}" will be permanently deleted.`
          }
          onConfirm={handleDeleteConfirm}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}
