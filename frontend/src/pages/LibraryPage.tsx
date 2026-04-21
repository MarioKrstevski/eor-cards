import { useCallback, useEffect, useState } from 'react';
import {
  getCurriculum,
  createCurriculumNode,
  updateCurriculumNode,
  deleteCurriculumNode,
  getRuleSets,
  createRuleSet,
  updateRuleSet,
  deleteRuleSet,
  setDefaultRuleSet,
  getDocuments,
  updateDocument,
  deleteDocument,
  exportCardsUrl,
} from '../api';
import type { CurriculumNode, RuleSet, Document } from '../types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function flattenTree(nodes: CurriculumNode[]): CurriculumNode[] {
  const result: CurriculumNode[] = [];
  function walk(list: CurriculumNode[]) {
    for (const node of list) {
      result.push(node);
      if (node.children.length > 0) walk(node.children);
    }
  }
  walk(nodes);
  return result;
}

// ─── CurriculumTreeNode ───────────────────────────────────────────────────────

interface TreeNodeProps {
  node: CurriculumNode;
  selectedId: number | null;
  onSelect: (node: CurriculumNode) => void;
  onRefresh: () => void;
  onDeselect: (id: number) => void;
}

function CurriculumTreeNode({
  node,
  selectedId,
  onSelect,
  onRefresh,
  onDeselect,
}: TreeNodeProps) {
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(node.name);
  const [addingChild, setAddingChild] = useState(false);
  const [childName, setChildName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const isSelected = node.id === selectedId;

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

  async function handleDelete() {
    try {
      await deleteCurriculumNode(node.id);
      onDeselect(node.id);
      onRefresh();
    } catch {
      setError('Delete failed');
    }
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

  return (
    <div>
      <div
        className={[
          'group flex items-center gap-1 px-3 py-1.5 rounded-md cursor-pointer text-sm transition-colors',
          isSelected
            ? 'bg-violet-50 border-l-2 border-violet-500 pl-2.5'
            : 'hover:bg-gray-100 border-l-2 border-transparent',
        ].join(' ')}
        onClick={() => onSelect(node)}
      >
        {renaming ? (
          <input
            autoFocus
            className="flex-1 border border-gray-300 rounded-md px-2 py-0.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRename();
              if (e.key === 'Escape') { setRenaming(false); setRenameValue(node.name); }
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="flex-1 truncate text-gray-700">{node.name}</span>
        )}

        {renaming ? (
          <>
            <button
              onClick={(e) => { e.stopPropagation(); handleRename(); }}
              className="text-xs text-green-600 hover:text-green-800 px-1 font-medium"
            >
              OK
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); setRenaming(false); setRenameValue(node.name); }}
              className="text-xs text-gray-500 hover:text-gray-700 px-1"
            >
              Cancel
            </button>
          </>
        ) : (
          <span className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 ml-1 transition-opacity">
            <button
              title="Add child"
              onClick={(e) => { e.stopPropagation(); setAddingChild((v) => !v); }}
              className="p-0.5 text-xs text-violet-500 hover:text-violet-700 leading-none rounded"
            >
              +
            </button>
            <button
              title="Rename"
              onClick={(e) => { e.stopPropagation(); setRenaming(true); }}
              className="p-0.5 text-xs text-gray-400 hover:text-gray-600 leading-none rounded"
            >
              ✎
            </button>
            <button
              title="Delete"
              onClick={(e) => { e.stopPropagation(); handleDelete(); }}
              className="p-0.5 text-xs text-red-400 hover:text-red-600 leading-none rounded"
            >
              ×
            </button>
          </span>
        )}
      </div>

      {error && <p className="text-red-500 text-xs pl-4 mt-0.5">{error}</p>}

      {addingChild && (
        <div className="pl-6 flex items-center gap-1 mt-1">
          <input
            autoFocus
            className="border border-gray-300 rounded-md px-2 py-0.5 text-xs flex-1 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
            placeholder="Child name"
            value={childName}
            onChange={(e) => setChildName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAddChild();
              if (e.key === 'Escape') { setAddingChild(false); setChildName(''); }
            }}
          />
          <button onClick={handleAddChild} className="text-xs text-green-600 hover:text-green-800 font-medium">OK</button>
          <button onClick={() => { setAddingChild(false); setChildName(''); }} className="text-xs text-gray-500 hover:text-gray-700">Cancel</button>
        </div>
      )}

      {node.children.length > 0 && (
        <div className="pl-4">
          {node.children.map((child) => (
            <CurriculumTreeNode
              key={child.id}
              node={child}
              selectedId={selectedId}
              onSelect={onSelect}
              onRefresh={onRefresh}
              onDeselect={onDeselect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── RuleSetItem ──────────────────────────────────────────────────────────────

interface RuleSetItemProps {
  rs: RuleSet;
  onRefresh: () => void;
}

function RuleSetItem({ rs, onRefresh }: RuleSetItemProps) {
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(rs.name);
  const [editContent, setEditContent] = useState(rs.content);
  const [editIsDefault, setEditIsDefault] = useState(rs.is_default);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    try {
      await updateRuleSet(rs.id, {
        name: editName.trim(),
        content: editContent,
        is_default: editIsDefault,
      });
      setEditing(false);
      onRefresh();
    } catch {
      setError('Save failed');
    }
  }

  async function handleDelete() {
    try {
      await deleteRuleSet(rs.id);
      onRefresh();
    } catch {
      setError('Delete failed');
    }
  }

  async function handleSetDefault() {
    try {
      await setDefaultRuleSet(rs.id);
      onRefresh();
    } catch {
      setError('Set default failed');
    }
  }

  if (editing) {
    return (
      <div className="border border-gray-200 rounded-md p-3 mb-2 bg-white">
        {error && <p className="text-red-500 text-xs mb-2">{error}</p>}
        <input
          className="w-full border border-gray-300 rounded-md px-3 py-1.5 mb-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          placeholder="Rule set name"
        />
        <textarea
          className="w-full border border-gray-300 rounded-md px-3 py-1.5 mb-2 text-xs font-mono resize-y focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
          rows={6}
          value={editContent}
          onChange={(e) => setEditContent(e.target.value)}
          placeholder="Rule set content"
        />
        <label className="flex items-center gap-1.5 text-xs mb-3 cursor-pointer text-gray-600">
          <input
            type="checkbox"
            checked={editIsDefault}
            onChange={(e) => setEditIsDefault(e.target.checked)}
            className="rounded border-gray-300 text-violet-600 focus:ring-violet-400"
          />
          Is default
        </label>
        <div className="flex gap-2">
          <button
            onClick={handleSave}
            className="text-xs bg-violet-600 text-white px-3 py-1.5 rounded-md hover:bg-violet-700 font-medium transition-colors"
          >
            Save
          </button>
          <button
            onClick={() => { setEditing(false); setError(null); }}
            className="text-xs text-gray-600 hover:text-gray-800 px-2 py-1.5"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="border border-gray-200 rounded-md p-3 mb-2 bg-white hover:border-gray-300 transition-colors">
      {error && <p className="text-red-500 text-xs mb-1">{error}</p>}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-medium text-gray-800 flex-1 truncate">{rs.name}</span>
        {rs.is_default && (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-50 text-green-700 border border-green-200">
            default
          </span>
        )}
      </div>
      <div className="flex gap-2 mt-2 flex-wrap">
        {!rs.is_default && (
          <button
            onClick={handleSetDefault}
            className="text-xs text-violet-600 hover:text-violet-800 font-medium"
          >
            Set default
          </button>
        )}
        <button
          onClick={() => setEditing(true)}
          className="text-xs text-gray-500 hover:text-gray-700 font-medium"
        >
          Edit
        </button>
        <button
          onClick={handleDelete}
          className="text-xs text-red-500 hover:text-red-700 font-medium"
        >
          Delete
        </button>
      </div>
    </div>
  );
}

// ─── NewRuleSetForm ───────────────────────────────────────────────────────────

interface NewRuleSetFormProps {
  onSaved: () => void;
  onCancel: () => void;
}

function NewRuleSetForm({ onSaved, onCancel }: NewRuleSetFormProps) {
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    if (!name.trim()) { setError('Name is required'); return; }
    try {
      await createRuleSet({ name: name.trim(), content, is_default: isDefault });
      onSaved();
    } catch {
      setError('Create failed');
    }
  }

  return (
    <div className="border border-violet-200 rounded-md p-3 mb-2 bg-violet-50/30">
      {error && <p className="text-red-500 text-xs mb-2">{error}</p>}
      <input
        autoFocus
        className="w-full border border-gray-300 rounded-md px-3 py-1.5 mb-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Rule set name"
      />
      <textarea
        className="w-full border border-gray-300 rounded-md px-3 py-1.5 mb-2 text-xs font-mono resize-y bg-white focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
        rows={6}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="Rule set content"
      />
      <label className="flex items-center gap-1.5 text-xs mb-3 cursor-pointer text-gray-600">
        <input
          type="checkbox"
          checked={isDefault}
          onChange={(e) => setIsDefault(e.target.checked)}
          className="rounded border-gray-300 text-violet-600 focus:ring-violet-400"
        />
        Is default
      </label>
      <div className="flex gap-2">
        <button
          onClick={handleSave}
          className="text-xs bg-violet-600 text-white px-3 py-1.5 rounded-md hover:bg-violet-700 font-medium transition-colors"
        >
          Save
        </button>
        <button
          onClick={onCancel}
          className="text-xs text-gray-600 hover:text-gray-800 px-2 py-1.5"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ─── LibraryPage ──────────────────────────────────────────────────────────────

export default function LibraryPage() {
  // Curriculum state
  const [curriculum, setCurriculum] = useState<CurriculumNode[]>([]);
  const [selectedNode, setSelectedNode] = useState<CurriculumNode | null>(null);
  const [addingRoot, setAddingRoot] = useState(false);
  const [rootName, setRootName] = useState('');
  const [curriculumError, setCurriculumError] = useState<string | null>(null);

  // Rule sets state
  const [ruleSets, setRuleSets] = useState<RuleSet[]>([]);
  const [creatingRuleSet, setCreatingRuleSet] = useState(false);
  const [ruleSetError, setRuleSetError] = useState<string | null>(null);

  // Documents state
  const [documents, setDocuments] = useState<Document[]>([]);
  const [docError, setDocError] = useState<string | null>(null);

  // ── Data fetching ──

  const fetchCurriculum = useCallback(async () => {
    try {
      const data = await getCurriculum();
      setCurriculum(data);
    } catch {
      setCurriculumError('Failed to load curriculum');
    }
  }, []);

  const fetchRuleSets = useCallback(async () => {
    try {
      const data = await getRuleSets();
      setRuleSets(data);
    } catch {
      setRuleSetError('Failed to load rule sets');
    }
  }, []);

  const fetchDocuments = useCallback(async () => {
    try {
      const data = await getDocuments();
      setDocuments(data);
    } catch {
      setDocError('Failed to load documents');
    }
  }, []);

  useEffect(() => {
    fetchCurriculum();
    fetchRuleSets();
    fetchDocuments();
  }, [fetchCurriculum, fetchRuleSets, fetchDocuments]);

  // ── Curriculum helpers ──

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

  // ── Document helpers ──

  const handleAssignCurriculum = useCallback(async (docId: number, value: string) => {
    const curriculum_id = value === '' ? null : Number(value);
    try {
      await updateDocument(docId, { curriculum_id });
      fetchDocuments();
    } catch {
      setDocError('Update failed');
    }
  }, [fetchDocuments]);

  const handleDeleteDocument = useCallback(async (docId: number) => {
    try {
      await deleteDocument(docId);
      fetchDocuments();
    } catch {
      setDocError('Delete failed');
    }
  }, [fetchDocuments]);

  // ── Derived data ──

  const flatCurriculum = flattenTree(curriculum);

  const filteredDocuments = selectedNode
    ? documents.filter(
        (doc) =>
          doc.topic_path === selectedNode.path ||
          doc.topic_path?.startsWith(selectedNode.path + ' > ')
      )
    : documents;

  // ── Export ──

  function handleExport() {
    const url = exportCardsUrl(
      selectedNode ? { curriculum_id: selectedNode.id } : undefined
    );
    window.open(url);
  }

  // ──────────────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-[calc(100vh-48px)]">
      {/* ── Left Panel ──────────────────────────────────────────────────── */}
      <aside className="bg-white w-64 border-r border-gray-200 flex flex-col overflow-y-auto shrink-0">

        {/* Curriculum section */}
        <div className="px-4 py-3 border-b border-gray-100">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-widest">
              Curriculum
            </h2>
            <button
              onClick={() => setAddingRoot((v) => !v)}
              className="text-xs text-violet-600 hover:text-violet-800 font-medium transition-colors"
              title="Add root node"
            >
              + Add root
            </button>
          </div>

          {curriculumError && (
            <p className="text-red-500 text-xs mb-1">{curriculumError}</p>
          )}

          {addingRoot && (
            <div className="flex items-center gap-1 mb-2">
              <input
                autoFocus
                className="border border-gray-300 rounded-md px-2 py-0.5 text-xs flex-1 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
                placeholder="Node name"
                value={rootName}
                onChange={(e) => setRootName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleAddRoot();
                  if (e.key === 'Escape') { setAddingRoot(false); setRootName(''); }
                }}
              />
              <button onClick={handleAddRoot} className="text-xs text-green-600 hover:text-green-800 font-medium">OK</button>
              <button onClick={() => { setAddingRoot(false); setRootName(''); }} className="text-xs text-gray-500 hover:text-gray-700">Cancel</button>
            </div>
          )}

          {curriculum.length === 0 && !addingRoot && (
            <p className="text-xs text-gray-400 italic py-1">No nodes yet</p>
          )}

          <div className="space-y-0.5 mt-1">
            {curriculum.map((node) => (
              <CurriculumTreeNode
                key={node.id}
                node={node}
                selectedId={selectedNode?.id ?? null}
                onSelect={setSelectedNode}
                onRefresh={fetchCurriculum}
                onDeselect={handleDeselectIfDeleted}
              />
            ))}
          </div>
        </div>

        {/* Rule Sets section */}
        <div className="px-4 py-3 flex-1">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-widest">
              Rule Sets
            </h2>
            <button
              onClick={() => setCreatingRuleSet((v) => !v)}
              className="text-xs text-violet-600 hover:text-violet-800 font-medium transition-colors"
            >
              + New
            </button>
          </div>

          {ruleSetError && (
            <p className="text-red-500 text-xs mb-1">{ruleSetError}</p>
          )}

          {creatingRuleSet && (
            <NewRuleSetForm
              onSaved={() => { setCreatingRuleSet(false); fetchRuleSets(); }}
              onCancel={() => setCreatingRuleSet(false)}
            />
          )}

          {ruleSets.length === 0 && !creatingRuleSet && (
            <p className="text-xs text-gray-400 italic py-1">No rule sets yet</p>
          )}

          {ruleSets.map((rs) => (
            <RuleSetItem key={rs.id} rs={rs} onRefresh={fetchRuleSets} />
          ))}
        </div>
      </aside>

      {/* ── Right Panel ─────────────────────────────────────────────────── */}
      <main className="flex-1 overflow-y-auto bg-gray-50">
        <div className="px-6 py-4 bg-white border-b border-gray-200 flex items-center justify-between">
          <div>
            <h1 className="text-sm font-semibold text-gray-900">
              {selectedNode ? selectedNode.path : 'All Documents'}
            </h1>
            {selectedNode && (
              <p className="text-xs text-gray-400 mt-0.5">Filtered by curriculum node</p>
            )}
          </div>
          <div className="flex items-center gap-3">
            {selectedNode && (
              <button
                onClick={() => setSelectedNode(null)}
                className="text-xs text-gray-500 hover:text-gray-700 font-medium border border-gray-300 px-2.5 py-1 rounded-md hover:bg-gray-50 transition-colors"
              >
                Clear filter
              </button>
            )}
            <button
              onClick={handleExport}
              className="flex items-center gap-1.5 text-sm font-medium bg-violet-600 text-white px-3 py-1.5 rounded-md hover:bg-violet-700 transition-colors focus:outline-none focus:ring-2 focus:ring-violet-500 focus:ring-offset-1"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Export cards
            </button>
          </div>
        </div>

        <div className="p-6">
          {docError && (
            <div className="mb-4 px-3 py-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-md">
              {docError}
            </div>
          )}

          {filteredDocuments.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 gap-2 text-center">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-10 w-10 text-gray-200"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                />
              </svg>
              <p className="text-sm text-gray-400">No documents found.</p>
            </div>
          ) : (
            <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Document</th>
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Topic path</th>
                    <th className="px-4 py-2.5 text-right text-xs font-medium text-gray-500 uppercase tracking-wide">Chunks</th>
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Assigned curriculum</th>
                    <th className="px-4 py-2.5"></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredDocuments.map((doc) => (
                    <tr key={doc.id} className="hover:bg-gray-50 border-b border-gray-100 last:border-0 transition-colors">
                      <td className="px-4 py-3 font-medium text-gray-800 max-w-xs truncate">
                        {doc.original_name}
                      </td>
                      <td className="px-4 py-3 text-gray-400 text-xs max-w-xs truncate">
                        {doc.topic_path ?? '—'}
                      </td>
                      <td className="px-4 py-3 text-right text-gray-600 tabular-nums">
                        {doc.chunk_count}
                      </td>
                      <td className="px-4 py-3">
                        <select
                          className="border border-gray-300 rounded-md px-2 py-1 text-sm w-full max-w-[200px] focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent bg-white"
                          value={doc.curriculum_id ?? ''}
                          onChange={(e) =>
                            handleAssignCurriculum(doc.id, e.target.value)
                          }
                        >
                          <option value="">— unassigned —</option>
                          {flatCurriculum.map((node) => (
                            <option key={node.id} value={node.id}>
                              {node.path}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() => handleDeleteDocument(doc.id)}
                          className="text-red-400 hover:text-red-600 text-xs font-medium transition-colors"
                          title="Delete document"
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
