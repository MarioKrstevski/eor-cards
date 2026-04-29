import { useCallback } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  type Node,
  type Edge,
  type NodeTypes,
  Handle,
  Position,
  MarkerType,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

// ─── Custom Node Types ───────────────────────────────────────────────────────

interface StepNodeData {
  label: string;
  description: string;
  icon: string;
  aiPowered?: boolean;
  info?: string;
  [key: string]: unknown;
}

function StepNode({ data }: { data: StepNodeData }) {
  return (
    <div className={`px-4 py-3 rounded-xl border-2 shadow-md min-w-[200px] max-w-[260px] bg-white ${data.aiPowered ? 'border-purple-300' : 'border-gray-200'}`}>
      <Handle type="target" position={Position.Top} className="!bg-gray-400 !w-2 !h-2" />
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-lg">{data.icon}</span>
        <span className="text-sm font-semibold text-gray-900">{data.label}</span>
        {data.aiPowered && (
          <span className="text-[9px] font-bold text-purple-600 bg-purple-50 px-1.5 py-0.5 rounded-full">AI</span>
        )}
      </div>
      <p className="text-[11px] text-gray-500 leading-relaxed">{data.description}</p>
      {data.info && (
        <p className="text-[10px] text-blue-600 mt-1.5 leading-snug border-t border-gray-100 pt-1.5">{data.info}</p>
      )}
      <Handle type="source" position={Position.Bottom} className="!bg-gray-400 !w-2 !h-2" />
    </div>
  );
}

interface DecisionNodeData {
  label: string;
  description: string;
  [key: string]: unknown;
}

function DecisionNode({ data }: { data: DecisionNodeData }) {
  return (
    <div className="relative">
      <Handle type="target" position={Position.Top} className="!bg-amber-500 !w-2 !h-2" />
      <div className="bg-amber-50 border-2 border-amber-300 rounded-lg px-4 py-2.5 shadow-md min-w-[180px] max-w-[220px] text-center">
        <span className="text-sm font-semibold text-amber-800">{data.label}</span>
        <p className="text-[10px] text-amber-600 mt-1">{data.description}</p>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-amber-500 !w-2 !h-2" />
      <Handle type="source" position={Position.Right} id="right" className="!bg-amber-500 !w-2 !h-2" />
    </div>
  );
}

interface InfoNodeData {
  label: string;
  items: string[];
  [key: string]: unknown;
}

function InfoNode({ data }: { data: InfoNodeData }) {
  return (
    <div className="bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 shadow-sm max-w-[220px]">
      <Handle type="target" position={Position.Left} className="!bg-blue-400 !w-2 !h-2" />
      <span className="text-xs font-semibold text-blue-800 block mb-1">{data.label}</span>
      <ul className="space-y-0.5">
        {data.items.map((item, i) => (
          <li key={i} className="text-[10px] text-blue-600 flex items-start gap-1">
            <span className="text-blue-400 mt-0.5">•</span>
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── Flow Data ───────────────────────────────────────────────────────────────

const nodes: Node[] = [
  // Row 1: Entry
  {
    id: 'upload',
    type: 'step',
    position: { x: 300, y: 0 },
    data: {
      icon: '📄',
      label: 'Upload or Paste',
      description: 'Upload a .docx file or paste HTML content from Word, Google Docs, etc.',
      info: 'Images are extracted and stored as base64. Document is saved to the system.',
    },
  },
  // Row 2: Chunking
  {
    id: 'chunking',
    type: 'step',
    position: { x: 300, y: 150 },
    data: {
      icon: '✂️',
      label: 'Semantic Chunking',
      description: 'AI splits the document into meaningful chunks based on content structure and topic boundaries.',
      aiPowered: true,
      info: 'Uses Haiku model (fixed). Identifies headings, bullet lists, tables, images. Each chunk gets a heading and content type.',
    },
  },
  // Row 3: Topic Detection
  {
    id: 'topics',
    type: 'step',
    position: { x: 300, y: 330 },
    data: {
      icon: '🏷️',
      label: 'Topic Detection',
      description: 'AI matches each chunk to the most relevant topic in your curriculum tree.',
      aiPowered: true,
      info: 'Uses Haiku model. Reads the curriculum tree and chunk content to find the best match. Results are suggestions — you review them next.',
    },
  },
  // Row 4: Topic Review
  {
    id: 'review_topics',
    type: 'step',
    position: { x: 300, y: 510 },
    data: {
      icon: '👁️',
      label: 'Review Topics',
      description: 'You see each chunk with its AI-suggested topic. Adjust any that are wrong using the topic picker.',
      info: 'Click "Confirm" to save. Each chunk\'s topic determines the tags on its cards. Topics can be reassigned later from the curriculum sidebar.',
    },
  },
  // Row 5: Generate decision
  {
    id: 'decide_gen',
    type: 'decision',
    position: { x: 330, y: 700 },
    data: {
      label: 'Generate Cards?',
      description: '"Generate now" or "Later"',
    },
  },
  // Later path info
  {
    id: 'later_info',
    type: 'info',
    position: { x: 620, y: 700 },
    data: {
      label: 'Skip for Later',
      items: [
        'Chunks are saved with topics',
        'Generate cards anytime from the document view',
        'Select chunks and click Generate',
      ],
    },
  },
  // Row 6: Card Generation
  {
    id: 'card_gen',
    type: 'step',
    position: { x: 300, y: 860 },
    data: {
      icon: '🃏',
      label: 'Card Generation',
      description: 'AI generates Anki cloze cards from each chunk. Cards include an anchor term (never clozed) so students know what they\'re studying.',
      aiPowered: true,
      info: 'Uses your selected Generation Model + Generation Rules. Sibling chunks (same topic) are sent as context. Each card gets a unique Anki-compatible note_id.',
    },
  },
  // Info: what AI knows
  {
    id: 'gen_context',
    type: 'info',
    position: { x: 620, y: 860 },
    data: {
      label: 'AI Context at This Step',
      items: [
        'Chunk source text + heading',
        'Topic path (curriculum context)',
        'Sibling chunks under same topic',
        'Your generation rules (prompt)',
        'Anchor instruction (hardcoded)',
      ],
    },
  },
  // Row 7: Supplemental decision
  {
    id: 'decide_supp',
    type: 'decision',
    position: { x: 330, y: 1060 },
    data: {
      label: 'Generate Vignettes & Cases?',
      description: 'Optional — can do later from cards table',
    },
  },
  // Row 8: Supplemental Generation
  {
    id: 'supp_gen',
    type: 'step',
    position: { x: 300, y: 1220 },
    data: {
      icon: '📋',
      label: 'Vignette & Teaching Case Generation',
      description: 'AI generates one shared vignette + teaching case per condition (leaf topic). All cards for the same condition get the same content.',
      aiPowered: true,
      info: 'Cards grouped by leaf topic. One API call per condition group. Uses your Vignette Rules. Patient names are alliterative and tied to the diagnosis.',
    },
  },
  // Info: supplemental context
  {
    id: 'supp_context',
    type: 'info',
    position: { x: 620, y: 1220 },
    data: {
      label: 'AI Context at This Step',
      items: [
        'All card fronts for the condition',
        'Topic/condition name',
        'Your vignette/TC rules',
        'Does NOT use chunk source text',
        'Uses AI medical knowledge',
      ],
    },
  },
  // ─── SIDEBAR: Management & Settings (left column) ─────────────────────────

  {
    id: 'settings_block',
    type: 'step',
    position: { x: -220, y: 0 },
    data: {
      icon: '⚙️',
      label: 'Settings (Gear Icon)',
      description: 'Configure models and rules before generating. Settings are saved to your browser.',
      info: 'Card Generation: Model + Rules. Vignette + Teaching Case: Model + Rules. Chunking model is fixed to Haiku.',
    },
  },
  {
    id: 'rules_block',
    type: 'step',
    position: { x: -220, y: 200 },
    data: {
      icon: '📝',
      label: 'Rules (Library > Rules)',
      description: 'Create and manage prompt templates. Two types: Generation (for cards) and Vignette + Teaching Case (for supplemental content).',
      info: 'Set one default per type. The client\'s prompt goes here — it tells the AI exactly how to format output.',
    },
  },
  {
    id: 'curriculum_block',
    type: 'step',
    position: { x: -220, y: 400 },
    data: {
      icon: '🌳',
      label: 'Curriculum (Workspace Sidebar)',
      description: 'Manage the topic tree. Add, rename, delete, or reorganize topics. Topics are hierarchical: Parent > Child > Leaf.',
      info: 'Leaf topics = conditions. Cards are tagged with the full path. Deleting a topic reassigns chunks to parent and removes the tag from cards.',
    },
  },
  {
    id: 'reassign_block',
    type: 'step',
    position: { x: -220, y: 600 },
    data: {
      icon: '🔄',
      label: 'Reassign Topics',
      description: 'Re-run AI topic detection on chunks under a topic. Use when curriculum structure changes or initial assignments were wrong.',
      aiPowered: true,
      info: 'Click "Reassign" on a topic in the sidebar. AI suggests new topic for each chunk. Review and confirm before saving.',
    },
  },
  {
    id: 'documents_block',
    type: 'step',
    position: { x: -220, y: 800 },
    data: {
      icon: '📚',
      label: 'Documents (Library > Documents)',
      description: 'View all uploaded/pasted documents. See chunk counts and card counts. Click to navigate to document in workspace.',
      info: 'Filter by topic to find documents for a specific condition. Rename or delete documents here.',
    },
  },

  // Row 9: Review
  {
    id: 'review_cards',
    type: 'step',
    position: { x: 300, y: 1460 },
    data: {
      icon: '✏️',
      label: 'Review & Edit Cards',
      description: 'Review generated cards in the table. Edit front text, tags, vignettes, teaching cases inline. Toggle ref images between front/back.',
      info: 'Mark cards as reviewed. Reject bad cards. Regenerate individual cards with optional guidance. Use Ankify mode to preview the study experience.',
    },
  },
  // Row 10: Export
  {
    id: 'export',
    type: 'step',
    position: { x: 300, y: 1700 },
    data: {
      icon: '📤',
      label: 'Export to Anki',
      description: 'Export cards as CSV with note_id, front, tags, vignette, teaching case, ref_img. Import into Anki for spaced repetition study.',
      info: 'note_id ensures Anki can update existing cards on re-import without creating duplicates.',
    },
  },
];

const edgeDefaults = {
  markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: '#94a3b8' },
  style: { stroke: '#94a3b8', strokeWidth: 1.5 },
  animated: false,
};

const edges: Edge[] = [
  { id: 'e1', source: 'upload', target: 'chunking', ...edgeDefaults },
  { id: 'e2', source: 'chunking', target: 'topics', ...edgeDefaults },
  { id: 'e3', source: 'topics', target: 'review_topics', ...edgeDefaults },
  { id: 'e4', source: 'review_topics', target: 'decide_gen', ...edgeDefaults },
  { id: 'e5', source: 'decide_gen', target: 'card_gen', label: 'Yes', ...edgeDefaults, style: { ...edgeDefaults.style, stroke: '#16a34a' } },
  { id: 'e5b', source: 'decide_gen', sourceHandle: 'right', target: 'later_info', ...edgeDefaults, style: { ...edgeDefaults.style, stroke: '#d97706', strokeDasharray: '5 5' } },
  { id: 'e6', source: 'card_gen', target: 'gen_context', ...edgeDefaults, style: { ...edgeDefaults.style, strokeDasharray: '4 4', stroke: '#3b82f6' } },
  { id: 'e7', source: 'card_gen', target: 'decide_supp', ...edgeDefaults },
  { id: 'e8', source: 'decide_supp', target: 'supp_gen', label: 'Yes', ...edgeDefaults, style: { ...edgeDefaults.style, stroke: '#16a34a' } },
  { id: 'e9', source: 'supp_gen', target: 'supp_context', ...edgeDefaults, style: { ...edgeDefaults.style, strokeDasharray: '4 4', stroke: '#3b82f6' } },
  { id: 'e10', source: 'supp_gen', target: 'review_cards', ...edgeDefaults },
  { id: 'e10b', source: 'decide_supp', sourceHandle: 'right', target: 'review_cards', label: 'Skip', ...edgeDefaults, style: { ...edgeDefaults.style, stroke: '#d97706', strokeDasharray: '5 5' }, type: 'smoothstep' },
  { id: 'e11', source: 'review_cards', target: 'export', ...edgeDefaults },
];

const nodeTypes: NodeTypes = {
  step: StepNode as any,
  decision: DecisionNode as any,
  info: InfoNode as any,
};

// ─── Component ───────────────────────────────────────────────────────────────

export default function ProcessesFlow() {
  const onInit = useCallback(() => {}, []);

  return (
    <div className="w-full h-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onInit={onInit}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnScroll
        zoomOnScroll
        minZoom={0.3}
        maxZoom={1.5}
        defaultViewport={{ x: 0, y: 0, zoom: 0.8 }}
      >
        <Background color="#e5e7eb" gap={20} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
