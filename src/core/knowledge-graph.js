/**
 * ClawBrid Knowledge Graph
 * - 엔티티(노드)와 관계(엣지) 기반 지식 그래프
 * - 대화에서 자동으로 엔티티 추출 및 관계 생성
 * - 프롬프트에 관련 지식을 그래프 탐색으로 주입
 * - 기존 memory-manager와 호환 (메모리 저장 시 그래프에도 반영)
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const GRAPH_FILE = path.join(os.homedir(), '.clawbrid', 'knowledge-graph.json');

const ENTITY_TYPES = ['technology', 'project', 'person', 'concept', 'preference', 'file', 'command'];

function loadGraph() {
  try {
    if (fs.existsSync(GRAPH_FILE)) return JSON.parse(fs.readFileSync(GRAPH_FILE, 'utf-8'));
  } catch (err) { console.error(`[GRAPH] load error: ${err.message}`); }
  return { nodes: {}, edges: [] };
}

function saveGraph(graph) {
  try {
    const dir = path.dirname(GRAPH_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(GRAPH_FILE, JSON.stringify(graph, null, 2), 'utf-8');
  } catch (err) { console.error(`[GRAPH] save error: ${err.message}`); }
}

/**
 * 노드 ID 생성 (label → snake_case)
 */
function toNodeId(label) {
  return label.toLowerCase().replace(/[^a-z0-9가-힣]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
}

/**
 * 노드 추가/업데이트
 */
function addNode(label, type = 'concept', context = '') {
  const graph = loadGraph();
  const id = toNodeId(label);
  if (!id) return null;

  if (graph.nodes[id]) {
    graph.nodes[id].mentions++;
    graph.nodes[id].lastSeen = new Date().toISOString();
    if (context && !graph.nodes[id].contexts.includes(context)) {
      graph.nodes[id].contexts.push(context);
      if (graph.nodes[id].contexts.length > 10) graph.nodes[id].contexts.shift();
    }
  } else {
    graph.nodes[id] = {
      label,
      type: ENTITY_TYPES.includes(type) ? type : 'concept',
      mentions: 1,
      lastSeen: new Date().toISOString(),
      contexts: context ? [context] : [],
    };
  }

  // 노드 수 제한 (500개)
  const ids = Object.keys(graph.nodes);
  if (ids.length > 500) {
    const sorted = ids.sort((a, b) => {
      const na = graph.nodes[a], nb = graph.nodes[b];
      return (na.mentions * 0.7 + (new Date(na.lastSeen).getTime() / 1e12) * 0.3) -
             (nb.mentions * 0.7 + (new Date(nb.lastSeen).getTime() / 1e12) * 0.3);
    });
    const toRemove = sorted.slice(0, ids.length - 500);
    for (const rid of toRemove) {
      delete graph.nodes[rid];
      graph.edges = graph.edges.filter(e => e.from !== rid && e.to !== rid);
    }
  }

  saveGraph(graph);
  return id;
}

/**
 * 엣지 추가/업데이트
 */
function addEdge(fromLabel, toLabel, relation = 'related') {
  const graph = loadGraph();
  const fromId = toNodeId(fromLabel);
  const toId = toNodeId(toLabel);

  if (!graph.nodes[fromId] || !graph.nodes[toId]) return false;
  if (fromId === toId) return false;

  const existing = graph.edges.find(e =>
    (e.from === fromId && e.to === toId) || (e.from === toId && e.to === fromId)
  );

  if (existing) {
    existing.weight++;
    existing.lastSeen = new Date().toISOString();
  } else {
    graph.edges.push({
      from: fromId,
      to: toId,
      relation,
      weight: 1,
      lastSeen: new Date().toISOString(),
    });
  }

  // 엣지 수 제한 (1000개)
  if (graph.edges.length > 1000) {
    graph.edges.sort((a, b) => a.weight - b.weight);
    graph.edges = graph.edges.slice(graph.edges.length - 1000);
  }

  saveGraph(graph);
  return true;
}

/**
 * 노드 삭제
 */
function removeNode(label) {
  const graph = loadGraph();
  const id = toNodeId(label);
  if (!graph.nodes[id]) return false;
  delete graph.nodes[id];
  graph.edges = graph.edges.filter(e => e.from !== id && e.to !== id);
  saveGraph(graph);
  return true;
}

/**
 * 메모리 항목에서 그래프 노드/엣지 자동 생성
 * memory-manager의 add()와 연동
 * 1회 load/save로 I/O 최소화
 */
function indexMemory(key, value) {
  const graph = loadGraph();
  const keyType = detectType(key);
  const valueType = detectType(value);

  const keyId = _addNodeToGraph(graph, key, keyType, value);
  const valueId = _addNodeToGraph(graph, value, valueType, key);

  if (keyId && valueId && keyId !== valueId) {
    _addEdgeToGraph(graph, keyId, valueId, 'is');
  }

  saveGraph(graph);
}

/**
 * 내부용: graph 객체에 직접 노드 추가 (I/O 없음)
 */
function _addNodeToGraph(graph, label, type = 'concept', context = '') {
  const id = toNodeId(label);
  if (!id) return null;

  if (graph.nodes[id]) {
    graph.nodes[id].mentions++;
    graph.nodes[id].lastSeen = new Date().toISOString();
    if (context && !graph.nodes[id].contexts.includes(context)) {
      graph.nodes[id].contexts.push(context);
      if (graph.nodes[id].contexts.length > 10) graph.nodes[id].contexts.shift();
    }
  } else {
    graph.nodes[id] = {
      label,
      type: ENTITY_TYPES.includes(type) ? type : 'concept',
      mentions: 1,
      lastSeen: new Date().toISOString(),
      contexts: context ? [context] : [],
    };
  }
  return id;
}

/**
 * 내부용: graph 객체에 직접 엣지 추가 (I/O 없음)
 */
function _addEdgeToGraph(graph, fromId, toId, relation = 'related') {
  if (!graph.nodes[fromId] || !graph.nodes[toId]) return false;
  if (fromId === toId) return false;

  const existing = graph.edges.find(e =>
    (e.from === fromId && e.to === toId) || (e.from === toId && e.to === fromId)
  );

  if (existing) {
    existing.weight++;
    existing.lastSeen = new Date().toISOString();
  } else {
    graph.edges.push({ from: fromId, to: toId, relation, weight: 1, lastSeen: new Date().toISOString() });
  }
  return true;
}

/**
 * 텍스트에서 타입 추론
 */
function detectType(text) {
  const lower = text.toLowerCase();
  if (/\.(js|ts|py|java|cs|go|rs|cpp|c|rb|php)$/i.test(lower)) return 'file';
  if (/^(npm|pip|git|docker|kubectl|yarn|pnpm|cargo|dotnet)\b/.test(lower)) return 'command';
  if (/(react|vue|angular|node|python|typescript|javascript|java|c#|go|rust|tailwind|next|nuxt)/i.test(lower)) return 'technology';
  if (/(프로젝트|project|앱|app|서버|server|시스템|system|대시보드|dashboard)/i.test(lower)) return 'project';
  if (/(선호|prefer|좋아|싫어|항상|always|never)/i.test(lower)) return 'preference';
  return 'concept';
}

/**
 * 프롬프트에서 관련 지식을 그래프 탐색으로 찾기
 * 1. 키워드 매칭으로 시작 노드 찾기
 * 2. 1-hop 이웃 노드 탐색
 * 3. 점수 기반 정렬 후 상위 N개 반환
 */
function getRelevantContext(prompt, maxItems = 7) {
  const graph = loadGraph();
  const nodeIds = Object.keys(graph.nodes);
  if (!nodeIds.length) return '';

  const words = prompt.toLowerCase().split(/\s+/).filter(w => w.length >= 2);
  if (!words.length) return '';

  // 1단계: 키워드 매칭으로 시드 노드 점수 계산
  const scores = {};

  for (const id of nodeIds) {
    const node = graph.nodes[id];
    const searchText = `${node.label} ${node.contexts.join(' ')}`.toLowerCase();
    let keywordScore = 0;

    for (const w of words) {
      if (searchText.includes(w)) keywordScore += 2;
      if (node.label.toLowerCase() === w) keywordScore += 5; // 정확한 매칭 보너스
    }

    // 키워드 매칭이 있을 때만 보너스 적용
    if (keywordScore > 0) {
      let bonus = Math.min(node.mentions * 0.3, 3);
      const daysSince = (Date.now() - new Date(node.lastSeen).getTime()) / 86400000;
      if (daysSince < 7) bonus += 1;
      scores[id] = keywordScore + bonus;
    }
  }

  // 2단계: 1-hop 이웃 탐색 (시드 점수 스냅샷으로 전파, 증폭 방지)
  const seedScores = { ...scores };
  for (const edge of graph.edges) {
    if (seedScores[edge.from] && graph.nodes[edge.to]) {
      scores[edge.to] = (scores[edge.to] || 0) + seedScores[edge.from] * 0.4 * Math.min(edge.weight, 3);
    }
    if (seedScores[edge.to] && graph.nodes[edge.from]) {
      scores[edge.from] = (scores[edge.from] || 0) + seedScores[edge.to] * 0.4 * Math.min(edge.weight, 3);
    }
  }

  // 3단계: 점수 정렬 후 상위 N개
  const ranked = Object.entries(scores)
    .filter(([id]) => graph.nodes[id])
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxItems);

  if (!ranked.length) return '';

  // 컨텍스트 문자열 생성
  const lines = ranked.map(([id]) => {
    const node = graph.nodes[id];
    const ctx = node.contexts.length ? ` (${node.contexts[0]})` : '';
    // 연결된 엣지 정보
    const related = graph.edges
      .filter(e => e.from === id || e.to === id)
      .slice(0, 3)
      .map(e => {
        const otherId = e.from === id ? e.to : e.from;
        const other = graph.nodes[otherId];
        return other ? `${e.relation}→${other.label}` : null;
      })
      .filter(Boolean);

    const relStr = related.length ? ` [${related.join(', ')}]` : '';
    return `- [${node.type}] ${node.label}${ctx}${relStr}`;
  }).join('\n');

  return `--- 지식 그래프 컨텍스트 ---\n${lines}\n--- 그래프 끝 ---\n\n`;
}

/**
 * Claude 응답에서 엔티티 자동 추출
 * [GRAPH:entity1->relation->entity2] 패턴 인식
 * 기존 [MEMORY:key=value]와 병행 사용
 */
function extractAndIndex(responseText) {
  const pattern = /\[GRAPH:([^\]]+)\]/g;
  let match;
  const indexed = [];
  const graph = loadGraph();

  while ((match = pattern.exec(responseText)) !== null) {
    const content = match[1].trim();
    const arrowMatch = content.match(/^(.+?)\s*->\s*(.+?)\s*->\s*(.+)$/);

    if (arrowMatch) {
      const [, entity1, relation, entity2] = arrowMatch;
      const id1 = _addNodeToGraph(graph, entity1.trim(), detectType(entity1.trim()));
      const id2 = _addNodeToGraph(graph, entity2.trim(), detectType(entity2.trim()));
      if (id1 && id2) _addEdgeToGraph(graph, id1, id2, relation.trim());
      indexed.push({ entity1: entity1.trim(), relation: relation.trim(), entity2: entity2.trim() });
    } else {
      _addNodeToGraph(graph, content, detectType(content));
      indexed.push({ entity1: content });
    }
  }

  if (indexed.length > 0) saveGraph(graph);
  const cleaned = responseText.replace(pattern, '').trim();
  return { cleaned, indexed };
}

/**
 * 그래프 통계
 */
function getStats() {
  const graph = loadGraph();
  const nodeCount = Object.keys(graph.nodes).length;
  const edgeCount = graph.edges.length;
  const types = {};
  for (const node of Object.values(graph.nodes)) {
    types[node.type] = (types[node.type] || 0) + 1;
  }
  return { nodeCount, edgeCount, types };
}

/**
 * 모든 노드 반환
 */
function getAllNodes() {
  const graph = loadGraph();
  return Object.entries(graph.nodes).map(([id, node]) => ({ id, ...node }));
}

/**
 * 특정 노드의 이웃 조회
 */
function getNeighbors(label) {
  const graph = loadGraph();
  const id = toNodeId(label);
  if (!graph.nodes[id]) return null;

  const neighbors = [];
  for (const edge of graph.edges) {
    if (edge.from === id && graph.nodes[edge.to]) {
      neighbors.push({ node: graph.nodes[edge.to], relation: edge.relation, direction: 'out' });
    }
    if (edge.to === id && graph.nodes[edge.from]) {
      neighbors.push({ node: graph.nodes[edge.from], relation: edge.relation, direction: 'in' });
    }
  }
  return { node: graph.nodes[id], neighbors };
}

/** 그래프 시스템 프롬프트 */
const GRAPH_SYSTEM_PROMPT = '대화에서 중요한 엔티티 관계를 발견하면 응답 맨 끝에 [GRAPH:엔티티1->관계->엔티티2] 형식으로 기록해. 예: [GRAPH:TypeScript->used_in->React 대시보드] [GRAPH:Redis->caches->세션데이터]. 단일 엔티티도 가능: [GRAPH:Playwright]. 일회성 정보는 기록하지 마.';

module.exports = {
  loadGraph,
  addNode,
  addEdge,
  removeNode,
  indexMemory,
  getRelevantContext,
  extractAndIndex,
  getStats,
  getAllNodes,
  getNeighbors,
  GRAPH_SYSTEM_PROMPT,
  GRAPH_FILE,
};
